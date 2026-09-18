const path = require('path');
// CSS integrity checker: braces, declarations, var() syntax, and per-theme
// token coverage (every var(--x) used anywhere in style.css/themes.css must
// be defined in :root AND in every html[data-theme=…] scope).
// Usage: node .scratch/ui/css_check.cjs
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const files = { 'style.css': fs.readFileSync(ROOT + '/style.css', 'utf8'), 'themes.css': fs.readFileSync(ROOT + '/themes.css', 'utf8') };
let failures = 0;
const ok = (c, m) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failures++; };

/* ---- strip comments for structural checks ---- */
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '');

/* ---- 1. balanced braces + var() parens ---- */
for (const [name, raw] of Object.entries(files)) {
  const css = strip(raw);
  let depth = 0, bad = null;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') { depth--; if (depth < 0 && !bad) bad = i; }
  }
  ok(depth === 0 && !bad, `${name}: balanced braces (final depth ${depth})`);
  const opens = (css.match(/var\(/g) || []).length;
  // every var( must close; check paren balance per line containing var(
  let varBad = 0;
  for (const line of css.split('\n')) {
    if (!line.includes('var(')) continue;
    let d = 0;
    for (const ch of line) { if (ch === '(') d++; else if (ch === ')') d--; }
    if (d !== 0) varBad++;
  }
  ok(varBad === 0, `${name}: ${opens} var() usages, all paren-balanced per line (${varBad} bad)`);
}

/* ---- 2. declaration sanity: inside rule blocks, each ;-terminated chunk is prop:value ---- */
for (const [name, raw] of Object.entries(files)) {
  const css = strip(raw);
  const malformed = [];
  // walk blocks: text between { and matching } that contains no { (leaf rules)
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const body = m[2];
    for (let decl of body.split(';')) {
      decl = decl.trim();
      if (!decl) continue;
      if (!/^-{0,2}[A-Za-z-][A-Za-z0-9_-]*\s*:/.test(decl) && !/^[A-Za-z-]+\s*:/.test(decl)) {
        malformed.push(decl.slice(0, 70));
      }
      if ((decl.match(/:/g) || []).length === 0) malformed.push(decl.slice(0, 70));
    }
  }
  ok(malformed.length === 0, `${name}: no malformed declarations${malformed.length ? ' → ' + JSON.stringify(malformed.slice(0, 5)) : ''}`);
}

