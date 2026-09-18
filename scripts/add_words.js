#!/usr/bin/env node
/**
 * add_words.js — офлайн-добавление слов в data/leitner_data.json (+ зеркало .js).
 *
 * ПОЧЕМУ ПЕРЕПИСАН. Прежняя версия глотала ошибку разбора JSON и подставляла
 * { cards: [] }, после чего ПЕРЕЗАПИСЫВАЛА базу этой пустотой и рапортовала успех.
 * Оба файла в data/ хранились с BOM (EF BB BF), а JSON.parse на BOM падает —
 * то есть обычный запуск скрипта тихо уничтожал всю базу (воспроизведено: 198 → 1).
 *
 * Новое правило: ЛЮБОЙ сбой чтения/разбора = немедленный выход БЕЗ единой записи.
 * Пустое состояние создаётся только если файла физически нет.
 *
 * Использование:
 *   node scripts/add_words.js '[{"word":"resilience","translation":"стойкость"}]'
 *   node scripts/add_words.js --file=words.json
 *   node scripts/add_words.js --dry-run --batch=Unit5 '[...]'
 *
 * Флаги:
 *   --file=PATH       читать слова из JSON-файла вместо argv
 *   --today=YYYY-MM-DD  дата для created_at/next_review (по умолчанию — сегодня, UTC)
 *   --batch=NAME      batch_name/batch_id для добавляемых слов
 *   --activate        сразу перевести слова в ACTIVE (по умолчанию — в Банк)
 *   --data-dir=PATH   каталог данных (по умолчанию ./data)
 *   --dry-run         посчитать и показать, ничего не записывая
 *   -h, --help        справка
 *
 * Коды выхода: 0 — успех; 1 — ошибка аргументов; 2 — чтение/разбор данных не удался
 * (записи НЕ было); 3 — база ещё не мигрирована на schema 2 (записи НЕ было);
 * 4 — валидатор отклонил итоговое состояние (записи НЕ было).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const SRS = require('../srs.js');

// ---------------------------------------------------------------- аргументы
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of argv) {
  if (a === '-h' || a === '--help') { flags.help = true; continue; }
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = (m[2] === undefined) ? true : m[2];
  else positional.push(a);
}

if (flags.help) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim());
  process.exit(0);
}

const die = (code, msg) => { console.error(`\n[add_words] ${msg}\n[add_words] НИЧЕГО НЕ ЗАПИСАНО.`); process.exit(code); };

// ---------------------------------------------------------------- пути
const dataDir = flags['data-dir'] ? path.resolve(String(flags['data-dir'])) : path.join(__dirname, '..', 'data');
const dataPath = path.join(dataDir, 'leitner_data.json');
const jsPath = path.join(dataDir, 'leitner_data.js');

const todayFlag = flags.today ? String(flags.today) : '';
if (todayFlag && !SRS.isDateStr(todayFlag)) die(1, `--today должен быть датой YYYY-MM-DD, получено: ${todayFlag}`);
const TODAY = todayFlag || SRS.todayString();

// ---------------------------------------------------------------- чтение слов
function stripBom(s) { return String(s).replace(/^\uFEFF/, ''); }

let rawWords;
if (flags.file) {
  const p = path.resolve(String(flags.file));
  if (!fs.existsSync(p)) die(1, `файл со словами не найден: ${p}`);
  rawWords = fs.readFileSync(p, 'utf8');
} else if (positional.length) {
  rawWords = positional.join(' ');
} else {
  die(1, 'не переданы слова. Пример: node scripts/add_words.js \'[{"word":"x","translation":"y"}]\'');
}

let parsed;
try {
  parsed = JSON.parse(stripBom(rawWords));
} catch (e) {
  die(1, `входные слова — не валидный JSON: ${e.message}`);
}
const items = Array.isArray(parsed) ? parsed : [parsed];
if (!items.length) die(1, 'список слов пуст');

// ---------------------------------------------------------------- чтение базы
/**
 * Критично: ошибка чтения НЕ подменяется пустым состоянием.
 * fresh=true только когда файла физически нет — это единственная легальная пустая база.
 */
