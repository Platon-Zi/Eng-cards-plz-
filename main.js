const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

/* ============================ PERSISTENCE HARDENING =========================
 * Rules enforced by this file (schema-2 era):
 *  1. Every read strips a leading UTF-8 BOM before JSON.parse — a BOM must
 *     never again produce a silent `null` (that silent null is what let
 *     scripts/add_words.js "recover" an empty base and overwrite 198 cards).
 *  2. Every write emits UTF-8 WITHOUT a BOM (Node's utf8 writer never adds
 *     one, and incoming content is BOM-stripped defensively).
 *  3. Every write is atomic: sibling temp file in the SAME directory →
 *     write → fsyncSync(fd) → renameSync over the target. A crash mid-write
 *     can never truncate the base.
 *  4. IPC handlers resolve to structured envelopes —
 *       success: { ok: true,  data, ... }
 *       failure: { ok: false, reason: '...', detail: '...', data: null }
 *     — never a raw throw, never a bare null. `data` is the parsed state or
 *     null. load-data additionally spreads the state at top level so the
 *     legacy renderer (`ipcData.cards`) keeps working alongside the new one
 *     (`result.ok` / `result.data`).
 *  5. A file that fails to parse is QUARANTINED, never overwritten:
 *     leitner_data.corrupt-<ISO timestamp>.json in the same directory.
 *  6. Every save is verified by reading the file back (raw byte equality,
 *     BOM check, JSON parse, cards.length comparison).
 *  7. data/leitner_data.js (browser fallback mirror) is regenerated on every
 *     save-data as 'window.LEITNER_DATA = ' + json + ';' — asserted to be
 *     exactly 23 bytes longer than the json payload — and written atomically.
 *  8. Channel names are unchanged: load-data, save-data, export-csv,
 *     save-backup-json. One ADDITIVE channel exists: save-snapshot — a
 *     silent (no dialog), write-once, filename-hardened snapshot writer used
 *     for the pre-migration auto-backup.
 * The data dir can be redirected with LEITNER_DATA_DIR (used by the offline
 * test harness / migration tooling); unset means the original ./data.
 * ========================================================================== */

/* srs.js is the authoritative pure kernel. We only borrow stripBom from it,
 * and fall back to a local copy so the main process still boots if srs.js is
 * ever broken. */
let SRS = null;
try { SRS = require('./srs.js'); } catch (e) {
  console.error('srs.js unavailable, using built-in stripBom:', e && e.message);
}
const stripBom = (SRS && typeof SRS.stripBom === 'function')
  ? SRS.stripBom
  : (t) => (typeof t === 'string' && t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 900,
    minHeight: 650,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: THEME_OVERLAY_STRIP[currentThemeId],
      symbolColor: THEME_OVERLAY_SYMBOL[currentThemeId],
      height: 38
    },
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    backgroundColor: THEME_STARTUP_BG[currentThemeId],
    icon: path.join(__dirname, 'icon.png')
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

/* --------------------------- THEME-AWARE WINDOW CHROME ----------------------
 * The renderer's theme.js owns colour; this layer only mirrors the chosen
 * theme onto the NATIVE bits (startup backgroundColor + Windows/macOS
 * titleBarOverlay button strip) so light themes don't open behind a dark
 * flash. The chosen id is persisted in a tiny userData file and read back
 * BEFORE the window is created. Linux has no setTitleBarOverlay → wrapped in
 * try/catch, and the startup colour still prevents the flash everywhere. */
const THEME_CHROME_FILE = path.join(app.getPath('userData'), 'eng_cards_theme.txt');
const THEME_STARTUP_BG = { beta: '#0f172a', midnight: '#051219', light: '#e8f2f5', sandstone: '#f5f0e4' };
const THEME_OVERLAY_STRIP = { beta: '#0b1329', midnight: '#010b11', light: '#deedf0', sandstone: '#ede7d8' };
const THEME_OVERLAY_SYMBOL = { beta: '#94a3b8', midnight: '#8d9da2', light: '#556c74', sandstone: '#74685c' };
let currentThemeId = 'beta';
try {
  const saved = String(fs.readFileSync(THEME_CHROME_FILE, 'utf8')).trim();
  if (THEME_STARTUP_BG[saved]) currentThemeId = saved;
} catch (e) { /* first run: no file yet, keep beta */ }

