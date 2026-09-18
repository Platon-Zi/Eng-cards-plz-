// OKLCH → sRGB hex + WCAG audit for the redesigned palettes.
// Formulae: Björn Ottosson's OKLab ↔ linear sRGB (D65).
import { readFileSync, writeFileSync } from 'node:fs';

function oklchToHex(L, C, Hdeg) {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  let bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const gam = (x) => {
    x = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(Math.abs(x), 1 / 2.4) - 0.055;
    return x;
  };
  let rr = gam(r), gg = gam(g), bbb = gam(bb);
  const clipped = rr < 0 || rr > 1 || gg < 0 || gg > 1 || bbb < 0 || bbb > 1;
  const to255 = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
  const hex = '#' + [to255(rr), to255(gg), to255(bbb)]
    .map((v) => v.toString(16).padStart(2, '0')).join('');
  return { hex, clipped };
}
function lum(hex) {
  hex = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function cr(a, b) {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
function over(fgHex, alpha, bgHex) {
  const p = (h) => { h = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const [r1, g1, b1] = p(fgHex), [r2, g2, b2] = p(bgHex);
  const m = (a, b) => Math.round(a * alpha + b * (1 - alpha));
  return '#' + [m(r1, r2), m(g1, g2), m(b1, b2)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function rgbTriplet(hex) {
  hex = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
}

// ---- palette specs in OKLCH -------------------------------------------------
// token: [L, C, H]
const P = {
  midnight: { // v3 "Arctic": glacial cyan family on polar-blue ground
    bgDark:      [0.175, 0.025, 230], bgSidebar:  [0.140, 0.025, 230],
    bgCard:      [0.225, 0.024, 228], bgCardHover:[0.285, 0.022, 226],
    bgCardDeep:  [0.205, 0.026, 228], bgCode:     [0.155, 0.022, 228],
    borderActive:[0.820, 0.090, 210],
    textMain:    [0.930, 0.012, 215], textBright: [0.960, 0.008, 215],
    textSoft:    [0.855, 0.015, 215], textSoft2:  [0.890, 0.012, 215],
    textBody:    [0.790, 0.018, 215], textMuted:  [0.685, 0.020, 215],
    textDark:    [0.625, 0.022, 215],
    textOnAccent:[0.170, 0.040, 230], textOnAmber:[0.230, 0.045, 80],
    primary:     [0.780, 0.090, 205], primaryHover:[0.720, 0.100, 205],
    green:       [0.780, 0.110, 178], greenHover: [0.720, 0.120, 178],
    red:         [0.700, 0.130, 15],  redHover:   [0.650, 0.140, 15],
    amber:       [0.820, 0.100, 85],  purple:     [0.740, 0.100, 285],
    blue:        [0.720, 0.110, 235],
    primarySoft: [0.800, 0.075, 205], primaryBright:[0.740, 0.100, 205],
    primaryPale: [0.850, 0.055, 205], primaryFrost: [0.910, 0.035, 208],
    blueSoft:    [0.760, 0.090, 235], greenSoft:  [0.810, 0.085, 178],
    greenPale:   [0.860, 0.065, 178], redSoft:    [0.740, 0.110, 15],
    redPale:     [0.810, 0.075, 15],  amberPale:  [0.860, 0.070, 85],
    amberText:   [0.850, 0.065, 85],  amberDeep:  [0.790, 0.095, 85],
    purpleSoft:  [0.770, 0.085, 285], purplePale: [0.830, 0.060, 285],
    purpleBright:[0.740, 0.100, 285], pinkSoft:   [0.750, 0.100, 340],
    graySoft:    [0.790, 0.014, 220],
    grpBank:     [0.680, 0.018, 215], grpNew:     [0.700, 0.130, 15],
    grpLearning: [0.750, 0.110, 60],  grpFamiliar:[0.760, 0.085, 205],
    grpConfident:[0.750, 0.090, 285], grpMastered:[0.750, 0.100, 175],
  },
  light: { // v3 "Frost": deep teal x tangerine complementary on frost porcelain
    bgDark:      [0.955, 0.012, 210], bgSidebar:  [0.935, 0.016, 212],
    bgCard:      [0.988, 0.006, 205], bgCardHover:[0.915, 0.018, 212],
    bgCardDeep:  [0.900, 0.020, 213], bgCode:     [0.945, 0.012, 210],
    borderActive:[0.480, 0.095, 222],
    textMain:    [0.320, 0.045, 225], textBright: [0.250, 0.050, 225],
    textSoft:    [0.400, 0.040, 224], textSoft2:  [0.360, 0.042, 224],
    textBody:    [0.450, 0.038, 223], textMuted:  [0.515, 0.030, 222],
    textDark:    [0.520, 0.028, 222],
    textOnAccent:[0.980, 0.008, 205], textOnAmber:[0.970, 0.010, 70],
    primary:     [0.455, 0.095, 222], primaryHover:[0.415, 0.090, 222],
    green:       [0.450, 0.115, 165], greenHover: [0.410, 0.110, 165],
    red:         [0.510, 0.185, 12],  redHover:   [0.460, 0.170, 12],
    amber:       [0.495, 0.140, 48],  purple:     [0.500, 0.210, 288],
    blue:        [0.530, 0.110, 240],
    primarySoft: [0.455, 0.095, 222], primaryBright:[0.455, 0.095, 222],
    primaryPale: [0.415, 0.090, 222], primaryFrost: [0.380, 0.085, 222],
    blueSoft:    [0.500, 0.110, 240], greenSoft:  [0.435, 0.110, 165],
    greenPale:   [0.440, 0.105, 165], redSoft:    [0.510, 0.185, 12],
    redPale:     [0.460, 0.170, 8],   amberPale:  [0.455, 0.135, 48],
    amberText:   [0.480, 0.130, 50],  amberDeep:  [0.480, 0.130, 50],
    purpleSoft:  [0.470, 0.190, 288], purplePale: [0.470, 0.190, 288],
    purpleBright:[0.470, 0.190, 288], pinkSoft:   [0.500, 0.170, 3],
    graySoft:    [0.450, 0.020, 220],
    grpBank:     [0.470, 0.020, 215], grpNew:     [0.510, 0.185, 12],
    grpLearning: [0.495, 0.140, 48],  grpFamiliar:[0.455, 0.095, 222],
    grpConfident:[0.500, 0.200, 288], grpMastered:[0.465, 0.110, 165],
  },
  sandstone: { // new warm theme
    bgDark:      [0.955, 0.017, 88], bgSidebar:  [0.930, 0.021, 89],
    bgCard:      [0.987, 0.008, 93], bgCardHover:[0.915, 0.020, 90],
    bgCardDeep:  [0.900, 0.023, 89], bgCode:     [0.940, 0.018, 89],
    borderActive:[0.455, 0.140, 46],
    textMain:    [0.320, 0.033, 62], textBright: [0.260, 0.035, 58],
    textSoft:    [0.400, 0.030, 64], textSoft2:  [0.360, 0.032, 63],
    textBody:    [0.450, 0.028, 66], textMuted:  [0.525, 0.024, 70],
    textDark:    [0.530, 0.024, 72],
    textOnAccent:[0.980, 0.010, 85], textOnAmber:[0.960, 0.020, 85],
    primary:     [0.455, 0.140, 46], primaryHover:[0.415, 0.130, 46],
    green:       [0.470, 0.105, 150], greenHover:[0.420, 0.105, 150],
    red:         [0.500, 0.165, 30],  redHover:   [0.450, 0.150, 30],
    amber:       [0.470, 0.115, 60],  purple:     [0.500, 0.150, 355],
    blue:        [0.500, 0.095, 205],
    primarySoft: [0.455, 0.140, 46], primaryBright:[0.455, 0.140, 46],
    primaryPale: [0.480, 0.150, 46], primaryFrost: [0.440, 0.140, 46],
    blueSoft:    [0.460, 0.095, 205], greenSoft:  [0.440, 0.100, 150],
    greenPale:   [0.410, 0.095, 150], redSoft:    [0.500, 0.165, 30],
    redPale:     [0.450, 0.150, 25],  amberPale:  [0.470, 0.115, 60],
    amberText:   [0.440, 0.110, 65],  amberDeep:  [0.440, 0.110, 65],
    purpleSoft:  [0.460, 0.140, 355], purplePale: [0.460, 0.140, 355],
    purpleBright:[0.460, 0.140, 355], pinkSoft:   [0.490, 0.155, 5],
    graySoft:    [0.460, 0.018, 70],
    grpBank:     [0.500, 0.018, 75], grpNew:     [0.500, 0.165, 30],
    grpLearning: [0.500, 0.130, 50], grpFamiliar:[0.500, 0.140, 258],
    grpConfident:[0.480, 0.150, 355], grpMastered:[0.470, 0.105, 150],
  },
};

// ---- convert ----------------------------------------------------------------
const out = {};
const warnings = [];
for (const [tn, spec] of Object.entries(P)) {
  out[tn] = {};
  for (const [k, v] of Object.entries(spec)) {
    const { hex, clipped } = oklchToHex(...v);
    if (clipped) warnings.push(`${tn}.${k} [${v}] gamut-clipped → ${hex}`);
    out[tn][k] = hex;
  }
}

// ---- WCAG audit (ported from .scratch/ui/contrast.js) -----------------------
const fails = [];
let CUR = '';
function need(name, ratio, min, note) {
  name = CUR + ' ' + name;
  const ok = ratio >= min;
  const line = `${ok ? 'ok   ' : 'FAIL '} ${name.padEnd(58)} ${ratio.toFixed(2)} (min ${min})${note ? '  ' + note : ''}`;
  if (!ok) fails.push(line);
  return line;
}
const lines = [];
for (const [tn, t] of Object.entries(out)) {
  lines.push(`\n===== ${tn} =====`); CUR = tn;
  out.push;
  lines.push(need('textMain/bgCard', cr(t.textMain, t.bgCard), 4.5));
  lines.push(need('textMain/bgDark', cr(t.textMain, t.bgDark), 4.5));
  lines.push(need('textMuted/bgCard', cr(t.textMuted, t.bgCard), 4.5));
  lines.push(need('textMuted/bgDark', cr(t.textMuted, t.bgDark), 4.5));
  lines.push(need('textDark/bgCard', cr(t.textDark, t.bgCard), 4.5));
  lines.push(need('textSoft/bgCard', cr(t.textSoft, t.bgCard), 4.5));
  lines.push(need('textBody/bgCard', cr(t.textBody, t.bgCard), 4.5));
  lines.push(need('textSoft2/bgCard', cr(t.textSoft2, t.bgCard), 4.5));
  lines.push(need('textBright/bgCard', cr(t.textBright, t.bgCard), 4.5));
  lines.push(need('textBright/bgDark', cr(t.textBright, t.bgDark), 4.5));
  lines.push(need('onAccent/primary', cr(t.textOnAccent, t.primary), 4.5));
  lines.push(need('onAccent/primaryHover', cr(t.textOnAccent, t.primaryHover), 4.5));
  lines.push(need('onAccent/green', cr(t.textOnAccent, t.green), 4.5));
  lines.push(need('onAccent/greenHover', cr(t.textOnAccent, t.greenHover), 4.5));
  lines.push(need('onAccent/red', cr(t.textOnAccent, t.red), 4.5));
  lines.push(need('onAccent/redHover', cr(t.textOnAccent, t.redHover), 4.5));
  lines.push(need('onAmber/amber', cr(t.textOnAmber, t.amber), 4.5));
  for (const k of ['primary', 'green', 'red', 'amber', 'purple', 'blue'])
    lines.push(need(`accent ${k}/bgCard`, cr(t[k], t.bgCard), 4.5));
  lines.push(need('accent amber/bgSidebar(streak)', cr(t.amber, t.bgSidebar), 4.5));
  for (const k of ['primarySoft', 'primaryBright', 'primaryPale', 'primaryFrost', 'blueSoft', 'greenSoft', 'greenPale', 'redSoft', 'redPale', 'amberPale', 'amberText', 'amberDeep', 'purpleSoft', 'purplePale', 'purpleBright', 'pinkSoft', 'graySoft'])
    lines.push(need(`soft ${k}/bgCard`, cr(t[k], t.bgCard), 4.5));
  const tintPairs = [['redPale', 'red', 0.22], ['amberPale', 'amber', 0.22], ['greenPale', 'green', 0.22],
    ['blueSoft', 'blue', 0.15], ['greenPale', 'green', 0.2], ['amberPale', 'amber', 0.18], ['purplePale', 'purpleBright', 0.2],
    ['pinkSoft', 'pink', 0.15], ['graySoft', 'gray', 0.15], ['redPale', 'red', 0.2], ['redSoft', 'red', 0.1],
    ['greenSoft', 'green', 0.18], ['greenSoft', 'green', 0.12], ['amberDeep', 'amber', 0.15], ['primarySoft', 'primary', 0.25],
    ['primarySoft', 'primary', 0.2], ['primarySoft', 'primary', 0.12], ['primary', 'primary', 0.25], ['primaryBright', 'primary', 0.15],
    ['primaryBright', 'primary', 0.12], ['amberText', 'amber', 0.15], ['amberText', 'amber', 0.1], ['primaryFrost', 'primary', 0.12],
    ['textBright', 'primary', 0.2], ['textBright', 'primary', 0.18], ['textSoft', 'red', 0.35], ['red', 'red', 0.18], ['green', 'green', 0.18],
    ['purpleSoft', 'purple', 0.12], ['purpleSoft', 'purple', 0.2], ['textMain', 'primary', 0.25]];
  for (const [fg, bg, a] of tintPairs) {
    const baseHex = bg === 'pink' ? t.pinkSoft : bg === 'gray' ? t.graySoft : t[bg];
    const tint = over(baseHex, a, t.bgCard);
    lines.push(need(`soft ${fg} over ${a} tint of ${bg}`, cr(t[fg], tint), 4.5));
  }
  const grps = [['grpBank', 'bank'], ['grpNew', 'new'], ['grpLearning', 'learning'], ['grpFamiliar', 'familiar'], ['grpConfident', 'confident'], ['grpMastered', 'mastered']];
  for (const [k, n] of grps) {
    const tint = over(t[k], 0.16, t.bgCard);
    lines.push(need(`grp ${n} pill text on own tint`, cr(t[k], tint), 4.5));
    lines.push(need(`grp ${n} bar fill vs bgCard (UI 3:1)`, cr(t[k], t.bgCard), 3.0));
  }
  const overlayHex = tn === 'midnight' ? '#ffffff' : '#3e2a1e';
  lines.push(need('kbd textSoft over overlay .15 on card', cr(t.textSoft, over(overlayHex, 0.15, t.bgCard)), 4.5));
  lines.push(need('primarySoft/bgCode', cr(t.primarySoft, t.bgCode), 4.5));
  lines.push(need('textSoft/bgCode', cr(t.textSoft, t.bgCode), 4.5));
}
console.log(lines.join('\n'));
console.log('\n================ FAILURES ================');
console.log(fails.length ? fails.join('\n') : 'none ✅');
if (warnings.length) { console.log('\n== GAMUT =='); console.log(warnings.join('\n')); }

// ---- emit CSS token blocks --------------------------------------------------
const TOKEN_MAP = [
  ['bg-dark', 'bgDark'], ['bg-card', 'bgCard'], ['bg-card-hover', 'bgCardHover'],
  ['bg-sidebar', 'bgSidebar'], ['bg-card-deep', 'bgCardDeep'], ['bg-code', 'bgCode'],
  ['border-active', 'borderActive'],
  ['text-main', 'textMain'], ['text-muted', 'textMuted'], ['text-dark', 'textDark'],
  ['text-soft', 'textSoft'], ['text-soft-2', 'textSoft2'], ['text-body', 'textBody'],
  ['text-bright', 'textBright'], ['text-on-accent', 'textOnAccent'], ['text-on-amber', 'textOnAmber'],
  ['accent-primary', 'primary'], ['accent-primary-hover', 'primaryHover'],
  ['accent-green', 'green'], ['accent-green-hover', 'greenHover'],
  ['accent-red', 'red'], ['accent-red-hover', 'redHover'],
  ['accent-amber', 'amber'], ['accent-purple', 'purple'], ['accent-blue', 'blue'],
  ['accent-primary-soft', 'primarySoft'], ['accent-primary-bright', 'primaryBright'],
  ['accent-primary-pale', 'primaryPale'], ['accent-primary-frost', 'primaryFrost'],
  ['accent-blue-soft', 'blueSoft'], ['accent-green-soft', 'greenSoft'], ['accent-green-pale', 'greenPale'],
  ['accent-red-soft', 'redSoft'], ['accent-red-pale', 'redPale'],
  ['accent-amber-pale', 'amberPale'], ['accent-amber-text', 'amberText'], ['accent-amber-deep', 'amberDeep'],
  ['accent-purple-soft', 'purpleSoft'], ['accent-purple-pale', 'purplePale'], ['accent-purple-bright', 'purpleBright'],
  ['accent-pink-soft', 'pinkSoft'], ['accent-gray-soft', 'graySoft'],
  ['grp-bank', 'grpBank'], ['grp-new', 'grpNew'], ['grp-learning', 'grpLearning'],
  ['grp-familiar', 'grpFamiliar'], ['grp-confident', 'grpConfident'], ['grp-mastered', 'grpMastered'],
];
const TRIP = ['accent-primary:primary', 'accent-green:green', 'accent-red:red', 'accent-amber:amber',
  'accent-purple:purple', 'accent-blue:blue', 'accent-primary-bright:primaryBright',
  'accent-purple-bright:purpleBright', 'accent-pink:pinkSoft', 'accent-gray:graySoft',
  'bg-dark:bgDark', 'bg-card:bgCard', 'text-dark:textDark', 'text-body:textBody',
  'grp-bank:grpBank', 'grp-new:grpNew', 'grp-learning:grpLearning', 'grp-familiar:grpFamiliar',
  'grp-confident:grpConfident', 'grp-mastered:grpMastered'];
let css = '';
for (const tn of Object.keys(out)) {
  const t = out[tn];
  css += `\n/* ==== ${tn} ==== */\n`;
  for (const [tok, key] of TOKEN_MAP) css += `  --${tok}: ${t[key]};\n`;
  for (const pair of TRIP) {
    const [tok, key] = pair.split(':');
    css += `  --${tok}-rgb: ${rgbTriplet(t[key])};\n`;
  }
}
writeFileSync(new URL('./theme_lab_out.css', import.meta.url), css);
console.log('\nCSS emitted to theme_lab_out.css');