function loadBase() {
  if (!fs.existsSync(dataPath)) {
    if (fs.existsSync(jsPath)) {
      // Зеркало есть, а основной файл пропал — чинить молча нельзя: сначала разбор.
      const mirror = stripBom(fs.readFileSync(jsPath, 'utf8'));
      const m = /window\.LEITNER_DATA\s*=\s*([\s\S]*?);?\s*$/.exec(mirror);
      if (!m) die(2, `найден только ${path.basename(jsPath)}, но он не разобран — основная база отсутствует`);
      try {
        return { data: JSON.parse(m[1]), fresh: false, source: 'leitner_data.js' };
      } catch (e) {
        die(2, `найден только ${path.basename(jsPath)}, и он не парсится: ${e.message}`);
      }
    }
    return {
      data: { schema_version: SRS.SCHEMA_VERSION, saved_at: null, cards: [], history: {}, streak: { count: 0, last_date: null }, custom_groups: [], deleted_ids: [] },
      fresh: true,
      source: null
    };
  }

  let text;
  try {
    text = fs.readFileSync(dataPath, 'utf8');
  } catch (e) {
    die(2, `не удалось прочитать ${dataPath}: ${e.message}`);
  }
  const hadBom = text.charCodeAt(0) === 0xFEFF;
  try {
    return { data: JSON.parse(stripBom(text)), fresh: false, source: 'leitner_data.json', hadBom };
  } catch (e) {
    die(2, `${path.basename(dataPath)} не парсится (${e.message}). Файл повреждён или имеет BOM/обёртку — восстановите его из резервной копии или запустите node scripts/migrate-offline.cjs`);
  }
}

const base = loadBase();
const state = base.data && typeof base.data === 'object' ? base.data : null;
if (!state || !Array.isArray(state.cards)) {
  die(2, 'прочитанные данные не содержат массива cards — структура не распознана');
}

// База должна быть уже в schema 2: миграцию делает отдельный скрипт (он же пишет
// одноразовый снапшот leitner_data.pre-srs.json). Молча мигрировать отсюда нельзя —
// иначе добавление пары слов переписало бы расписание всех 198 карточек.
if (!base.fresh && Number(state.schema_version) !== SRS.SCHEMA_VERSION) {
  die(3, `база в schema ${state.schema_version == null ? '?' : state.schema_version}, требуется ${SRS.SCHEMA_VERSION}. Сначала выполните: node scripts/migrate-offline.cjs`);
}

// ---------------------------------------------------------------- сборка карточек
const batchName = typeof flags.batch === 'string' ? flags.batch.trim() : '';
const batchId = batchName ? 'batch_' + SRS.fnv1a(batchName).toString(36) : '';
const wantActive = !!flags.activate;

const byId = new Map();
const byPair = new Map();
state.cards.forEach(c => {
  if (!c || typeof c !== 'object') return;
  if (c.id != null) byId.set(String(c.id), c);
  const key = `${String(c.word || '').trim().toLowerCase()}||${String(c.translation || '').trim().toLowerCase()}`;
  if (!byPair.has(key)) byPair.set(key, c);
});

// Слова в Банке/архиве не «заняты»: совпадением считаем только точную пару word+translation.
const deletedIds = new Set(Array.isArray(state.deleted_ids) ? state.deleted_ids.map(String) : []);

const added = [];
const skipped = [];
items.forEach((item, idx) => {
  if (!item || typeof item !== 'object') { skipped.push({ idx, reason: 'не объект' }); return; }
  const word = typeof item.word === 'string' ? item.word.trim() : '';
  const translation = typeof item.translation === 'string' ? item.translation.trim() : '';
  if (!word || !translation) { skipped.push({ idx, word, reason: 'нет word или translation' }); return; }

  const pairKey = `${word.toLowerCase()}||${translation.toLowerCase()}`;
  if (byPair.has(pairKey)) { skipped.push({ idx, word, reason: 'уже есть в базе' }); return; }

  // id детерминированный (FNV-1a от word|translation|salt), а не Math.random():
  // повторный запуск скрипта не плодит дубликаты и не ломает историю.
  let id = typeof item.id === 'string' && item.id ? item.id : null;
  let salt = String(idx);
  if (!id) {
    id = 'card_' + SRS.fnv1a([word, translation, salt].join('|')).toString(36);
    let guard = 0;
    while (byId.has(id) && guard++ < 1000) {
      salt = `${idx}#${guard}`;
      id = 'card_' + SRS.fnv1a([word, translation, salt].join('|')).toString(36);
    }
  }
  if (byId.has(id)) { skipped.push({ idx, word, reason: `id уже занят (${id})` }); return; }
  if (deletedIds.has(id)) { skipped.push({ idx, word, reason: 'id в томбстонах deleted_ids' }); return; }

  let card = SRS.newCardSkeleton({
    id,
    word,
    translation,
    phonetic: typeof item.phonetic === 'string' ? item.phonetic.trim() : '',
    example: typeof item.example === 'string' ? item.example.trim() : '',
    example_translation: typeof item.example_translation === 'string'
      ? item.example_translation.trim()
      : (typeof item.example_rus === 'string' ? item.example_rus.trim() : ''),
    part_of_speech: item.part_of_speech != null ? item.part_of_speech : item.partOfSpeech,
    batch_id: batchId || (typeof item.batch_id === 'string' ? item.batch_id : ''),
    batch_name: batchName || (typeof item.batch_name === 'string' ? item.batch_name : ''),
    created_at: TODAY
  }, { today: TODAY, salt });

  // RULE 1: новое слово по умолчанию лежит в Банке и не попадает в повторение,
  // пока его явно не активировали (--activate или кнопка в приложении).
  if (wantActive) card = SRS.activateCard(card, TODAY);

  byId.set(card.id, card);
  byPair.set(pairKey, card);
  added.push(card);
});

