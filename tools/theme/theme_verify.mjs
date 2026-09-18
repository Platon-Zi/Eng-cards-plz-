// End-to-end verification of the FINAL themes.css (not the lab source).
import { readFileSync } from 'node:fs';

const rawCss = readFileSync(new URL('../../themes.css', import.meta.url), 'utf8');
const rawStyle = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, ' ');
const style = rawStyle.replace(/\/\*[\s\S]*?\*\//g, ' ');
const themejs = readFileSync(new URL('../../theme.js', import.meta.url), 'utf8');

const problems = [];

function parseScope(text, selRe) {
  const m = text.match(selRe);
  if (!m) return null;
  const start = text.indexOf('{', m.index);
  let depth = 0, i = start;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (!depth) break; }
  }
  const body = text.slice(start + 1, i);
  const toks = {};
  for (const line of body.split('\n')) {
    const t = line.trim().replace(/;$/, '');
    const mm = t.match(/^--([\w-]+):\s*(.+)$/);
    if (mm && !t.startsWith('/*')) toks[mm[1]] = mm[2];
  }
  return toks;
}

const scopes = {};
for (const id of ['beta', 'midnight', 'light', 'sandstone']) {
  const toks = parseScope(css, new RegExp(`html\\[data-theme="${id}"\\]`));
  if (!toks) { problems.push(`missing scope ${id}`); continue; }
  scopes[id] = toks;
}

// 1. identical token sets across scopes
const base = Object.keys(scopes.beta).sort().join(',');
for (const id of Object.keys(scopes)) {
  if (Object.keys(scopes[id]).sort().join(',') !== base) {
    const miss = Object.keys(scopes.beta).filter(k => !(k in scopes[id]));
    const extra = Object.keys(scopes[id]).filter(k => !(k in scopes.beta));
    problems.push(`${id} token set differs: missing ${miss} extra ${extra}`);
  }
}

// 2. beta scope must equal :root in style.css (contract from themes.css header)
const root = parseScope(style, /:root/) || {};
for (const [k, v] of Object.entries(scopes.beta)) {
  if (root[k] && root[k].trim().replace(/\s+/g, '') !== v.trim().replace(/\s+/g, ''))
    problems.push(`beta --${k} (${v}) != style.css :root (${root[k]})`);
}

// 3. triplets must match their hex tokens
function hexRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ');
}
const tripMap = {
  'accent-primary-rgb': 'accent-primary', 'accent-green-rgb': 'accent-green',
  'accent-red-rgb': 'accent-red', 'accent-amber-rgb': 'accent-amber',
  'accent-purple-rgb': 'accent-purple', 'accent-blue-rgb': 'accent-blue',
  'accent-primary-bright-rgb': 'accent-primary-bright', 'accent-purple-bright-rgb': 'accent-purple-bright',
  'bg-dark-rgb': 'bg-dark', 'bg-card-rgb': 'bg-card', 'text-dark-rgb': 'text-dark',
  'text-body-rgb': 'text-body', 'grp-bank-rgb': 'grp-bank', 'grp-new-rgb': 'grp-new',
  'grp-learning-rgb': 'grp-learning', 'grp-familiar-rgb': 'grp-familiar',
  'grp-confident-rgb': 'grp-confident', 'grp-mastered-rgb': 'grp-mastered',
};
for (const [id, toks] of Object.entries(scopes))
  for (const [tr, hx] of Object.entries(tripMap))
    if (toks[tr] && toks[hx] && toks[tr].split(',').map(v => v.trim()).join(', ') !== hexRgb(toks[hx]))
      problems.push(`${id}: --${tr} (${toks[tr]}) does not match --${hx} (${toks[hx]})`);

