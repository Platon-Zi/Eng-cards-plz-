const path = require('path');
// Generator for docs/UI-EN-STRINGS.md — merges a fresh app.js extraction with
// a curated translation table, keyed on the EXACT literal (survives line churn).
// Usage: node .scratch/ui/gen_doc.cjs > docs/UI-EN-STRINGS.md
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');

const rows = JSON.parse(execSync(`node "${ROOT}/.scratch/ui/extract_ru.cjs" "${ROOT}/app.js" 2>/dev/null`, { maxBuffer: 64e6 }).toString());
const st = fs.statSync(ROOT + '/app.js');
const sha = crypto.createHash('sha256').update(fs.readFileSync(ROOT + '/app.js')).digest('hex');

/* disposition: EN = translate to English · KEEP-RU = intentionally Russian ·
   CODE = functional literal, do not translate · OPT = console diagnostic (optional) */
const T = {
  // ---- Data layer: save/load/migration TOASTS (user-visible, category c) ----
  'Сохранение заблокировано (защита базы): ': { d: 'EN', s: 'Global · data layer', en: "'Save blocked (data protection): '" },
  'Не удалось сохранить базу: все хранилища отказали': { d: 'EN', s: 'Global · data layer', en: "'Failed to save the database: every storage layer failed'" },
  'Миграция базы не выполнена: ': { d: 'EN', s: 'Global · data layer', en: "'Database migration failed: '" },
  'Миграция отклонена: ': { d: 'EN', s: 'Global · data layer', en: "'Migration rejected by the validator: '" },
  'База переведена на две шкалы (АНГ→РУС / РУС→АНГ). ': { d: 'EN', s: 'Global · data layer', en: "'Database upgraded to the two-vector model (EN→RU / RU→EN). '" },
  'Обновлено карточек: ${…}': { d: 'EN', cat: 'c (toast body)', s: 'Global · data layer', en: '`Cards updated: ${report.migrated}` (keep the original ${} expression)' },
  'В банке: ${…}': { d: 'EN', cat: 'c (toast body)', s: 'Global · data layer', en: '`In the bank: ${…}` (keep the original ${} expression)' },
  'В работе: ${…}': { d: 'EN', cat: 'c (toast body)', s: 'Global · data layer', en: '`Active: ${…}` (keep the original ${} expression)' },
  'К повтору сегодня: ${…}': { d: 'EN', cat: 'c (toast body)', s: 'Global · data layer', en: '`Due today: ${…}` (keep the original ${} expression)' },
  // ---- Add Words screen ----
  '📋 Промпт для нейросети скопирован в буфер!': { d: 'EN', s: 'Add Words', en: "'📋 AI prompt copied to clipboard!'" },
  // ---- Groups & Packs: POS category display labels (label-field, category b) ----
  'Nouns (Существительные)': { d: 'EN', s: 'Groups & Packs', en: "'Nouns'" },
  'Verbs (Глаголы)': { d: 'EN', s: 'Groups & Packs', en: "'Verbs'" },
  'Adjectives (Прилагательные)': { d: 'EN', s: 'Groups & Packs', en: "'Adjectives'" },
  'Adverbs (Наречия)': { d: 'EN', s: 'Groups & Packs', en: "'Adverbs'" },
  'Phrases & Idioms (Фразы)': { d: 'EN', s: 'Groups & Packs', en: "'Phrases & Idioms'" },
  'Other / Pronouns (Другое)': { d: 'EN', s: 'Groups & Packs', en: "'Other / Pronouns'" },
  // ---- Batch default name (data-visible in Groups & Packs) ----
  'Single Additions (Отдельные слова)': { d: 'EN', s: 'Add Words · Groups & Packs', cat: 'b (data name)', en: "'Single Additions' — ⚠ see caveat below the table" },
  // ---- Guide screen: intentionally Russian (only applied in the RU view) ----
  '📖 Инструкция и Руководство': { d: 'KEEP-RU', s: 'Guide (RU view)', en: '— (set only when the RU guide view is toggled; matches index.html RU header)' },
  'Система Лейтнера, занесение слов через ИИ, хранение данных, выгрузка/загрузка и горячие клавиши': { d: 'KEEP-RU', s: 'Guide (RU view)', en: '— (RU guide subtitle)' },
  '✅ Скопировано!': { d: 'KEEP-RU', s: 'Guide (RU view)', en: '— (RU copy-button feedback)' },
  '📋 Промпт для нейросети скопирован в буфер обмена!': { d: 'KEEP-RU', s: 'Guide (RU view)', en: '— (RU prompt-copy toast)' },
  'Не удалось скопировать промпт': { d: 'KEEP-RU', s: 'Guide (RU view)', en: '— (RU prompt-copy failure toast)' },
  // ---- Functional literals: NEVER translate ----
  'сущ': { d: 'CODE', s: 'import/parsing', en: '— (Russian PoS keyword matched against card translations)' },
  'существительное': { d: 'CODE', s: 'import/parsing', en: '— (PoS keyword)' },
  'гл': { d: 'CODE', s: 'import/parsing', en: '— (PoS keyword)' },
  'глагол': { d: 'CODE', s: 'import/parsing', en: '— (PoS keyword)' },
  'что делать': { d: 'CODE', s: 'import/parsing', en: '— (verb keyword)' },
  'что сделать': { d: 'CODE', s: 'import/parsing', en: '— (verb keyword)' },
  'прил': { d: 'CODE', s: 'import/parsing', en: '— (PoS keyword)' },
  'прилагательное': { d: 'CODE', s: 'import/parsing', en: '— (PoS keyword)' },
  'нареч': { d: 'CODE', s: 'import/parsing', en: '— (PoS keyword)' },
  'наречие': { d: 'CODE', s: 'import/parsing', en: '— (PoS keyword)' },
  'местоим': { d: 'CODE', s: 'import/parsing', en: '— (PoS keyword)' },
  'предлог': { d: 'CODE', s: 'import/parsing', en: '— (PoS keyword)' },
  'союз': { d: 'CODE', s: 'import/parsing', en: '— (PoS keyword)' },
  'фраза': { d: 'CODE', s: 'import/parsing', en: '— (PoS keyword)' },
  'выражение': { d: 'CODE', s: 'import/parsing', en: '— (PoS keyword)' },
  'идиома': { d: 'CODE', s: 'import/parsing', en: '— (PoS keyword)' },
  'выраж': { d: 'CODE', s: 'Dictionary', en: '— (PoS keyword, badge classifier)' },
  'фраз': { d: 'CODE', s: 'Dictionary', en: '— (PoS keyword, badge classifier)' },
  'другое': { d: 'CODE', s: 'Groups & Packs', en: '— (PoS keyword)' },
  'местоимение': { d: 'CODE', s: 'Groups & Packs', en: '— (PoS keyword)' },
  'ы': { d: 'CODE', s: 'Training · hotkeys', en: '— (Cyrillic-layout alias for S = flip)' },
  'ф': { d: 'CODE', s: 'Training · hotkeys', en: '— (Cyrillic-layout alias for A = Forgot)' },
  'в': { d: 'CODE', s: 'Training · hotkeys', en: '— (Cyrillic-layout alias for D = Easy)' },
  'ц': { d: 'CODE', s: 'Training · hotkeys', en: '— (Cyrillic-layout alias for W = to end of queue)' },
  // ---- Console diagnostics (not user-visible; translate only if desired) ----
  '[load] источник ${…} отброшен: cards не массив или пуст': { d: 'OPT', s: 'console · load engine', en: '`[load] source ${…} rejected: cards is not an array or is empty`' },
  'localStorage leitner_data недоступен:': { d: 'OPT', s: 'console · load engine', en: "'localStorage leitner_data unavailable:'" },
  'localStorage leitner_data_backup недоступен:': { d: 'OPT', s: 'console · load engine', en: "'localStorage leitner_data_backup unavailable:'" },
  '[load] источники:': { d: 'OPT', s: 'console · load engine', en: "'[load] sources:'" },
  'нет данных': { d: 'OPT', s: 'console · load engine', en: "'no data'" },
  '[load] normalizeCard отклонил запись:': { d: 'OPT', s: 'console · load engine', en: "'[load] normalizeCard rejected a record:'" },
  '[load] слиты настоящие дубликаты:': { d: 'OPT', s: 'console · load engine', en: "'[load] merged true duplicates:'" },
  '[load] пропущено удалённых (надгробия):': { d: 'OPT', s: 'console · load engine', en: "'[load] skipped deleted (tombstones):'" },
  '[load] пропущено битых записей:': { d: 'OPT', s: 'console · load engine', en: "'[load] skipped corrupt records:'" },
  '[SRS] сохранение ОТКЛОНЕНО:': { d: 'OPT', s: 'console · save engine', en: "'[SRS] save REJECTED:'" },
  '[SRS] предупреждения сохранения:': { d: 'OPT', s: 'console · save engine', en: "'[SRS] save warnings:'" },
  '[SRS] сериализация не удалась:': { d: 'OPT', s: 'console · save engine', en: "'[SRS] serialization failed:'" },
  'отказ': { d: 'OPT', s: 'console · save engine', en: "'failed'" },
  '[save] предупреждения файлового слоя:': { d: 'OPT', s: 'console · save engine', en: "'[save] file-layer warnings:'" },
  '[ipc] ${…}: файла ещё нет${…}': { d: 'OPT', s: 'console · ipc', en: '`[ipc] ${…}: no file yet${…}`' },
  '[ipc] ${…} отказал:': { d: 'OPT', s: 'console · ipc', en: '`[ipc] ${…} failed:`' },
  '[ipc] повреждённый файл изолирован:': { d: 'OPT', s: 'console · ipc', en: "'[ipc] corrupt file quarantined:'" },
  'Не удалось разобрать ${…}:': { d: 'OPT', s: 'console · parsing', en: '`Failed to parse ${…}:`' },
  'Не удалось сериализовать снимок до миграции:': { d: 'OPT', s: 'console · migration', en: "'Failed to serialize the pre-migration snapshot:'" },
  'localStorage-снимок до миграции не сохранён:': { d: 'OPT', s: 'console · migration', en: "'pre-migration localStorage snapshot not saved:'" },
  'Снимок до миграции:': { d: 'OPT', s: 'console · migration', en: "'Pre-migration snapshot:'" },
  '(уже существовал — не перезаписан)': { d: 'OPT', s: 'console · migration', en: "'(already existed — not overwritten)'" },
  '(${…} байт)': { d: 'OPT', s: 'console · migration', en: '`(${…} bytes)`' },
  'save-snapshot ${…} недоступен:': { d: 'OPT', s: 'console · migration', en: '`save-snapshot ${…} unavailable:`' },
  'Миграция SRS провалилась — состояние не изменено:': { d: 'OPT', s: 'console · migration', en: "'SRS migration failed — state unchanged:'" },
  'Миграция отклонена валидатором:': { d: 'OPT', s: 'console · migration', en: "'Migration rejected by the validator:'" },
  '[SRS] миграция ${…} → schema ${…}': { d: 'OPT', s: 'console · migration', en: '`[SRS] migration ${…} → schema ${…}`' },
  'Неизвестное направление в переключателе:': { d: 'OPT', s: 'console · training', en: "'Unknown direction in the switcher:'" },
  '[train] карточка исчезла из базы, пропускаем:': { d: 'OPT', s: 'console · training', en: "'[train] card vanished from the base, skipping:'" },
  '[answer] карточка не найдена, пропускаем запись:': { d: 'OPT', s: 'console · training', en: "'[answer] card not found, skipping the write:'" },
  '[answer] неизвестная оценка:': { d: 'OPT', s: 'console · training', en: "'[answer] unknown answer grade:'" },
  '[learn] вторая сторона добавлена в сессию:': { d: 'OPT', s: 'console · training', en: "'[learn] second side added to the session:'" },
  '[save] после возврата в Банк:': { d: 'OPT', s: 'console · training', en: "'[save] after returning to the Bank:'" },
};