if (!added.length) {
  console.log(`[add_words] новых слов нет (${skipped.length} пропущено).`);
  skipped.slice(0, 10).forEach(s => console.log(`  - #${s.idx} ${s.word || '(без слова)'}: ${s.reason}`));
  process.exit(0);
}

const nextCards = state.cards.concat(added);

// Незнакомые корневые ключи сохраняем: база могла содержать поля, о которых
// этот скрипт ничего не знает (правило migrateState «не терять неизвестное»).
const nextState = Object.assign({}, state, {
  cards: nextCards,
  schema_version: SRS.SCHEMA_VERSION,
  saved_at: new Date().toISOString()
});

// ---------------------------------------------------------------- проверка
const check = SRS.validateState(nextState, state, { today: TODAY, removedIds: [] });
if (!check.ok) {
  die(4, `валидатор отклонил итог: ${check.errors.slice(0, 5).join('; ')}`);
}

// ---------------------------------------------------------------- запись
function atomicWrite(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

const json = SRS.serializeState(nextState, { savedAt: nextState.saved_at });

if (flags['dry-run']) {
  console.log(`[dry-run] будет добавлено ${added.length} слов; всего станет ${nextCards.length} (было ${state.cards.length}).`);
  added.slice(0, 15).forEach(c => console.log(`  + ${c.id}  ${c.word} → ${c.translation}  [${c.status}]`));
  if (skipped.length) {
    console.log(`[dry-run] пропущено ${skipped.length}:`);
    skipped.slice(0, 15).forEach(s => console.log(`  - #${s.idx} ${s.word || '(без слова)'}: ${s.reason}`));
  }
  if (check.warnings && check.warnings.length) console.log('[dry-run] предупреждения:', check.warnings.slice(0, 5));
  process.exit(0);
}

try {
  atomicWrite(dataPath, json);
} catch (e) {
  die(4, `не удалось записать ${dataPath}: ${e.message}`);
}

// Зеркало для браузерного режима (window.LEITNER_DATA) пишем тем же содержимым.
const jsText = `window.LEITNER_DATA = ${json};`;
try {
  atomicWrite(jsPath, jsText);
} catch (e) {
  console.error(`[add_words] ВНИМАНИЕ: ${dataPath} записан, но зеркало ${jsPath} не обновился: ${e.message}`);
}

// Контрольное чтение: убеждаемся, что на диске действительно то, что мы собрали.
let readBack = null;
try {
  readBack = JSON.parse(stripBom(fs.readFileSync(dataPath, 'utf8')));
} catch (e) {
  console.error(`[add_words] ВНИМАНИЕ: контрольное чтение не удалось: ${e.message}`);
}
const readBackOk = readBack && Array.isArray(readBack.cards) && readBack.cards.length === nextCards.length;

console.log(`[add_words] добавлено ${added.length} слов (пропущено ${skipped.length}).`);
console.log(`[add_words] карточек в базе: ${state.cards.length} → ${nextCards.length}  [${wantActive ? 'ACTIVE' : 'BANK'}]`);
console.log(`[add_words] записано: ${dataPath}${readBackOk ? ' (контрольное чтение OK)' : ' (контрольное чтение НЕ подтвердилось!)'}`);
if (skipped.length) skipped.slice(0, 10).forEach(s => console.log(`  - #${s.idx} ${s.word || '(без слова)'}: ${s.reason}`));
if (check.warnings && check.warnings.length) console.log('[add_words] предупреждения:', check.warnings.slice(0, 5));
process.exit(readBackOk ? 0 : 4);