/* Renderer asks us to mirror a live theme change. We re-derive the native
   colours from the shared maps (single source of truth is themes.css tokens,
   but the exact strip/symbol hexes are stable) and update the existing
   window. Linux has no setTitleBarOverlay → guarded try/catch. */
ipcMain.on('theme:window', (event, payload) => {
  const id = payload && payload.id;
  if (!THEME_STARTUP_BG[id]) return;
  currentThemeId = id;
  try { fs.writeFileSync(THEME_CHROME_FILE, id, 'utf8'); } catch (e) { /* non-fatal */ }
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  try { win.setBackgroundColor(THEME_STARTUP_BG[id]); } catch (e) { /* older API */ }
  try {
    win.setTitleBarOverlay({
      color: THEME_OVERLAY_STRIP[id],
      symbolColor: THEME_OVERLAY_SYMBOL[id],
      height: 38
    });
  } catch (e) { /* platform without titleBarOverlay (Linux): startup bg is enough */ }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------------------- paths & constants --------------------------- */

const DATA_FILE = 'leitner_data.json';
const MIRROR_FILE = 'leitner_data.js';
const MIRROR_PREFIX = 'window.LEITNER_DATA = ';
const MIRROR_SUFFIX = ';';
const MIRROR_OVERHEAD = Buffer.byteLength(MIRROR_PREFIX + MIRROR_SUFFIX, 'utf8'); // === 23

// Stored in project ./data/leitner_data.json for instant Antigravity integration
function getDataDir() {
  const dir = process.env.LEITNER_DATA_DIR
    ? path.resolve(process.env.LEITNER_DATA_DIR)
    : path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function getDataPath() { return path.join(getDataDir(), DATA_FILE); }
function getMirrorPath() { return path.join(getDataDir(), MIRROR_FILE); }

/* ------------------------------ fs primitives ----------------------------- */

function errMessage(e) { return String((e && e.message) || e); }
function hasBom(text) { return typeof text === 'string' && text.charCodeAt(0) === 0xFEFF; }

/**
 * Atomic write: temp file in the SAME directory → write → fsyncSync(fd) →
 * renameSync over target. UTF-8 without BOM (content is BOM-stripped first).
 * Returns {ok:true, bytes} or {ok:false, error} — never throws.
 */
function writeFileAtomicSync(targetPath, text) {
  const clean = stripBom(String(text));
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, clean, 'utf8');
    fs.fsyncSync(fd);           // flush to stable storage BEFORE the rename
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, targetPath); // atomic replace; old file intact until here
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    return { ok: false, error: e };
  }
  try { // best-effort: fsync the directory so the rename itself is durable
    const dh = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dh); } finally { fs.closeSync(dh); }
  } catch (_) { /* not supported on every platform (e.g. Windows) */ }
  return { ok: true, bytes: Buffer.byteLength(clean, 'utf8') };
}

/**
 * Atomic WRITE-ONCE (no-clobber) variant: same temp → fsync → publish flow,
 * but publication uses linkSync (fails EEXIST if target exists) with a
 * guarded rename fallback. An existing target is NEVER touched.
 * Returns {ok:true, skipped:boolean, bytes} or {ok:false, error}.
 */
function writeFileAtomicNoClobberSync(targetPath, text) {
  const clean = stripBom(String(text));
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(targetPath)) return { ok: true, skipped: true, bytes: 0 };
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, clean, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.linkSync(tmp, targetPath);      // exclusive publish: EEXIST if it appeared meanwhile
    } catch (le) {
      if (le && le.code === 'EEXIST') return { ok: true, skipped: true, bytes: 0 };
      if (fs.existsSync(targetPath)) return { ok: true, skipped: true, bytes: 0 };
      if (le && (le.code === 'EPERM' || le.code === 'EACCES' || le.code === 'ENOTSUP' || le.code === 'EXDEV')) {
        fs.renameSync(tmp, targetPath);  // platform without hard links; target confirmed absent above
      } else {
        throw le;
      }
    }
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    return { ok: false, error: e };
  }
  try {
    const dh = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dh); } finally { fs.closeSync(dh); }
  } catch (_) { /* not supported on every platform */ }
  return { ok: true, skipped: false, bytes: Buffer.byteLength(clean, 'utf8') };
}

