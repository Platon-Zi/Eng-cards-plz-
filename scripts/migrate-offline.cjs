#!/usr/bin/env node
'use strict';
/* ============================================================================
 * migrate-offline.cjs — one-off OFFLINE migration of the on-disk base to
 * schema 2 (per-direction SRS), WITHOUT booting the app.
 *
 *   node scripts/migrate-offline.cjs [--dry-run] [--today=YYYY-MM-DD]
 *       [--due-policy=stagger|fresh] [--data-dir=<path>]
 *
 * Safety contract:
 *   - BOM-tolerant read; refuses to run if data/leitner_data.json is missing.
 *   - Writes a write-once pre-migration snapshot (leitner_data.pre-srs.json +
 *     a browser-openable .js mirror) BEFORE touching the base; an existing
 *     snapshot is NEVER overwritten.
 *   - SRS.migrateState → independent no-card-loss assertion → SRS.validateState
 *     ({today, allowShrink:false}); any failure ABORTS with exit 1 and writes
 *     nothing at all (guards run before the first write).
 *   - Atomic writes only: sibling temp file → write → fsyncSync(fd) →
 *     renameSync. UTF-8 WITHOUT BOM. json via SRS.serializeState (fixed key
 *     order, schema_version: 2). Mirror = 'window.LEITNER_DATA = ' + json + ';'
 *     with the +23-byte wrapper asserted.
 *   - Read-back verification after every write.
 *   - Idempotent: a second run reports migratedCount 0 and rewrites a
 *     byte-identical file except for saved_at.
 *
 * Exit codes: 0 = success (incl. dry run), 1 = aborted/refused, 2 = usage.
 * Env: LEITNER_DATA_DIR may point at an alternative data dir (--data-dir wins).
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const SRS = require(path.join(__dirname, '..', 'srs.js'));

const EXIT_OK = 0;
const EXIT_ABORT = 1;
const EXIT_USAGE = 2;

const MIRROR_PREFIX = 'window.LEITNER_DATA = ';
const MIRROR_SUFFIX = ';';
const MIRROR_OVERHEAD = Buffer.byteLength(MIRROR_PREFIX + MIRROR_SUFFIX, 'utf8'); // 23

const JSON_NAME = 'leitner_data.json';
const JS_NAME = 'leitner_data.js';
const SNAP_JSON_NAME = 'leitner_data.pre-srs.json';
const SNAP_JS_NAME = 'leitner_data.pre-srs.js';

/* Fields that must be GONE from every migrated card (schema-1 legacy). */
const FORBIDDEN_FIELDS = [
  'box', 'eng_to_rus', 'rus_to_eng', 'last_tested', 'last_tested_eng', 'last_tested_rus',
  'next_review_date', 'srsStage', 'interval', 'easeFactor', 'repetitions', 'dueDate',
  'knowledge_group', 'level', 'stage'
];

/* --------------------------------- helpers -------------------------------- */

function log(msg) { process.stdout.write(msg + '\n'); }
function errOut(msg) { process.stderr.write('migrate-offline: ' + msg + '\n'); }

function usage() {
  log(`Usage: node scripts/migrate-offline.cjs [options]

Migrates data/leitner_data.json (+ the leitner_data.js browser mirror) from
the legacy 6-box Leitner/SM-2 schema to schema 2 (per-direction SRS), offline.

Options:
  --dry-run               Compute and print the full report; write NOTHING.
  --today=YYYY-MM-DD      Migration "today" (default: SRS.todayString()).
                          Must be a real calendar date.
  --due-policy=stagger|fresh
                          Due-date policy for migrateState (default: stagger).
  --data-dir=<path>       Data directory to operate on (default: the repo's
                          ./data; env LEITNER_DATA_DIR is also honored, the
                          flag wins).
  -h, --help              This help.

Exit codes: 0 success (incl. dry run), 1 aborted/refused, 2 usage error.`);
}

function parseArgs(argv) {
  const opts = { dryRun: false, today: null, duePolicy: 'stagger', dataDir: null, help: false };
  const needValue = (name, inline, i) => {
    if (inline !== undefined && inline !== '') return { value: inline, next: i };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`--${name} requires a value`);
    return { value: v, next: i + 1 };
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    switch (name) {
      case '--dry-run':
        if (inline !== undefined) throw new UsageError('--dry-run takes no value');
        opts.dryRun = true; break;
      case '--today': {
        const r = needValue('today', inline, i); opts.today = r.value; i = r.next; break;
      }
      case '--due-policy': {
        const r = needValue('due-policy', inline, i); opts.duePolicy = r.value; i = r.next; break;
      }
      case '--data-dir': {
        const r = needValue('data-dir', inline, i); opts.dataDir = r.value; i = r.next; break;
      }
      case '-h': case '--help':
        if (inline !== undefined) throw new UsageError('--help takes no value');
        opts.help = true; break;
      default:
        throw new UsageError(`unknown option: ${a}`);
    }
  }
  return opts;
}
class UsageError extends Error {}

function isValidYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const parts = s.split('-').map(Number);
  const y = parts[0], m = parts[1], d = parts[2];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function hasBom(text) { return typeof text === 'string' && text.charCodeAt(0) === 0xFEFF; }
function stripBom(text) { return SRS.stripBom(text); }

/** Atomic write: sibling temp → write → fsyncSync(fd) → renameSync. No BOM. */
function writeFileAtomicSync(targetPath, text) {
  const clean = stripBom(String(text));
  if (hasBom(clean)) throw new Error('internal: BOM survived stripping'); // paranoia
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, clean, 'utf8');
    fs.fsyncSync(fd);                 // flush BEFORE the rename
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, targetPath);   // atomic replace
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore (already renamed) */ }
  }
  return Buffer.byteLength(clean, 'utf8');
}

/** Read back a just-written file; throws unless it matches EXACTLY (no BOM). */
function verifyWrittenFile(filePath, expectedText) {
  const back = fs.readFileSync(filePath, 'utf8');
  if (hasBom(back)) throw new Error(`${filePath}: read-back found a UTF-8 BOM on disk`);
  if (back !== expectedText) throw new Error(`${filePath}: read-back differs from written content`);
}

function buildMirror(json) {
  const js = MIRROR_PREFIX + json + MIRROR_SUFFIX;
  const overhead = Buffer.byteLength(js, 'utf8') - Buffer.byteLength(json, 'utf8');
  if (overhead !== MIRROR_OVERHEAD) {
    throw new Error(`mirror wrapper is ${overhead} bytes over json, expected exactly ${MIRROR_OVERHEAD}`);
  }
  return js;
}

function fmtObj(o) {
  return Object.keys(o).map((k) => `${k}=${o[k]}`).join(' ');
}