/* multi-line template literals keyed by prefix */
const PREFIX = [
  { p: 'Я хочу добавить новые английские слова в приложение.', d: 'EN', cat: 'b (clipboard payload)', s: 'Add Words · #btn-copy-prompt clipboard payload',
    en: 'Replace the whole template with the English prompt that now matches the visible code block in index.html (tab "AI Import"). Full replacement text is in §3 below. The Russian original stays available in the RU guide (#guide-prompt-code-ru).' }
];

/* template literals are keyed with every ${expr} normalised to ${…} so the
   table survives changes to the interpolated expressions */
const normKey = v => v.replace(/\$\{[^]*?\}/g, '${…}');
function lookup(v) {
  const n = normKey(v);
  if (T[v]) return T[v];
  if (T[n]) return T[n];
  for (const k of Object.keys(T)) if (normKey(k) === n) return T[k];
  for (const pre of PREFIX) if (v.startsWith(pre.p)) return pre;
  return null;
}

const order = { EN: 0, 'KEEP-RU': 1, OPT: 2, CODE: 3 };
const catOf = r => r.ctx === 'toast' ? 'c (toast)' : /^(dialog)$/.test(r.ctx) ? 'c (dialog)' :
  ['textContent', 'innerHTML', 'label-field', 'attr-title', 'attr-placeholder', 'attr-aria', 'clipboard', 'data-name'].includes(r.ctx) ? 'b (rendered)' :
  r.ctx === 'keyword-match' || r.ctx === 'hotkey-alias' ? 'b (functional)' : 'b (console/internal)';

