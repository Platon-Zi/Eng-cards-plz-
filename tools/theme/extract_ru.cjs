// Extract every string literal containing Cyrillic from app.js with:
// line number, exact literal, enclosing function, usage category, screen hint.
// Usage: node .scratch/ui/extract_ru.cjs [path-to-app.js] > ru_strings.json
const fs = require('fs');
const FILE = process.argv[2] || '/home/zinko/ENG CARDS/app.js';
const src = fs.readFileSync(FILE, 'utf8');

const CYR = /[\u0400-\u04FF]/;
const literals = []; // {value, quote, startLine, startCol, index}

// ---- tiny JS string tokenizer (handles ' " ` and ${} nesting) ----
let i = 0, line = 1;
const lineStarts = [0];
for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
function lineOf(idx) { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo + 1; }

function scan(start, stopAtBacktick) {
  let j = start;
  while (j < src.length) {
    const c = src[j];
    if (c === '\n' && stopAtBacktick === 'line') { j++; continue; }
    if (c === '/' && src[j + 1] === '/' && stopAtBacktick !== '`') { while (j < src.length && src[j] !== '\n') j++; continue; }
    if (c === '/' && src[j + 1] === '*' && stopAtBacktick !== '`') { const e = src.indexOf('*/', j + 2); j = e < 0 ? src.length : e + 2; continue; }
    if (c === '/' && stopAtBacktick !== '`') {
      // regex literal? look at the previous significant char
      let k = j - 1;
      while (k >= 0 && /[\s]/.test(src[k])) k--;
      const prev = k >= 0 ? src[k] : '\n';
      const prevWord = (k >= 5 ? src.slice(k - 5, k + 1) : src.slice(0, k + 1));
      if (/[({,=:[!&|?+\-*%~^<>;]/.test(prev) || /return$|typeof$|case$|in$|of$|new$|delete$|void$|instanceof$/.test(prevWord)) {
        let inClass = false; j++;
        while (j < src.length) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) { j++; break; }
          else if (src[j] === '\n') break; // not a regex after all
          j++;
        }
        while (j < src.length && /[a-z]/.test(src[j])) j++; // flags
        continue;
      }
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; const begin = j; j++;
      let value = '';
      while (j < src.length) {
        if (src[j] === '\\') { value += src[j] + (src[j + 1] || ''); j += 2; continue; }
        if (src[j] === q) { j++; break; }
        if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
          // skip the expression, tracking nested braces/strings
          let depth = 1; j += 2;
          while (j < src.length && depth > 0) {
            const d = src[j];
            if (d === '{') depth++;
            else if (d === '}') depth--;
            else if (d === "'" || d === '"' || d === '`') {
              const q2 = d; j++;
              while (j < src.length) {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === q2) { j++; break; }
                j++;
              }
              continue;
            }
            if (depth > 0) j++;
          }
          if (j < src.length && src[j] === '}') j++; // consume the closing brace
          value += '${…}';
          continue;
        }
        value += src[j]; j++;
      }
      if (q !== '`' || CYR.test(value)) {
        if (CYR.test(value)) literals.push({ quote: q, value, raw: src.slice(begin, j), startLine: lineOf(begin), index: begin });
      }
      continue;
    }
    j++;
  }
}
scan(0);

// ---- enclosing function + usage context ----
const DECL_PATS = [
  /function\s+([A-Za-z0-9_$]+)\s*\(/g,
  /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?function\b/g,
  /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
  /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?[A-Za-z0-9_$]+\s*=>/g,
  /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*[\[{]/g,
];
const decls = [];
DECL_PATS.forEach((re, pi) => {
  let m;
  while ((m = re.exec(src))) {
    // container consts (pattern index 4) only count at module scope (column 0)
    if (pi === 4) {
      const ls = src.lastIndexOf('\n', m.index);
      if (m.index - (ls + 1) !== 0) continue;
    }
    decls.push({ index: m.index, name: m[1] });
  }
});
decls.sort((a, b) => a.index - b.index);
function enclosingFunction(idx) {
  let best = null;
  for (const d of decls) { if (d.index < idx) best = d; else break; }
  return best ? best.name : '(top-level)';
}

function contextOf(lit) {
  // look at the ~160 chars before the literal on the same statement
  const before = src.slice(Math.max(0, lit.index - 200), lit.index);
  const after = src.slice(lit.index, lit.index + 40);
  const stmt = before.split(/[;\n]/).pop() + after;
  if (/showToast\s*\(\s*[^;]*$/.test(before + '`')) return 'toast';
  if (/(confirm|alert)\s*\(\s*[^;]*$/.test(before + '`')) return 'dialog';
  if (/window\.prompt\s*\(\s*[^;]*$|\bprompt\s*\(\s*['"`][^'"`]*['"`]\s*,\s*$/.test(before + '`')) return 'dialog';
  if (/\.includes\s*\(\s*$/.test(before)) return 'keyword-match';
  if (/key\s*===\s*$|===\s*'(?:.)'$/.test(before) && lit.value.length <= 1) return 'hotkey-alias';
  if (/textContent\s*=\s*[^;]*$/.test(before + '`')) return 'textContent';
  if (/innerHTML\s*(\+=)?=\s*[^;]*$/.test(before + '`')) return 'innerHTML';
  if (/insertAdjacentHTML\s*\([^;]*$/.test(before + '`')) return 'innerHTML';
  if (/title\s*[:=]\s*[^;]*$/.test(before + '`')) return 'attr-title';
  if (/placeholder\s*[:=]\s*[^;]*$/.test(before + '`')) return 'attr-placeholder';
  if (/aria-label\s*[:=]\s*[^;]*$/.test(before + '`')) return 'attr-aria';
  if (/label\s*:\s*[^;]*$/.test(before + '`')) return 'label-field';
  if (/batch_name|batchName|bName\s*=/.test(stmt)) return 'data-name';
  if (/writeText/.test(before.slice(-120))) return 'clipboard';
  return 'other';
}

const rows = literals.map(lit => ({
  line: lit.startLine,
  quote: lit.quote,
  value: lit.value,
  raw: lit.raw,
  fn: enclosingFunction(lit.index),
  ctx: contextOf(lit),
}));

console.log(JSON.stringify(rows, null, 1));
console.error(`total Cyrillic literals: ${rows.length}`);