/** Read a file as UTF-8 text. {found:false} on ENOENT; {found:true, error} on
 *  any other read failure; never throws. */
function readTextFile(filePath) {
  try {
    return { found: true, text: fs.readFileSync(filePath, 'utf8'), error: null };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { found: false, text: null, error: null };
    return { found: true, text: null, error: e };
  }
}

/**
 * Move a corrupt file aside as `<name>.corrupt-<ISO timestamp>.json` in the
 * same directory (colons/dots in the timestamp are replaced so the name is
 * valid on Windows too). Returns the new path; throws only if rename fails.
 */
function quarantineFile(filePath) {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath)) || 'data';
  const iso = () => new Date().toISOString().replace(/[:.]/g, '-');
  let target = path.join(dir, `${stem}.corrupt-${iso()}.json`);
  for (let n = 1; fs.existsSync(target); n++) {
    target = path.join(dir, `${stem}-${n}.corrupt-${iso()}.json`);
  }
  fs.renameSync(filePath, target);
  return target;
}

/* --------------------------- result envelopes ----------------------------- */

function okResult(extra) { return Object.assign({ ok: true }, extra); }
function failResult(reason, detail, extra) {
  return Object.assign({ ok: false, reason, detail: String(detail || ''), data: null }, extra || {});
}

/** Is this a plausible state object? (object with a cards array) */
function isStateShape(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.cards);
}

/** Build the mirror payload and assert the 23-byte wrapper invariant.
 *  Returns {ok:true, js} or {ok:false, detail}. */
function buildMirror(json) {
  const js = stripBom(MIRROR_PREFIX + json + MIRROR_SUFFIX);
  const overhead = Buffer.byteLength(js, 'utf8') - Buffer.byteLength(json, 'utf8');
  if (overhead !== MIRROR_OVERHEAD) {
    return { ok: false, detail: `mirror wrapper is ${overhead} bytes over json, expected exactly ${MIRROR_OVERHEAD}` };
  }
  return { ok: true, js };
}

/** Read back a just-written file and demand raw byte equality + no BOM.
 *  Returns {ok:true, text} or {ok:false, detail}. */
function verifyWrittenFile(filePath, expectedText) {
  const back = readTextFile(filePath);
  if (!back.found) return { ok: false, detail: `file vanished after write: ${filePath}` };
  if (back.error) return { ok: false, detail: `read-back failed: ${errMessage(back.error)}` };
  if (hasBom(back.text)) return { ok: false, detail: 'read-back found a UTF-8 BOM on disk (must never be written)' };
  if (back.text !== expectedText) return { ok: false, detail: 'read-back content differs from written content' };
  return { ok: true, text: back.text };
}

/* ------------------------------- IPC handlers ----------------------------- */

ipcMain.handle('load-data', async () => {
  let dataPath;
  try {
    dataPath = getDataPath();
    const r = readTextFile(dataPath);

    if (!r.found) {
      // Legitimate "no file yet" — distinct from corruption.
      return failResult('not-found', `No data file at ${dataPath}`, { path: dataPath });
    }
    if (r.error) {
      return failResult('read-failed', errMessage(r.error), { path: dataPath });
    }

    const hadBom = hasBom(r.text);
    const clean = stripBom(r.text);   // ← a BOM can never cause a parse failure again

    let state;
    try {
      state = JSON.parse(clean);
    } catch (e) {
      // Quarantine instead of leaving a corrupt file that a later save would
      // happily overwrite. Evidence preserved, handler still resolves.
      let quarantined = null;
      try { quarantined = quarantineFile(dataPath); } catch (qe) {
        console.error('Quarantine failed:', qe);
        return failResult('parse-failed', `JSON parse failed: ${errMessage(e)}; quarantine rename failed: ${errMessage(qe)}`,
          { path: dataPath, hadBom });
      }
      console.error(`load-data: ${dataPath} failed to parse — quarantined to ${quarantined}`);
      return failResult('parse-failed', `JSON parse failed: ${errMessage(e)}`,
        { path: dataPath, quarantined, hadBom });
    }

    if (!isStateShape(state)) {
      let quarantined = null;
      try { quarantined = quarantineFile(dataPath); } catch (_) { /* reported below */ }
      return failResult('shape-invalid', 'Parsed JSON is not a state object with a cards array',
        { path: dataPath, quarantined, hadBom });
    }

    // Spread keeps the legacy renderer working (ipcData.cards); ok/data serve
    // the new renderer (result.ok / result.data).
    return Object.assign({}, state, {
      ok: true, data: state, path: dataPath, hadBom, cardCount: state.cards.length
    });
  } catch (e) {
    console.error('Error reading data:', e);
    return failResult('unexpected', errMessage(e), { path: dataPath || null });
  }
});