/* LEGACY_BATCH_ALIASES keys must stay Russian — they match legacy user data */
const ALIAS_T = { d: 'CODE', s: 'Data layer · batch-name normalisation', cat: 'b (functional)',
  en: '— (legacy-data alias key; intentionally Russian — it matches old user records, translating it breaks normalisation)' };

const groups = new Map();
const unreviewed = [];
for (const r of rows) {
  const t = r.fn === 'LEGACY_BATCH_ALIASES' ? ALIAS_T : lookup(r.value);
  if (!t) { unreviewed.push(r); continue; }
  const key = t.d;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ ...r, ...t });
}
for (const k of Object.keys(order)) groups.get(k)?.sort((a, b) => a.line - b.line || a.value.localeCompare(b.value));

const fmt = s => '`' + s.replace(/`/g, '\\`').replace(/\|/g, '\\|').replace(/\r?\n/g, '\\n') + '`';
const fmtRaw = r => r.raw.length > 160 ? fmt(r.raw.slice(0, 160)) + ' …(truncated, multi-line)' : fmt(r.raw);

const cnt = k => (groups.get(k) || []).length;
const out = [];
out.push('# UI-EN-STRINGS — Russian string inventory for `app.js` (EN-by-default conversion)');
out.push('');
out.push('> **FROZEN snapshot** — confirmed by the parent agent: no further `app.js` edits after this inventory was taken.');
out.push(`> Row keys are the **exact string literal + enclosing function** (line numbers are snapshot-only; enclosing fn = nearest preceding function/module-level-const declaration, heuristic).`);
const appLines = fs.readFileSync(ROOT + '/app.js', 'utf8').split('\n').length;
out.push(`> Snapshot: sha256 \`${sha}\` · mtime \`${st.mtime.toISOString()}\` · \`${st.size}\` bytes · ${appLines} lines · Cyrillic literals found: **${rows.length}**`);
out.push('> Generated by the UI agent; static markup (index.html) is already English by default — see §1.');
out.push('');
out.push('## 0. Summary');
out.push('');
out.push('| Disposition | Count | Meaning |');
out.push('|---|---|---|');
out.push(`| **EN — translate** | ${cnt('EN')} | User-visible copy that must become English${cnt('EN') === 0 ? ' — **none remain: all resolved in the frozen snapshot**' : ''} |`);
out.push(`| **KEEP-RU — intentional** | ${cnt('KEEP-RU')} | Only ever shown in the RU guide view; keep Russian |`);
out.push(`| **OPT — console diagnostics** | ${cnt('OPT')} | Not user-visible (devtools only) — **not applied by design** (parent-agent decision; code comments are Russian too) |`);
out.push(`| **CODE — functional** | ${cnt('CODE')} | PoS keyword matching / Cyrillic hotkey aliases — translating BREAKS behaviour (confirmed intentional by the parent agent) |`);
out.push(`| **NEEDS-REVIEW** | ${unreviewed.length} | New strings that appeared after curation — listed in §5, must not be applied blindly |`);
out.push('');
out.push('Category legend (per the parent-agent contract): **(a)** static markup owned by the UI agent (already done, §1) · **(b)** generated by app.js into the DOM · **(c)** toast / confirm() / prompt() / alert() copy.');
out.push('');

