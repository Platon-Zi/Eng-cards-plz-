/* =============================================================================
   srs.js — ядро интервальных повторений (schema 2, «два независимых вектора»)
   -----------------------------------------------------------------------------
   Одно слово несёт ДВЕ независимые шкалы: распознавание EN→RUS и производство
   RUS→ENG («две нейронные связи одного слова»). Жёсткого гейта между ними нет:
   оценка одного направления НИКОГДА не трогает другое.

     status             : 'BANK' | 'ACTIVE'
     level_en_ru        : 0..6     next_review_en_ru : 'YYYY-MM-DD' | null
     level_ru_en        : 0..6     next_review_ru_en : 'YYYY-MM-DD' | null

     INTERVALS = [0, 1, 2, 4, 7, 14, 30]     индекс = уровень, значение = дни
     🔴 Забыл  → уровень ≤3 ⇒ 1,  уровень >3 ⇒ 2      (асимметрия — данными)
     🟠 Сложно → уровень заморожен (долбим на своём интервале)
     🟢 Легко  → +1 уровень, потолок 6 = 30 дней (архива больше нет)

   Группа знаний НЕ хранится — выводится из САМОГО СЛАБОГО направления.
   Банк изолирован: status='BANK' невидим для ежедневной очереди и активируется
   только первым ответом в режиме изучения.

   КОНТРАКТ ЧИСТОТЫ (нарушение = красный прогон .verify/test-srs.cjs):
     • ни DOM, ни localStorage, ни fetch, ни require, ни Math.random;
     • часы читает только todayString(now?, timeZone?) — оба аргумента инъективны;
     • карточные операции возвращают НОВЫЕ объекты, входные не мутируются;
     • даты ходят строками 'YYYY-MM-DD'; арифметика — целые сутки UTC-эпохи,
       поэтому DST и таймзоны физически не могут сдвинуть день.

   ЗАГРУЗКА: <script src="srs.js"> до app.js  →  глобальный SRS
             require('./srs.js')               →  module.exports (Node, тесты)
   ========================================================================== */