ipcMain.handle('save-data', async (event, data) => {
  let dataPath = null;
  try {
    if (!isStateShape(data)) {
      return failResult('invalid-payload', 'save-data expects a state object with a cards array; nothing was written',
        { success: false });
    }
    dataPath = getDataPath();
    const jsPath = getMirrorPath();
    const warnings = [];

    /* Quarantine-instead-of-overwrite on the write path too: if the file
     * currently on disk is corrupt, move it aside first so forensic evidence
     * survives and the new save can never destroy it. */
    let quarantined = null;
    let prevCount = null;
    const prev = readTextFile(dataPath);
    if (prev.found && prev.error) {
      return failResult('read-failed', `Could not read existing data file: ${errMessage(prev.error)}`,
        { success: false, path: dataPath });
    }
    if (prev.found && prev.text !== null) {
      try {
        const prevState = JSON.parse(stripBom(prev.text));
        if (isStateShape(prevState)) prevCount = prevState.cards.length;
      } catch (e) {
        try {
          quarantined = quarantineFile(dataPath);
          console.error(`save-data: existing ${dataPath} failed to parse — quarantined to ${quarantined}`);
        } catch (qe) {
          return failResult('quarantine-failed',
            `Existing file is corrupt and could not be moved aside (${errMessage(qe)}); refusing to overwrite`,
            { success: false, path: dataPath });
        }
      }
    }
    if (prevCount !== null && data.cards.length < prevCount) {
      // Non-blocking observability: the renderer is authoritative, but a big
      // shrink is exactly the signature of the old silent-null data loss.
      warnings.push(`shrink:${prevCount}->${data.cards.length}`);
    }

    const json = stripBom(JSON.stringify(data, null, 2));
    const mirror = buildMirror(json);
    if (!mirror.ok) {
      return failResult('mirror-invariant-violated', mirror.detail + '; nothing was written',
        { success: false, path: dataPath });
    }

    /* Write 1/2: the JSON base, atomically, then verify by reading back. */
    const w1 = writeFileAtomicSync(dataPath, json);
    if (!w1.ok) {
      return failResult('write-failed', `Could not write ${dataPath}: ${errMessage(w1.error)}`,
        { success: false, path: dataPath, quarantined, warnings });
    }
    const back1 = verifyWrittenFile(dataPath, json);
    if (!back1.ok) {
      return failResult('readback-mismatch', `JSON base: ${back1.detail}`,
        { success: false, path: dataPath, jsPath, quarantined, warnings });
    }
    let backState;
    try {
      backState = JSON.parse(stripBom(back1.text));
    } catch (e) {
      return failResult('readback-mismatch', `JSON base does not parse after write: ${errMessage(e)}`,
        { success: false, path: dataPath, jsPath, quarantined, warnings });
    }
    if (!isStateShape(backState) || backState.cards.length !== data.cards.length) {
      return failResult('readback-mismatch',
        `cards.length on disk is ${backState && Array.isArray(backState.cards) ? backState.cards.length : 'n/a'}, expected ${data.cards.length}`,
        { success: false, path: dataPath, jsPath, quarantined, warnings });
    }

    /* Write 2/2: the browser mirror, atomically, then verify. */
    const w2 = writeFileAtomicSync(jsPath, mirror.js);
    if (!w2.ok) {
      return failResult('mirror-write-failed',
        `Base JSON saved and verified, but mirror write failed: ${errMessage(w2.error)}`,
        { success: false, saved: true, dataSaved: true, path: dataPath, jsPath, quarantined, warnings });
    }
    const back2 = verifyWrittenFile(jsPath, mirror.js);
    if (!back2.ok) {
      return failResult('readback-mismatch', `mirror: ${back2.detail}`,
        { success: false, saved: true, dataSaved: true, path: dataPath, jsPath, quarantined, warnings });
    }

    return okResult({
      saved: true, success: true, data: null,
      path: dataPath, jsPath, cards: data.cards.length, prevCount,
      bytes: w1.bytes, mirrorBytes: w2.bytes, quarantined, warnings
    });
  } catch (e) {
    console.error('Error saving data:', e);
    return failResult('unexpected', errMessage(e), { success: false, path: dataPath });
  }
});