out.push('## 1. Static markup (category a) — already converted by the UI agent');
out.push('');
out.push('`index.html` is English by default: nav («Инструкция»→Guide), knowledge panel (Knowledge Groups / not started yet / level 0 · shown in the same session / 1 day / 2–4 days / 7–14 days / 30 days · ceiling / "N words"), due summary, the three answer buttons (🔴 Forgot · 🟠 Hard · 🟢 Easy, titles + kbd hints), shortcut tip line, dictionary filter option (🏦 Bank (not studied)), group tabs, the whole Spelling Studio, the whole Statistics screen, the edit modal (Level · ENG→RUS / RUS→ENG, day-suffixed options, Review schedule), group-detail table head, and the AI-import prompt code block (now English, mirroring §3).');
out.push('Deliberate Russian kept in markup: the RU guide view (hidden by default, toggle intact, `lang="ru"`), Cyrillic-layout hotkey aliases (kbd Ы/Ф/В/Ц) in the EN cheatsheet, `lang="ru"` cross-references to old button names, and Russian sample/placeholder word data (translation fields expect Russian).');
out.push('');

const sec = (k, title, note) => {
  out.push(`## ${title}`);
  if (note) { out.push(''); out.push(note); }
  out.push('');
  out.push('| Screen | Enclosing fn | Cat | Line (snapshot) | Current literal (exact) | Proposed replacement | Already English in target? |');
  out.push('|---|---|---|---|---|---|---|');
  for (const r of groups.get(k) || []) {
    out.push(`| ${r.s} | \`${r.fn}\` | ${r.cat || catOf(r)} | ${r.line} | ${fmtRaw(r)} | ${r.en} | no |`);
  }
  out.push('');
};
sec('EN', '2. EN — user-visible Russian that must be translated',
  (groups.get('EN') || []).length === 0
    ? '**None remain.** Earlier snapshots listed ~20 user-visible rows (migration/save toasts, POS_CATEGORIES labels, the `Single Additions (Отдельные слова)` batch name, the Russian `promptText` clipboard template); the parent agent\'s app.js rewrite absorbed all of them before the freeze. The prompt replacement this doc proposed lives on in §3 (RESOLVED).'
    : 'All rows verified reachable from UI (toast, clipboard payload, rendered label, batch name). Apply by searching the **exact literal** — line numbers may have moved.');