(function (globalScope) {
  'use strict';

  /* ============================== 1. КОНСТАНТЫ ============================ */

  var VERSION = 'srs-v2';
  var SCHEMA_VERSION = 2;               // 1 = коробки (box/eng_to_rus/…), 2 = векторы направлений
  var SUPPORTED_SCHEMA_MAX = 2;

  var INTERVALS = [0, 1, 2, 4, 7, 14, 30];
  var MAX_LEVEL = INTERVALS.length - 1; // 6
  var MIN_REST_LEVEL = 1;               // уровень 0 = «активировано, ответа ещё не было» (инвариант A1)

  var KNOWLEDGE_GROUPS = ['NEW', 'LEARNING', 'FAMILIAR', 'CONFIDENT', 'MASTERED'];
  var BUCKETS = ['BANK'].concat(KNOWLEDGE_GROUPS);
  var GROUP_OF_LEVEL = { 0: 'NEW', 1: 'LEARNING', 2: 'FAMILIAR', 3: 'FAMILIAR', 4: 'CONFIDENT', 5: 'CONFIDENT', 6: 'MASTERED' };
  var LEVELS_OF_GROUP = { NEW: [0], LEARNING: [1], FAMILIAR: [2, 3], CONFIDENT: [4, 5], MASTERED: [6] };
  var GROUP_RANK = { BANK: -1, NEW: 0, LEARNING: 1, FAMILIAR: 2, CONFIDENT: 3, MASTERED: 4 };
  var GROUP_META = {
    BANK:      { ru: 'Банк',      en: 'Bank',      color: '#94a3b8', levels: '—',     intervalRu: 'не изучается',      captionRu: 'ещё не начаты' },
    NEW:       { ru: 'Новые',     en: 'New',       color: '#ef4444', levels: 'L0',    intervalRu: '0 дней',            captionRu: 'уровень 0 · показ в той же сессии' },
    LEARNING:  { ru: 'Учимся',    en: 'Learning',  color: '#f97316', levels: 'L1',    intervalRu: '1 день',            captionRu: '1 день' },
    FAMILIAR:  { ru: 'Знакомые',  en: 'Familiar',  color: '#6366f1', levels: 'L2–L3', intervalRu: '2 и 4 дня',         captionRu: '2–4 дня' },
    CONFIDENT: { ru: 'Уверенные', en: 'Confident', color: '#8b5cf6', levels: 'L4–L5', intervalRu: '7 и 14 дней',       captionRu: '7–14 дней' },
    MASTERED:  { ru: 'Освоены',   en: 'Mastered',  color: '#10b981', levels: 'L6',    intervalRu: '30 дней · потолок', captionRu: '30 дней · потолок' }
  };

  var STATUS = { BANK: 'BANK', ACTIVE: 'ACTIVE' };
  var DIRECTIONS = ['en_ru', 'ru_en'];                    // канонические токены = суффиксы полей
  var DIRECTION_META = {
    en_ru: { short: 'EN → RU', full: 'ENG → RUS', ru: 'АНГ → РУС', flag: '🇬🇧', ui: 'eng-rus' },
    ru_en: { short: 'RU → EN', full: 'RUS → ENG', ru: 'РУС → АНГ', flag: '🇷🇺', ui: 'rus-eng' }
  };
  /* Все исторические написания направлений сводятся в один канон: 'en_ru' | 'ru_en'. */
  var DIRECTION_ALIASES = {
    'en_ru': 'en_ru', 'en-ru': 'en_ru', 'en-rus': 'en_ru', 'eng-rus': 'eng-rus→en_ru',
    'eng2rus': 'en_ru', 'eng_rus': 'en_ru', 'en': 'en_ru', 'eng': 'en_ru', 'forward': 'en_ru',
    'ru_en': 'ru_en', 'ru-en': 'ru_en', 'ru-eng': 'ru_en', 'rus-eng': 'ru_en',
    'rus2eng': 'ru_en', 'rus_eng': 'ru_en', 'ru': 'ru_en', 'rus': 'ru_en', 'reverse': 'ru_en'
  };
  DIRECTION_ALIASES['eng-rus'] = 'en_ru';
  DIRECTION_ALIASES['ENG-RUS'] = 'en_ru';
  DIRECTION_ALIASES['RUS-ENG'] = 'ru_en';
  DIRECTION_ALIASES['EN_RU'] = 'en_ru';
  DIRECTION_ALIASES['RU_EN'] = 'ru_en';

  var ANSWERS = { AGAIN: 'again', HARD: 'hard', EASY: 'easy' };
  var ANSWER_ORDER = ['again', 'hard', 'easy'];
  var ANSWER_META = {
    again: { ru: 'Забыл',  en: 'Forgot', icon: '🔴', correct: false, hotkeys: ['1', 'arrowleft', 'a', 'ф'] },
    hard:  { ru: 'Сложно', en: 'Hard',   icon: '🟠', correct: true,  hotkeys: ['2'] },
    easy:  { ru: 'Легко',  en: 'Easy',   icon: '🟢', correct: true,  hotkeys: ['3', 'arrowright', 'd', 'в'] }
  };
  var RESET_TABLE = { lowMaxLevel: 3, lowTo: 1, highTo: 2 };   // ПРАВИЛО 3 как данные, а не как код

  var DEFAULTS = {
    sameCardGap: 3,          // минимальное расстояние между двумя сторонами одного слова
    learnBatchLimit: 20,     // сколько новых слов из банка за один заход
    requeueDelay: 4,         // куда вставлять «забытое» слово внутри сессии
    maxRepeatsPerSession: 1, // потолок повторных показов одной пары за сессию
    reviewChunkSize: 30,     // пагинация очереди повторения
    maxOverdueDisplay: 365,
    shrinkThreshold: 0.8,    // страж массовой потери данных
    penalizeArchive: false,  // миграция: штрафовать и архивные слова?
    duePolicy: 'stagger'     // 'stagger' = долг просрочки один раз на слово | 'fresh' = всё с сегодняшнего дня
  };

  /* Мёртвые поля старой модели: не сериализуются никогда, вырезаются при нормализации. */
  var DEPRECATED_FIELDS = [
    'box', 'srsStage', 'interval', 'easeFactor', 'repetitions', 'dueDate',
    'eng_to_rus', 'rus_to_eng', 'last_tested', 'last_tested_eng', 'last_tested_rus',
    'next_review_date', 'knowledge_group', 'level', 'stage'
  ];

  /* Старые коробки → новый уровень ПО ИНТЕРВАЛАМ: box3=7д→L4=7д, box4=14д→L5=14д, box5=30д→L6=30д. */
  var BOX_TO_LEVEL = { '0': 0, '1': 1, '2': 2, '3': 4, '4': 5, '5': 6, '6': 6, 'archive': 6, 'bank': 0 };
  var STAGE_TO_LEVEL = { 'new': 0, 'learning': 1, 'review': 4, 'mastered': 6, 'bank': 0 };
  var EVIDENCE_FIELDS = {
    en_ru: { tested: 'last_tested_eng', flag: 'eng_to_rus' },
    ru_en: { tested: 'last_tested_rus', flag: 'rus_to_eng' }
  };

  /* ============================== 2. УТИЛИТЫ ============================== */

  function freezeDeep(o) {
    Object.freeze(o);
    Object.keys(o).forEach(function (k) {
      var v = o[k];
      if (v && typeof v === 'object' && !Object.isFrozen(v)) freezeDeep(v);
    });
    return o;
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function num(v) { return Number.isFinite(v) ? v : 0; }
  function isEmpty(v) { return v === null || v === undefined || v === ''; }

  function clone(obj) {
    var out = {};
    Object.keys(obj || {}).forEach(function (k) { out[k] = obj[k]; });
    return out;
  }

  /** part_of_speech легально бывает массивом (это обещает наш же AI-промпт) → строка для UI. */
  function posText(value, sep) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.filter(function (x) { return !isEmpty(x); }).map(String).join(sep || ' / ');
    return String(value);
  }

  function pluralRu(n, one, few, many) {
    var m10 = Math.abs(n) % 10, m100 = Math.abs(n) % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  /** BOM ломает JSON.parse в main.js и в node-ветке app.js — снимаем её на входе везде. */
  function stripBom(text) {
    if (typeof text !== 'string') return text;
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  }

  /* ================================ 3. ДАТЫ =============================== */

  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  /** Строгий разбор: только реально существующая календарная дата; 2026-02-30 → null. */
  /**
   * UTC-дата по y/m/d БЕЗ ловушки Date.UTC: конструктор отображает годы 0..99 в
   * 1900+y, из-за чего честные даты вида 0001-01-01 отклонялись как несуществующие.
   * setUTCFullYear(y, m, d) задаёт год буквально.
   */
  function utcDate(y, m, d) {
    var dt = new Date(Date.UTC(2001, 0, 1));
    dt.setUTCHours(0, 0, 0, 0);
    dt.setUTCFullYear(y, m - 1, d);
    return dt;
  }

  /** Год всегда четырьмя цифрами: контракт даты — строго YYYY-MM-DD. */
  function pad4(n) {
    var out = String(Math.abs(n));
    while (out.length < 4) out = '0' + out;
    return out;
  }

  function parseYMD(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
    var p = s.split('-');
    var y = +p[0], m = +p[1], d = +p[2];
    if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    var dt = utcDate(y, m, d);
    // Переполнение месяца (2026-02-30) Date молча уносит в март — сверяем все три поля.
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return { y: y, m: m, d: d };
  }

  function isDateStr(s) { return parseYMD(s) !== null; }

  function toEpochDays(s) {
    var p = parseYMD(s);
    if (!p) return null;
    return Math.floor(utcDate(p.y, p.m, p.d).getTime() / 86400000);
  }

  function fromEpochDays(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    var dt = new Date(Math.round(n) * 86400000);
    // pad4: без дополнения года 0999-12-31 печатался как '999-12-31', не проходил
    // DATE_RE, и round-trip toEpochDays(fromEpochDays(x)) рвался на годах < 1000.
    return pad4(dt.getUTCFullYear()) + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
  }

  /** Целые сутки эпохи: никаких 23h/25h из-за DST и никаких локальных геттеров. */
  function addDays(s, n) {
    var base = toEpochDays(s);
    if (base === null) throw new TypeError('SRS.addDays: не дата — ' + JSON.stringify(s));
    var k = Number(n);
    if (!Number.isFinite(k)) throw new TypeError('SRS.addDays: не число — ' + JSON.stringify(n));
    return fromEpochDays(base + Math.round(k));
  }

  /** diffDays(a, b) = a − b в сутках; null, если хоть один аргумент мусорный. */
  function diffDays(a, b) {
    var ea = toEpochDays(a), eb = toEpochDays(b);
    if (ea === null || eb === null) return null;
    return ea - eb;
  }

  /** Единственный читатель часов в модуле. */
  function todayString(now, timeZone) {
    var d = (now instanceof Date && !isNaN(now.getTime())) ? now : new Date();
    try {
      var opts = { year: 'numeric', month: '2-digit', day: '2-digit' };
      if (timeZone) opts.timeZone = timeZone;
      var y, m, dd;
      new Intl.DateTimeFormat('en-CA', opts).formatToParts(d).forEach(function (p) {
        if (p.type === 'year') y = p.value;
        else if (p.type === 'month') m = p.value;
        else if (p.type === 'day') dd = p.value;
      });
      if (y && m && dd) return y + '-' + m + '-' + dd;
    } catch (e) { /* Intl недоступен → локальные части */ }
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* ========================= 4. УРОВНИ И ГРУППЫ =========================== */

  function clampLevel(v) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    if (!Number.isFinite(n)) return 0;
    n = Math.round(n);
    return n < 0 ? 0 : (n > MAX_LEVEL ? MAX_LEVEL : n);
  }

  function isValidLevel(v) { return Number.isInteger(v) && v >= 0 && v <= MAX_LEVEL; }
  function groupForLevel(level) { return GROUP_OF_LEVEL[clampLevel(level)]; }
  function intervalForLevel(level) { return INTERVALS[clampLevel(level)]; }
  function levelsForGroup(group) { return LEVELS_OF_GROUP[group] ? LEVELS_OF_GROUP[group].slice() : null; }
  function groupRank(group) { return Object.prototype.hasOwnProperty.call(GROUP_RANK, group) ? GROUP_RANK[group] : 99; }

  function pipString(level) {
    var lv = clampLevel(level), s = '';
    for (var i = 0; i <= MAX_LEVEL; i++) s += i <= lv ? '●' : '○';
    return s;
  }

  /* =================== 5. ДОСТУП К ВЕКТОРАМ НАПРАВЛЕНИЙ =================== */

  function normalizeDir(dir) {
    if (dir === 'en_ru' || dir === 'ru_en') return dir;
    if (typeof dir !== 'string') throw new TypeError('SRS: неизвестное направление — ' + JSON.stringify(dir));
    var alias = DIRECTION_ALIASES[dir] || DIRECTION_ALIASES[dir.toLowerCase()] || DIRECTION_ALIASES[dir.trim()];
    if (alias === 'en_ru' || alias === 'ru_en') return alias;
    throw new TypeError('SRS: неизвестное направление — ' + JSON.stringify(dir));
  }

  function otherDir(dir) { return normalizeDir(dir) === 'en_ru' ? 'ru_en' : 'en_ru'; }
  function levelKey(dir) { return 'level_' + normalizeDir(dir); }
  function dueKey(dir) { return 'next_review_' + normalizeDir(dir); }
  /* День последнего ответа по направлению — память антиинфляционного guards:
     повторное EASY в те же календарные сутки уровень НЕ поднимает. */
  function lastKey(dir) { return 'last_review_' + normalizeDir(dir); }

  function directionLevel(card, dir) { return card ? clampLevel(card[levelKey(dir)]) : 0; }

  function directionDueDate(card, dir) {
    var raw = card ? card[dueKey(dir)] : null;
    return isDateStr(raw) ? raw : null;
  }

  function isBank(card) { return !card || card.status !== STATUS.ACTIVE; }
  function isActive(card) { return !!card && card.status === STATUS.ACTIVE; }

  /** Направление просрочено? fail-open: битая/отсутствующая дата ⇒ показать, а не похоронить. */
  function isDirectionDue(card, dir, today) {
    if (!card || isBank(card)) return false;
    var due = directionDueDate(card, dir);
    if (due === null) return true;
    var delta = diffDays(today, due);
    return delta === null ? true : delta >= 0;
  }

  function dueDirections(card, today) {
    return DIRECTIONS.filter(function (d) { return isDirectionDue(card, d, today); });
  }

  function isDue(card, today) { return isActive(card) && dueDirections(card, today).length > 0; }

  /** Группа слова = группа САМОГО СЛАБОГО направления («слабое звено»). */
  function derivedGroup(card) {
    if (isBank(card)) return 'BANK';
    return groupForLevel(Math.min(directionLevel(card, 'en_ru'), directionLevel(card, 'ru_en')));
  }

  function derivedRank(card) { return groupRank(derivedGroup(card)); }
  function sessionKey(cardId, dir) { return cardId + ':' + normalizeDir(dir); }

  /* ======================== 6. ИЗМЕНЕНИЕ КАРТОЧЕК ========================= */

  /** Банк → активация. Идемпотентна: уже ACTIVE слово не откатывает прогресс. */
  function activateCard(card, today) {
    if (!card) return card;
    var c = clone(card);
    if (c.status === STATUS.ACTIVE) return c;
    c.status = STATUS.ACTIVE;
    c.level_en_ru = 0;
    c.level_ru_en = 0;
    c.next_review_en_ru = today;
    c.next_review_ru_en = today;
    c.fail_count = num(c.fail_count);
    c.review_count = num(c.review_count);
    return c;
  }

  function returnToBank(card) {
    if (!card) return card;
    var c = clone(card);
    c.status = STATUS.BANK;
    c.level_en_ru = 0;
    c.level_ru_en = 0;
    c.next_review_en_ru = null;
    c.next_review_ru_en = null;
    return c;
  }

  function setCardStatus(card, status, today) {
    if (!card) return card;
    if (String(status).toUpperCase() === STATUS.BANK) return returnToBank(card);
    return activateCard(card, today);
  }

  /** Ручная установка уровня ОДНОГО направления (модалка редактирования). */
  function setDirectionLevel(card, dir, level, today) {
    var d = normalizeDir(dir);
    var c = clone(card);
    c.status = STATUS.ACTIVE;
    var lv = clampLevel(level);
    c[levelKey(d)] = lv;
    c[dueKey(d)] = addDays(today, INTERVALS[lv]);
    // Аудит L1: ручная смена уровня — тоже событие дня. Без штампа ранний EASY
    // в тот же день обошёл бы guard (elapsed считался бы от старого ответа).
    c[lastKey(d)] = today;
    return c;
  }

  function normalizeAnswer(answer) {
    if (typeof answer === 'boolean') return answer ? ANSWERS.EASY : ANSWERS.AGAIN;
    if (typeof answer === 'number') {
      if (answer === 1) return ANSWERS.AGAIN;      // старый SM-2 «Again»
      if (answer === 2) return ANSWERS.HARD;       // старый «Hard» → «Сложно»
      if (answer === 3 || answer === 4) return ANSWERS.EASY;
      throw new TypeError('SRS: неизвестная оценка — ' + answer);
    }
    var a = String(isEmpty(answer) ? '' : answer).toLowerCase().trim();
    if (a === 'again' || a === 'forgot' || a === 'забыл' || a === 'не_помню' || a === 'нет' || a === 'wrong' || a === 'fail') return ANSWERS.AGAIN;
    if (a === 'hard' || a === 'difficult' || a === 'сложно' || a === 'трудно') return ANSWERS.HARD;
    if (a === 'easy' || a === 'remembered' || a === 'good' || a === 'легко' || a === 'помню' || a === 'да') return ANSWERS.EASY;
    throw new TypeError('SRS: неизвестный ответ — ' + JSON.stringify(answer));
  }

  /**
   * ПРАВИЛО 3. Ответ применяется ИСКЛЮЧИТЕЛЬНО к показанному направлению;
   * второй вектор остаётся байт-в-байт прежним (инвариант A8 — проверяется тестом).
   *
   * A1 (терминация): уровень 0 означает «только что активировано, ответа ещё не было».
   * ЛЮБОЙ ответ над L0 поднимает его до L1 — иначе INTERVALS[0]=0 вернул бы слово
   * в очередь того же дня навсегда. Это буквальное следствие вашей формулировки
   * «NEW: интервал 0 дней — показ в ту же сессию».
   */
  function applyAnswer(card, dir, answer, today) {
    if (!card || typeof card !== 'object') throw new TypeError('SRS.applyAnswer: нет карточки');
    if (!isDateStr(today)) throw new TypeError('SRS.applyAnswer: today не дата — ' + JSON.stringify(today));
    var d = normalizeDir(dir);
    var ans = normalizeAnswer(answer);

    var base = card;
    var activated = false;
    if (isBank(base)) { base = activateCard(base, today); activated = true; }

    var c = clone(base);
    var kL = levelKey(d), kD = dueKey(d), kLast = lastKey(d);
    var prevLevel = clampLevel(base[kL]);
    var prevDue = directionDueDate(base, d);
    // Антиинфляционный guard (19.09, проблема пользователя): второй ответ в те же
    // календарные сутки подсказан краткосрочной памятью, а не долгосрочной —
    // «Легко» через 5 минут после «Легко» не доказательство знания.
    var sameDayRepeat = base[kLast] === today;
    // Обобщение guard'а: EASY ДО наступления срока (ранний повтор — cram/группы/
    // single word) уровень тоже не поднимает. Подъём = вспоминание НА интервале
    // или позже; ранний повтор — бонусная практика без надувания интервала.
    // В due-очередях (system/daily/practice) карточка показывается только когда
    // elapsed >= INTERVALS[prevLevel], поэтому обычная тренировка не затронута.
    var lastRev = isDateStr(base[kLast]) ? base[kLast] : null;
    var elapsedDays = (lastRev && !sameDayRepeat) ? diffDays(today, lastRev) : null;
    var earlyReview = false;
    var daysEarly = 0;
    if (ans === ANSWERS.EASY && prevLevel > 0 && !sameDayRepeat) {
      if (elapsedDays !== null) {
        earlyReview = elapsedDays < INTERVALS[prevLevel];
        if (earlyReview) daysEarly = INTERVALS[prevLevel] - elapsedDays;
      } else if (isDateStr(prevDue)) {
        // Переходный период (аудит M1): у карточек, сохранённых ДО появления
        // last_review_*, штампа нет — судим о зрелости по due-дате: срок в
        // будущем ⇒ вспоминание раннее. Без этой ветви вся существующая база
        // была бы слепа к guard'у до первого зачтённого ответа.
        daysEarly = diffDays(prevDue, today);
        earlyReview = daysEarly > 0;
        if (!earlyReview) daysEarly = 0;
      }
    }
    var next;

    if (prevLevel === 0) {
      next = MIN_REST_LEVEL;                                 // A1: любой ответ уводит с нуля
    } else if (ans === ANSWERS.EASY) {
      // EASY при повторе в те же сутки или ДО срока ЗАМОРАЖИВАЕТ уровень (как HARD):
      // подъём по лестнице возможен только через вспоминание на плановом интервале
      // или позже. Иначе слово, удержанное «на пять минут» (или закрамленное
      // ежедневно), раздувается до недельного интервала и выпадает из обучения
      // до фактического забывания.
      next = (sameDayRepeat || earlyReview) ? prevLevel : Math.min(prevLevel + 1, MAX_LEVEL);
    } else if (ans === ANSWERS.HARD) {
      next = prevLevel;                                      // заморозка
    } else {
      next = prevLevel <= RESET_TABLE.lowMaxLevel ? RESET_TABLE.lowTo : RESET_TABLE.highTo;
    }

    c[kL] = next;
    c[kD] = addDays(today, INTERVALS[next]);
    // Штамп «последний ответ» двигаем только когда ответ ЗАЧТЁН в прогресс.
    // Held-ранний/повторный EASY штамп НЕ обновляет: плановые часы продолжают
    // идти от последнего честного вспоминания — ежедневный cram не обнуляет
    // elapsed, и слово поднимется ровно когда интервал созреет (elapsed >= INTERVALS).
    if (!(ans === ANSWERS.EASY && prevLevel > 0 && (sameDayRepeat || earlyReview))) {
      c[kLast] = today;
    }
    c.review_count = num(c.review_count) + 1;
    if (ans === ANSWERS.AGAIN) c.fail_count = num(c.fail_count) + 1;

    var warnings = [];
    if (next < MIN_REST_LEVEL) warnings.push('level0_retained');
    if (isDirectionDue(c, d, today)) warnings.push('still_due_today');
    if (sameDayRepeat && ans === ANSWERS.EASY && prevLevel > 0 && next === prevLevel) {
      warnings.push('same_day_easy_hold');
    }
    if (earlyReview && next === prevLevel) warnings.push('early_easy_hold');

    return {
      card: c,
      direction: d,
      answer: ans,
      activated: activated,
      prev: { level: prevLevel, due: prevDue },
      next: { level: next, due: c[kD], intervalDays: INTERVALS[next], group: groupForLevel(next) },
      outcome: next > prevLevel ? 'advance' : (next < prevLevel ? 'reset' : 'hold'),
      promotedFromNew: prevLevel === 0,
      sameDayRepeat: sameDayRepeat,
      earlyReview: earlyReview,
      daysEarly: daysEarly,
      cardGroup: derivedGroup(c),
      pendingDirections: dueDirections(c, today),            // для learn-режима: вторая сторона ждёт
      warnings: warnings
    };
  }

  /** Единственная точка входа режима изучения: активация + ответ одним чистым вызовом. */
  function answerBankCard(card, dir, answer, today) {
    var res = applyAnswer(card, dir, answer, today);
    return Object.assign({}, res, { activated: true, pendingDirections: dueDirections(res.card, today) });
  }

  /** Скелет нового слова: строго в банк, оба вектора нулевые, дат нет (ПРАВИЛО 1). */
  function newCardSkeleton(content, opts) {
    opts = opts || {};
    var src = content || {};
    var c = {
      id: (typeof src.id === 'string' && src.id)
        ? src.id
        : 'card_' + fnv1a([src.word, src.translation, opts.salt || ''].join('|')).toString(36),
      word: typeof src.word === 'string' ? src.word : String(isEmpty(src.word) ? '' : src.word),
      phonetic: typeof src.phonetic === 'string' ? src.phonetic : '',
      translation: typeof src.translation === 'string' ? src.translation : String(isEmpty(src.translation) ? '' : src.translation),
      example: typeof src.example === 'string' ? src.example : '',
      example_translation: typeof src.example_translation === 'string' ? src.example_translation : '',
      part_of_speech: isEmpty(src.part_of_speech) ? posText(src.partOfSpeech) : src.part_of_speech,
      partOfSpeech: isEmpty(src.partOfSpeech) ? posText(src.part_of_speech) : src.partOfSpeech,
      batch_id: typeof src.batch_id === 'string' ? src.batch_id : '',
      batch_name: typeof src.batch_name === 'string' ? src.batch_name : '',
      created_at: isDateStr(src.created_at) ? src.created_at : (isDateStr(opts.today) ? opts.today : ''),
      status: STATUS.BANK,
      level_en_ru: 0,
      level_ru_en: 0,
      next_review_en_ru: null,
      next_review_ru_en: null,
      fail_count: num(src.fail_count),
      review_count: num(src.review_count)
    };
    Object.keys(src).forEach(function (k) {
      if (!(k in c) && DEPRECATED_FIELDS.indexOf(k) === -1) c[k] = src[k];
    });
    return c;
  }

  /* =================== 7. ДЕТЕРМИНИЗМ ПОРЯДКА ОЧЕРЕДИ ===================== */

  function fnv1a(str) {
    var h = 0x811c9dc5;
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function rngFromSeed(seed) {                               // mulberry32
    var a = (typeof seed === 'number' ? seed : fnv1a(String(seed))) >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seededShuffle(items, seed) {
    var arr = (items || []).slice();
    var rnd = rngFromSeed(seed);
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  /**
   * A5: две стороны одного слова не идут подряд. Жадно берём первого кандидата,
   * чьего слова не было в последних `gap` выпусках; если таких нет — ослабляем
   * до «не соседний». Длину массива НЕ меняет никогда (иначе запись пропала бы
   * из сессии молча — этот баг пойман прототипом).
   */
  function spreadSameCard(items, gap) {
    var list = (items || []).slice();
    var g = Number.isFinite(gap) ? Math.max(1, Math.round(gap)) : DEFAULTS.sameCardGap;
    var pool = list.slice();
    var out = [];
    var recent = [];
    while (pool.length) {
      var idx = -1, i;
      for (i = 0; i < pool.length; i++) {
        if (recent.indexOf(pool[i].cardId) === -1) { idx = i; break; }
      }
      if (idx === -1) {
        var lastId = out.length ? out[out.length - 1].cardId : null;
        for (i = 0; i < pool.length; i++) {
          if (pool[i].cardId !== lastId) { idx = i; break; }
        }
      }
      if (idx === -1) idx = 0;                               // вырожденный случай: одно слово на всю очередь
      var picked = pool.splice(idx, 1)[0];
      out.push(picked);
      recent.push(picked.cardId);
      if (recent.length > g) recent.shift();
    }
    if (out.length !== list.length) {
      throw new Error('SRS.spreadSameCard: потеря записей (' + list.length + ' → ' + out.length + ')');
    }
    return out;
  }

  /* ============================== 8. ОЧЕРЕДИ ============================== */

  function makeItem(card, dir, today, seedSalt, kind) {
    var d = normalizeDir(dir);
    var lvl = directionLevel(card, d);
    var due = directionDueDate(card, d);
    var od = due === null ? 0 : Math.max(0, num(diffDays(today, due)));
    return {
      key: sessionKey(card.id, d),
      cardId: card.id,
      direction: d,
      kind: kind || 'review',
      level: lvl,
      intervalDays: INTERVALS[lvl],
      entryGroup: groupForLevel(lvl),
      entryRank: groupRank(groupForLevel(lvl)),
      cardGroup: derivedGroup(card),
      dueDate: due,
      overdue: od,
      overdueDisplay: Math.min(od, DEFAULTS.maxOverdueDisplay),
      tieBreak: fnv1a(String(seedSalt) + '|' + card.id + '|' + d)
    };
  }

  /** Слабые первыми; внутри группы — кто дольше в долге; дальше всё детерминированно. */
  function compareItems(a, b) {
    return (a.entryRank - b.entryRank)
      || (b.overdue - a.overdue)
      || (a.tieBreak - b.tieBreak)
      || (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0)
      || (DIRECTIONS.indexOf(a.direction) - DIRECTIONS.indexOf(b.direction));
  }

  function cardList(cards) {
    return Array.isArray(cards) ? cards.filter(function (c) { return c && typeof c === 'object' && c.id; }) : [];
  }

  function excludeSet(excludeIds) {
    if (!excludeIds) return null;
    if (excludeIds instanceof Set) return excludeIds;
    return new Set(Array.isArray(excludeIds) ? excludeIds : [excludeIds]);
  }

  function dedupeByKey(items) {
    var seen = new Set();
    return items.filter(function (it) {
      if (seen.has(it.key)) return false;
      seen.add(it.key);
      return true;
    });
  }

  function applyLimit(items, limit) {
    return (Number.isFinite(limit) && limit > 0) ? items.slice(0, limit) : items;
  }

  /**
   * ПРАВИЛО 2/4 — ежедневная очередь Practice:
   * status='ACTIVE' И (next_review_en_ru ≤ TODAY ИЛИ next_review_ru_en ≤ TODAY).
   * Одно просроченное направление → одна запись; оба → две, не соседние.
   * opts: { seed, limit, excludeIds, direction, group, gap }
   */
  function buildReviewQueue(cards, today, opts) {
    opts = opts || {};
    var salt = opts.seed !== undefined ? opts.seed : (today + '|review|v' + SCHEMA_VERSION);
    var skip = excludeSet(opts.excludeIds);
    var onlyGroup = (opts.group && opts.group !== 'all') ? String(opts.group).toUpperCase() : null;
    var onlyDir = opts.direction ? normalizeDir(opts.direction) : null;
    var items = [];

    cardList(cards).forEach(function (card) {
      if (isBank(card)) return;                                  // ПРАВИЛО 1: банк игнорируется
      if (skip && skip.has(card.id)) return;
      if (onlyGroup && derivedGroup(card) !== onlyGroup) return;
      dueDirections(card, today).forEach(function (dir) {
        if (onlyDir && onlyDir !== dir) return;
        items.push(makeItem(card, dir, today, salt, 'review'));
      });
    });

    return applyLimit(spreadSameCard(dedupeByKey(items).sort(compareItems), opts.gap), opts.limit);
  }

  /**
   * Очередь изучения: слова из Банка, каждое даёт ОБА направления, с чередованием,
   * чтобы стороны одного слова шли не подряд и обе были продежурены в одном уроке.
   * opts: { seed, limit (слов), excludeIds, gap }
   */
  function buildLearnQueue(cards, today, opts) {
    opts = opts || {};
    var salt = opts.seed !== undefined ? opts.seed : (today + '|learn|v' + SCHEMA_VERSION);
    var limit = (Number.isFinite(opts.limit) && opts.limit > 0) ? opts.limit : DEFAULTS.learnBatchLimit;
    var skip = excludeSet(opts.excludeIds);

    var bank = cardList(cards).filter(function (c) {
      return isBank(c) && !(skip && skip.has(c.id));
    });
    var words = seededShuffle(bank, fnv1a(String(salt))).slice(0, limit);

    var items = [];
    words.forEach(function (card) {
      DIRECTIONS.forEach(function (dir) { items.push(makeItem(card, dir, today, salt, 'learn')); });
    });
    return spreadSameCard(items, opts.gap);
  }

  /** Без фильтра по сроку: все ACTIVE (бывший режим 'mixed'). opts: {group, direction, limit, seed, gap} */
  function buildCramQueue(cards, today, opts) {
    opts = opts || {};
    var salt = opts.seed !== undefined ? opts.seed : (today + '|cram|v' + SCHEMA_VERSION);
    var onlyGroup = (opts.group && opts.group !== 'all') ? String(opts.group).toUpperCase() : null;
    var onlyDir = opts.direction ? normalizeDir(opts.direction) : null;
    var items = [];

    cardList(cards).forEach(function (card) {
      if (isBank(card)) return;
      if (onlyGroup && derivedGroup(card) !== onlyGroup) return;
      DIRECTIONS.forEach(function (dir) {
        if (onlyDir && onlyDir !== dir) return;
        items.push(makeItem(card, dir, today, salt, 'cram'));
      });
    });
    return applyLimit(spreadSameCard(dedupeByKey(items).sort(compareItems), opts.gap), opts.limit);
  }

  /**
   * Очередь произвольного набора (партия импорта / часть речи / своя группа / одно слово).
   * opts: { allDirections, fallbackAllDirections, direction, limit, seed, gap, includeBank }
   */
  function buildSubsetQueue(subset, today, opts) {
    opts = opts || {};
    var salt = opts.seed !== undefined ? opts.seed : (today + '|subset|v' + SCHEMA_VERSION);
    var onlyDir = opts.direction ? normalizeDir(opts.direction) : null;
    var items = [];

    cardList(subset).forEach(function (card) {
      if (isBank(card) && !opts.includeBank) return;
      var dirs = opts.allDirections ? DIRECTIONS.slice() : dueDirections(card, today);
      if (!dirs.length && opts.fallbackAllDirections) dirs = DIRECTIONS.slice();
      dirs.forEach(function (dir) {
        if (onlyDir && onlyDir !== dir) return;
        items.push(makeItem(card, dir, today, salt, isBank(card) ? 'learn' : 'review'));
      });
    });
    return applyLimit(spreadSameCard(dedupeByKey(items).sort(compareItems), opts.gap), opts.limit);
  }

  /* ============================= 9. АНАЛИТИКА ============================= */

  function zeroHist() { return [0, 0, 0, 0, 0, 0, 0]; }

  function summarize(cards, today) {
    var list = cardList(cards);
    var groups = { BANK: 0, NEW: 0, LEARNING: 0, FAMILIAR: 0, CONFIDENT: 0, MASTERED: 0 };
    var levels = { en_ru: zeroHist(), ru_en: zeroHist() };
    var dueByDirection = { en_ru: 0, ru_en: 0 };
    var bank = 0, active = 0, dueCards = 0, dueEntries = 0, overdueEntries = 0, mastered = 0, brokenDates = 0;
    var asymmetry = { pairs: 0, lagGe2: 0, lagGe3: 0, worst: [] };

    list.forEach(function (card) {
      if (isBank(card)) { bank++; groups.BANK++; return; }
      active++;
      var g = derivedGroup(card);
      groups[g] = num(groups[g]) + 1;
      if (g === 'MASTERED') mastered++;

      DIRECTIONS.forEach(function (dir) {
        levels[dir][directionLevel(card, dir)]++;
        if (!isDateStr(card[dueKey(dir)])) brokenDates++;
        if (isDirectionDue(card, dir, today)) {
          dueByDirection[dir]++;
          dueEntries++;
          var due = directionDueDate(card, dir);
          if (due !== null && num(diffDays(today, due)) > 0) overdueEntries++;
        }
      });
      if (dueDirections(card, today).length) dueCards++;

      var gap = Math.abs(directionLevel(card, 'en_ru') - directionLevel(card, 'ru_en'));
      if (gap >= 2) asymmetry.lagGe2++;
      if (gap >= 3) {
        asymmetry.lagGe3++;
        asymmetry.worst.push({
          id: card.id, word: card.word, gap: gap,
          en: directionLevel(card, 'en_ru'), ru: directionLevel(card, 'ru_en')
        });
      }
    });

    asymmetry.pairs = asymmetry.lagGe2;
    asymmetry.worst.sort(function (a, b) { return b.gap - a.gap || String(a.word).localeCompare(String(b.word)); });
    asymmetry.worst = asymmetry.worst.slice(0, 10);

    return {
      today: today,
      total: list.length,
      bank: bank,
      active: active,
      dueCards: dueCards,
      dueEntries: dueEntries,
      overdueEntries: overdueEntries,
      brokenDates: brokenDates,
      dueByDirection: dueByDirection,
      groups: groups,
      levels: levels,
      asymmetry: asymmetry,
      masteredShare: active ? Math.round((mastered / active) * 100) : 0
    };
  }

  /** Данные для бейджа карточки/плитки. lang: 'ru' | 'en'. */
  function describeDirection(card, dir, today, lang) {
    var d = normalizeDir(dir);
    var ru = lang !== 'en';
    var lvl = directionLevel(card, d);
    var group = groupForLevel(lvl);
    var meta = GROUP_META[group];
    var dm = DIRECTION_META[d];
    var due = directionDueDate(card, d);
    var bucket, phrase, days = 0;

    if (isBank(card)) {
      bucket = 'bank';
      phrase = ru ? 'в банке' : 'in the bank';
    } else if (due === null) {
      bucket = 'today';
      phrase = ru ? 'повтори сегодня' : 'review today';
    } else {
      var delta = num(diffDays(due, today));                  // >0 = ещё не пора
      days = Math.abs(delta);
      bucket = delta < 0 ? 'overdue' : (delta === 0 ? 'today' : 'future');
      if (ru) {
        phrase = bucket === 'overdue'
          ? 'просрочено на ' + days + ' ' + pluralRu(days, 'день', 'дня', 'дней')
          : bucket === 'today' ? 'повтори сегодня'
            : 'вернётся через ' + days + ' ' + pluralRu(days, 'день', 'дня', 'дней');
      } else {
        phrase = bucket === 'overdue' ? days + 'd overdue'
          : bucket === 'today' ? 'review today'
            : 'back in ' + days + 'd';
      }
    }

    return {
      direction: d,
      label: ru ? dm.ru : dm.short,
      short: dm.short,
      full: dm.full,
      flag: dm.flag,
      level: lvl,
      levelLabel: 'L' + lvl,
      group: group,
      groupLabel: ru ? meta.ru : meta.en,
      color: meta.color,
      intervalDays: INTERVALS[lvl],
      dueDate: due,
      overdueDays: bucket === 'overdue' ? days : 0,
      bucket: bucket,
      phrase: phrase,
      pips: pipString(lvl),
      cssClass: 'grp-' + group.toLowerCase()
    };
  }

  /** Обе стороны одной карточки одним объектом — для словаря и подсказок. */
  function describeCard(card, today, lang) {
    var g = derivedGroup(card);
    return {
      group: g,
      groupLabel: lang === 'en' ? GROUP_META[g].en : GROUP_META[g].ru,
      enRu: describeDirection(card, 'en_ru', today, lang),
      ruEn: describeDirection(card, 'ru_en', today, lang),
      dueNow: dueDirections(card, today)
    };
  }

  /* ======================= 10. СЛИЯНИЕ ДВУХ ЗАПИСЕЙ ======================= */

  function earlierDate(a, b) {
    var ea = toEpochDays(a), eb = toEpochDays(b);
    if (ea === null) return isDateStr(b) ? b : null;
    if (eb === null) return a;
    return ea <= eb ? a : b;
  }

  /**
   * Слияние двух записей одного слова (дубликаты, восстановление бэкапа).
   * Прогресс НЕ теряется: уровень = max по каждому направлению отдельно,
   * дата — у победившего уровня (при равенстве уровней берём более раннюю,
   * чтобы не пропустить повторение). Контент дозаполняется, не перезаписывается.
   */
  function mergeRecords(a, b, today) {
    if (!a || typeof a !== 'object') return b;
    if (!b || typeof b !== 'object') return a;
    var day = isDateStr(today) ? today : todayString();
    var m = clone(a);

    Object.keys(b).forEach(function (k) {
      if (DEPRECATED_FIELDS.indexOf(k) !== -1) return;
      if (isEmpty(m[k]) && !isEmpty(b[k])) m[k] = b[k];       // дозаполнение пустот
    });

    m.id = a.id;                                              // id победителя не меняется
    m.status = (a.status === STATUS.ACTIVE || b.status === STATUS.ACTIVE) ? STATUS.ACTIVE : STATUS.BANK;

    DIRECTIONS.forEach(function (dir) {
      var la = isValidLevel(a[levelKey(dir)]) ? a[levelKey(dir)] : 0;
      var lb = isValidLevel(b[levelKey(dir)]) ? b[levelKey(dir)] : 0;
      var lv = Math.max(la, lb);
      m[levelKey(dir)] = lv;
      if (m.status === STATUS.BANK) { m[dueKey(dir)] = null; return; }
      var da = isDateStr(a[dueKey(dir)]) ? a[dueKey(dir)] : null;
      var db = isDateStr(b[dueKey(dir)]) ? b[dueKey(dir)] : null;
      var chosen = (la === lb) ? earlierDate(da, db) : (lv === la ? da : db);
      m[dueKey(dir)] = isDateStr(chosen) ? chosen : addDays(day, INTERVALS[lv]);
    });

    m.fail_count = Math.max(num(a.fail_count), num(b.fail_count));
    m.review_count = Math.max(num(a.review_count), num(b.review_count));
    if (isDateStr(a.created_at) && isDateStr(b.created_at)) m.created_at = earlierDate(a.created_at, b.created_at);
    stripDeprecated(m);
    finalizeContent(m);
    return m;
  }

  /* ===================== 11. МИГРАЦИЯ V1 (коробки) → V2 ==================== */

  /** Свидетельство направления: живая дата last_tested_* первична, булев флаг вторичен.
   *  (Аудит данных: eng_to_rus && rus_to_eng истинн для 0 из 198 карточек — гейт мёртв.) */
  function hasEvidence(card, dir) {
    var ev = EVIDENCE_FIELDS[normalizeDir(dir)];
    var t = card[ev.tested];
    if (typeof t === 'string' && t.trim()) return true;
    if (t && typeof t !== 'string') return true;
    return !!card[ev.flag];
  }

  function legacyBaseOf(raw) {
    if (!isEmpty(raw.box)) {
      var key = String(raw.box).trim().toLowerCase();
      if (key === 'archive') return { base: MAX_LEVEL, archive: true, from: 'box' };
      if (key === 'bank') return { base: 0, archive: false, from: 'box' };
      if (BOX_TO_LEVEL[key] !== undefined) return { base: BOX_TO_LEVEL[key], archive: key === '6', from: 'box' };
      var n = Number(raw.box);
      if (Number.isFinite(n)) {
        var r = Math.round(n);
        if (r > 5) return { base: 5, archive: false, from: 'box', issue: 'box-out-of-range:' + raw.box };
        if (r < 0) return { base: MIN_REST_LEVEL, archive: false, from: 'box', issue: 'box-negative:' + raw.box };
        return { base: clampLevel(r), archive: false, from: 'box' };
      }
      return { base: null, archive: false, from: 'box', issue: 'box-unparseable:' + JSON.stringify(raw.box) };
    }
    if (!isEmpty(raw.srsStage)) {
      var st = String(raw.srsStage).trim().toLowerCase();
      if (STAGE_TO_LEVEL[st] !== undefined) return { base: STAGE_TO_LEVEL[st], archive: st === 'mastered', from: 'stage' };
      return { base: null, archive: false, from: 'stage', issue: 'stage-unparseable:' + st };
    }
    return { base: null, archive: false, from: null };
  }

  /**
   * Одна карточка ЛЮБОГО формата → канон v2. Входной объект не мутируется.
   * Возвращает { card, migrated, source: 'native'|'hybrid'|'legacy'|'synth'|'junk', issues }.
   */
  function normalizeCard(raw, today, opts) {
    opts = opts || {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { card: null, migrated: false, source: 'junk', issues: ['not-an-object'] };
    }
    if (!isDateStr(today)) throw new TypeError('SRS.normalizeCard: today не дата — ' + JSON.stringify(today));

    var c = clone(raw);
    var issues = [];

    var hasV2 = isValidLevel(raw.level_en_ru) || isValidLevel(raw.level_ru_en)
      || raw.status === STATUS.ACTIVE || raw.status === STATUS.BANK
      || isDateStr(raw.next_review_en_ru) || isDateStr(raw.next_review_ru_en);
    var hasV1 = ('box' in raw) || ('next_review_date' in raw) || ('srsStage' in raw)
      || ('eng_to_rus' in raw) || ('rus_to_eng' in raw) || ('repetitions' in raw)
      || ('easeFactor' in raw) || ('dueDate' in raw) || ('interval' in raw)
      || ('last_tested_eng' in raw) || ('last_tested_rus' in raw);

    /* (1) Чистая v2-запись: клампинг, ремонт дат, срезка мёртвых полей. */
    if (hasV2 && !hasV1) {
      c.status = c.status === STATUS.ACTIVE ? STATUS.ACTIVE : STATUS.BANK;
      c.level_en_ru = clampLevel(c.level_en_ru);
      c.level_ru_en = clampLevel(c.level_ru_en);
      if (c.status === STATUS.BANK) { c.next_review_en_ru = null; c.next_review_ru_en = null; }
      else repairDates(c, today, issues);
      stripDeprecated(c);
      finalizeContent(c);
      return { card: c, migrated: false, source: 'native', issues: issues };
    }

    /* (2) Помесь v1+v2: побеждает v2, box выбрасывается БЕЗ пересчёта уровней —
       иначе реально выученное слово откатилось бы назад из-за остаточного поля. */
    if (hasV2 && hasV1) {
      issues.push('half-migrated:v2-wins');
      c.status = c.status === STATUS.ACTIVE ? STATUS.ACTIVE : STATUS.BANK;
      if (!isValidLevel(raw.level_en_ru)) { c.level_en_ru = 0; issues.push('level_en_ru:reset'); }
      else c.level_en_ru = clampLevel(c.level_en_ru);
      if (!isValidLevel(raw.level_ru_en)) { c.level_ru_en = 0; issues.push('level_ru_en:reset'); }
      else c.level_ru_en = clampLevel(c.level_ru_en);
      if (c.status === STATUS.BANK) { c.next_review_en_ru = null; c.next_review_ru_en = null; }
      else repairDates(c, today, issues);
      stripDeprecated(c);
      finalizeContent(c);
      return { card: c, migrated: true, source: 'hybrid', issues: issues };
    }

    /* (3) Чистая старая модель → конвертация. */
    if (hasV1) {
      convertLegacy(c, today, issues, opts);
      stripDeprecated(c);
      finalizeContent(c);
      return { card: c, migrated: true, source: 'legacy', issues: issues };
    }

    /* (4) Ни расписания, ни коробки → свежий контент, строго в банк. */
    c.status = STATUS.BANK;
    c.level_en_ru = 0;
    c.level_ru_en = 0;
    c.next_review_en_ru = null;
    c.next_review_ru_en = null;
    c.fail_count = num(c.fail_count);
    c.review_count = num(c.review_count);
    issues.push('no-schedule-fields:banked');
    stripDeprecated(c);
    finalizeContent(c);
    return { card: c, migrated: true, source: 'synth', issues: issues };
  }

  function convertLegacy(c, today, issues, opts) {
    var info = legacyBaseOf(c);
    if (info.issue) issues.push(info.issue);
    var base = info.base;

    c.fail_count = num(c.fail_count);

    if (base === null) {                                   // полная тишина → считаем новым словом
      c.status = STATUS.BANK;
      c.level_en_ru = 0;
      c.level_ru_en = 0;
      c.next_review_en_ru = null;
      c.next_review_ru_en = null;
      c.review_count = 0;
      issues.push('no-evidence:banked');
      return;
    }

    if (base === 0) {                                      // коробка 0 / 'bank' → изоляция
      c.status = STATUS.BANK;
      c.level_en_ru = 0;
      c.level_ru_en = 0;
      c.next_review_en_ru = null;
      c.next_review_ru_en = null;
      c.review_count = num(c.repetitions);
      if (hasEvidence(c, 'en_ru') || hasEvidence(c, 'ru_en')) issues.push('bank_with_attestation');
      return;
    }

    var exempt = info.archive && !opts.penalizeArchive;     // 'archive'/6 = «выучено целиком»

    DIRECTIONS.forEach(function (dir) {
      var lv;
      if (exempt) lv = MAX_LEVEL;
      else if (hasEvidence(c, dir)) lv = base;
      else lv = Math.max(MIN_REST_LEVEL, base - 1);         // непроверенное направление не наследует длинный интервал
      c[levelKey(dir)] = clampLevel(lv);
      if (lv !== base) issues.push('penalized:' + dir);
    });

    c.status = STATUS.ACTIVE;
    c.review_count = Number.isFinite(c.repetitions) ? num(c.repetitions) : Math.max(0, base);

    /* Даты. 'stagger' (по умолчанию): долг просрочки заряжается РОВНО ОДИН РАЗ на слово —
       на самое слабое направление; сильное получает свежий интервал. Иначе в день апгрейда
       объём сессии удваивался бы (218 записей вместо 109 на реальной базе).
       'fresh': всё с сегодняшнего дня, задолженность прощается. */
    var legacyDue = isDateStr(c.next_review_date) ? c.next_review_date : null;
    var debt = (legacyDue !== null && num(diffDays(today, legacyDue)) > 0) ? legacyDue : null;
    var weaker = c.level_en_ru <= c.level_ru_en ? 'en_ru' : 'ru_en';   // ничья → en_ru (детерминированно)

    DIRECTIONS.forEach(function (dir) {
      var cadence = addDays(today, INTERVALS[c[levelKey(dir)]]);
      var useDebt = opts.duePolicy !== 'fresh' && debt !== null && dir === weaker;
      c[dueKey(dir)] = useDebt ? debt : cadence;
    });
    if (debt !== null) issues.push('overdue-carried:' + debt);
  }

  function repairDates(c, today, issues) {
    DIRECTIONS.forEach(function (dir) {
      var k = dueKey(dir);
      if (isDateStr(c[k])) return;
      var created = isDateStr(c.created_at) ? c.created_at : null;
      c[k] = (created !== null && num(diffDays(created, today)) > 0) ? created : today;
      issues.push('date-repaired:' + k);
    });
  }

  function stripDeprecated(c) {
    var dropped = [];
    DEPRECATED_FIELDS.forEach(function (f) {
      if (f in c) { delete c[f]; dropped.push(f); }
    });
    return dropped;
  }

  /** Контент сохраняем байт-в-байт (включая массивы part_of_speech — аудит: их 9). */
  function finalizeContent(c) {
    if (!c.id || typeof c.id !== 'string') c.id = syntheticId(c);
    if (typeof c.word !== 'string') c.word = isEmpty(c.word) ? '' : String(c.word);
    if (typeof c.translation !== 'string') c.translation = isEmpty(c.translation) ? '' : String(c.translation);
    ['phonetic', 'example', 'example_translation', 'batch_id', 'batch_name'].forEach(function (k) {
      if (typeof c[k] !== 'string') c[k] = isEmpty(c[k]) ? '' : String(c[k]);
    });
    if (isEmpty(c.part_of_speech) && !isEmpty(c.partOfSpeech)) c.part_of_speech = c.partOfSpeech;
    if (isEmpty(c.partOfSpeech) && !isEmpty(c.part_of_speech)) c.partOfSpeech = c.part_of_speech;
    if (isEmpty(c.phonetic) && typeof c.transcription === 'string') c.phonetic = c.transcription;
    c.fail_count = num(c.fail_count);
    c.review_count = num(c.review_count);
    return c;
  }

  function syntheticId(c) {
    return 'card_mig_' + fnv1a(String(c.word || '') + '|' + String(c.created_at || '') + '|' + String(c.translation || '')).toString(36);
  }

  /** Никакая миграция не имеет права потерять слово. */
  function assertNoCardLoss(beforeIds, afterCards) {
    var before = Array.isArray(beforeIds) ? beforeIds.filter(Boolean) : [];
    var after = (afterCards || []).map(function (c) { return c && c.id; });
    var afterSet = new Set(after);
    var lost = before.filter(function (id) { return !afterSet.has(id); });
    if (lost.length) {
      throw new Error('CARD LOSS DETECTED: ' + lost.length + ' — ' + lost.slice(0, 5).join(', '));
    }
    if (after.length !== before.length) {
      throw new Error('CARD COUNT CHANGED: ' + before.length + ' → ' + after.length);
    }
    return true;
  }

  /**
   * Миграция всей базы. Идемпотентна (второй прогон: migratedCount === 0),
   * без потерь (assertNoCardLoss) и бесшовна для корня: незнакомые ключи
   * (settings, deleted_ids, …) выживают благодаря spread, а не белому списку.
   */
  function migrateState(state, today, opts) {
    opts = opts || {};
    if (!state || typeof state !== 'object') throw new TypeError('SRS.migrateState: состояние не объект');
    if (!isDateStr(today)) throw new TypeError('SRS.migrateState: today не дата — ' + JSON.stringify(today));

    var report = {
      today: today,
      scanned: 0, migrated: 0, alreadyCurrent: 0, junk: 0,
      bySource: { native: 0, legacy: 0, hybrid: 0, synth: 0, junk: 0 },
      byStatus: { ACTIVE: 0, BANK: 0 },
      byGroup: { BANK: 0, NEW: 0, LEARNING: 0, FAMILIAR: 0, CONFIDENT: 0, MASTERED: 0 },
      levelHist: { en_ru: zeroHist(), ru_en: zeroHist() },
      penalized: { en_ru: 0, ru_en: 0 },
      overdueCarried: 0,
      droppedFields: {},
      collisions: [],
      issues: []
    };

    var input = Array.isArray(state.cards) ? state.cards : [];
    report.scanned = input.length;
    var beforeIds = input.filter(function (c) { return c && c.id; }).map(function (c) { return c.id; });

    var out = [];
    var byId = new Map();
    var byCombo = new Map();

    input.forEach(function (raw, index) {
      var res = normalizeCard(raw, today, opts);
      if (!res.card) { report.junk++; report.bySource.junk++; report.issues.push('junk@' + index); return; }

      report.bySource[res.source] = num(report.bySource[res.source]) + 1;
      if (res.source === 'native') report.alreadyCurrent++; else report.migrated++;

      DEPRECATED_FIELDS.forEach(function (f) {
        if (raw && typeof raw === 'object' && (f in raw)) report.droppedFields[f] = num(report.droppedFields[f]) + 1;
      });

      res.issues.forEach(function (iss) {
        if (iss === 'penalized:en_ru') report.penalized.en_ru++;
        else if (iss === 'penalized:ru_en') report.penalized.ru_en++;
        else if (iss.indexOf('overdue-carried:') === 0) report.overdueCarried++;
        if (report.issues.length < 200) report.issues.push((res.card.id || ('@' + index)) + ': ' + iss);
      });

      var card = res.card;

      var prev = byId.get(card.id);
      if (prev) {                                            // дубль id → сливаем, никто не теряется
        var at = out.findIndex(function (x) { return x.id === prev.id; });
        var mergedId = mergeRecords(prev, card, today);
        if (at >= 0) out[at] = mergedId; else out.push(mergedId);
        byId.set(prev.id, mergedId);
        report.collisions.push({ kind: 'id', word: mergedId.word, ids: [prev.id, card.id] });
        return;
      }

      /* Слово + перевод = настоящий дубликат. Омографы с РАЗНЫМ значением не
         схлопываем: в реальной базе «resilience» дважды с разным переводом — обе живут. */
      var combo = String(card.word || '').trim().toLowerCase() + '\u0000' + String(card.translation || '').trim().toLowerCase();
      var twinId = card.word ? byCombo.get(combo) : undefined;
      if (twinId !== undefined) {
        var ix = out.findIndex(function (x) { return x.id === twinId; });
        if (ix >= 0) {
          out[ix] = mergeRecords(out[ix], card, today);
          byId.set(twinId, out[ix]);
          report.collisions.push({ kind: 'word+translation', word: card.word, ids: [twinId, card.id] });
          return;
        }
      }

      byId.set(card.id, card);
      if (card.word) byCombo.set(combo, card.id);
      out.push(card);
    });

    /* Корень пересобираем ЧЕРЕЗ spread: незнакомые ключи (settings, tombstones…) выживают. */
    var next = clone(state);
    next.cards = out;
    next.schema_version = SCHEMA_VERSION;
    if (report.migrated > 0 && !isDateStr(next.migrated_at)) next.migrated_at = today;

    out.forEach(function (c) {
      var g = derivedGroup(c);
      report.byStatus[c.status] = num(report.byStatus[c.status]) + 1;
      report.byGroup[g] = num(report.byGroup[g]) + 1;
      DIRECTIONS.forEach(function (dir) { report.levelHist[dir][directionLevel(c, dir)]++; });
    });

    /* Настоящие дубликаты (слово+перевод) могут законно уменьшить счётчик —
       поэтому проверяем потери по id, а не по длине. */
    var afterIds = out.map(function (c) { return c.id; });
    var lostIds = beforeIds.filter(function (id) { return afterIds.indexOf(id) === -1; });
    var explained = new Set();
    report.collisions.forEach(function (col) { (col.ids || []).forEach(function (id) { explained.add(id); }); });
    var unexplained = lostIds.filter(function (id) { return !explained.has(id); });
    if (unexplained.length) {
      throw new Error('CARD LOSS DETECTED: ' + unexplained.length + ' — ' + unexplained.slice(0, 5).join(', '));
    }
    report.lostIds = lostIds;
    report.keptCount = out.length;

    return { state: next, migratedCount: report.migrated, report: report };
  }

  /* ========================== 12. ВАЛИДАЦИЯ =============================== */

  function validateCard(card, today) {
    var errors = [], warnings = [];
    if (!card || typeof card !== 'object') return { ok: false, errors: ['not-an-object'], warnings: warnings };

    if (typeof card.id !== 'string' || !card.id) errors.push('id-missing');
    if (card.status !== STATUS.ACTIVE && card.status !== STATUS.BANK) errors.push('status-invalid:' + card.status);

    DIRECTIONS.forEach(function (dir) {
      var lv = card[levelKey(dir)];
      if (!isValidLevel(lv)) errors.push(levelKey(dir) + '-invalid:' + JSON.stringify(lv));
      var due = card[dueKey(dir)];
      if (card.status === STATUS.BANK) {
        if (due !== null && due !== undefined) errors.push(dueKey(dir) + '-must-be-null-in-bank');
      } else {
        if (!isDateStr(due)) errors.push(dueKey(dir) + '-unparseable:' + JSON.stringify(due));
        else if (isDateStr(today)) {
          var ahead = num(diffDays(due, today));
          if (ahead > INTERVALS[MAX_LEVEL]) warnings.push(dueKey(dir) + '-too-far:' + due);
          if (isDateStr(card.created_at) && num(diffDays(card.created_at, due)) > 0) warnings.push(dueKey(dir) + '-before-created');
        }
      }
      // Аудит L7: мусорный штамп last_review молча выключал бы guard (fail-open) —
      // делаем повреждение видимым хотя бы в warnings.
      var lr = card[lastKey(dir)];
      if (lr !== null && lr !== undefined && !isDateStr(lr)) {
        warnings.push(lastKey(dir) + '-invalid:' + JSON.stringify(lr));
      }
    });

    DEPRECATED_FIELDS.forEach(function (f) {
      if (f in card) errors.push('deprecated-field:' + f);
    });

    if (isEmpty(card.word)) warnings.push('word-empty');
    if (isEmpty(card.translation)) warnings.push('translation-empty');

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  /**
   * validateState(next, prev, opts) — страж перед записью.
   * opts: { today, allowShrink, removedIds, shrinkThreshold, maxErrors }
   * Отказывает в сохранении при необъяснённой потере id, массовом сжатии,
   * дубликатах id и любой битой карточке.
   */
  function validateState(next, prev, opts) {
    opts = opts || {};
    var today = isDateStr(opts.today) ? opts.today : todayString();
    var errors = [], warnings = [];
    var maxErrors = Number.isFinite(opts.maxErrors) ? opts.maxErrors : 25;

    if (!next || typeof next !== 'object') return { ok: false, errors: ['state-not-object'], warnings: warnings, shrinkRatio: null, removedIds: [] };
    var cards = Array.isArray(next.cards) ? next.cards : null;
    if (!cards) return { ok: false, errors: ['cards-not-array'], warnings: warnings, shrinkRatio: null, removedIds: [] };

    var seen = new Set(), dupes = [];
    cards.forEach(function (c, i) {
      var v = validateCard(c, today);
      if (!v.ok) {
        v.errors.forEach(function (e) {
          if (errors.length < maxErrors) errors.push('card[' + i + ']' + (c && c.id ? '(' + c.id + ')' : '') + ': ' + e);
        });
      }
      v.warnings.forEach(function (w) {
        if (warnings.length < maxErrors) warnings.push('card[' + i + ']' + (c && c.id ? '(' + c.id + ')' : '') + ': ' + w);
      });
      var id = c && c.id;
      if (typeof id === 'string' && id) {
        if (seen.has(id)) dupes.push(id);
        seen.add(id);
      }
    });
    dupes.forEach(function (id) {
      if (errors.length < maxErrors) errors.push('duplicate-id:' + id);
    });

    var removedIds = [], shrinkRatio = null;
    if (prev && Array.isArray(prev.cards)) {
      var beforeIds = prev.cards.filter(function (c) { return c && c.id; }).map(function (c) { return c.id; });
      removedIds = beforeIds.filter(function (id) { return !seen.has(id); });
      shrinkRatio = beforeIds.length ? cards.length / beforeIds.length : 1;

      var allowed = new Set(Array.isArray(opts.removedIds) ? opts.removedIds : []);
      var unexplained = removedIds.filter(function (id) { return !allowed.has(id); });
      if (unexplained.length && !opts.allowShrink) {
        errors.push('UNEXPLAINED-LOSS:' + unexplained.length + ' (' + unexplained.slice(0, 5).join(', ') + ')');
      }
      var threshold = Number.isFinite(opts.shrinkThreshold) ? opts.shrinkThreshold : DEFAULTS.shrinkThreshold;
      if (shrinkRatio < threshold && !opts.allowShrink) {
        errors.push('SHRINK-OVER-LIMIT:' + beforeIds.length + '→' + cards.length + ' (' + Math.round(shrinkRatio * 100) + '%)');
      } else if (removedIds.length) {
        warnings.push('count-shrank:' + beforeIds.length + '→' + cards.length);
      }
      if (cards.length > beforeIds.length) warnings.push('count-grew:' + beforeIds.length + '→' + cards.length);
    }

    if (next.schema_version !== undefined && Number(next.schema_version) > SUPPORTED_SCHEMA_MAX) {
      errors.push('schema-too-new:' + next.schema_version);
    }

    return { ok: errors.length === 0, errors: errors, warnings: warnings, shrinkRatio: shrinkRatio, removedIds: removedIds, count: cards.length };
  }

  /* Порядок ключей фиксируем, чтобы git-diff базы не шумел на каждом сохранении. */
  var CARD_KEY_ORDER = [
    'id', 'word', 'phonetic', 'translation', 'example', 'example_translation',
    'part_of_speech', 'partOfSpeech', 'batch_id', 'batch_name', 'created_at',
    'status', 'level_en_ru', 'next_review_en_ru', 'level_ru_en', 'next_review_ru_en',
    'fail_count', 'review_count'
  ];
  var ROOT_KEY_ORDER = [
    'schema_version', 'saved_at', 'migrated_at', 'cards', 'history', 'streak',
    'activity', 'custom_groups', 'settings', 'deleted_ids'
  ];

  function orderKeys(obj, preferred) {
    var out = {};
    preferred.forEach(function (k) { if (k in obj) out[k] = obj[k]; });
    Object.keys(obj).sort().forEach(function (k) { if (!(k in out)) out[k] = obj[k]; });
    return out;
  }

  /** Сериализация с фиксированным порядком ключей. Часы не читает: saved_at передаёт вызывающий. */
  function serializeState(state, opts) {
    opts = opts || {};
    var src = state && typeof state === 'object' ? state : {};
    var root = clone(src);
    root.schema_version = SCHEMA_VERSION;
    if (opts.savedAt) root.saved_at = opts.savedAt;
    root.cards = (Array.isArray(root.cards) ? root.cards : []).map(function (c) {
      var clean = clone(c);
      stripDeprecated(clean);
      return orderKeys(clean, CARD_KEY_ORDER);
    });
    return JSON.stringify(orderKeys(root, ROOT_KEY_ORDER), null, 2);
  }

  /* ====================== 13. КОНТЕЙНЕР СЕССИИ ============================ */
  /* Сессия живёт только в памяти и никогда не persists. Единственный её смысл —
     не показывать одну и ту же пару (слово:направление) дважды и не зациклиться
     на «забытом» слове. */

  function createSession(items, opts) {
    opts = opts || {};
    var list = Array.isArray(items) ? items.slice() : [];
    return {
      mode: opts.mode || 'review',
      today: isDateStr(opts.today) ? opts.today : null,
      seed: opts.seed,
      items: list,
      order: list.map(function (it) { return it.key; }),
      cursor: 0,
      graded: Object.create(null),      // key → { answer, at, repeats }
      skipped: Object.create(null),     // key → count
      requeued: Object.create(null),    // key → count
      startedAt: opts.startedAt || null
    };
  }

  function sessionCurrent(s) {
    if (!s || !Array.isArray(s.items)) return null;
    while (s.cursor < s.items.length && s.graded[s.items[s.cursor].key]) s.cursor++;
    return s.cursor < s.items.length ? s.items[s.cursor] : null;
  }

  function sessionRemaining(s) {
    if (!s || !Array.isArray(s.items)) return 0;
    var n = 0;
    for (var i = s.cursor; i < s.items.length; i++) if (!s.graded[s.items[i].key]) n++;
    return n;
  }

  function sessionAdvance(s) { if (s) s.cursor++; }

  function sessionIsGraded(s, key) { return !!(s && s.graded && s.graded[key]); }

  function sessionMarkGraded(s, key, answer, direction) {
    if (!s) return;
    s.graded[key] = { answer: answer, direction: direction || null, at: s.today || null };
  }

  /**
   * «Забыл» внутри сессии: слово возвращается в хвост (через requeueDelay),
   * но не более maxRepeatsPerSession раз. Возвращает 'requeued' | 'capped'.
   */
  function sessionRequeue(s, item, opts) {
    if (!s || !item) return 'capped';
    opts = opts || {};
    var key = item.key;
    var cap = Number.isFinite(opts.maxRepeats) ? opts.maxRepeats : DEFAULTS.maxRepeatsPerSession;
    var used = num(s.requeued[key]);
    if (used >= cap) return 'capped';
    s.requeued[key] = used + 1;
    var delay = Number.isFinite(opts.delay) ? Math.max(1, Math.round(opts.delay)) : DEFAULTS.requeueDelay;
    var copy = clone(item);
    copy.kind = 'requeue';
    copy.repeat = used + 1;
    var at = Math.min(s.items.length, s.cursor + delay);
    s.items.splice(at, 0, copy);
    s.order.splice(at, 0, key);
    return 'requeued';
  }

  /** Пропуск без оценки: один раз в хвост, второй раз — убираем из сессии (слово останется должным завтра). */
  function sessionSkip(s, key) {
    if (!s || !key) return 'ignored';
    var n = num(s.skipped[key]);
    s.skipped[key] = n + 1;
    var idx = -1;
    for (var i = s.cursor; i < s.items.length; i++) {
      if (s.items[i].key === key) { idx = i; break; }
    }
    if (idx === -1) return 'absent';
    var item = s.items.splice(idx, 1)[0];
    if (n === 0) {
      // Инвариант «order зеркалит items»: сначала вынимаем ключ со СТАРОЙ позиции
      // (без этого первый же skip рассинхронизировал массивы — order рос на призрак),
      // затем добавляем в хвост обоих массивов.
      var oiFirst = s.order.indexOf(key);
      if (oiFirst !== -1) s.order.splice(oiFirst, 1);
      s.items.push(clone(item));
      s.order.push(key);
      return 'moved-to-tail';
    }
    var oi = s.order.indexOf(key);
    if (oi !== -1) s.order.splice(oi, 1);
    return 'removed';
  }

  /** Повторный показ пары в той же сессии запрещён (инвариант A3/A7). */
  function sessionEnsure(s, card, dirs, today, kind) {
    if (!s || !card || !card.id) return [];
    var added = [];
    (Array.isArray(dirs) ? dirs : []).forEach(function (dir) {
      var d = normalizeDir(dir);
      var key = sessionKey(card.id, d);
      if (s.graded[key]) return;
      for (var i = 0; i < s.items.length; i++) {
        if (s.items[i].key === key) return;                  // идемпотентная вставка (A4)
      }
      var item = makeItem(card, d, today || s.today, s.seed || (today + '|ensure'), kind || 'learn');
      var at = Math.min(s.items.length, s.cursor + DEFAULTS.sameCardGap);
      s.items.splice(at, 0, item);
      s.order.splice(at, 0, key);
      added.push(key);
    });
    return added;
  }

  function sessionStats(s) {
    var byAnswer = { again: 0, hard: 0, easy: 0 };
    var byDirection = { en_ru: 0, ru_en: 0 };
    var cards = new Set();
    var graded = 0;
    if (s && s.graded) {
      Object.keys(s.graded).forEach(function (key) {
        graded++;
        var rec = s.graded[key];
        if (byAnswer[rec.answer] !== undefined) byAnswer[rec.answer]++;
        if (rec.direction && byDirection[rec.direction] !== undefined) byDirection[rec.direction]++;
        cards.add(key.split(':')[0]);
      });
    }
    return {
      entries: s && Array.isArray(s.items) ? s.items.length : 0,
      graded: graded,
      cards: cards.size,
      remaining: sessionRemaining(s),
      byAnswer: byAnswer,
      byDirection: byDirection,
      skipped: s ? Object.keys(s.skipped || {}).length : 0,
      requeued: s ? Object.keys(s.requeued || {}).length : 0
    };
  }

  /* ========================= 14. ПУБЛИЧНЫЙ API ============================ */

  var api = {
    /* идентификация */
    VERSION: VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    SUPPORTED_SCHEMA_MAX: SUPPORTED_SCHEMA_MAX,

    /* константы модели */
    INTERVALS: freezeDeep(INTERVALS.slice()),
    MAX_LEVEL: MAX_LEVEL,
    MIN_REST_LEVEL: MIN_REST_LEVEL,
    KNOWLEDGE_GROUPS: freezeDeep(KNOWLEDGE_GROUPS),
    BUCKETS: freezeDeep(BUCKETS),
    GROUP_OF_LEVEL: freezeDeep(GROUP_OF_LEVEL),
    LEVELS_OF_GROUP: freezeDeep(LEVELS_OF_GROUP),
    GROUP_RANK: freezeDeep(GROUP_RANK),
    GROUP_META: freezeDeep(GROUP_META),
    STATUS: freezeDeep(STATUS),
    DIRECTIONS: freezeDeep(DIRECTIONS),
    DIRECTION_META: freezeDeep(DIRECTION_META),
    DIRECTION_ALIASES: freezeDeep(DIRECTION_ALIASES),
    ANSWERS: freezeDeep(ANSWERS),
    ANSWER_ORDER: freezeDeep(ANSWER_ORDER),
    ANSWER_META: freezeDeep(ANSWER_META),
    RESET_TABLE: freezeDeep(RESET_TABLE),
    BOX_TO_LEVEL: freezeDeep(BOX_TO_LEVEL),
    STAGE_TO_LEVEL: freezeDeep(STAGE_TO_LEVEL),
    DEFAULTS: freezeDeep(DEFAULTS),
    DEPRECATED_FIELDS: freezeDeep(DEPRECATED_FIELDS),
    CARD_KEY_ORDER: freezeDeep(CARD_KEY_ORDER),
    ROOT_KEY_ORDER: freezeDeep(ROOT_KEY_ORDER),

    /* утилиты */
    posText: posText,
    pluralRu: pluralRu,
    stripBom: stripBom,
    pipString: pipString,

    /* даты */
    parseYMD: parseYMD,
    isDateStr: isDateStr,
    toEpochDays: toEpochDays,
    fromEpochDays: fromEpochDays,
    addDays: addDays,
    diffDays: diffDays,
    todayString: todayString,

    /* уровни и группы */
    clampLevel: clampLevel,
    isValidLevel: isValidLevel,
    groupForLevel: groupForLevel,
    intervalForLevel: intervalForLevel,
    levelsForGroup: levelsForGroup,
    groupRank: groupRank,

    /* направления */
    normalizeDir: normalizeDir,
    otherDir: otherDir,
    levelKey: levelKey,
    dueKey: dueKey,
    directionLevel: directionLevel,
    directionDueDate: directionDueDate,

    /* предикаты */
    isBank: isBank,
    isActive: isActive,
    isDirectionDue: isDirectionDue,
    dueDirections: dueDirections,
    isDue: isDue,
    derivedGroup: derivedGroup,
    derivedRank: derivedRank,
    sessionKey: sessionKey,

    /* изменения */
    activateCard: activateCard,
    returnToBank: returnToBank,
    setCardStatus: setCardStatus,
    setDirectionLevel: setDirectionLevel,
    normalizeAnswer: normalizeAnswer,
    applyAnswer: applyAnswer,
    answerBankCard: answerBankCard,
    newCardSkeleton: newCardSkeleton,

    /* детерминизм */
    fnv1a: fnv1a,
    rngFromSeed: rngFromSeed,
    seededShuffle: seededShuffle,
    spreadSameCard: spreadSameCard,

    /* очереди */
    makeItem: makeItem,
    compareItems: compareItems,
    buildReviewQueue: buildReviewQueue,
    buildLearnQueue: buildLearnQueue,
    buildCramQueue: buildCramQueue,
    buildSubsetQueue: buildSubsetQueue,

    /* аналитика */
    summarize: summarize,
    describeDirection: describeDirection,
    describeCard: describeCard,

    /* миграция и валидация */
    hasEvidence: hasEvidence,
    normalizeCard: normalizeCard,
    mergeRecords: mergeRecords,
    migrateState: migrateState,
    assertNoCardLoss: assertNoCardLoss,
    validateCard: validateCard,
    validateState: validateState,
    serializeState: serializeState,

    /* сессия */
    createSession: createSession,
    sessionCurrent: sessionCurrent,
    sessionRemaining: sessionRemaining,
    sessionAdvance: sessionAdvance,
    sessionIsGraded: sessionIsGraded,
    sessionMarkGraded: sessionMarkGraded,
    sessionRequeue: sessionRequeue,
    sessionSkip: sessionSkip,
    sessionEnsure: sessionEnsure,
    sessionStats: sessionStats
  };

  if (typeof module === 'object' && module && module.exports) module.exports = api;   // Node / тесты
  if (globalScope) globalScope.SRS = api;                                            // браузер и Electron
  return api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