ipcMain.handle('export-csv', async (event, csvContent) => {
  try {
    if (typeof csvContent !== 'string') {
      return failResult('invalid-payload', 'export-csv expects a CSV string', { success: false });
    }
    let filePath = '';
    let canceled = false;
    try {
      const res = await dialog.showSaveDialog({
        title: 'Export Flashcards to CSV',
        defaultPath: 'leitner_words.csv',
        filters: [{ name: 'CSV Files', extensions: ['csv'] }]
      });
      filePath = (res && res.filePath) || '';
      canceled = !!(res && (res.canceled || res.cancelled));
    } catch (e) {
      return failResult('dialog-failed', errMessage(e), { success: false });
    }
    if (!filePath || canceled) {
      return failResult('cancelled', 'User cancelled the save dialog', { success: false, cancelled: true });
    }

    const text = stripBom(csvContent);   // never write a BOM, even if the renderer sent one
    const w = writeFileAtomicSync(filePath, text);
    if (!w.ok) {
      return failResult('write-failed', `Could not write ${filePath}: ${errMessage(w.error)}`,
        { success: false, filePath });
    }
    const back = verifyWrittenFile(filePath, text);
    if (!back.ok) {
      return failResult('readback-mismatch', `CSV: ${back.detail}`, { success: false, filePath });
    }
    return okResult({ success: true, filePath, bytes: w.bytes });
  } catch (e) {
    console.error('Error exporting CSV:', e);
    return failResult('unexpected', errMessage(e), { success: false });
  }
});

ipcMain.handle('save-backup-json', async (event, jsonContent) => {
  try {
    if (typeof jsonContent !== 'string') {
      return failResult('invalid-payload', 'save-backup-json expects a JSON string', { success: false });
    }
    // Validate BEFORE involving the user with a dialog: a corrupt backup must
    // never reach disk.
    let intendedCards = null;
    try {
      const parsed = JSON.parse(stripBom(jsonContent));
      if (isStateShape(parsed)) intendedCards = parsed.cards.length;
    } catch (e) {
      return failResult('invalid-payload', `Backup content is not valid JSON: ${errMessage(e)}; nothing written`,
        { success: false });
    }

    const today = new Date().toISOString().split('T')[0];
    let filePath = '';
    let canceled = false;
    try {
      const res = await dialog.showSaveDialog({
        title: 'Save Leitner Flashcards Backup',
        defaultPath: `leitner_cards_backup_${today}.json`,
        filters: [{ name: 'JSON Backup', extensions: ['json'] }]
      });
      filePath = (res && res.filePath) || '';
      canceled = !!(res && (res.canceled || res.cancelled));
    } catch (e) {
      return failResult('dialog-failed', errMessage(e), { success: false });
    }
    if (!filePath || canceled) {
      return failResult('cancelled', 'User cancelled the save dialog', { success: false, cancelled: true });
    }

    const text = stripBom(jsonContent);
    const w = writeFileAtomicSync(filePath, text);
    if (!w.ok) {
      return failResult('write-failed', `Could not write ${filePath}: ${errMessage(w.error)}`,
        { success: false, filePath });
    }
    const back = verifyWrittenFile(filePath, text);
    if (!back.ok) {
      return failResult('readback-mismatch', `backup JSON: ${back.detail}`, { success: false, filePath });
    }
    let backParsed;
    try {
      backParsed = JSON.parse(stripBom(back.text));
    } catch (e) {
      return failResult('readback-mismatch', `backup does not parse after write: ${errMessage(e)}`,
        { success: false, filePath });
    }
    if (intendedCards !== null && (!isStateShape(backParsed) || backParsed.cards.length !== intendedCards)) {
      return failResult('readback-mismatch',
        `backup cards.length on disk is ${backParsed && Array.isArray(backParsed.cards) ? backParsed.cards.length : 'n/a'}, expected ${intendedCards}`,
        { success: false, filePath });
    }
    return okResult({ success: true, filePath, cards: intendedCards, bytes: w.bytes });
  } catch (e) {
    console.error('Error saving backup:', e);
    return failResult('unexpected', errMessage(e), { success: false });
  }
});