const saRows = (groups.get('EN') || []).filter(r => r.value.includes('Single Additions'));
if (saRows.length) {
  out.push('⚠ **Caveat — `Single Additions (Отдельные слова)`**: this string is also persisted as `batch_name` in user data. After renaming the literal, old cards keep the old batch name and will group separately from new ones unless the load engine normalises it (e.g. map the legacy value to the new one in `normalizeCard`/merge).');
} else {
  out.push('✅ **RESOLVED — legacy `batch_name`**: earlier builds wrote `Single Additions (Отдельные слова)` into user data; without normalisation Groups & Packs would split one logical bucket in two. The frozen snapshot adds `LEGACY_BATCH_ALIASES` + `normalizeBatchName(card)` (top of app.js), called on BOTH ingestion paths — the loadData merge branch and the restore/import path — so the legacy spelling is normalised from any source (localStorage, backup, `data/*.json`). Note: the live `data/leitner_data.json` never contained the legacy name (its batches are the four "Import …" ones + empty); the exposure was localStorage/backup only. Normalisation added anyway as cheap insurance.');
}
out.push('');
sec('KEEP-RU', '2b. KEEP-RU — intentionally Russian (do NOT translate)', 'These fire only when the user switches the Guide to the Russian view; they mirror the RU markup in index.html. **Confirmed intentional by the parent agent** — the frozen snapshot keeps them wired to the RU toggle only.');
sec('OPT', '2c. OPT — console diagnostics (not user-visible) — NOT APPLIED BY DESIGN', 'devtools-only logging from the load/save/migration/train engines. **Parent-agent decision: left in Russian on purpose** (developer diagnostics, not UI; code comments are Russian too). The English proposals below were NOT applied and are kept only so a future reader does not mistake these rows for an oversight.');
sec('CODE', '2d. CODE — functional literals (translating breaks behaviour) — CONFIRMED', 'Part-of-speech keyword matching and physical Cyrillic-layout hotkey aliases. **Confirmed intentional by the parent agent; translating them WOULD break behaviour**: real user data stores `part_of_speech`/translation markers as «сущ.»/«глагол»/«прил.» strings that these keywords match against, and `ы/ф/в/ц` are the same physical keys as S/A/D/W on a Russian keyboard layout. Leave exactly as they are.');