/* ----------------------------------- main ---------------------------------- */

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      errOut(e.message);
      usage();
      return EXIT_USAGE;
    }
    throw e;
  }
  if (opts.help) { usage(); return EXIT_OK; }

  if (opts.duePolicy !== 'stagger' && opts.duePolicy !== 'fresh') {
    errOut(`--due-policy must be 'stagger' or 'fresh', got: ${JSON.stringify(opts.duePolicy)}`);
    return EXIT_USAGE;
  }
  let today;
  if (opts.today === null) {
    today = SRS.todayString();
  } else {
    if (!isValidYmd(opts.today)) {
      errOut(`--today must be a real calendar date YYYY-MM-DD, got: ${JSON.stringify(opts.today)}`);
      return EXIT_USAGE;
    }
    today = opts.today;
  }

  const dataDir = path.resolve(opts.dataDir || process.env.LEITNER_DATA_DIR || path.join(__dirname, '..', 'data'));
  const jsonPath = path.join(dataDir, JSON_NAME);
  const jsPath = path.join(dataDir, JS_NAME);
  const snapJsonPath = path.join(dataDir, SNAP_JSON_NAME);
  const snapJsPath = path.join(dataDir, SNAP_JS_NAME);

  log('migrate-offline.cjs — one-off migration to schema 2 (offline, app not booted)');
  log(`  data dir    : ${dataDir}`);
  log(`  today       : ${today}${opts.today === null ? ' (SRS.todayString())' : ' (from --today)'}`);
  log(`  due policy  : ${opts.duePolicy}`);
  log(`  mode        : ${opts.dryRun ? 'DRY RUN (nothing will be written)' : 'REAL RUN'}`);
  log('');

  /* ---- READ (BOM-tolerant; refuse if missing) ---- */
  if (!fs.existsSync(jsonPath)) {
    errOut(`REFUSING TO RUN: ${jsonPath} does not exist. Nothing to migrate; no files touched.`);
    return EXIT_ABORT;
  }
  let raw;
  try {
    raw = fs.readFileSync(jsonPath, 'utf8');
  } catch (e) {
    errOut(`REFUSING TO RUN: cannot read ${jsonPath}: ${e.message}`);
    return EXIT_ABORT;
  }
  const hadBom = hasBom(raw);
  const originalText = stripBom(raw); // snapshot content: byte-faithful minus BOM damage

  let prev;
  try {
    prev = JSON.parse(originalText);
  } catch (e) {
    errOut(`REFUSING TO RUN: ${jsonPath} is not valid JSON even after BOM strip: ${e.message}`);
    errOut('The file was left UNTOUCHED. Restore from a backup or quarantine copy manually.');
    return EXIT_ABORT;
  }
  if (!prev || typeof prev !== 'object' || Array.isArray(prev) || !Array.isArray(prev.cards)) {
    errOut(`REFUSING TO RUN: ${jsonPath} does not contain a state object with a cards array.`);
    return EXIT_ABORT;
  }

  const rawBytes = Buffer.byteLength(raw, 'utf8');
  const beforeIds = prev.cards.filter((c) => c && typeof c.id === 'string' && c.id).map((c) => c.id);
  log('READ');
  log(`  ${JSON_NAME} : ${rawBytes} bytes, BOM present: ${hadBom ? 'yes (stripped for parsing; snapshot will be BOM-free)' : 'no'}`);
  log(`  cards        : ${prev.cards.length}   schema_version: ${prev.schema_version === undefined ? '(absent → legacy 1)' : prev.schema_version}`);
  log(`  root keys    : ${Object.keys(prev).join(', ')}`);
  log('');

  /* ---- MIGRATE (pure, in memory) ---- */
  let res;
  try {
    res = SRS.migrateState(prev, today, { duePolicy: opts.duePolicy });
  } catch (e) {
    errOut(`ABORTED: SRS.migrateState threw: ${e.message}`);
    errOut('No files were written.');
    return EXIT_ABORT;
  }
  const next = res.state;
  const report = res.report;
  const afterIds = next.cards.map((c) => c.id);

  log('MIGRATION (SRS.migrateState)');
  log(`  migratedCount : ${res.migratedCount}`);
  log(`  scanned=${report.scanned} migrated=${report.migrated} alreadyCurrent=${report.alreadyCurrent} junk=${report.junk}`);
  log(`  bySource      : ${fmtObj(report.bySource)}`);
  log(`  byStatus      : ${fmtObj(report.byStatus)}`);
  log(`  byGroup       : ${fmtObj(report.byGroup)}`);
  log(`  levelHist en_ru : [${report.levelHist.en_ru.join(',')}]`);
  log(`  levelHist ru_en : [${report.levelHist.ru_en.join(',')}]`);
  log(`  overdueCarried : ${report.overdueCarried}`);
  log(`  penalized     : ${fmtObj(report.penalized)}`);
  log(`  droppedFields : ${Object.keys(report.droppedFields).length ? fmtObj(report.droppedFields) : '(none)'}`);
  log(`  collisions    : ${report.collisions.length}${report.collisions.length ? ' → ' + JSON.stringify(report.collisions.slice(0, 10)) : ''}`);
  log(`  lostIds       : ${report.lostIds.length}${report.lostIds.length ? ' → ' + report.lostIds.slice(0, 10).join(', ') : ''}`);
  if (report.issues && report.issues.length) {
    log(`  issues        : ${report.issues.length} (first 5: ${report.issues.slice(0, 5).join(' | ')})`);
  }
  log('');

  /* ---- GUARD 1: independent no-card-loss assertion ----
   * ids before ⊆ ids after (merged-away ids in report.collisions are explained),
   * and the count is conserved: after === before − collisions − junk.
   * For a clean base (collisions=0, junk=0) this is literally "count equal". */
  {
    const afterSet = new Set(afterIds);
    const explained = new Set();
    (report.collisions || []).forEach((col) => (col.ids || []).forEach((id) => explained.add(id)));
    const lostUnique = Array.from(new Set(beforeIds)).filter((id) => !afterSet.has(id));
    const unexplained = lostUnique.filter((id) => !explained.has(id));
    const expectedCount = prev.cards.length - report.collisions.length - report.junk;

    log('GUARDS');
    if (unexplained.length) {
      log(`  card-loss assertion : FAILED — ${unexplained.length} unexplained lost id(s): ${unexplained.slice(0, 10).join(', ')}`);
      errOut('ABORTED: CARD LOSS — ids present before migration are missing after it with no collision to explain them. No files were written.');
      return EXIT_ABORT;
    }
    if (afterIds.length !== expectedCount) {
      log(`  card-loss assertion : FAILED — count ${prev.cards.length} → ${afterIds.length}, expected ${expectedCount} (before − collisions − junk)`);
      errOut('ABORTED: card count not conserved and not explained by merges/junk. No files were written.');
      return EXIT_ABORT;
    }
    const countEqual = beforeIds.length === afterIds.length;
    log(`  card-loss assertion : OK — ${beforeIds.length} ids before ⊆ ${afterIds.length} ids after; count ${countEqual ? 'EQUAL' : `conserved (${prev.cards.length} − ${report.collisions.length} collisions − ${report.junk} junk = ${expectedCount})`}`);
  }

  /* ---- GUARD 2: SRS.validateState (strict, no shrink) ---- */
  {
    const vopts = { today, allowShrink: false };
    // Only when migrateState itself documented explained merges (duplicate
    // word+translation collapses) do we hand their ids over as removedIds;
    // for a clean base this is exactly {today, allowShrink:false}.
    if (Array.isArray(report.lostIds) && report.lostIds.length) vopts.removedIds = report.lostIds;
    const v = SRS.validateState(next, prev, vopts);
    log(`  validateState       : ok=${v.ok} errors=${v.errors.length} warnings=${v.warnings.length} shrinkRatio=${v.shrinkRatio} removedIds=${v.removedIds.length} count=${v.count}${vopts.removedIds ? ' (removedIds: explained merges)' : ''}`);
    if (v.warnings.length) log(`  warnings (first 5)  : ${v.warnings.slice(0, 5).join(' | ')}`);
    if (!v.ok) {
      v.errors.forEach((e) => errOut('validateState error: ' + e));
      errOut('ABORTED: validation failed. No files were written.');
      return EXIT_ABORT;
    }
  }

  /* ---- GUARD 3: output hygiene (schema, forbidden fields, root keys) ---- */
  {
    if (next.schema_version !== SRS.SCHEMA_VERSION) {
      errOut(`ABORTED: schema_version is ${next.schema_version}, expected ${SRS.SCHEMA_VERSION}. No files were written.`);
      return EXIT_ABORT;
    }
    const offenders = [];
    next.cards.forEach((c) => {
      FORBIDDEN_FIELDS.forEach((f) => { if (Object.prototype.hasOwnProperty.call(c, f)) offenders.push(`${c.id}:${f}`); });
    });
    if (offenders.length) {
      errOut(`ABORTED: ${offenders.length} deprecated field occurrence(s) survived migration: ${offenders.slice(0, 10).join(', ')}. No files were written.`);
      return EXIT_ABORT;
    }
    const lostRootKeys = Object.keys(prev).filter((k) => !(k in next));
    if (lostRootKeys.length) {
      errOut(`ABORTED: root keys vanished during migration: ${lostRootKeys.join(', ')}. No files were written.`);
      return EXIT_ABORT;
    }
    log(`  schema_version      : ${next.schema_version} ✓   deprecated fields on cards: none ✓   root keys preserved: ${Object.keys(prev).join(', ')} ✓`);
  }

  /* ---- due entries on migration day ---- */
  const dueCount = SRS.buildReviewQueue(next.cards, today).length;
  log(`  due entries on ${today} (SRS.buildReviewQueue): ${dueCount}`);
  log('');

  /* ---- SERIALIZE (pure) ---- */
  const jsonOut = SRS.serializeState(next, { savedAt: new Date().toISOString() });
  let jsOut;
  try {
    jsOut = buildMirror(jsonOut);
  } catch (e) {
    errOut(`ABORTED: ${e.message}. No files were written.`);
    return EXIT_ABORT;
  }
  if (hasBom(jsonOut) || hasBom(jsOut)) {
    errOut('ABORTED: internal error — serializer produced a BOM. No files were written.');
    return EXIT_ABORT;
  }

  if (opts.dryRun) {
    log('DRY RUN — no files written (no snapshot, no base, no mirror).');
    log(`Would write: ${snapJsonPath} (${Buffer.byteLength(originalText, 'utf8')} bytes, write-once) + ${snapJsPath}`);
    log(`Would write: ${jsonPath} (${Buffer.byteLength(jsonOut, 'utf8')} bytes) and ${jsPath} (${Buffer.byteLength(jsOut, 'utf8')} bytes, wrapper +${MIRROR_OVERHEAD} asserted)`);
    return EXIT_OK;
  }

  /* ---- SNAPSHOT (write-once, BEFORE any destructive step) ---- */
  log('SNAPSHOT (write-once pre-migration backup)');
  try {
    if (fs.existsSync(snapJsonPath)) {
      log(`  ${SNAP_JSON_NAME} : already exists — SKIPPED (never overwritten)`);
    } else {
      const n = writeFileAtomicSync(snapJsonPath, originalText);
      verifyWrittenFile(snapJsonPath, originalText);
      log(`  ${SNAP_JSON_NAME} : wrote ${n} bytes (original payload, BOM damage removed)`);
    }
    if (fs.existsSync(snapJsPath)) {
      log(`  ${SNAP_JS_NAME}    : already exists — SKIPPED (never overwritten)`);
    } else {
      // Mirror the snapshot from the snapshot json actually on disk so the
      // rollback copy is browser-openable even if .json predated this run.
      const snapText = stripBom(fs.readFileSync(snapJsonPath, 'utf8'));
      JSON.parse(snapText); // must be parseable before it gets a mirror
      const snapJs = buildMirror(snapText);
      const n = writeFileAtomicSync(snapJsPath, snapJs);
      verifyWrittenFile(snapJsPath, snapJs);
      log(`  ${SNAP_JS_NAME}    : wrote ${n} bytes (browser-openable rollback mirror, wrapper +${MIRROR_OVERHEAD})`);
    }
  } catch (e) {
    errOut(`ABORTED during snapshot: ${e.message}`);
    errOut('The base file was NOT touched.');
    return EXIT_ABORT;
  }
  log('');

  /* ---- WRITE base + mirror (atomic, verified) ---- */
  log('WRITE');
  try {
    const nJson = writeFileAtomicSync(jsonPath, jsonOut);
    verifyWrittenFile(jsonPath, jsonOut);
    const back = JSON.parse(stripBom(fs.readFileSync(jsonPath, 'utf8')));
    if (!back || !Array.isArray(back.cards) || back.cards.length !== next.cards.length) {
      throw new Error(`read-back cards.length is ${back && back.cards ? back.cards.length : 'n/a'}, expected ${next.cards.length}`);
    }
    if (back.schema_version !== SRS.SCHEMA_VERSION) {
      throw new Error(`read-back schema_version is ${back.schema_version}, expected ${SRS.SCHEMA_VERSION}`);
    }
    log(`  ${JSON_NAME} : wrote ${nJson} bytes atomically (temp+fsync+rename), UTF-8 no BOM; read-back verified (parses, cards=${back.cards.length}, schema_version=${back.schema_version})`);

    const nJs = writeFileAtomicSync(jsPath, jsOut);
    verifyWrittenFile(jsPath, jsOut);
    const jsBack = stripBom(fs.readFileSync(jsPath, 'utf8'));
    if (!jsBack.startsWith(MIRROR_PREFIX) || !jsBack.endsWith(MIRROR_SUFFIX)) {
      throw new Error('mirror read-back does not have the exact wrapper');
    }
    const inner = jsBack.slice(MIRROR_PREFIX.length, -MIRROR_SUFFIX.length);
    if (inner !== jsonOut) throw new Error('mirror payload differs from json payload');
    if (Buffer.byteLength(jsBack, 'utf8') !== Buffer.byteLength(jsonOut, 'utf8') + MIRROR_OVERHEAD) {
      throw new Error('mirror is not exactly +23 bytes over the json payload');
    }
    JSON.parse(inner); // mirror payload must parse standalone
    log(`  ${JS_NAME}    : wrote ${nJs} bytes atomically; wrapper exactly +${MIRROR_OVERHEAD} bytes over json ✓; payload identical to ${JSON_NAME} ✓`);
  } catch (e) {
    errOut(`FAILED during write: ${e.message}`);
    errOut(`The pre-migration snapshot at ${snapJsonPath} is intact; the base may be old or new — re-run after inspecting (the script is idempotent).`);
    return EXIT_ABORT;
  }
  log('');

  log('SUCCESS — migration to schema 2 complete.');
  log(`  cards: ${next.cards.length}   byStatus: ${fmtObj(report.byStatus)}   migratedCount: ${res.migratedCount}`);
  log(`  due entries on ${today}: ${dueCount}`);
  log('  Re-running this script is safe: it reports migratedCount 0 and rewrites a byte-identical file except saved_at.');
  return EXIT_OK;
}

try {
  process.exitCode = main();
} catch (e) {
  errOut(`UNEXPECTED FAILURE: ${e && e.stack ? e.stack : e}`);
  process.exitCode = EXIT_ABORT;
}