// 4. WCAG audit on final hexes (same battery as the lab)
function lum(hex) {
  hex = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function cr(a, b) { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
function over(fg, a, bg) {
  const p = h => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const [r1, g1, b1] = p(fg), [r2, g2, b2] = p(bg);
  const m = (x, y) => Math.round(x * a + y * (1 - a));
  return '#' + [m(r1, r2), m(g1, g2), m(b1, b2)].map(v => v.toString(16).padStart(2, '0')).join('');
}
let checks = 0, wcagFails = 0;
function ck(label, ratio, min) { checks++; if (ratio < min) { wcagFails++; problems.push(`WCAG ${label}: ${ratio.toFixed(2)} < ${min}`); } }
for (const id of ['midnight', 'light', 'sandstone']) {
  const s = k => scopes[id][k];
  for (const bg of ['bg-card', 'bg-dark', 'bg-sidebar', 'bg-card-hover', 'bg-card-deep'])
    for (const fg of ['text-main', 'text-soft', 'text-soft-2', 'text-body', 'text-bright'])
      ck(`${id} ${fg}/${bg}`, cr(s(fg), s(bg)), 4.5);
  for (const bg of ['bg-card', 'bg-dark']) {
    ck(`${id} text-muted/${bg}`, cr(s('text-muted'), s(bg)), 4.5);
    ck(`${id} text-dark/${bg}`, cr(s('text-dark'), s(bg)), 4.5);
  }
  for (const a of ['accent-primary', 'accent-primary-hover', 'accent-green', 'accent-green-hover', 'accent-red', 'accent-red-hover'])
    ck(`${id} onAccent/${a}`, cr(s('text-on-accent'), s(a)), 4.5);
  ck(`${id} onAmber/amber`, cr(s('text-on-amber'), s('accent-amber')), 4.5);
  for (const a of ['accent-primary', 'accent-green', 'accent-red', 'accent-amber', 'accent-purple', 'accent-blue']) {
    ck(`${id} accentAsText ${a}/bg-card`, cr(s(a), s('bg-card')), 4.5);
    ck(`${id} accentAsText ${a}/bg-dark`, cr(s(a), s('bg-dark')), 4.5);
  }
  for (const sh of ['accent-primary-soft', 'accent-primary-bright', 'accent-primary-pale', 'accent-primary-frost', 'accent-blue-soft', 'accent-green-soft', 'accent-green-pale', 'accent-red-soft', 'accent-red-pale', 'accent-amber-pale', 'accent-amber-text', 'accent-amber-deep', 'accent-purple-soft', 'accent-purple-pale', 'accent-purple-bright', 'accent-pink-soft', 'accent-gray-soft']) {
    ck(`${id} soft ${sh}/bg-card`, cr(s(sh), s('bg-card')), 4.5);
    ck(`${id} soft ${sh}/bg-dark`, cr(s(sh), s('bg-dark')), 4.5);
    ck(`${id} soft ${sh}/bg-code`, cr(s(sh), s('bg-code')), 4.5);
  }
  for (const [fg, bg, a] of [['accent-red-pale', 'accent-red', .22], ['accent-amber-pale', 'accent-amber', .22], ['accent-green-pale', 'accent-green', .22], ['accent-purple-pale', 'accent-purple-bright', .2], ['accent-primary-soft', 'accent-primary', .25], ['accent-primary', 'accent-primary', .25], ['accent-amber-text', 'accent-amber', .15], ['accent-primary-frost', 'accent-primary', .12], ['accent-red-soft', 'accent-red', .1], ['accent-green-soft', 'accent-green', .12], ['text-soft', 'accent-red', .35]])
    ck(`${id} ${fg} on ${a} tint ${bg}`, cr(s(fg), over(s(bg), a, s('bg-card'))), 4.5);
  for (const g of ['bank', 'new', 'learning', 'familiar', 'confident', 'mastered']) {
    ck(`${id} grp-${g} pill on own tint`, cr(s('grp-' + g), over(s('grp-' + g), .16, s('bg-card'))), 4.5);
    ck(`${id} grp-${g} bar vs bg-card`, cr(s('grp-' + g), s('bg-card')), 3.0);
  }
  ck(`${id} textSoft over overlay .15`, cr(s('text-soft'), over(s('overlay-rgb') === '255, 255, 255' ? '#ffffff' : '#' + s('overlay-rgb').split(',').map(v => (+v).toString(16).padStart(2, '0')).join(''), .15, s('bg-card'))), 4.5);
}

// 5. no pure #000/#fff in the three new scopes' hex tokens
for (const id of ['midnight', 'light', 'sandstone'])
  for (const [k, v] of Object.entries(scopes[id]))
    if (/^#000000$/i.test(v.trim())) problems.push(`${id}: --${k} is pure black`);

// 6. theme.js swatches must equal real tokens of their palettes
const swatchMap = {
  midnight: ['#051219', '#6bc8d3', '#5cceb7', '#e2bf76'],
  light: ['#e8f2f5', '#00617c', '#006845', '#9e4200'],
  sandstone: ['#f5f0e4', '#923500', '#256b3a', '#00727d'],
};
for (const [id, sws] of Object.entries(swatchMap)) {
  const pair = [scopes[id]['bg-dark'], scopes[id]['accent-primary'], scopes[id]['accent-green'], scopes[id]['accent-amber']];
  if (id === 'sandstone') pair[3] = scopes[id]['accent-blue'];
  const jsBlock = themejs.match(new RegExp(`id: '${id}'[\\s\\S]*?swatches: \\[([^\\]]+)\\]`));
  if (!jsBlock) { problems.push(`theme.js: no swatches for ${id}`); continue; }
  const jsSw = jsBlock[1].match(/#[0-9a-f]{6}/gi).map(h => h.toLowerCase());
  for (let i = 0; i < 4; i++)
    if (jsSw[i] !== pair[i].toLowerCase())
      problems.push(`theme.js ${id} swatch[${i}] ${jsSw[i]} != token ${pair[i]}`);
}

// 7. ids known everywhere
for (const [file, text] of [['index.html', readFileSync(new URL('../../index.html', import.meta.url), 'utf8')]])
  for (const id of ['beta', 'midnight', 'light', 'sandstone'])
    if (!text.includes(`'${id}'`)) problems.push(`${file}: id '${id}' not present`);

console.log(`WCAG battery: ${checks} checks, ${wcagFails} failures`);
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'ALL GREEN ✅');
process.exit(problems.length ? 1 : 0);