/* Silent, write-once snapshot writer (no dialog) for the pre-migration
 * auto-backup: ipcRenderer.invoke('save-snapshot', { filename, content }).
 * `content` is already-serialized text; it lands in the SAME data dir as
 * save-data, atomically, UTF-8 without BOM, and an existing target is never
 * overwritten ({ok:true, skipped:true}). `filename` is renderer-supplied and
 * therefore treated as hostile: it must be a bare [A-Za-z0-9._-]+ name with a
 * .json/.js extension — no '/', no '\', no '..', no leading dot — and the
 * resolved path is re-checked to sit directly inside the data dir. */
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9._-]+\.(json|js)$/;

function validateSnapshotFilename(filename) {
  if (typeof filename !== 'string' || !filename) return 'filename must be a non-empty string';
  if (filename.includes('/') || filename.includes('\\')) return 'filename must not contain path separators';
  if (filename.includes('..')) return 'filename must not contain ".."';
  if (filename.startsWith('.')) return 'filename must not start with a dot';
  if (!SNAPSHOT_NAME_RE.test(filename)) return 'filename must match [A-Za-z0-9._-]+ and end with .json or .js';
  return null;
}

ipcMain.handle('save-snapshot', async (event, payload) => {
  let targetPath = null;
  try {
    if (!payload || typeof payload !== 'object') {
      return failResult('invalid-payload', 'save-snapshot expects { filename, content }');
    }
    const { filename, content } = payload;
    const nameProblem = validateSnapshotFilename(filename);
    if (nameProblem) return failResult('invalid-filename', nameProblem);
    if (typeof content !== 'string' || !content) {
      return failResult('invalid-payload', 'content must be a non-empty string of serialized JSON text');
    }

    const dataDir = getDataDir();
    targetPath = path.join(dataDir, filename);
    // Defense in depth: the resolved target must sit DIRECTLY inside dataDir.
    if (path.dirname(path.resolve(targetPath)) !== path.resolve(dataDir)) {
      return failResult('invalid-filename', 'resolved path escapes the data directory; refusing');
    }

    // Content sanity per extension: a corrupt snapshot must never reach disk.
    const text = stripBom(content);
    if (/\.json$/i.test(filename)) {
      try {
        JSON.parse(text);
      } catch (e) {
        return failResult('invalid-content', `content is not valid JSON: ${errMessage(e)}; nothing written`);
      }
    } else { // .js mirror: must follow the repo's exact wrapper convention
      if (!text.startsWith(MIRROR_PREFIX) || !text.endsWith(MIRROR_SUFFIX)) {
        return failResult('invalid-content', `.js snapshot must be '${MIRROR_PREFIX}<json>${MIRROR_SUFFIX}'`);
      }
      try {
        JSON.parse(text.slice(MIRROR_PREFIX.length, -MIRROR_SUFFIX.length));
      } catch (e) {
        return failResult('invalid-content', `.js snapshot payload is not valid JSON: ${errMessage(e)}; nothing written`);
      }
    }

    const w = writeFileAtomicNoClobberSync(targetPath, text);
    if (!w.ok) {
      return failResult('write-failed', `Could not write ${targetPath}: ${errMessage(w.error)}`, { path: targetPath });
    }
    if (w.skipped) {
      // Write-once contract: the existing snapshot is authoritative, untouched.
      return okResult({ skipped: true, path: targetPath, reason: 'exists' });
    }
    const back = verifyWrittenFile(targetPath, text);
    if (!back.ok) {
      return failResult('readback-mismatch', `snapshot: ${back.detail}`, { path: targetPath });
    }
    return okResult({ skipped: false, path: targetPath, bytes: w.bytes });
  } catch (e) {
    console.error('Error saving snapshot:', e);
    return failResult('unexpected', errMessage(e), { path: targetPath });
  }
});