out.push('## 3. AI-import prompt (`#btn-copy-prompt` handler) — ✅ RESOLVED in the frozen snapshot');
out.push('');
out.push('This doc originally proposed the English template below for the Russian `promptText` literal. The parent agent applied it field-for-field before the freeze (the handler now copies an English prompt; the "exact Russian translation" requirement inside the prompt is preserved on purpose — word translations are DATA, not UI). Kept here for reference:');
out.push('');
out.push('```js');
out.push('const promptText = `I want to add new English words to my flashcard app.');
out.push('Build a clean JSON array of objects for them, without any extra text, markdown or explanations.');
out.push('Each object must have these fields:');
out.push('- "word": the English word or phrase');
out.push('- "transcription": IPA transcription (e.g. "[wɜːrk]")');
out.push('- "translation": accurate Russian translation');
out.push('- "part_of_speech": one of "noun", "verb", "adjective", "adverb", "phrase", "other"; an array like ["noun","verb"] is allowed for universal words');
out.push('- "example": a natural English example sentence');
out.push('- "example_translation": Russian translation of the example');
out.push('- "batch_title": (optional) theme or selection name`;');
out.push('```');
out.push('');
out.push('Field list matches the visible `<code lang="en">` block in the Add Words tab of index.html (same prompt, paragraph form) and keeps the PoS values the importer parses. The Russian prompt remains available to users in the RU guide view (`#guide-prompt-code-ru`). The button label reads "📋 Copy Prompt for Gemini", so the clipboard payload is now consistent with it.');
out.push('');
out.push('## 4. Remaining user-visible Russian, by visibility');
out.push('');
const enRows = groups.get('EN') || [];
if (enRows.length === 0) {
  out.push('None — every user-visible string in the frozen snapshot is already English. (~20 rows from earlier snapshots were absorbed by the app.js rewrite; the last one, the Russian `promptText`, is resolved — see §3.)');
} else {
  enRows.forEach((r, n) => {
    const flat = r.raw.replace(/\r?\n/g, ' ');
    const shown = flat.length > 80 ? flat.slice(0, 80) + '…' : flat;
    out.push(`${n + 1}. ${fmt(shown)} — \`${r.fn}\` (${r.s})${r.value.startsWith('Я хочу') ? ', full replacement in §3' : ''}`);
  });
}
out.push('');
out.push(`Plus: KEEP-RU set (§2b, ${(groups.get('KEEP-RU') || []).length} rows) stays wired to the RU guide toggle only (confirmed); legacy batch-name issue RESOLVED (§2 note); OPT console strings intentionally Russian (§2c).`);
out.push('');
out.push('## 5. NEEDS-REVIEW (strings not present when the table was curated)');
out.push('');
if (unreviewed.length === 0) out.push('None — every Cyrillic literal in the snapshot is classified above.');
else {
  out.push('| Line | Fn | Ctx | Literal |');
  out.push('|---|---|---|---|');
  for (const r of unreviewed) out.push(`| ${r.line} | \`${r.fn}\` | ${r.ctx} | ${fmtRaw(r)} |`);
}
out.push('');
console.log(out.join('\n'));
console.error(`rows=${rows.length} EN=${cnt('EN')} KEEP-RU=${cnt('KEEP-RU')} OPT=${cnt('OPT')} CODE=${cnt('CODE')} UNREVIEWED=${unreviewed.length}`);