/* ---- 3. collect scope definitions ---- */
function scopeVars(css, scopeRe) {
  const out = new Map(); // scopeKey -> Set(var names)
  const re = new RegExp(scopeRe.source, 'g');
  let m;
  while ((m = re.exec(css))) {
    const key = m[1].trim();
    const body = m[2];
    const set = out.get(key) || new Set();
    for (const d of body.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) set.add(d[1]);
    out.set(key, set);
  }
  return out;
}
const rootVars = scopeVars(strip(files['style.css']), /(:root)\s*\{([^{}]*)\}/);
const themeVars = scopeVars(strip(files['themes.css']), /(html\[data-theme=["'][a-z]+["']\])\s*\{([^{}]*)\}/);

ok(rootVars.has(':root'), ':root scope found in style.css');
const themeKeys = ['html[data-theme="beta"]', 'html[data-theme="midnight"]', 'html[data-theme="light"]', 'html[data-theme="sandstone"]'];
for (const k of themeKeys) ok(themeVars.has(k), `themes.css declares scope ${k}`);

/* ---- 4. every var(--x) used anywhere is defined in every scope ---- */
const used = new Map(); // var -> [files]
for (const [name, raw] of Object.entries(files)) {
  for (const m of strip(raw).matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) {
    if (!used.has(m[1])) used.set(m[1], new Set());
    used.get(m[1]).add(name);
  }
}
console.log(`   (distinct custom properties referenced: ${used.size})`);
/* component-local custom properties: declared in ordinary rule blocks
   (e.g. --gc/--gc-tint/--gc-line on .kg-row/.dict-card-progress) and always
   consumed with a var() fallback — intentionally NOT theme-scope tokens. */
const localVars = new Set();
{
  const css = strip(files['style.css']).replace(/:root\s*\{[^{}]*\}/, '') + strip(files['themes.css']).replace(/html\[data-theme="[a-z]+"\]\s*\{[^{}]*\}/g, '');
  for (const m of css.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) localVars.add(m[1]);
}
console.log(`   (component-local vars exempted: ${[...localVars].join(', ') || 'none'})`);
let undef = [];
for (const v of used.keys()) {
  if (localVars.has(v)) continue;
  const scopes = [[':root', rootVars.get(':root')], ...themeKeys.map(k => [k, themeVars.get(k)])];
  for (const [sname, set] of scopes) {
    if (!set || !set.has(v)) undef.push(`${v} missing in ${sname}`);
  }
}
ok(undef.length === 0, `all ${used.size} used tokens defined in :root + all ${themeKeys.length} theme scopes${undef.length ? '\n   ' + undef.join('\n   ') : ''}`);

/* ---- 5. beta scope identical to :root (theme 1 = today's look) ---- */
function parseVals(css, scopeRe) {
  const vals = new Map();
  const re = new RegExp(scopeRe.source, 'g');
  let m;
  while ((m = re.exec(css))) {
    for (const d of m[2].matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) {
      vals.set(d[1], d[2].replace(/\s+/g, ' ').trim());
    }
  }
  return vals;
}
const rootVals = parseVals(strip(files['style.css']), /(:root)\s*\{([^{}]*)\}/);
const betaVals = parseVals(strip(files['themes.css']), /(html\[data-theme="beta"])\s*\{([^{}]*)\}/);
let drift = [];
for (const [k, v] of rootVals) {
  if (!betaVals.has(k)) drift.push(`${k}: absent in beta`);
  else if (betaVals.get(k) !== v) drift.push(`${k}: root="${v}" beta="${betaVals.get(k)}"`);
}
for (const k of betaVals.keys()) if (!rootVals.has(k)) drift.push(`${k}: only in beta`);
ok(drift.length === 0, `beta scope == :root token-for-token (${rootVals.size} tokens)${drift.length ? '\n   ' + drift.join('\n   ') : ''}`);

/* ---- 6. six grp triplet tokens: bare "R, G, B" in every scope ---- */
const grpTriplets = ['bank', 'new', 'learning', 'familiar', 'confident', 'mastered'];
const themeValsByName = new Map();
{
  const re = /html\[data-theme="([a-z]+)"\]\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(strip(files['themes.css'])))) {
    const vals = new Map();
    for (const d of m[2].matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) vals.set(d[1], d[2].replace(/\s+/g, ' ').trim());
    themeValsByName.set(m[1], vals);
  }
}
const tripletScopes = [[':root', rootVals], ...['beta', 'midnight', 'light', 'sandstone'].map(t => [`html[data-theme="${t}"]`, themeValsByName.get(t) || new Map()])];
let tripBad = [];
for (const [sname, vals] of tripletScopes) {
  for (const g of grpTriplets) {
    const v = vals.get(`--grp-${g}-rgb`);
    if (!v || !/^\d{1,3}, \d{1,3}, \d{1,3}$/.test(v)) tripBad.push(`${sname} --grp-${g}-rgb = ${v}`);
  }
}
ok(tripBad.length === 0, `6 --grp-*-rgb triplets well-formed in all 4 scopes${tripBad.length ? ' → ' + tripBad.join(', ') : ''}`);

/* ---- 7. no remaining hardcoded colour literals outside :root/themes + documented keeps ---- */
const KEEPS = [
  'background: rgba(0, 0, 0, 0.24)',   // .btn-answer:hover kbd chip on saturated accent
  'background: rgba(0, 0, 0, 0.7)',    // .modal-overlay scrim
  'border: 2px solid #ffffff',         // range slider thumb ring
];
const afterRoot = strip(files['style.css']).replace(/:root\s*\{[^{}]*\}/, '');
const lits = [...afterRoot.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*[\d.]/g)];
// Проверяем ПОДМНОЖЕСТВО, а не точное совпадение количества: если очередной хардкод
// переведут в токен, станет только лучше, и чекер не должен из-за этого краснеть.
// (Раньше здесь было lits.length === KEEPS.length — проверка ломалась при улучшении.)
const unkept = lits.filter(m => !KEEPS.some(k =>
  afterRoot.slice(Math.max(0, m.index - 40), m.index + 60).includes(k.slice(0, 20))));
ok(unkept.length === 0 && lits.length <= KEEPS.length,
  `style.css body literals: ${lits.length} найдено, незадокументированных ${unkept.length}` +
  (lits.length < KEEPS.length ? ` (${KEEPS.length - lits.length} из ${KEEPS.length} уже переведены в токены)` : ''));
if (unkept.length) {
  for (const m of unkept) console.log('   ↳ НЕЗАДОКУМЕНТИРОВАН:', JSON.stringify(afterRoot.slice(Math.max(0, m.index - 60), m.index + 40).replace(/\s+/g, ' ')));
}

console.log(`\n=== ${failures === 0 ? 'ALL CSS CHECKS PASS' : failures + ' CSS FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
