// Dual-mode helper: Check if running inside Electron or Standard Browser
const isElectron = typeof require !== 'undefined';
let ipcRenderer = null;
if (isElectron) {
  try {
    ipcRenderer = require('electron').ipcRenderer;
  } catch (e) {
    console.log('Running in browser mode');
  }
}

// ==========================================
// STATE MANAGEMENT & DATA MODEL
// ==========================================
let appState = {
  cards: [],
  history: {},
  streak: { count: 0, last_date: null }
};

// Training session state & history stack for Undo
// ВАЖНО: currentTrainingQueue теперь holding SRS.QueueItem ({key, cardId, direction, level, …}),
// а не сами карточки. Направление показа решает очередь, а не монетка в моменте рендера.
let currentTrainingQueue = [];
let currentCardIndex = 0;
let currentTrainingItem = null;
let isFlipped = false;
let hasBeenFlippedForCurrentCard = false;
let hintUsedForCurrentCard = false;
let sessionUndoStack = [];
let activeGroupFilterForPractice = null;   // было activeBoxFilterForPractice: фильтр по группе знаний
let trainingSourceScreen = null;
// Переопределение направления для сессии: null = авто, иначе канон SRS ('en_ru' | 'ru_en')
let sessionDirectionOverride = null;

// Реестр сессии из srs.js: какие пары (слово:направление) уже оценены, сколько повторов.
let srsSession = null;
let sessionSeed = null;          // детерминированный сид порядка на весь запуск
let shuffleCounter = 0;          // чтобы повторные вызовы shuffleArray различались, но воспроизводимо
let lastMigrationReport = null;  // отчёт SRS.migrateState — для тоста и диагностики
let saveBlockedReason = null;    // если страж отказал в записи, базу не перезаписываем

// Интервалы, уровни и группы знаний живут в srs.js: SRS.INTERVALS = [0,1,2,4,7,14,30].
// Единственный источник «сегодня» — SRS.todayString(): локальный календарный день.
// Прежний getTodayDateString() через toISOString() между 00:00 и 03:00 в UTC+3 отдавал ВЧЕРА,
// а addDaysToDate() парсила 'YYYY-MM-DD' как UTC и читала локальными геттерами → сдвиг на день.
function getTodayString() {
  return SRS.todayString();
}

function addDaysToDate(dateStr, days) {
  return SRS.addDays(dateStr, days);
}

// Детерминированное перемешивание: тот же сид и вход ⇒ тот же порядок (Math.random больше нет).
function shuffleArray(arr, seed) {
  shuffleCounter++;
  const base = (sessionSeed === null ? getTodayString() : String(sessionSeed));
  return SRS.seededShuffle(arr || [], seed !== undefined ? seed : base + '|' + shuffleCounter);
}

/**
 * Исторические подписи партии → действующая.
 * Подпись «Single Additions (Отдельные слова)» была двуязычной; после перевода
 * интерфейса новый код пишет просто 'Single Additions'. Без нормализации на загрузке
 * экран Groups показал бы ДВЕ группы одного смысла — старую из сохранённых данных
 * (localStorage, резервная копия, data/*.json) и новую от добавленных слов.
 */
const LEGACY_BATCH_ALIASES = {
  'Single Additions (Отдельные слова)': 'Single Additions',
  'Отдельные слова': 'Single Additions'
};

/** Приводит batch_name к действующей подписи; возвращает true, если что-то изменил. */
function normalizeBatchName(card) {
  if (!card || typeof card !== 'object') return false;
  const key = String(card.batch_name == null ? '' : card.batch_name).trim();
  const mapped = LEGACY_BATCH_ALIASES[key];
  if (mapped && card.batch_name !== mapped) { card.batch_name = mapped; return true; }
  return false;
}

/**
 * Контекст слияния карточек. ОДИН И ТОТ ЖЕ алгоритм используется при стартовом слиянии
 * источников (loadData) и при восстановлении резервной копии (restoreDataFromJson).
 * Раньше второй путь был своим и сливал карточки ПО ОДНОМУ ЛИШЬ СЛОВУ, из-за чего
 * схлопывал омографы: в реальной базе два разных «resilience» с разными переводами,
 * и восстановление бэкапа молча уничтожало одно из них. Плюс оно не приводило legacy-бэкап
 * к schema 2 и игнорировало надгробия удалённых слов.
 */
function createMergeContext(deletedIds) {
  return {
    byId: new Map(),
    byCombo: new Map(),
    collisions: [],
    deletedIds: deletedIds instanceof Set ? deletedIds : new Set(deletedIds || []),
    skippedDeleted: 0,
    skippedJunk: 0,
    // id, отброшенные ПО НАДГРОБИЮ. Их нужно возвращать вызывающему: для стража
    // сохранения это ОБЪЯСНЁННОЕ удаление, а не потеря базы (см. restoreDataFromJson).
    tombstonedIds: [],
    // Признак того, что на входе были данные СТАРОЙ модели. Нужен потому, что
    // mergeCardInto приводит карточки к v2 ещё ДО вызова migrateState: ядро после этого
    // честно считает их native и возвращает migratedCount === 0, из-за чего снимок до
    // миграции и тост об обновлении никогда не срабатывали (BUG-1).
    legacyCards: 0,
    rawLegacyState: null
  };
}

function mergeCardInto(ctx, raw, today) {
  if (!raw || typeof raw !== 'object') { ctx.skippedJunk++; return false; }
  let norm;
  try {
    norm = SRS.normalizeCard(raw, today);      // приводим источник к v2 ДО слияния
  } catch (e) {
    console.error('[merge] normalizeCard отклонил запись:', e && e.message);
    ctx.skippedJunk++;
    return false;
  }
  if (!norm.card) { ctx.skippedJunk++; return false; }
  const card = norm.card;

  // Ядро намеренно бережливо: normalizeCard синтезирует id даже для записи без слова
  // (source 'synth'), чтобы миграция ничего не теряла. Но карточка с ПУСТЫМ словом
  // необучаема — её не показать в тренировке, не найти в словаре и не слить по паре
  // «слово + перевод». Отсекаем на входе в приложение, иначе битый файл или чужой
  // бэкап наплодил бы пустых плиток. Одинаково для loadData и restoreDataFromJson.
  if (String(card.word == null ? '' : card.word).trim() === '') {
    ctx.skippedJunk++;
    console.warn('[merge] пропущена запись без слова:', JSON.stringify(card.id), 'перевод:', JSON.stringify(String(card.translation || '').slice(0, 40)));
    return false;
  }

  if (norm.migrated || norm.source === 'legacy' || norm.source === 'hybrid') ctx.legacyCards++;
  if (ctx.deletedIds.has(card.id)) {
    ctx.skippedDeleted++;
    if (card.id) ctx.tombstonedIds.push(String(card.id));
    return false;
  }

  const prevById = ctx.byId.get(card.id);
  if (prevById) { ctx.byId.set(card.id, SRS.mergeRecords(prevById, card, today)); return true; }

  const word = String(card.word || '').trim().toLowerCase();
  // Ключ дубля — слово И перевод: омографы с разными значениями остаются разными карточками.
  const combo = word + '\u0000' + String(card.translation || '').trim().toLowerCase();
  const twinId = word ? ctx.byCombo.get(combo) : undefined;
  if (twinId !== undefined && ctx.byId.has(twinId)) {
    ctx.byId.set(twinId, SRS.mergeRecords(ctx.byId.get(twinId), card, today));
    ctx.collisions.push({ word: card.word, ids: [twinId, card.id] });
    return true;
  }

  // Слова без партии попадают в «Single Additions», иначе их не видно на экране групп.
  if (!card.batch_id && !card.batch_name) {
    card.batch_id = 'batch_manual';
    card.batch_name = 'Single Additions';
  } else {
    normalizeBatchName(card);
  }

  ctx.byId.set(card.id, card);
  if (word) ctx.byCombo.set(combo, card.id);
  return true;
}

/** История — append-only актив пользователя: по каждому дню берём максимум, не перезапись. */
function mergeHistoryInto(target, incoming) {
  if (!incoming || typeof incoming !== 'object') return target;
  Object.keys(incoming).forEach(dateKey => {
    const inc = incoming[dateKey] || {};
    if (!target[dateKey]) { target[dateKey] = Object.assign({}, inc); return; }
    target[dateKey].total = Math.max(target[dateKey].total || 0, inc.total || 0);
    target[dateKey].correct = Math.max(target[dateKey].correct || 0, inc.correct || 0);
  });
  return target;
}

/** Пользовательские группы — объединение по id или имени, уже существующие не перезаписываются. */
function mergeGroupsInto(target, incoming) {
  if (!Array.isArray(incoming)) return target;
  incoming.forEach(g => {
    if (!g) return;
    if (!target.some(x => x && (x.id === g.id || x.name === g.name))) target.push(g);
  });
  return target;
}

// ==========================================
// INITIALIZATION & TRIPLE-BULLETPROOF STORAGE ENGINE
// ==========================================
async function initApp() {
  // Сид порядка на весь запуск. Без него пересборка очереди в середине сессии
  // (смена направления, откат, повтор после «Забыл») давала бы другой порядок тех же
  // слов, а два пользователя с одной датой видели бы разную последовательность.
  if (sessionSeed === null) sessionSeed = SRS.todayString();

  await loadData();
  setupNavigation();
  setupEventHandlers();
  setupSwipeGestures();
  setupEditModal();
  setupBackupRestoreHandlers();
  setupGuideHandlers();
  updateStreakOnLaunch();

  // Темы: диаграммы и бейджи читают CSS-переменные В МОМЕНТ рендера, поэтому на смену
  // палитры (theme.js шлёт CustomEvent 'themechange') перерисовываем их. Без этого
  // после переключения темы графики оставались бы в цветах предыдущей палитры.
  document.addEventListener('themechange', () => {
    renderDashboard();
    renderStatsScreen();
    if (typeof renderCurrentCard === 'function' && currentTrainingItem) renderCurrentCard();
  });

  renderDashboard();
  renderDictionary();
  renderStatsScreen();
  renderGroupsScreen();
  setupSpellingScreen();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// Helper: Infer Part of Speech from card content if missing
function inferPartOfSpeech(card) {
  if (!card) return 'other';
  if (card.partOfSpeech) return card.partOfSpeech;
  
  const text = ((card.translation || '') + ' ' + (card.word || '')).toLowerCase();
  
  if (text.includes('сущ') || text.includes('существительное')) return 'noun';
  if (text.includes('гл') || text.includes('глагол') || text.includes('что делать') || text.includes('что сделать')) return 'verb';
  if (text.includes('прил') || text.includes('прилагательное')) return 'adjective';
  if (text.includes('нареч') || text.includes('наречие')) return 'adverb';
  if (text.includes('местоим')) return 'pronoun';
  if (text.includes('предлог')) return 'preposition';
  if (text.includes('союз')) return 'conjunction';
  if (text.includes('фраза') || text.includes('выражение') || text.includes('идиома')) return 'phrase';

  // Check English word patterns
  const w = (card.word || '').trim().toLowerCase();
  if (w.startsWith('to ')) return 'verb';
  if (w.endsWith('ly')) return 'adverb';
  if (w.endsWith('tion') || w.endsWith('ment') || w.endsWith('ness') || w.endsWith('ity')) return 'noun';
  if (w.endsWith('able') || w.endsWith('ible') || w.endsWith('ous') || w.endsWith('ful') || w.endsWith('less')) return 'adjective';

  return 'other';
}

// Последний успешный снимок для стража «не сжать базу»: только id, этого достаточно,
// чтобы отличить намеренное удаление от массовой потери.
let lastSavedSnapshot = null;

/**
 * ЗАГРУЗКА. Источников по-прежнему несколько (Electron-файл, два ключа localStorage,
 * node-fs, window.LEITNER_DATA, fetch), но:
 *  1) каждый парсер терпит BOM — раньше JSON.parse падал, и слой данных исчезал молча;
 *  2) кандидат-база выбирается по (schema_version ↓, saved_at ↓, cards.length ↓),
 *     а не просто по наибольшему массиву: иначе устаревшая статическая копия
 *     window.LEITNER_DATA воскрешала удалённые слова;
 *  3) каждая карточка нормализуется ДО слияния, поэтому слияние сравнивает настоящие
 *     уровни направлений, а не мёртвое поле box (прежний счётчик давал 0 для всех);
 *  4) схлопываются только НАСТОЯЩИЕ дубликаты (слово И перевод), омографы выживают;
 *  5) незнакомые корневые ключи сохраняются (прежний белый список из 4 ключей стирал
 *     schema_version/saved_at/deleted_ids при каждом запуске);
 *  6) после слияния — миграция и валидация, и только потом запись.
 */
async function loadData() {
  const candidates = [];
  const pushCandidate = (source, data) => {
    if (data && Array.isArray(data.cards) && data.cards.length > 0) candidates.push({ source, data });
    else if (data) console.warn(`[load] источник ${source} отброшен: cards не массив или пуст`);
  };

  // Source 1: Electron IPC Desktop File
  if (ipcRenderer) {
    try {
      pushCandidate('electron_ipc', unwrapIpcResult(await ipcRenderer.invoke('load-data'), 'load-data'));
    } catch (e) {
      console.warn('IPC load-data error:', e && e.message);
    }
  }

  // Source 2: Primary LocalStorage Key
  try {
    pushCandidate('local_storage', parseJsonTolerant(localStorage.getItem('leitner_data'), 'localStorage.leitner_data'));
  } catch (e) { console.warn('localStorage leitner_data недоступен:', e && e.message); }

  // Source 3: Backup LocalStorage Key
  try {
    pushCandidate('local_backup', parseJsonTolerant(localStorage.getItem('leitner_data_backup'), 'localStorage.leitner_data_backup'));
  } catch (e) { console.warn('localStorage leitner_data_backup недоступен:', e && e.message); }

  // Source 4: Node.js filesystem fallback
  if (typeof require !== 'undefined') {
    try {
      const fs = require('fs');
      const path = require('path');
      const p = path.join(__dirname, 'data', 'leitner_data.json');
      if (fs.existsSync(p)) {
        pushCandidate('node_fs', parseJsonTolerant(fs.readFileSync(p, 'utf-8'), 'data/leitner_data.json'));
      }
    } catch (e) { console.warn('node_fs fallback:', e && e.message); }
  }

  // Source 5: Global static object (data/leitner_data.js)
  try {
    if (typeof window !== 'undefined' && window.LEITNER_DATA) pushCandidate('window_global', window.LEITNER_DATA);
  } catch (e) { console.warn('window.LEITNER_DATA:', e && e.message); }

  // Source 6: fetch — только если больше ничего не нашлось
  if (candidates.length === 0) {
    try {
      const resp = await fetch('./data/leitner_data.json');
      if (resp.ok) pushCandidate('fetch', parseJsonTolerant(await resp.text(), 'fetch ./data/leitner_data.json'));
    } catch (e) { console.warn('fetch fallback:', e && e.message); }
  }

  console.log('[load] источники:', candidates.map(c => `${c.source}(${c.data.cards.length})`).join(', ') || 'нет данных');

  if (candidates.length === 0) {
    appState = { cards: [], history: {}, streak: { count: 0, last_date: null }, custom_groups: [], deleted_ids: [] };
    return;
  }

  const rankOf = (d) => ({
    schema: Number(d && d.schema_version) || 0,
    savedAt: (d && typeof d.saved_at === 'string') ? d.saved_at : '',
    count: (d && Array.isArray(d.cards)) ? d.cards.length : 0
  });
  candidates.sort((a, b) => {
    const ra = rankOf(a.data), rb = rankOf(b.data);
    return (rb.schema - ra.schema)
      || rb.savedAt.localeCompare(ra.savedAt)
      || (rb.count - ra.count);
  });

  const base = candidates[0].data;
  const today = srsToday();

  // Надгробия: union по всем источникам, чтобы удалённое слово не воскресло из старой копии.
  const deletedIds = new Set();
  candidates.forEach(cand => {
    if (Array.isArray(cand.data.deleted_ids)) cand.data.deleted_ids.forEach(id => { if (id) deletedIds.add(id); });
  });

  // Сырой legacy-payload. К моменту migrateState прежний вид базы уже утрачен (карточки
  // приведены к v2 внутри mergeCardInto), поэтому сохраняем сырой слепок наивысшего по
  // рангу источника старой модели: кандидаты уже отсортированы, берём первый подходящий.
  let rawLegacyState = null;
  for (const cand of candidates) {
    const ver = Number(cand.data && cand.data.schema_version) || 0;
    const holdsLegacyCards = Array.isArray(cand.data.cards) && cand.data.cards.some(
      c => c && typeof c === 'object' && (c.level_en_ru === undefined || c.box !== undefined)
    );
    if (ver < SRS.SCHEMA_VERSION || holdsLegacyCards) {
      try { rawLegacyState = JSON.parse(JSON.stringify(cand.data)); }
      catch (e) { rawLegacyState = cand.data; }
      console.log(`[load] источник «${cand.source}» — прежняя модель (schema_version=${ver || 'нет'}), снимок до миграции будет записан`);
      break;
    }
  }

  const mergeCtx = createMergeContext(deletedIds);
  mergeCtx.rawLegacyState = rawLegacyState;
  candidates.forEach(cand => cand.data.cards.forEach(raw => mergeCardInto(mergeCtx, raw, today)));

  const byId = mergeCtx.byId;
  const collisions = mergeCtx.collisions;
  const skippedDeleted = mergeCtx.skippedDeleted;
  const skippedJunk = mergeCtx.skippedJunk;

  // История: максимум по каждому дню (append-only актив пользователя, не ломаем).
  const mergedHistory = Object.assign({}, base.history || {});
  candidates.forEach(cand => mergeHistoryInto(mergedHistory, cand.data.history));

  let maxStreakCount = base.streak ? (base.streak.count || 0) : 0;
  let latestStreakDate = base.streak ? (base.streak.last_date || null) : null;
  candidates.forEach(cand => {
    if (cand.data.streak && (cand.data.streak.count || 0) > maxStreakCount) {
      maxStreakCount = cand.data.streak.count || 0;
      latestStreakDate = cand.data.streak.last_date || null;
    }
  });

  const mergedGroups = [...(base.custom_groups || [])];
  candidates.forEach(cand => {
    mergeGroupsInto(mergedGroups, cand.data.custom_groups);
  });

  // Корень — СПРЕДОМ от базы-победителя: незнакомые ключи выживают.
  const merged = Object.assign({}, base);
  candidates.forEach(cand => {
    Object.keys(cand.data).forEach(k => { if (!(k in merged)) merged[k] = cand.data[k]; });
  });
  merged.cards = Array.from(byId.values());
  merged.history = mergedHistory;
  merged.streak = { count: maxStreakCount, last_date: latestStreakDate };
  merged.custom_groups = mergedGroups;
  merged.deleted_ids = Array.from(deletedIds);

  appState = merged;

  if (collisions.length) console.log('[load] слиты настоящие дубликаты:', collisions.map(c => c.word).join(', '));
  if (skippedDeleted) console.log('[load] пропущено удалённых (надгробия):', skippedDeleted);
  if (skippedJunk) console.warn('[load] пропущено битых записей:', skippedJunk);

  await migrateAppStateToSRS('loadData:' + candidates[0].source, mergeCtx);
  await saveData();
}

/**
 * СОХРАНЕНИЕ. Три слоя пишутся независимо: отказ одного не должен убивать остальные
 * (прежде один общий try/catch терял и файл, и оба ключа localStorage).
 * Перед записью — валидация и страж массовой потери: необъяснённое исчезновение id
 * или сжатие базы ниже порога блокирует сохранение вместо тихой перезаписи.
 */
async function saveData(opts) {
  opts = opts || {};
  const today = srsToday();

  const check = SRS.validateState(appState, lastSavedSnapshot, {
    today,
    allowShrink: !!opts.allowShrink,
    removedIds: Array.isArray(opts.removedIds) ? opts.removedIds : []
  });
  if (!check.ok) {
    saveBlockedReason = check.errors.slice(0, 5).join('; ');
    console.error('[SRS] сохранение ОТКЛОНЕНО:', check.errors.slice(0, 10));
    if (typeof showToast === 'function') {
      showToast('Saving blocked (data-loss guard): ' + check.errors.slice(0, 2).join('; '), 'error');
    }
    return false;
  }
  if (check.warnings && check.warnings.length) console.warn('[SRS] предупреждения сохранения:', check.warnings.slice(0, 5));
  saveBlockedReason = null;

  let json;
  try {
    json = SRS.serializeState(appState, { savedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[SRS] сериализация не удалась:', e && e.message);
    return false;
  }

  let okPrimary = false, okBackup = false, okIpc = false;

  try {
    localStorage.setItem('leitner_data', json);
    okPrimary = true;
  } catch (e) { console.error('[save] localStorage.leitner_data:', e && e.message); }

  try {
    localStorage.setItem('leitner_data_backup', json);
    okBackup = true;
  } catch (e) { console.error('[save] localStorage.leitner_data_backup:', e && e.message); }

  if (ipcRenderer) {
    try {
      const res = await ipcRenderer.invoke('save-data', appState);
      okIpc = !(res && res.ok === false);
      if (!okIpc) {
        console.error('[save] IPC save-data:', (res && res.reason) || 'отказ', (res && res.detail) || '');
      } else if (res && Array.isArray(res.warnings) && res.warnings.length) {
        console.warn('[save] предупреждения файлового слоя:', res.warnings.join('; '));
      }
    } catch (e) {
      console.error('[save] IPC save-data:', e && e.message);
    }
  }

  lastSavedSnapshot = { cards: (appState.cards || []).map(c => ({ id: c && c.id })) };
  if (!okPrimary && !okIpc) {
    if (typeof showToast === 'function') showToast('Could not save your base — every storage sink refused the write', 'error');
    return false;
  }
  return true;
}

let idCounter = 0;

function generateId(prefix) {
  idCounter = (idCounter + 1) % 46656;
  const salt = Date.now().toString(36) + ':' + idCounter.toString(36);
  return (prefix || 'card') + '_' + Date.now() + '_' + SRS.fnv1a(salt).toString(36).slice(0, 6);
}

// ─────────────────────────────────────────────────────────────────────────────
// МОСТЫ К ЯДРУ srs.js
// Прежние migrateCardsToSRS() и calculateNextSrs() (SM-2: srsStage / interval /
// easeFactor / repetitions / dueDate + зеркало в card.box) УДАЛЕНЫ ЦЕЛИКОМ.
// Единственный планировщик теперь SRS.applyAnswer, единственный источник
// расписания — два вектора (level_en_ru/next_review_en_ru, level_ru_en/next_review_ru_en).
// Группа знаний производная и в карточке не хранится.
// ─────────────────────────────────────────────────────────────────────────────

function srsToday() { return SRS.todayString(); }

// Прежнее имя оставлено алиасом: оно встречается в рендерах статистики, а смысл
// «сегодня» обязан быть один. Старая реализация через toISOString() между 00:00 и
// 03:00 в UTC+3 возвращала вчера и молча сдвигала расписание.
function getTodayDateString() { return SRS.todayString(); }

function cardById(id) {
  if (!id) return null;
  return appState.cards.find(c => c && c.id === id) || null;
}

function replaceCardById(card) {
  if (!card || !card.id) return card;
  const i = appState.cards.findIndex(c => c && c.id === card.id);
  if (i >= 0) appState.cards[i] = card; else appState.cards.push(card);
  return card;
}

/** Производная группа слова: 'BANK'|'NEW'|'LEARNING'|'FAMILIAR'|'CONFIDENT'|'MASTERED' */
function groupOf(card) { return SRS.derivedGroup(card); }

/**
 * Ответ IPC бывает и старой формы {cards:…}, и новым конвертом {ok,data,reason}.
 * 'not-found' — штатная ситуация (файла ещё нет), всё остальное логируем громко:
 * прежде отказ чтения выглядел как пустая база и молча вёл к перезаписи.
 */
function unwrapIpcResult(res, channel) {
  if (res === null || res === undefined) return null;
  if (res.ok === false) {
    const reason = res.reason || 'unknown';
    if (reason === 'not-found') {
      console.log(`[ipc] ${channel || 'channel'}: файла ещё нет${res.path ? ' (' + res.path + ')' : ''}`);
    } else {
      console.error(`[ipc] ${channel || 'channel'} отказал:`, reason, res.detail || '');
      if (res.quarantined) {
        // Файл был битым и отложен в сторону (не перезаписан) — базу можно достать оттуда.
        console.warn('[ipc] повреждённый файл изолирован:', res.quarantined);
        if (typeof showToast === 'function') {
          showToast('Base file was corrupt and has been set aside (not overwritten): ' + res.quarantined, 'error');
        }
      }
    }
    return null;
  }
  if (res.data && Array.isArray(res.data.cards)) return res.data;
  if (Array.isArray(res.cards)) return res;
  return null;
}

/** BOM больше не роняет чтение: он ломал JSON.parse в main.js и в node-ветке загрузчика. */
function parseJsonTolerant(text, label) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(SRS.stripBom(text));
  } catch (e) {
    console.error(`Не удалось разобрать ${label || 'JSON'}:`, e && e.message);
    return null;
  }
}

/** Короткая человеческая сводка отчёта миграции — для тоста первого запуска. */
function describeMigrationReport(report) {
  if (!report) return '';
  const g = report.byGroup || {};
  const parts = [
    `${report.migrated} cards upgraded`,
    `${g.BANK || 0} in the Bank`,
    `${(g.LEARNING || 0) + (g.FAMILIAR || 0) + (g.CONFIDENT || 0) + (g.MASTERED || 0)} in rotation`,
  ];
  if (report.overdueCarried) parts.push(`${report.overdueCarried} due today`);
  return parts.join(' · ');
}

/**
 * Автобэкап базы ДО миграции. Пишется один раз и никогда не перезаписывается:
 * это единственная точка полного отката на старую модель коробок.
 */
async function writePreMigrationSnapshot(preState) {
  let json;
  try {
    json = JSON.stringify(preState, null, 2);
  } catch (e) {
    console.error('Не удалось сериализовать снимок до миграции:', e && e.message);
    return false;
  }
  try {
    localStorage.setItem('leitner_data_pre_srs_backup', json);
  } catch (e) {
    console.warn('localStorage-снимок до миграции не сохранён:', e && e.message);
  }
  if (ipcRenderer) {
    const snapshots = [
      { filename: 'leitner_data.pre-srs.json', content: json },
      // Зеркало для открытия снапшота прямо в браузере (тот же формат, что data/leitner_data.js).
      { filename: 'leitner_data.pre-srs.js', content: 'window.LEITNER_DATA = ' + json + ';' }
    ];
    for (const snap of snapshots) {
      try {
        const res = await ipcRenderer.invoke('save-snapshot', snap);
        if (res && res.ok === false) console.warn(`save-snapshot ${snap.filename}:`, res.reason || 'отказ', res.detail || '');
        else if (res && res.path) console.log('Снимок до миграции:', res.path, res.skipped ? '(уже существовал — не перезаписан)' : `(${res.bytes} байт)`);
      } catch (e) {
        // Канала может не быть в старой обёртке — localStorage-копия уже записана.
        console.warn(`save-snapshot ${snap.filename} недоступен:`, e && e.message);
      }
    }
  }
  return true;
}

/**
 * Миграция всей базы в schema 2. Идемпотентна: на уже мигрированной базе
 * migratedCount === 0 и ничего не перезаписывается. При любой ошибке или отказе
 * валидатора appState остаётся ПРЕЖНИМ — полумигрированное состояние не сохраняется.
 */
async function migrateAppStateToSRS(sourceLabel, legacyHint) {
  if (!appState || !Array.isArray(appState.cards)) return null;
  const today = srsToday();
  const before = appState;

  let result;
  try {
    result = SRS.migrateState(before, today);
  } catch (e) {
    console.error('Миграция SRS провалилась — состояние не изменено:', e);
    if (typeof showToast === 'function') showToast('Base migration did not run — your data is unchanged: ' + (e && e.message), 'error');
    return null;
  }

  const check = SRS.validateState(result.state, before, { today });
  if (!check.ok) {
    console.error('Миграция отклонена валидатором:', check.errors.slice(0, 10));
    if (typeof showToast === 'function') showToast('Migration rejected by the validator — your data was NOT changed: ' + check.errors.slice(0, 2).join('; '), 'error');
    return null;
  }

  // legacyHint.legacyCards считает карточки прежней модели, приведённые к v2 ещё на
  // слиянии (см. createMergeContext), поэтому firstMigration срабатывает даже когда
  // само ядро вернуло migratedCount === 0. Снимок пишем из СЫРОГО payload, а не из
  // before: before к этому моменту уже содержит нормализованные карточки и для отката
  // на модель коробок непригоден.
  const hint = legacyHint || {};
  const firstMigration = result.migratedCount > 0 || (hint.legacyCards || 0) > 0;
  if (firstMigration) await writePreMigrationSnapshot(hint.rawLegacyState || before);

  appState = result.state;      // migrateState сохраняет незнакомые корневые ключи

  // ДЕЙСТВИТЕЛЬНОЕ число сконвертированных карточек. Ядро считает только те, что дошли
  // до migrateState в прежнем виде, а loadData приводит карточки к v2 ещё на слиянии —
  // поэтому на легаси-старте migratedCount === 0, хотя конвертирована вся база. Без этой
  // поправки отчёт утверждал бы «0 cards upgraded» сразу после реальной миграции.
  const migratedAtMerge = hint.legacyCards || 0;
  const effectiveMigrated = Math.max(result.migratedCount, migratedAtMerge);
  lastMigrationReport = Object.assign({}, result.report, {
    migrated: effectiveMigrated,
    migratedByKernel: result.migratedCount,   // сколько пересчитало само ядро
    migratedAtMerge                           // сколько привёл к v2 движок слияния
  });

  if (firstMigration) {
    console.log(`[SRS] миграция ${sourceLabel || 'base'} → schema ${SRS.SCHEMA_VERSION}`,
      'всего сконвертировано:', effectiveMigrated,
      '(ядром:', result.migratedCount, '+ на слиянии:', migratedAtMerge + ')',
      lastMigrationReport.byStatus, lastMigrationReport.byGroup);
    if (typeof showToast === 'function') {
      showToast('Your base was upgraded to two independent scales (ENG→RUS / RUS→ENG). ' + describeMigrationReport(lastMigrationReport), 'success');
    }
  }
  return lastMigrationReport;
}

function calculateAccuracy() {
  let totalAnswers = 0;
  let correctAnswers = 0;
  
  if (appState.history) {
    Object.values(appState.history).forEach(h => {
      totalAnswers += (h.total || 0);
      correctAnswers += (h.correct || 0);
    });
  }

  const accuracy = totalAnswers > 0 ? Math.round((correctAnswers / totalAnswers) * 100) : 0;
  return { accuracy, totalAnswers, correctAnswers };
}

// ==========================================
// MANUAL BACKUP EXPORT & RESTORE HANDLERS
// ==========================================
function setupBackupRestoreHandlers() {
  const btnBackup = document.getElementById('btn-backup-json');
  const btnRestore = document.getElementById('btn-restore-json');
  const restoreFileInput = document.getElementById('input-restore-json-file');

  if (btnBackup) {
    btnBackup.addEventListener('click', () => {
      exportDataToJson();
    });
  }

  if (btnRestore && restoreFileInput) {
    btnRestore.addEventListener('click', () => {
      restoreFileInput.click();
    });

    restoreFileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        restoreDataFromJson(e.target.files[0]);
      }
    });
  }
}

async function exportDataToJson() {
  if (!appState.cards || appState.cards.length === 0) {
    showToast('Cannot export: Dictionary is empty!', 'error');
    return;
  }

  // serializeState, а не JSON.stringify: канонический порядок ключей, обязательный
  // schema_version и saved_at. Именно этот файл потом читается путем восстановления,
  // и самописный дамп мог бы не пройти валидацию при импорте.
  const jsonStr = SRS.serializeState(appState, { savedAt: new Date().toISOString() });
  const totalCount = appState.cards.length;

  if (ipcRenderer) {
    try {
      const res = await ipcRenderer.invoke('save-backup-json', jsonStr);
      if (res && res.success) {
        showToast(`💾 Backup saved successfully (${totalCount} cards total)!`, 'success');
        return;
      } else if (res && res.cancelled) {
        return; // User intentionally cancelled the save file dialog
      }
    } catch (e) {
      console.warn('IPC save-backup-json error, falling back to browser download:', e);
    }
  }

  // Browser download fallback
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `leitner_cards_backup_${getTodayString()}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast(`💾 Backup JSON saved (${totalCount} cards total)!`, 'success');
}

function restoreDataFromJson(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      // BOM-устойчивость: резервная копия могла быть сохранена старой версией или
      // сторонним редактором, а JSON.parse на BOM падает (именно так прежний
      // scripts/add_words.js терял всю базу).
      const parsed = JSON.parse(SRS.stripBom(String(e.target.result)));
      if (!parsed || !Array.isArray(parsed.cards) || parsed.cards.length === 0) {
        showToast('Invalid backup JSON format or empty cards list!', 'error');
        return;
      }

      const today = srsToday();

      // Поведение прежней версии сохраняем: если часть речи не указана, выводим её из
      // контента — иначе карточка уедет в «Other» на экране групп по частям речи.
      parsed.cards.forEach(c => {
        if (!c || typeof c !== 'object') return;
        if (SRS.posText(c.part_of_speech) === '' && SRS.posText(c.partOfSpeech) === '') {
          const inferred = inferPartOfSpeech(c);
          if (inferred) { c.part_of_speech = inferred; c.partOfSpeech = inferred; }
        }
      });

      // Резервная копия может быть СТАРОЙ (schema 1: коробки, одно расписание на слово).
      // Приводим её тем же путём, что и при старте приложения, иначе в базу попали бы
      // card.box и пустые векторы направлений.
      let incoming;
      try {
        incoming = SRS.migrateState(parsed, today);
      } catch (err) {
        console.error('[restore] миграция копии не удалась:', err && err.message);
        showToast('Backup could not be migrated to the current format: ' + (err && err.message), 'error');
        return;
      }

      // Надгробия: удалённое слово не должно воскресать из старой копии.
      const deletedIds = new Set((Array.isArray(appState.deleted_ids) ? appState.deleted_ids : []).map(String));
      (Array.isArray(incoming.state.deleted_ids) ? incoming.state.deleted_ids : []).forEach(id => { if (id) deletedIds.add(String(id)); });

      // Слияние — ТОТ ЖЕ алгоритм, что и при загрузке: сначала по id, затем по паре
      // «слово + перевод», поэтому омографы с разными значениями не схлопываются.
      const ctx = createMergeContext(deletedIds);
      (appState.cards || []).forEach(c => mergeCardInto(ctx, c, today));
      incoming.state.cards.forEach(c => mergeCardInto(ctx, c, today));

      const next = Object.assign({}, appState, {
        cards: Array.from(ctx.byId.values()),
        schema_version: SRS.SCHEMA_VERSION,
        deleted_ids: Array.from(deletedIds),
        history: mergeHistoryInto(Object.assign({}, appState.history || {}), incoming.state.history)
      });
      if (incoming.state.streak && (incoming.state.streak.count || 0) > (appState.streak ? (appState.streak.count || 0) : 0)) {
        next.streak = incoming.state.streak;
      }
      next.custom_groups = mergeGroupsInto([...(appState.custom_groups || [])], incoming.state.custom_groups);

      // Валидация ДО изменения состояния. Слияние — объединение, поэтому единственная
      // законная причина уменьшения счётчика — карточка, отброшенная по надгробию
      // (удалённое слово не должно воскресать из старой копии). Такие id передаются
      // стражу как ОБЪЯСНЁННЫЕ: без этого любое восстановление после удаления слова
      // отменялось ЦЕЛИКОМ с вердиктом UNEXPLAINED-LOSS.
      const removedIds = ctx.tombstonedIds.slice();
      const check = SRS.validateState(next, appState, { today, removedIds });
      if (!check.ok) {
        console.error('[restore] отклонено валидатором:', check.errors.slice(0, 10));
        showToast('Restore rejected (data-loss guard): ' + check.errors.slice(0, 2).join('; '), 'error');
        return;
      }

      appState = next;
      const saved = await saveData({ removedIds, allowShrink: removedIds.length > 0 });
      renderDashboard();
      renderDictionary();
      renderGroupsScreen();
      renderStatistics();

      const parts = [`${appState.cards.length} cards`];
      if (incoming.migratedCount) parts.push(`${incoming.migratedCount} upgraded from the old format`);
      if (ctx.collisions.length) parts.push(`${ctx.collisions.length} duplicate pairs merged`);
      if (ctx.skippedDeleted) parts.push(`${ctx.skippedDeleted} deleted words skipped`);
      if (ctx.skippedJunk) parts.push(`${ctx.skippedJunk} malformed rows ignored`);
      showToast(saved ? `✅ Restored & synchronized: ${parts.join(', ')}`
                      : '⚠️ Restored in memory, but saving was blocked — see console',
                saved ? 'success' : 'error');
    } catch (err) {
      console.error('[restore] сбой чтения копии:', err && err.message);
      showToast('Error reading backup file: ' + (err && err.message), 'error');
    }
  };
  reader.onerror = () => showToast('Error reading backup file!', 'error');
  reader.readAsText(file);
}

// ==========================================
// GUIDE & INSTRUCTIONS SCREEN HANDLERS
// ==========================================
function setupGuideHandlers() {
  const guideLangBtns = document.querySelectorAll('.guide-lang-btn');
  const guideViewEn = document.getElementById('guide-lang-en');
  const guideViewRu = document.getElementById('guide-lang-ru');
  const guideHeaderTitle = document.getElementById('guide-header-title');
  const guideHeaderSubtitle = document.getElementById('guide-header-subtitle');

  guideLangBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const lang = btn.dataset.guideLang;
      guideLangBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (lang === 'ru') {
        if (guideViewEn) guideViewEn.classList.add('hidden');
        if (guideViewRu) guideViewRu.classList.remove('hidden');
        if (guideHeaderTitle) guideHeaderTitle.textContent = '📖 Инструкция и Руководство';
        if (guideHeaderSubtitle) guideHeaderSubtitle.textContent = 'Система Лейтнера, занесение слов через ИИ, хранение данных, выгрузка/загрузка и горячие клавиши';
      } else {
        if (guideViewEn) guideViewEn.classList.remove('hidden');
        if (guideViewRu) guideViewRu.classList.add('hidden');
        if (guideHeaderTitle) guideHeaderTitle.textContent = '📖 User Guide & Manual';
        if (guideHeaderSubtitle) guideHeaderSubtitle.textContent = 'Leitner box system, AI word import, data storage, export/import and keyboard shortcuts';
      }
    });
  });

  // Prompt Copy Button in EN Guide
  const btnCopyPromptEn = document.getElementById('btn-guide-copy-prompt-en');
  const promptCodeEn = document.getElementById('guide-prompt-code-en');
  if (btnCopyPromptEn && promptCodeEn) {
    btnCopyPromptEn.addEventListener('click', () => {
      const text = promptCodeEn.textContent.trim();
      navigator.clipboard.writeText(text)
        .then(() => {
          const originalText = btnCopyPromptEn.textContent;
          btnCopyPromptEn.textContent = '✅ Copied!';
          setTimeout(() => { btnCopyPromptEn.textContent = originalText; }, 2000);
          showToast('📋 AI prompt copied to clipboard!', 'success');
        })
        .catch(() => showToast('Failed to copy prompt to clipboard', 'error'));
    });
  }

  // Prompt Copy Button in RU Guide
  const btnCopyPromptRu = document.getElementById('btn-guide-copy-prompt-ru');
  const promptCodeRu = document.getElementById('guide-prompt-code-ru');
  if (btnCopyPromptRu && promptCodeRu) {
    btnCopyPromptRu.addEventListener('click', () => {
      const text = promptCodeRu.textContent.trim();
      navigator.clipboard.writeText(text)
        .then(() => {
          const originalText = btnCopyPromptRu.textContent;
          btnCopyPromptRu.textContent = '✅ Скопировано!';
          setTimeout(() => { btnCopyPromptRu.textContent = originalText; }, 2000);
          showToast('📋 Промпт для нейросети скопирован в буфер обмена!', 'success');
        })
        .catch(() => showToast('Не удалось скопировать промпт', 'error'));
    });
  }
}

// ==========================================
// STREAK MANAGEMENT
// ==========================================
function updateStreakOnLaunch() {
  const today = getTodayString();
  const last = appState.streak.last_date;

  if (!last) {
    appState.streak = { count: 0, last_date: null };
    return;
  }

  const diffDays = Math.floor((new Date(today) - new Date(last)) / (1000 * 60 * 60 * 24));
  if (diffDays > 1) {
    appState.streak.count = 0;
  }
}

function recordActivity() {
  const today = getTodayString();
  if (appState.streak.last_date !== today) {
    const last = appState.streak.last_date;
    if (last) {
      const diffDays = Math.floor((new Date(today) - new Date(last)) / (1000 * 60 * 60 * 24));
      if (diffDays === 1) {
        appState.streak.count += 1;
      } else {
        appState.streak.count = 1;
      }
    } else {
      appState.streak.count = 1;
    }
    appState.streak.last_date = today;
    saveData();
  }
}

// ==========================================
// NAVIGATION & SCREEN SWITCHING
// ==========================================
function setupNavigation() {
  const navBtns = document.querySelectorAll('.nav-btn');
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetScreen = btn.dataset.screen;
      switchScreen(targetScreen);
    });
  });

  document.querySelectorAll('.btn-back-dash').forEach(btn => {
    btn.addEventListener('click', () => {
      const trainingScreen = document.getElementById('screen-training');
      if (trainingScreen && trainingScreen.classList.contains('active') && trainingSourceScreen) {
        switchScreen(trainingSourceScreen);
      } else {
        switchScreen('dashboard');
      }
    });
  });
}

function switchScreen(screenId) {
  if (document.activeElement && document.activeElement.blur && document.activeElement !== document.body) {
    document.activeElement.blur();
  }

  // Stop active dictation speech whenever user navigates away from spelling screen
  if (screenId !== 'spelling') {
    stopSpellingDictation();
    if (typeof typingTestState !== 'undefined') { clearTimeout(typingTestState.advanceTimer); typingTestState.advanceTimer = null; }
    if (typeof listeningTestState !== 'undefined') { clearTimeout(listeningTestState.advanceTimer); listeningTestState.advanceTimer = null; }
  }

  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.screen === screenId);
  });

  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
  });

  const target = document.getElementById(`screen-${screenId}`);
  if (target) {
    target.classList.add('active');
  }

  if (screenId === 'dashboard') renderDashboard();
  if (screenId === 'dictionary') renderDictionary();
  if (screenId === 'groups') renderGroupsScreen();
  if (screenId === 'stats' || screenId === 'statistics') renderStatistics();
  if (screenId === 'spelling') renderSpellingScreen();
}


// ==========================================
// STATISTICS & CHARTS RENDERER
// ==========================================
let chartActivityInstance = null;
let chartStagesInstance = null;

// ---------------------------------------------------------------------------
// Тема и цвета графиков.
// Палитры (бэта / midnight / light) живут в themes.css и задают --grp-*-rgb и
// --accent-primary-rgb. Графики читают их В МОМЕНТ рендера, а initApp подписан на
// событие themechange и перерисовывает диаграммы: зашитый гекс оставлял бы их в
// цветах предыдущей палитры после переключения темы.
// ---------------------------------------------------------------------------
function themeToken(name, fallback) {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
    const v = (raw || '').trim();
    return v || fallback;
  } catch (e) { return fallback; }
}

function hexToRgba(hex, alpha) {
  let h = String(hex == null ? '' : hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return `rgba(148, 163, 184, ${alpha})`;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** "r, g, b" из CSS-токена → rgba(); fallbackTriplet — тоже строка "r, g, b". */
function themeRgba(name, fallbackTriplet, alpha) {
  const rgb = themeToken(name, fallbackTriplet).replace(/\s+/g, '');
  return /^\d{1,3},\d{1,3},\d{1,3}$/.test(rgb) ? `rgba(${rgb}, ${alpha})` : `rgba(${fallbackTriplet.replace(/\s+/g, '')}, ${alpha})`;
}

/** Цвет группы знаний с откатом на палитру бэта из GROUP_META, если токена нет. */
function bucketRgba(bucket, alpha) {
  const b = String(bucket).toLowerCase();
  const raw = themeToken(`--grp-${b}-rgb`, '').replace(/\s+/g, '');
  if (/^\d{1,3},\d{1,3},\d{1,3}$/.test(raw)) return `rgba(${raw}, ${alpha})`;
  const meta = SRS.GROUP_META[String(bucket).toUpperCase()] || {};
  return hexToRgba(meta.color, alpha);
}

const CHART_BUCKETS = ['BANK', 'NEW', 'LEARNING', 'FAMILIAR', 'CONFIDENT', 'MASTERED'];

function renderStatsScreen() {
  const cards = appState.cards || [];
  const todayStr = srsToday();
  const sum = SRS.summarize(cards, todayStr);
  const groups = sum.groups || {};

  // calculateAccuracy() возвращает ОБЪЕКТ {accuracy,totalAnswers,correctAnswers}:
  // прежняя строка `accuracy + '%'` печатала "[object Object]%" на экране статистики.
  const acc = calculateAccuracy();
  const streak = appState.streak ? appState.streak.count || 0 : 0;

  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setText('stats-total-cards', cards.length);
  // «К сроку» — ЗАПИСЯМИ (слово × направление), а не карточками: у одного слова два
  // независимых вектора, и просрочка одного ничего не говорит о втором.
  setText('stats-due-cards', sum.dueEntries || 0);
  setText('stats-mastered-cards', groups.MASTERED || 0);
  setText('stats-accuracy', (acc.accuracy || 0) + '%');
  setText('stats-streak', streak + ' days');

  // Отдельная строка на каждый вектор: средний уровень, к сроку, просрочено.
  // Среднее считаем только по АКТИВНЫМ: слова в Банке имеют уровень 0 и занизили бы его.
  const directionLine = (dir) => {
    const el = document.getElementById(dir === 'en_ru' ? 'stats-dir-en-ru' : 'stats-dir-ru-en');
    if (!el) return;
    const lvKey = SRS.levelKey(dir);
    const dueKey = SRS.dueKey(dir);
    let lvlSum = 0, active = 0, due = 0, overdue = 0;
    for (const c of cards) {
      if (!SRS.isActive(c)) continue;
      lvlSum += Number(c[lvKey]) || 0;
      active++;
      if (SRS.isDirectionDue(c, dir, todayStr)) {
        due++;
        const d = c[dueKey];
        if (d && d < todayStr) overdue++;
      }
    }
    el.textContent = active === 0
      ? 'No active words yet — the Bank is untouched'
      : `avg L${(lvlSum / active).toFixed(1)} · ${due} due · ${overdue} overdue`;
  };
  SRS.DIRECTIONS.forEach(directionLine);

  // Окно активности берём от todayString через addDays: локальный new Date() сдвигал
  // бы его на сутки вблизи полуночи и в отрицательных часовых поясах.
  const last14Days = [];
  const activityData = [];
  for (let i = 13; i >= 0; i--) {
    const dateKey = SRS.addDays(todayStr, -i);
    const parts = String(dateKey).split('-');
    last14Days.push(`${parseInt(parts[2], 10)}/${parseInt(parts[1], 10)}`);
    const dayHist = appState.history ? appState.history[dateKey] : null;
    activityData.push(dayHist ? (dayHist.total || 0) : 0);
  }

  const muted = themeToken('--text-muted', '#94a3b8');
  const mainText = themeToken('--text-main', '#cbd5e1');
  const gridColor = themeToken('--border-color', 'rgba(255,255,255,0.05)');

  const canvasActivity = document.getElementById('chart-activity');
  if (canvasActivity) {
    if (typeof Chart !== 'undefined') {
      if (chartActivityInstance) chartActivityInstance.destroy();
      chartActivityInstance = new Chart(canvasActivity, {
        type: 'bar',
        data: {
          labels: last14Days,
          datasets: [{
            label: 'Reviewed Words',
            data: activityData,
            backgroundColor: themeRgba('--accent-primary-rgb', '99, 102, 241', 0.65),
            borderColor: themeToken('--accent-primary', '#6366f1'),
            borderWidth: 2,
            borderRadius: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: muted } },
            y: { grid: { color: gridColor }, ticks: { color: muted, precision: 0 }, beginAtZero: true }
          }
        }
      });
    } else {
      drawFallbackBarChart(canvasActivity, last14Days, activityData);
    }
  }

  // Шесть срезов: Банк + пять групп знаний (прежние New/Learning/Review/Mastered/Bank
  // читали мёртвое поле srsStage и всегда показывали нули после миграции).
  const stageLabels = CHART_BUCKETS.map(g => (g === 'BANK' ? 'Bank' : g));
  const stageCounts = CHART_BUCKETS.map(g => groups[g] || 0);
  const stageColors = CHART_BUCKETS.map(g => bucketRgba(g, 0.85));

  const canvasStages = document.getElementById('chart-stages');
  if (canvasStages) {
    if (typeof Chart !== 'undefined') {
      if (chartStagesInstance) chartStagesInstance.destroy();
      chartStagesInstance = new Chart(canvasStages, {
        type: 'doughnut',
        data: {
          labels: stageLabels,
          datasets: [{ data: stageCounts, backgroundColor: stageColors, borderWidth: 0 }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'right', labels: { color: mainText, font: { size: 12 } } }
          }
        }
      });
    } else {
      drawFallbackDonutChart(canvasStages, stageLabels, stageCounts, stageColors);
    }
    if (canvasStages._chart) {
      // «Понт» с пользой: клик по срезу открывает эту группу в Dictionary.
      canvasStages._chart.click = (i) => openGroupInDictionary(CHART_BUCKETS[i]);
    }
  }
}

/* ============ ИНТЕРАКТИВНЫЙ СЛОЙ ГРАФИКОВ (18.09, «понты по делу») ============
 * Hover: сегмент светится/«всплывает», у столбика ярче шапка, всплывает
 * общий тултип #chart-tooltip (статичный элемент в index.html — контракт
 * check.cjs «все static id из app.js есть в разметке»). Клик по срезу доната
 * групп ведёт в Dictionary с фильтром (openGroupInDictionary). Всё деградирует
 * тихо: нет _chart — нет интерактива. */
function showChartTooltip(clientX, clientY, html) {
  const el = document.getElementById('chart-tooltip');
  if (!el) return;
  el.innerHTML = html;
  el.hidden = false;
  const pad = 14;
  const r = el.getBoundingClientRect();
  let x = clientX + pad, y = clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = clientY - r.height - pad;
  el.style.left = Math.max(4, x) + 'px';
  el.style.top = Math.max(4, y) + 'px';
}
function hideChartTooltip() {
  const el = document.getElementById('chart-tooltip');
  if (el) el.hidden = true;
}
function bindChartHover(canvas) {
  if (!canvas || canvas._hoverBound) return;
  canvas._hoverBound = true;
  canvas.addEventListener('mousemove', (e) => {
    const st = canvas._chart;
    if (!st || typeof st.hit !== 'function') return;
    const rect = canvas.getBoundingClientRect();
    const idx = st.hit(e.clientX - rect.left, e.clientY - rect.top);
    if (idx !== st.hover) { st.hover = idx; st.redraw(idx); }
    if (idx >= 0) {
      showChartTooltip(e.clientX, e.clientY, st.tipFor(idx));
      canvas.style.cursor = st.click ? 'pointer' : 'default';
    } else {
      hideChartTooltip();
      canvas.style.cursor = 'default';
    }
  });
  canvas.addEventListener('mouseleave', () => {
    const st = canvas._chart;
    hideChartTooltip();
    canvas.style.cursor = 'default';
    if (st && st.hover !== -1) { st.hover = -1; st.redraw(-1); }
  });
  canvas.addEventListener('click', () => {
    const st = canvas._chart;
    if (st && st.click && st.hover >= 0) st.click(st.hover);
  });
}

function drawFallbackBarChart(canvas, labels, data, hoverIdx) {
  if (!canvas) return;
  hoverIdx = typeof hoverIdx === 'number' ? hoverIdx : -1;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = (rect.width || 360) * dpr;
  canvas.height = (rect.height || 260) * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width || 360;
  const height = rect.height || 260;

  ctx.clearRect(0, 0, width, height);

  // Палитра — из текущей темы (самописный canvas был закрашен литералами
  // тёмной «Беты» и на светлых Frost/sandstone терял сетку и подписи).
  const fbMuted = themeToken('--text-muted', '#94a3b8');
  const fbAccent = themeToken('--accent-primary', '#6366f1');
  const fbGrid = themeRgba('--overlay-rgb', '128, 128, 128', 0.14);
  const fbEmpty = themeRgba('--overlay-rgb', '128, 128, 128', 0.07);
  const fbAccentHi = themeToken('--accent-primary-hover', fbAccent);

  const maxVal = Math.max(5, ...data);
  const paddingBottom = 30;
  const paddingTop = 20;
  const paddingLeft = 30;
  const paddingRight = 15;

  const chartW = width - paddingLeft - paddingRight;
  const chartH = height - paddingTop - paddingBottom;
  const barGap = 6;
  const barWidth = Math.max(4, (chartW / data.length) - barGap);

  // Y Grid
  ctx.strokeStyle = fbGrid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = paddingTop + (chartH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(paddingLeft, y);
    ctx.lineTo(width - paddingRight, y);
    ctx.stroke();

    ctx.fillStyle = fbMuted;
    ctx.font = '10px sans-serif';
    const valLabel = Math.round(maxVal - (maxVal / 4) * i);
    ctx.fillText(String(valLabel), 6, y + 3);
  }

  // Bars
  data.forEach((val, idx) => {
    const x = paddingLeft + idx * (barWidth + barGap) + barGap / 2;
    const barH = (val / maxVal) * chartH;
    const y = paddingTop + chartH - barH;

    const hovered = idx === hoverIdx;
    ctx.save();
    if (hovered) { ctx.shadowColor = fbAccent; ctx.shadowBlur = 16; }
    ctx.fillStyle = val > 0 ? (hovered ? fbAccentHi : fbAccent) : fbEmpty;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, barWidth, barH, [4, 4, 0, 0]);
    } else {
      ctx.rect(x, y, barWidth, barH);
    }
    ctx.fill();
    ctx.restore();

    if (val > 0) {
      ctx.fillStyle = hovered ? fbAccentHi : fbMuted;
      ctx.font = (hovered ? '700 ' : '600 ') + '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(val), x + barWidth / 2, y - 4);
    }

    if (idx % 2 === 0) {
      ctx.fillStyle = fbMuted;
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(labels[idx], x + barWidth / 2, height - 10);
    }
  });

  // Интерактив: щедрые «колонки» во всю высоту графика.
  const prevChart = canvas._chart;
  canvas._chart = {
    kind: 'bar',
    hover: hoverIdx,
    hit: (mx, my) => {
      if (mx < paddingLeft || my < paddingTop - 6 || my > paddingTop + chartH + 24) return -1;
      const i = Math.floor((mx - paddingLeft) / (barWidth + barGap));
      return (i >= 0 && i < data.length) ? i : -1;
    },
    tipFor: (i) => `<b>${labels[i]}</b> · ${data[i]} ${data[i] === 1 ? 'review' : 'reviews'}`,
    redraw: (h) => drawFallbackBarChart(canvas, labels, data, h)
  };
  if (prevChart && typeof prevChart.click === 'function') canvas._chart.click = prevChart.click;
  bindChartHover(canvas);
}

function drawFallbackDonutChart(canvas, labels, data, colors, centerWord, hoverIdx) {
  if (!canvas) return;
  hoverIdx = typeof hoverIdx === 'number' ? hoverIdx : -1;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = (rect.width || 360) * dpr;
  canvas.height = (rect.height || 260) * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width || 360;
  const height = rect.height || 260;

  ctx.clearRect(0, 0, width, height);

  const total = data.reduce((a, b) => a + b, 0) || 1;
  const centerX = width * 0.38;
  const centerY = height * 0.5;
  const outerRadius = Math.min(centerX, centerY) - 15;
  const innerRadius = outerRadius * 0.6;

  let startAngle = -Math.PI / 2;
  const slices = [];

  data.forEach((val, i) => {
    const sliceAngle = (val / total) * 2 * Math.PI;
    const endAngle = startAngle + sliceAngle;
    const hovered = i === hoverIdx && val > 0;
    const mid = (startAngle + endAngle) / 2;
    const off = hovered ? 7 : 0;
    const cx = centerX + Math.cos(mid) * off;
    const cy = centerY + Math.sin(mid) * off;

    ctx.save();
    if (hovered) { ctx.shadowColor = colors[i]; ctx.shadowBlur = 18; }
    ctx.beginPath();
    ctx.arc(cx, cy, outerRadius + (hovered ? 3 : 0), startAngle, endAngle);
    ctx.arc(cx, cy, innerRadius, endAngle, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = colors[i];
    ctx.fill();
    ctx.restore();

    slices.push({ s: startAngle, e: endAngle });
    startAngle = endAngle;
  });

  // Центр «дырки»: при наведении — сегмент крупно, иначе общая сумма.
  ctx.textAlign = 'center';
  if (hoverIdx >= 0 && data[hoverIdx] !== undefined && data[hoverIdx] > 0) {
    const pct = Math.round((data[hoverIdx] / total) * 100);
    ctx.fillStyle = themeToken('--text-muted', '#94a3b8');
    ctx.font = '700 10px sans-serif';
    ctx.fillText(String(labels[hoverIdx]).toUpperCase(), centerX, centerY - 12);
    ctx.fillStyle = themeToken('--text-bright', '#f1f5f9');
    ctx.font = '800 24px "Plus Jakarta Sans", sans-serif';
    ctx.fillText(String(data[hoverIdx]), centerX, centerY + 10);
    ctx.fillStyle = themeToken('--text-muted', '#94a3b8');
    ctx.font = '10px sans-serif';
    ctx.fillText(pct + '% of total', centerX, centerY + 26);
  } else {
    ctx.fillStyle = themeToken('--text-bright', '#f1f5f9');
    ctx.font = '800 22px "Plus Jakarta Sans", sans-serif';
    ctx.fillText(String(data.reduce((a, b) => a + b, 0)), centerX, centerY + 2);
    ctx.fillStyle = themeToken('--text-muted', '#94a3b8');
    ctx.font = '10px sans-serif';
    ctx.fillText(centerWord || 'words total', centerX, centerY + 18);
  }

  // Legend
  const legendX = width * 0.7;
  let legendY = height * 0.2;
  labels.forEach((label, i) => {
    const hovered = i === hoverIdx && data[i] > 0;
    ctx.save();
    if (hovered) { ctx.shadowColor = colors[i]; ctx.shadowBlur = 10; }
    ctx.fillStyle = colors[i];
    ctx.fillRect(legendX, legendY - (hovered ? 1 : 0), 12, hovered ? 14 : 12);
    ctx.restore();

    ctx.fillStyle = hovered ? themeToken('--text-bright', '#f1f5f9') : themeToken('--text-main', '#cbd5e1');
    ctx.font = (hovered ? '700 ' : '') + '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${label}: ${data[i]}`, legendX + 18, legendY + 10);

    legendY += 24;
  });

  // Интерактив: кольцо между inner и outer радиусами, угол → срез.
  // ВАЖНО: hover/themechange перерисовывают и ПЕРЕСОЗДАЮТ canvas._chart —
  // click-биндинг (его навешивает renderStatsScreen после первой отрисовки)
  // обязан переживать перерисовки, иначе клик по срезу умирает после первого
  // же наведения (найдено browser-ревью: любой реальный клик preceded hover).
  const prevChart = canvas._chart;
  canvas._chart = {
    kind: 'donut',
    hover: hoverIdx,
    hit: (mx, my) => {
      const dx = mx - centerX, dy = my - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < innerRadius - 8 || dist > outerRadius + 12) return -1;
      let a = Math.atan2(dy, dx);
      while (a < -Math.PI / 2) a += Math.PI * 2;
      for (let i = 0; i < slices.length; i++) {
        if (a >= slices[i].s && a < slices[i].e && data[i] > 0) return i;
      }
      return -1;
    },
    tipFor: (i) => `<b>${labels[i]}</b> · ${data[i]} (${Math.round((data[i] / total) * 100)}%)`,
    redraw: (h) => drawFallbackDonutChart(canvas, labels, data, colors, centerWord, h)
  };
  if (prevChart && typeof prevChart.click === 'function') canvas._chart.click = prevChart.click;
  bindChartHover(canvas);
}

// ==========================================
// DASHBOARD RENDERER & INTERACTIVE BOXES
// ==========================================
// Порядок строк панели знаний = порядок DOM-контракта (bank → mastered).
const BUCKET_ORDER = ['bank', 'new', 'learning', 'familiar', 'confident', 'mastered'];

function renderDashboard() {
  const today = srsToday();
  const summary = SRS.summarize(appState.cards, today);
  const total = summary.total;
  // «К повтору» считаем ЗАПИСЯМИ (слово × направление): у слова две независимые стороны,
  // и каждая просроченная сторона — отдельная работа.
  const dueCount = summary.dueEntries;

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  // DOM-контракт v2: #dash-total подписан «In the Bank», #dash-learned — «MASTERED (30 days)».
  setText('dash-total', summary.bank);
  setText('dash-learned', summary.groups.MASTERED || 0);
  setText('dash-due', dueCount);
  setText('dash-streak', (appState.streak && appState.streak.count) || 0);
  setText('dash-due-now', dueCount);
  setText('dash-due-en-ru', summary.dueByDirection.en_ru);
  setText('dash-due-ru-en', summary.dueByDirection.ru_en);

  const acc = calculateAccuracy();
  setText('dash-accuracy', `${acc.accuracy}%`);

  const heroDue = document.getElementById('hero-due-text');
  if (heroDue) {
    if (total === 0) heroDue.textContent = 'Your dictionary is empty. Add new words to begin!';
    else if (dueCount > 0) heroDue.textContent = `Due now: ${dueCount} ${dueCount === 1 ? 'side' : 'sides'} across ${summary.dueCards} ${summary.dueCards === 1 ? 'word' : 'words'}`;
    else heroDue.textContent = 'Nothing due right now — every review is done 💪';
  }

  const heroLearn = document.getElementById('hero-learn-text');
  if (heroLearn) {
    heroLearn.textContent = summary.bank > 0
      ? `${summary.bank} new ${summary.bank === 1 ? 'word' : 'words'} waiting in the Bank`
      : 'The Bank is empty — add new words to keep going';
  }

  // Шесть строк групп знаний вместо шести коробок; доля считается от общего числа карточек.
  BUCKET_ORDER.forEach(bucket => {
    const count = summary.groups[String(bucket).toUpperCase()] || 0;
    const cntEl = document.getElementById(`kg-count-${bucket}`);
    const barEl = document.getElementById(`kg-bar-${bucket}`);
    if (cntEl) cntEl.textContent = count;
    if (barEl) barEl.style.width = `${Math.min(100, Math.round((count / Math.max(total, 1)) * 100))}%`;
  });

  // Страж отказа в записи обязан быть виден, а не прятаться в консоли.
  if (saveBlockedReason && typeof showToast === 'function') {
    showToast('Saving is blocked — your base was not overwritten: ' + saveBlockedReason, 'error');
  }
}

/** Клик по строке группы знаний → словарь с этим фильтром. */
function openGroupInDictionary(bucket) {
  const key = String(bucket === null || bucket === undefined ? '' : bucket).toLowerCase();
  const filterSelect = document.getElementById('dict-filter-group');
  if (filterSelect) filterSelect.value = key;
  activeGroupFilterForPractice = key;
  switchScreen('dictionary');
  renderDictionary();
}

// ==========================================
// ПЛАНИРОВЩИК: ОЧЕРЕДИ ИЗ srs.js (БЕЗ КОРОБОК)
// ==========================================

/** 'auto' | '' | null → автовыбор; 'eng-rus'/'rus-eng' → канон SRS. */
function resolveDirectionOverride() {
  if (!sessionDirectionOverride) return null;
  const v = String(sessionDirectionOverride).trim().toLowerCase();
  if (!v || v === 'auto' || v === 'null' || v === 'undefined') return null;
  try {
    return SRS.normalizeDir(v);
  } catch (e) {
    console.warn('Неизвестное направление в переключателе:', sessionDirectionOverride);
    return null;
  }
}

/**
 * Направление для режимов, где очередь не диктует сторону (партия, часть речи,
 * своя группа). Прежний pickDirection() бросал монетку и читал мёртвые флаги
 * eng_to_rus/rus_to_eng (они никогда не выставлялись в true), поэтому фактически
 * всегда возвращал 'eng-rus'. Теперь выбираем ОСНОВАННО: явный оверрайд →
 * единственное просроченное направление → более слабый вектор → дольше ждущий.
 */
function directionForCard(card, today) {
  const override = resolveDirectionOverride();
  if (override) return override;
  const due = SRS.dueDirections(card, today);
  if (due.length === 1) return due[0];
  const le = SRS.directionLevel(card, 'en_ru');
  const lr = SRS.directionLevel(card, 'ru_en');
  if (le !== lr) return le < lr ? 'en_ru' : 'ru_en';
  const de = SRS.directionDueDate(card, 'en_ru');
  const dr = SRS.directionDueDate(card, 'ru_en');
  if (de && dr && de !== dr) return SRS.diffDays(de, dr) < 0 ? 'en_ru' : 'ru_en';
  return 'en_ru';
}

/** Общие опции очередей: детерминированный сид + учёт переключателя направления. */
function queueOpts(extra) {
  const o = { seed: sessionSeed === null ? srsToday() : sessionSeed };
  const dir = resolveDirectionOverride();
  if (dir) o.direction = dir;
  return Object.assign(o, extra || {});
}

// Категории частей речи уже объявлены ниже (POS_CATEGORIES + getPosCards) — переиспользуем их.

/**
 * Построение очереди под режим. Все очереди — из srs.js, поэтому порядок
 * «слабые первыми», изоляция банка и несоседность двух сторон одного слова
 * гарантируются ядром, а не здешним кодом.
 */
function buildQueueForMode(mode, specificGroup, specificFilter, today) {
  const cards = appState.cards;

  if (mode === 'single_word') {
    const card = cardById(specificFilter);
    if (!card) return [];
    // Одно слово прогоняем ОБЕИМИ сторонами: это и есть смысл двух векторов.
    return SRS.buildSubsetQueue([card], today, queueOpts({ allDirections: true, includeBank: true }));
  }

  if (mode === 'batch') {
    const list = cards.filter(c => (c.batch_id || 'unbatched') === specificFilter);
    return SRS.buildSubsetQueue(list, today, queueOpts({ fallbackAllDirections: true, includeBank: true }));
  }

  if (mode === 'pos') {
    const list = getPosCards(specificFilter);
    return SRS.buildSubsetQueue(list, today, queueOpts({ fallbackAllDirections: true, includeBank: true }));
  }

  if (mode === 'custom_group') {
    const grp = (appState.custom_groups || []).find(g => g && g.id === specificFilter);
    const ids = grp ? (Array.isArray(grp.card_ids) ? grp.card_ids : (Array.isArray(grp.cards) ? grp.cards : [])) : [];
    const list = cards.filter(c => ids.includes(c.id));
    return SRS.buildSubsetQueue(list, today, queueOpts({ fallbackAllDirections: true, includeBank: true }));
  }

  if (mode === 'group') {
    // «Практиковать группу» drill-ит всю группу, а не только просроченное.
    return SRS.buildCramQueue(cards, today, queueOpts({ group: specificGroup }));
  }

  if (mode === 'learn') {
    return SRS.buildLearnQueue(cards, today, queueOpts({ limit: SRS.DEFAULTS.learnBatchLimit }));
  }

  if (mode === 'mixed' || mode === 'cram') {
    return SRS.buildCramQueue(cards, today, queueOpts({}));
  }

  if (mode === 'eng-rus') return SRS.buildCramQueue(cards, today, queueOpts({ direction: 'en_ru' }));
  if (mode === 'rus-eng') return SRS.buildCramQueue(cards, today, queueOpts({ direction: 'ru_en' }));

  // 'system' / 'daily' / 'practice' — большая кнопка Practice: ровно то, что должно сегодня.
  return SRS.buildReviewQueue(cards, today, queueOpts({ group: specificGroup || undefined }));
}

// Update direction switcher UI to show active button
function updateDirectionSwitcherUI(isLearnMode = false) {
  const bar = document.getElementById('direction-switcher-bar');
  if (!bar) return;

  // В режиме изучения сторону диктует очередь (обе стороны слова), а не переключатель.
  if (isLearnMode) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  document.querySelectorAll('.dir-btn').forEach(btn => btn.classList.remove('dir-btn-active'));
  const activeDir = sessionDirectionOverride || 'auto';
  const activeBtn = document.querySelector(`.dir-btn[data-dir="${activeDir}"]`);
  if (activeBtn) activeBtn.classList.add('dir-btn-active');
}

let currentTrainingMode = null;
let currentTrainingGroup = null;
let currentTrainingFilter = null;

/**
 * Запуск сессии. mode:
 *  'system'|'daily'|'practice' — ежедневная очередь (большая кнопка Practice)
 *  'learn'                     — новые слова из Банка, обе стороны
 *  'group'   + specificGroup   — drill всей группы знаний
 *  'mixed'                     — все активные без фильтра по сроку
 *  'single_word'|'batch'|'pos'|'custom_group' + specificFilter
 *  'eng-rus'|'rus-eng'         — drill одного направления
 */
function startTrainingSession(mode, specificGroup = null, specificFilter = null) {
  if (document.activeElement && document.activeElement.blur && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
  const today = srsToday();

  if (appState.cards.length === 0) {
    showToast('Your dictionary is empty! Add words first.', 'info');
    switchScreen('add-words');
    return;
  }

  // Каждая новая сессия начинает с автовыбора направления.
  sessionDirectionOverride = null;

  const isLearnMode = mode === 'learn';
  const items = buildQueueForMode(mode, specificGroup, specificFilter, today);

  if (!items.length) {
    if (mode === 'system' || mode === 'daily' || mode === 'practice') {
      showToast('🎉 Nothing due — every review for today is done!', 'success');
    } else if (isLearnMode) {
      showToast('🏦 The Bank is empty — no new words to learn right now.', 'info');
    } else if (mode === 'group') {
      showToast(`No words in group “${String(specificGroup || '').toUpperCase()}”.`, 'info');
    } else {
      showToast('No cards to practice in this mode.', 'info');
    }
    return;
  }

  // Сессия — реестр оценок и повторов. currentTrainingQueue и srsSession.items
  // намеренно ОДИН массив: повторный показ «забытого» слова вставляется в него же.
  srsSession = SRS.createSession(items, { mode, today, seed: sessionSeed });
  currentTrainingQueue = srsSession.items;
  currentTrainingMode = mode;
  currentTrainingGroup = specificGroup;
  currentTrainingFilter = specificFilter;
  sessionUndoStack = [];
  currentCardIndex = 0;

  if (mode === 'single_word') trainingSourceScreen = 'dictionary';
  else if (mode === 'batch' || mode === 'pos' || mode === 'custom_group') trainingSourceScreen = 'groups';
  else trainingSourceScreen = 'dashboard';

  switchScreen('training');
  updateDirectionSwitcherUI(isLearnMode);
  renderCurrentCard();
}

/** Пересобрать очередь текущей сессии (после переключения направления). */
function restartCurrentTrainingSession() {
  if (!currentTrainingMode) return;
  startTrainingSession(currentTrainingMode, currentTrainingGroup, currentTrainingFilter);
}

// ==========================================
// MINIMALIST CARD TRAINER UI & QUEUE ACTIONS
// ==========================================
function renderCurrentCard() {
  if (currentCardIndex >= currentTrainingQueue.length) {
    launchConfetti();
    showToast('🎉 Practice finished! All words reviewed!', 'success');
    recordActivity();
    // Reset direction override after session ends so next session starts with default
    sessionDirectionOverride = null;
    updateDirectionSwitcherUI(false);
    switchScreen(trainingSourceScreen || 'dashboard');
    return;
  }


  if (currentCardIndex < 0) currentCardIndex = 0;

  // Пропускаем уже закрытые записи. Флаг ставится на КОНКРЕТНЫЙ объект очереди,
  // а не на ключ: повторный показ «забытого» слова вставляется отдельной копией
  // (kind:'requeue') и обязан остаться видимым.
  while (currentCardIndex < currentTrainingQueue.length
         && currentTrainingQueue[currentCardIndex]
         && currentTrainingQueue[currentCardIndex].done === true) {
    currentCardIndex++;
  }
  if (currentCardIndex >= currentTrainingQueue.length) { renderCurrentCard(); return; }
  if (srsSession) srsSession.cursor = currentCardIndex;

  currentTrainingItem = currentTrainingQueue[currentCardIndex];
  // Направление диктует очередь (QueueItem.direction), а не монетка в момент рендера.
  const direction = SRS.normalizeDir(currentTrainingItem.direction);
  const card = cardById(currentTrainingItem.cardId);

  // Слово могли удалить из словаря прямо во время сессии — рендер не роняем.
  if (!card) {
    console.warn('[train] карточка исчезла из базы, пропускаем:', currentTrainingItem.cardId);
    currentTrainingItem.done = true;
    currentCardIndex++;
    renderCurrentCard();
    return;
  }

  isFlipped = false;
  hasBeenFlippedForCurrentCard = false;
  hintUsedForCurrentCard = false;

  const flashcard = document.getElementById('flashcard');
  if (flashcard) {
    flashcard.style.transition = 'none';
    flashcard.style.transform = 'rotateY(0deg)';
    flashcard.classList.remove('flipped');
  }

  // Reset hint UI
  const hintDisplay = document.getElementById('hint-display');
  if (hintDisplay) {
    hintDisplay.classList.add('hidden');
    hintDisplay.textContent = '';
  }
  const btnHint = document.getElementById('btn-hint');
  if (btnHint) btnHint.disabled = false;

  const sStats = srsSession ? SRS.sessionStats(srsSession) : null;
  const repeatsSuffix = (sStats && sStats.requeued) ? ` (+${sStats.requeued} repeat${sStats.requeued === 1 ? '' : 's'})` : '';
  const counterEl = document.getElementById('train-counter');
  if (counterEl) counterEl.textContent = `${currentCardIndex + 1} / ${currentTrainingQueue.length}${repeatsSuffix}`;

  const phoneticEl = document.getElementById('card-phonetic-text');
  const modeTitleEl = document.getElementById('train-mode-title');

  if (direction === 'en_ru') {
    if (modeTitleEl) modeTitleEl.textContent = 'Mode: ENG ➔ RUS';
    document.getElementById('card-word-text').textContent = card.word;

    // Show Phonetic Transcription on English front face (if available)
    if (card.phonetic && String(card.phonetic).trim() !== '') {
      phoneticEl.textContent = String(card.phonetic).trim();
      phoneticEl.classList.remove('hidden');
    } else {
      phoneticEl.textContent = '';
      phoneticEl.classList.add('hidden');
    }

    document.getElementById('card-back-original').textContent = card.word;
    document.getElementById('card-translation-text').textContent = card.translation;
  } else {
    if (modeTitleEl) modeTitleEl.textContent = 'Mode: RUS ➔ ENG';
    document.getElementById('card-word-text').textContent = card.translation;

    // HIDE Phonetic Transcription completely on Russian front face!
    phoneticEl.textContent = '';
    phoneticEl.classList.add('hidden');

    document.getElementById('card-back-original').textContent = card.translation;
    document.getElementById('card-translation-text').textContent = card.word;
  }

  // Back side: Dual Example Box (English Example + Russian Example Translation)
  document.getElementById('card-example-text').textContent = card.example || 'No example sentence provided.';
  const transEl = document.getElementById('card-example-trans-text');
  if (card.example_translation && String(card.example_translation).trim() !== '') {
    transEl.textContent = String(card.example_translation).trim();
    transEl.classList.remove('hidden');
  } else {
    transEl.textContent = '';
    transEl.classList.add('hidden');
  }

  // Хром карточки: направление + уровень/группа + срок вместо номера коробки.
  // Показываем состояние ИМЕННО ЭТОГО направления: вторая сторона живёт своим графиком.
  const chromeInfo = SRS.describeDirection(card, direction, srsToday(), 'en');
  ['front', 'back'].forEach(side => {
    const dirEl = document.getElementById(`card-dir-indicator-${side}`);
    const pillEl = document.getElementById(`card-level-pill-${side}`);
    const dueEl = document.getElementById(`card-due-note-${side}`);
    if (dirEl) dirEl.textContent = chromeInfo.short;
    if (pillEl) {
      pillEl.textContent = `${chromeInfo.levelLabel} · ${chromeInfo.group}`;
      pillEl.className = `card-level-pill grp-${chromeInfo.group.toLowerCase()}`;
    }
    if (dueEl) {
      dueEl.textContent = chromeInfo.phrase;
      dueEl.classList.toggle('is-overdue', chromeInfo.bucket === 'overdue');
      dueEl.dataset.overdue = chromeInfo.bucket === 'overdue' ? 'true' : 'false';
    }
  });

  // Speak buttons setup for both Front and Back sides
  const btnSpeakWord = document.getElementById('btn-speak-word');
  const btnSpeakHint = document.getElementById('btn-speak-hint');
  const hintContainer = document.getElementById('hint-container');
  const btnSpeakBackWord = document.getElementById('btn-speak-back-word');
  const btnSpeakBackExample = document.getElementById('btn-speak-back-example');

  if (hintContainer) hintContainer.classList.add('hidden');
  if (btnSpeakHint) btnSpeakHint.classList.add('hidden');

  // Front Face speak button: English word on ENG->RUS mode only
  if (btnSpeakWord) {
    if (direction === 'en_ru') {
      btnSpeakWord.classList.remove('hidden');
      attachSpeakHandler(btnSpeakWord, card.word);
    } else {
      btnSpeakWord.classList.add('hidden');
    }
  }

  // Back Face speak button for English word (available in both ENG->RUS and RUS->ENG modes)
  if (btnSpeakBackWord) {
    btnSpeakBackWord.classList.remove('hidden');
    attachSpeakHandler(btnSpeakBackWord, card.word);
  }

  // Back Face speak button for English example sentence
  if (btnSpeakBackExample) {
    if (card.example && card.example.trim() !== '') {
      btnSpeakBackExample.classList.remove('hidden');
      attachSpeakHandler(btnSpeakBackExample, card.example.trim());
    } else {
      btnSpeakBackExample.classList.add('hidden');
    }
  }
}

// ==========================================
// TEXT-TO-SPEECH UTILITY & SAFE CLICK HANDLER
// ==========================================
let englishVoice = null;
function loadVoices() {
  if (!window.speechSynthesis) return;
  const voices = window.speechSynthesis.getVoices();
  if (voices && voices.length > 0) {
    englishVoice = voices.find(v => (v.lang === 'en-US' || v.lang === 'en_US') && (v.name.includes('Natural') || v.name.includes('Online') || v.name.includes('Google') || v.name.includes('Jenny') || v.name.includes('Guy')))
      || voices.find(v => v.lang === 'en-US' || v.lang === 'en_US')
      || voices.find(v => v.lang.startsWith('en'))
      || null;
  }
}
if (typeof window !== 'undefined' && window.speechSynthesis) {
  loadVoices();
  if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = loadVoices;
  }
}

function speakEnglish(text) {
  if (!window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  if (!englishVoice) loadVoices();
  if (englishVoice) utt.voice = englishVoice;
  utt.lang = 'en-US';
  utt.rate = 0.88;
  utt.pitch = 1;
  window.speechSynthesis.speak(utt);
}

function attachSpeakHandler(btn, textToSpeak) {
  if (!btn) return;
  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    speakEnglish(textToSpeak);
  };
  btn.onmousedown = (e) => e.stopPropagation();
  btn.ontouchstart = (e) => e.stopPropagation();
  btn.onpointerdown = (e) => e.stopPropagation();
}

// Bidirectional Flip (Front <-> Back)
function toggleFlipCard() {
  isFlipped = !isFlipped;
  const flashcard = document.getElementById('flashcard');
  if (!flashcard) return;

  if (isFlipped) {
    hasBeenFlippedForCurrentCard = true;
  }

  flashcard.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
  if (isFlipped) {
    flashcard.classList.add('flipped');
    flashcard.style.transform = 'rotateY(180deg)';
  } else {
    flashcard.classList.remove('flipped');
    flashcard.style.transform = 'rotateY(0deg)';
  }
}

// Hint button: Shows English sentence on ENG side, Russian sentence on RUS side
function useHint() {
  if (hintUsedForCurrentCard) return;
  hintUsedForCurrentCard = true;

  if (!currentTrainingItem) return;
  const direction = SRS.normalizeDir(currentTrainingItem.direction);
  const card = cardById(currentTrainingItem.cardId);
  if (!card) return;
  const hintContainer = document.getElementById('hint-container');
  const hintDisplay = document.getElementById('hint-display');
  const btnSpeakHint = document.getElementById('btn-speak-hint');
  
  if (direction === 'en_ru') {
    if (!card.example || card.example.trim() === '') {
      hintDisplay.textContent = 'No example sentence set for this word.';
      if (btnSpeakHint) btnSpeakHint.classList.add('hidden');
    } else {
      hintDisplay.textContent = `Example: "${card.example.trim()}"`;
      if (btnSpeakHint) {
        btnSpeakHint.classList.remove('hidden');
        attachSpeakHandler(btnSpeakHint, card.example.trim());
      }
    }
  } else {
    const rusEx = (card.example_translation && card.example_translation.trim() !== '') 
      ? card.example_translation.trim() 
      : card.example;

    if (!rusEx || String(rusEx).trim() === '') {
      hintDisplay.textContent = 'No example sentence set for this word.';
    } else {
      hintDisplay.textContent = `Example: "${String(rusEx).trim()}"`;
    }
    if (btnSpeakHint) btnSpeakHint.classList.add('hidden');
  }

  if (hintContainer) hintContainer.classList.remove('hidden');
  hintDisplay.classList.remove('hidden');
  document.getElementById('btn-hint').disabled = true;

  showToast('⚠️ Hint used — this side will be graded as “Forgot”.', 'info');
}

/**
 * ОЦЕНКА ОТВЕТА. ПРАВИЛО 3: нажатие «Легко / Сложно / Забыл» применяется
 * ИСКЛЮЧИТЕЛЬНО к тому направлению, которое сейчас показано. Второй вектор слова
 * не трогается вообще — этим занимается SRS.applyAnswer (инвариант проверяется тестами).
 *
 * answerToken: 'again'|'hard'|'easy' (а также русские/английские синонимы, 1..4 и boolean —
 * всё нормализует SRS.normalizeAnswer, поэтому старые вызовы processAnswer(1|3) работают).
 */
async function submitAnswer(answerToken) {
  if (!currentTrainingItem) return;
  const item = currentTrainingItem;
  const today = srsToday();
  const card = cardById(item.cardId);

  if (!card) {
    console.warn('[answer] карточка не найдена, пропускаем запись:', item.cardId);
    item.done = true;
    currentCardIndex++;
    if (srsSession) srsSession.cursor = currentCardIndex;
    renderCurrentCard();
    return;
  }

  // Защита от двойной оценки одной и той же пары слово:направление
  // (двойное нажатие, залипшая клавиша, повтор в очереди).
  // Выходим БЕЗ продвижения: первый, ещё не завершённый вызов сам оценит запись и
  // продвинет курсор. Прежняя версия двигала индекс здесь и там же, из-за чего
  // следующая НЕоцененная карточка молча выпадала из сессии (и оставалась к сроку).
  if (srsSession && SRS.sessionIsGraded(srsSession, item.key) && item.kind !== 'requeue') {
    console.warn('[answer] запись уже оценена в этой сессии, повторный клик проигнорирован:', item.key);
    return;
  }

  let answer;
  try {
    answer = SRS.normalizeAnswer(answerToken);
  } catch (e) {
    console.error('[answer] неизвестная оценка:', answerToken, e && e.message);
    return;
  }

  // Подсказка = сам не вспомнил (прежнее поведение rating=1 сохранено).
  if (hintUsedForCurrentCard) answer = SRS.ANSWERS.AGAIN;

  const direction = SRS.normalizeDir(item.direction);

  // Кадр отката снимаем ДО изменения: карточка целиком (оба вектора), история дня,
  // позиция в очереди и факт «слово было в банке» (для отката активации).
  const undoFrame = {
    cardId: card.id,
    cardSnapshot: JSON.parse(JSON.stringify(card)),
    historySnapshot: appState.history[today] ? JSON.parse(JSON.stringify(appState.history[today])) : null,
    today,
    itemKey: item.key,
    itemIndex: currentCardIndex,
    wasBank: SRS.isBank(card),
    direction,
    answer
  };

  const result = SRS.applyAnswer(card, direction, answer, today);
  replaceCardById(result.card);

  // История дня. total = число ОЦЕНЁННЫХ ЗАПИСЕЙ (слово × направление), поэтому в день,
  // когда у слова просрочены обе стороны, счётчик выше прежнего «по карточкам» — это
  // честно и описано в гайде. correct = вспомнил (Сложно и Легко).
  if (!appState.history[today]) {
    appState.history[today] = {
      total: 0, correct: 0,
      byAnswer: { again: 0, hard: 0, easy: 0 },
      byDirection: { en_ru: { total: 0, correct: 0 }, ru_en: { total: 0, correct: 0 } }
    };
  }
  const h = appState.history[today];
  h.total = (h.total || 0) + 1;
  const isCorrect = answer !== SRS.ANSWERS.AGAIN;
  if (isCorrect) h.correct = (h.correct || 0) + 1;
  if (!h.byAnswer) h.byAnswer = { again: 0, hard: 0, easy: 0 };
  h.byAnswer[answer] = (h.byAnswer[answer] || 0) + 1;
  if (!h.byDirection) h.byDirection = { en_ru: { total: 0, correct: 0 }, ru_en: { total: 0, correct: 0 } };
  if (!h.byDirection[direction]) h.byDirection[direction] = { total: 0, correct: 0 };
  h.byDirection[direction].total = (h.byDirection[direction].total || 0) + 1;
  if (isCorrect) h.byDirection[direction].correct = (h.byDirection[direction].correct || 0) + 1;

  sessionUndoStack.push(undoFrame);
  if (srsSession) SRS.sessionMarkGraded(srsSession, item.key, answer, direction);

  // «Забыл» → слово возвращается в хвост ЭТОЙ же сессии (не более одного повтора),
  // чтобы добить его сегодня, не ломая правило «в очереди только просроченное».
  let requeueOutcome = null;
  if (answer === SRS.ANSWERS.AGAIN && srsSession) {
    requeueOutcome = SRS.sessionRequeue(srsSession, item);
  }
  // ВАЖНО: done ставим ПОСЛЕ sessionRequeue — копия в очереди должна остаться неотмеченной.
  item.done = true;

  // Режим изучения: первое слово из Банка активируется этим ответом, а вторая его
  // сторона остаётся должной сегодня → добавляем её в ту же сессию (не подряд).
  if (result.activated && srsSession && result.pendingDirections && result.pendingDirections.length) {
    const added = SRS.sessionEnsure(srsSession, result.card, result.pendingDirections, today, 'learn');
    if (added.length) console.log('[learn] вторая сторона добавлена в сессию:', added.join(', '));
  }

  await saveData();

  currentCardIndex++;
  if (srsSession) srsSession.cursor = currentCardIndex;
  renderCurrentCard();

  // Короткая обратная связь: что случилось с ЭТИМ направлением.
  const meta = SRS.ANSWER_META[answer];
  const nextInfo = result.next;
  if (answer === SRS.ANSWERS.AGAIN) {
    showToast(`${meta.icon} “${card.word}” ${direction === 'en_ru' ? 'EN→RU' : 'RU→EN'} → L${nextInfo.level}, back ${nextInfo.intervalDays}d${requeueOutcome === 'requeued' ? ' · repeated in this session' : ''}`, 'error');
  } else if (result.outcome === 'advance') {
    showToast(`${meta.icon} “${card.word}” ${direction === 'en_ru' ? 'EN→RU' : 'RU→EN'} → L${nextInfo.level} (${nextInfo.group}), next in ${nextInfo.intervalDays}d`, 'success');
  } else {
    showToast(`${meta.icon} “${card.word}” held at L${nextInfo.level}, next in ${nextInfo.intervalDays}d`, 'info');
  }
}

/** Обратная совместимость: старые вызовы processAnswer(1|2|3|4|true|false). */
async function processAnswer(ratingOrIsCorrect) {
  return submitAnswer(ratingOrIsCorrect);
}

/**
 * Возврат слова в Банк. Замена прежнего manuallyMoveCardToBox(0..5): ручных
 * коробок больше нет — есть только статус и два уровня, которые ставятся
 * либо ответами, либо явно в модалке редактирования.
 */
async function returnWordToBank(cardOrId) {
  const card = typeof cardOrId === 'string'
    ? cardById(cardOrId)
    : (cardOrId && cardOrId.id ? cardOrId : (currentTrainingItem ? cardById(currentTrainingItem.cardId) : null));
  if (!card) return null;
  if (SRS.isBank(card)) {
    showToast('“' + card.word + '” is already in the Bank.', 'info');
    return null;
  }
  const snapshot = JSON.parse(JSON.stringify(card));
  replaceCardById(SRS.returnToBank(card));
  await saveData();
  showToast(`🏦 “${card.word}” returned to the Bank — it is out of the review schedule until you learn it again.`, 'info');
  renderDashboard();
  return snapshot;
}

/** Ручная установка уровня одного направления (модалка редактирования). */
async function setCardDirectionLevel(cardOrId, dir, level) {
  const card = typeof cardOrId === 'string' ? cardById(cardOrId) : cardOrId;
  if (!card) return null;
  const updated = SRS.setDirectionLevel(card, dir, level, srsToday());
  replaceCardById(updated);
  await saveData();
  renderDashboard();
  return updated;
}

// Down Arrow (↓): Undo & Return to Previous Card
async function undoPreviousCard() {
  if (sessionUndoStack.length === 0) {
    showToast('No previous card to return to!', 'info');
    return;
  }

  const frame = sessionUndoStack.pop();
  const live = cardById(frame.cardId);

  // Восстанавливаем карточку ЦЕЛИКОМ (оба вектора, счётчики, статус) на месте,
  // чтобы не порвать ссылки, которые уже держит очередь или словарь.
  if (live) {
    Object.keys(live).forEach(k => { delete live[k]; });
    Object.assign(live, frame.cardSnapshot);
  } else {
    replaceCardById(JSON.parse(JSON.stringify(frame.cardSnapshot)));
  }

  if (frame.historySnapshot) appState.history[frame.today] = frame.historySnapshot;
  else if (appState.history[frame.today]) delete appState.history[frame.today];

  // Снимаем отметку об оценке, чтобы пару можно было оценить заново,
  // и убираем повторный показ, который добавило «Забыл».
  if (srsSession) {
    if (srsSession.graded) delete srsSession.graded[frame.itemKey];
    if (srsSession.requeued) delete srsSession.requeued[frame.itemKey];
    if (Array.isArray(srsSession.items)) {
      for (let i = srsSession.items.length - 1; i > frame.itemIndex; i--) {
        const it = srsSession.items[i];
        if (it && it.key === frame.itemKey && it.kind === 'requeue') srsSession.items.splice(i, 1);
      }
    }
  }

  await saveData();

  currentCardIndex = Math.max(0, frame.itemIndex);
  if (srsSession) srsSession.cursor = currentCardIndex;
  const target = currentTrainingQueue[currentCardIndex];
  if (target && target.key === frame.itemKey) target.done = false;
  renderCurrentCard();
  renderDashboard();
  showToast(frame.wasBank ? '↩ Undone — the word is back in the Bank.' : '↩ Returned to previous card!', 'info');
}

// Up Arrow (↑) / W: Skip current card & move to END of current training session queue
function skipCardToEnd() {
  if (!currentTrainingItem) return;
  const item = currentTrainingItem;

  // Пропуск — БЕЗ оценки: уровень и даты не меняются, слово останется должным.
  const outcome = srsSession ? SRS.sessionSkip(srsSession, item.key) : null;

  if (outcome === 'moved-to-tail' || outcome === 'removed') {
    // sessionSkip сам изъял запись из позиции курсора (массив сдвинулся),
    // поэтому индекс НЕ увеличиваем — иначе запись пропала бы молча.
    showToast(outcome === 'removed'
      ? '⏭️ Skipped twice — the word stays due for a later session.'
      : '⏭️ Card moved to the end of the queue.', 'info');
  } else {
    // Страховка на случай сессии без реестра: переставляем руками.
    const idx = currentTrainingQueue.indexOf(item);
    if (idx >= 0) {
      currentTrainingQueue.splice(idx, 1);
      currentTrainingQueue.push(item);
    } else {
      currentCardIndex++;
    }
    showToast('⏭️ Card moved to the end of the queue.', 'info');
  }

  if (srsSession) srsSession.cursor = currentCardIndex;
  renderCurrentCard();
}

// ==========================================
// PURE OFFLINE CANVASES CONFETTI ANIMATION
// ==========================================
function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const pieces = [];
  const colors = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#3b82f6'];

  for (let i = 0; i < 120; i++) {
    pieces.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height - canvas.height,
      w: Math.random() * 10 + 6,
      h: Math.random() * 8 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      vy: Math.random() * 3 + 2,
      vx: Math.random() * 2 - 1,
      rot: Math.random() * 360,
      vRot: Math.random() * 6 - 3
    });
  }

  let animationFrame;
  function update() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let active = false;

    pieces.forEach(p => {
      p.y += p.vy;
      p.x += p.vx;
      p.rot += p.vRot;

      if (p.y < canvas.height) active = true;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rot * Math.PI) / 180);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });

    if (active) {
      animationFrame = requestAnimationFrame(update);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      cancelAnimationFrame(animationFrame);
    }
  }

  update();
}

// ==========================================
// SWIPE GESTURES: RIGHT = REMEMBERED 🟢, LEFT = FORGOT 🔴
// ==========================================
function setupSwipeGestures() {
  const container = document.getElementById('flashcard-container');
  const flashcard = document.getElementById('flashcard');

  let isDragging = false;
  let hasMoved = false;
  let startX = 0;
  let currentX = 0;

  function onPointerDown(e) {
    const trainingScreen = document.getElementById('screen-training');
    if (!trainingScreen || !trainingScreen.classList.contains('active')) return;
    if (e.target.closest('button, .btn-speak, #btn-hint, .no-flip, a, input, select, textarea')) return;

    isDragging = true;
    hasMoved = false;
    startX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
    currentX = 0;
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    const clientX = e.clientX || (e.touches && e.touches[0].clientX) || 0;
    currentX = clientX - startX;

    if (Math.abs(currentX) > 6) {
      hasMoved = true;
      flashcard.style.transition = 'none';
      const rot = currentX * 0.08;
      const currentRotY = isFlipped ? 180 : 0;
      flashcard.style.transform = `translateX(${currentX}px) rotate(${rot}deg) rotateY(${currentRotY}deg)`;
    }
  }

  function onPointerUp() {
    if (!isDragging) return;
    isDragging = false;

    if (!hasMoved) {
      // User just clicked/tapped the card — do not override transform, click listener handles flip smoothly
      return;
    }

    flashcard.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
    const threshold = 75;

    if (currentX > threshold) {
      // Swipe Right -> Remembered 🟢
      flashcard.style.transform = `translateX(600px) rotate(30deg) rotateY(${isFlipped ? 180 : 0}deg)`;
      setTimeout(() => {
        processAnswer(true);
      }, 150);
    } else if (currentX < -threshold) {
      // Swipe Left -> Forgot 🔴
      flashcard.style.transform = `translateX(-600px) rotate(-30deg) rotateY(${isFlipped ? 180 : 0}deg)`;
      setTimeout(() => {
        processAnswer(false);
      }, 150);
    } else {
      // Spring back to current face
      flashcard.style.transform = isFlipped ? 'rotateY(180deg)' : 'rotateY(0deg)';
    }

    currentX = 0;
    hasMoved = false;
  }

  container.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);

  container.addEventListener('touchstart', onPointerDown, { passive: true });
  window.addEventListener('touchmove', onPointerMove, { passive: true });
  window.addEventListener('touchend', onPointerUp);
}

// ==========================================
// CARD EDIT MODAL LOGIC
// ==========================================
function setupEditModal() {
  const modal = document.getElementById('modal-edit-card');
  const closeBtn = document.getElementById('btn-close-edit-modal');
  const cancelBtn = document.getElementById('btn-cancel-edit');
  const editForm = document.getElementById('form-edit-card');

  function hideModal() {
    modal.classList.add('hidden');
  }

  closeBtn.addEventListener('click', hideModal);
  cancelBtn.addEventListener('click', hideModal);

  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-card-id').value;
    const card = appState.cards.find(c => c.id === id);

    if (card) {
      const val = (id) => { const el = document.getElementById(id); return el ? String(el.value == null ? '' : el.value) : null; };
      const today = srsToday();
      let next = Object.assign({}, card);

      next.word = (val('edit-word') || '').trim();
      next.phonetic = (val('edit-phonetic') || '').trim();
      next.translation = (val('edit-translation') || '').trim();
      next.example = (val('edit-example') || '').trim();
      next.example_translation = (val('edit-example-trans') || '').trim();

      // part_of_speech может быть МАССИВОМ (реальные данные: 9 таких карточек), а поле
      // ввода — строка. Перезаписываем только если пользователь действительно его менял,
      // иначе молча превратили бы ["noun","verb"] в "noun / verb".
      const posInput = val('edit-part-of-speech');
      const posShown = SRS.posText(next.part_of_speech);
      if (posInput !== null && posInput.trim() !== String(posShown).trim()) next.part_of_speech = posInput.trim();

      // Статус и уровни ставятся мутаторами ядра: они чистые, возвращают копию и сами
      // пересчитывают next_review_* под новый уровень (INTERVALS[level]).
      const wantStatus = String(val('edit-status') || next.status || 'ACTIVE').toUpperCase();
      if (wantStatus === 'BANK') {
        next = SRS.returnToBank(next);
      } else {
        next = SRS.setCardStatus(next, 'ACTIVE', today);
        const le = parseInt(val('edit-level-en-ru'), 10);
        const lr = parseInt(val('edit-level-ru-en'), 10);
        if (Number.isFinite(le) && le !== (Number(next.level_en_ru) || 0)) next = SRS.setDirectionLevel(next, 'en_ru', le, today);
        if (Number.isFinite(lr) && lr !== (Number(next.level_ru_en) || 0)) next = SRS.setDirectionLevel(next, 'ru_en', lr, today);
      }

      replaceCardById(next);
      await saveData();
      renderDictionary();
      renderDashboard();
      renderGroupsScreen();
      hideModal();
      showToast(`✅ Card "${card.word}" successfully updated!`, 'success');
    }
  });
}

function openEditModal(card) {
  document.getElementById('edit-card-id').value = card.id;
  document.getElementById('edit-word').value = card.word || '';
  document.getElementById('edit-phonetic').value = card.phonetic || '';
  document.getElementById('edit-translation').value = card.translation || '';
  document.getElementById('edit-example').value = card.example || '';
  document.getElementById('edit-example-trans').value = card.example_translation || '';

  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('edit-part-of-speech', SRS.posText(card.part_of_speech));
  setVal('edit-status', String(card.status || 'ACTIVE').toUpperCase());
  setVal('edit-level-en-ru', String(Number(card.level_en_ru) || 0));
  setVal('edit-level-ru-en', String(Number(card.level_ru_en) || 0));

  // #edit-due-info — readonly: даты назначает алгоритм, вручную их править нельзя
  // (иначе расписание расходилось бы с историей оценок).
  const dueInfo = document.getElementById('edit-due-info');
  if (dueInfo) {
    const today = srsToday();
    dueInfo.value = SRS.isBank(card)
      ? 'Word Bank — no review dates until the word is activated'
      : SRS.DIRECTIONS.map(dir => {
          const m = SRS.DIRECTION_META[dir] || {};
          const d = card[SRS.dueKey(dir)] || '—';
          return `${m.short || dir}: ${d}${SRS.isDirectionDue(card, dir, today) ? ' (due)' : ''}`;
        }).join('   ·   ');
  }

  const editModal = document.getElementById('modal-edit-card');
  if (editModal) editModal.classList.remove('hidden');
}

// ==========================================
// IMPORT & EVENT HANDLERS
// ==========================================
function setupEventHandlers() {
  const btnStartPractice = document.getElementById('btn-hero-start-practice');
  if (btnStartPractice) {
    btnStartPractice.addEventListener('click', () => startTrainingSession('system'));
  }
  const btnStartLearn = document.getElementById('btn-hero-start-learn');
  if (btnStartLearn) {
    btnStartLearn.addEventListener('click', () => startTrainingSession('learn'));
  }

  // Переключатель направления внутри сессии. Направление теперь — свойство записи
  // очереди (слово × сторона), а не догадка в момент рендера, поэтому меняем его
  // честным пересбором очереди. Прежняя подмена item.direction у уже построенных
  // записей ломала связку «показанная сторона = оценённая сторона».
  document.querySelectorAll('.dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.dir;
      sessionDirectionOverride = (dir === 'auto') ? null : dir;
      updateDirectionSwitcherUI(currentTrainingMode === 'learn');
      if (currentTrainingMode) restartCurrentTrainingSession();
      else renderCurrentCard();
      showToast(`Direction set to: ${btn.textContent.trim()}`, 'info');
    });
  });

  // Клик по строке группы знаний → словарь с этим фильтром (было: строка коробки).
  document.querySelectorAll('.kg-row').forEach(row => {
    row.addEventListener('click', () => {
      const bucket = row.dataset.group;
      if (bucket) openGroupInDictionary(bucket);
    });
  });

  // «Practice this group»: drill всей выбранной группы знаний.
  const btnPracticeGroup = document.getElementById('btn-practice-group');
  if (btnPracticeGroup) {
    btnPracticeGroup.addEventListener('click', () => {
      const sel = document.getElementById('dict-filter-group');
      const bucket = sel ? String(sel.value || '') : '';
      if (bucket === 'due') startTrainingSession('system');
      else if (bucket) startTrainingSession('group', bucket);
      else startTrainingSession('mixed');
    });
  }

  // Card click toggles flip (front <-> back)
  const flashcardContainer = document.getElementById('flashcard-container');
  flashcardContainer.addEventListener('click', (e) => {
    if (e.target.closest('button, .btn-speak, #btn-hint, .no-flip, a, input, select, textarea')) return;
    if (document.activeElement && document.activeElement.blur && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    toggleFlipCard();
  });

  // ТРИ кнопки оценки вместо четырёх SM-2. «Сложно» больше не значит «хорошо»:
  // оно замораживает уровень, а продвигает только «Легко». Оценка уходит строго
  // в то направление, которое сейчас показано (currentTrainingItem.direction).
  const btnAgain = document.getElementById('btn-answer-again');
  const btnHard = document.getElementById('btn-answer-hard');
  const btnEasy = document.getElementById('btn-answer-easy');

  if (btnAgain) btnAgain.addEventListener('click', (e) => { e.stopPropagation(); submitAnswer(SRS.ANSWERS.AGAIN); });
  if (btnHard) btnHard.addEventListener('click', (e) => { e.stopPropagation(); submitAnswer(SRS.ANSWERS.HARD); });
  if (btnEasy) btnEasy.addEventListener('click', (e) => { e.stopPropagation(); submitAnswer(SRS.ANSWERS.EASY); });

  // Свайп-кнопки (👎 / 👍) удалены из разметки вместе с тиндер-механикой:
  // «нравится / не нравится» не способно выразить третью оценку «Сложно».

  document.getElementById('btn-undo-card').addEventListener('click', (e) => {
    e.stopPropagation();
    undoPreviousCard();
  });

  document.getElementById('btn-skip-card').addEventListener('click', (e) => {
    e.stopPropagation();
    skipCardToEnd();
  });

  // Keyboard Navigation Bindings (Window Capture Phase to guarantee instant response):
  // Space / S / Ы        = перевернуть карточку 🔄
  // 1 / ← / A / Ф        = 🔴 Забыл (уровень ≤3 → 1, >3 → 2)
  // 2                    = 🟠 Сложно (уровень заморожен)
  // 3 / → / D / В        = 🟢 Легко (+1 уровень, потолок L6 = 30 дней)
  // 0                    = 🏦 вернуть слово в Банк
  // ↓                    = откат к предыдущей карточке
  // ↑ / W / Ц            = пропустить (в конец очереди, без оценки)
  // Enter / Shift+Enter  = озвучить слово / подсказку
  // Escape               = закрыть модалку или вернуться в меню
  // Клавиша 4 намеренно свободна, а Shift/Alt+0..5 удалены: ручных коробок больше нет,
  // и расписание меняется только оценками (прежние горячие клавиши правили box и
  // next_review_date в обход истории — главный источник тихого дрейфа прогресса).
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Priority 1: Close any open modal
      const modals = [
        document.getElementById('modal-edit-card'),
        document.getElementById('modal-group-detail'),
        document.getElementById('modal-group-words'),
        document.getElementById('modal-manage-group-words')
      ];
      const openModal = modals.find(m => m && !m.classList.contains('hidden'));
      if (openModal) {
        openModal.classList.add('hidden');
        return;
      }

      // If we are on training screen, go back to source screen
      const trainingScreen = document.getElementById('screen-training');
      if (trainingScreen && trainingScreen.classList.contains('active') && trainingSourceScreen) {
        e.preventDefault();
        switchScreen(trainingSourceScreen);
        return;
      }

      // Priority 2: Return to dashboard from any screen
      e.preventDefault();
      switchScreen('dashboard');
      return;
    }

    const trainingScreen = document.getElementById('screen-training');
    if (trainingScreen && trainingScreen.classList.contains('active')) {
      const activeEl = document.activeElement;
      
      // If user is actually typing inside a visible input/textarea/select in an open modal
      if (activeEl && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName)) {
        if (activeEl.offsetParent === null) {
          activeEl.blur();
        } else {
          return;
        }
      }

      const key = (e.key || '').toLowerCase();
      const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar' || e.keyCode === 32 || e.which === 32;
      const isS = key === 's' || key === 'ы';
      const isEnter = e.code === 'Enter' || e.key === 'Enter' || e.keyCode === 13;

      // Enter / Shift + Enter Audio & Hint Handlers
      if (isEnter) {
        e.preventDefault();
        e.stopPropagation();
        if (activeEl && activeEl.blur && activeEl !== document.body) {
          activeEl.blur();
        }

        if (currentTrainingItem) {
          const card = cardById(currentTrainingItem.cardId);
          if (!card) return;
          const direction = SRS.normalizeDir(currentTrainingItem.direction);
          const isRusToEng = direction === 'ru_en';

          if (e.shiftKey) {
            // Shift + Enter:
            if (!hintUsedForCurrentCard) {
              // 1st press: reveal hint (shows Russian example in RUS->ENG, English example in ENG->RUS)
              useHint();
            } else {
              // 2nd press: speak hint (example sentence)
              // In RUS->ENG mode, if the card has NOT been flipped yet, do NOT pronounce English example sentence to avoid giving away the answer
              if (isRusToEng && !hasBeenFlippedForCurrentCard) {
                return;
              }

              const ex = card.example;
              if (ex && ex.trim() !== '') {
                speakEnglish(ex.trim());
                showToast('🔊 Playing example sentence...', 'info');
              } else {
                showToast('No example sentence to play', 'info');
              }
            }
          } else {
            // Plain Enter: speak English word
            // In RUS->ENG mode, if the card has NOT been flipped yet, do NOT pronounce English word to avoid giving away the answer
            if (isRusToEng && !hasBeenFlippedForCurrentCard) {
              return;
            }

            const w = card.word;
            if (w && w.trim() !== '') {
              speakEnglish(w.trim());
            }
          }
        }
        return;
      }

      if (isSpace || isS) {
        e.preventDefault();
        e.stopPropagation();
        if (activeEl && activeEl.blur && activeEl !== document.body) {
          activeEl.blur();
        }
        toggleFlipCard(); // Space / S / Ы = Toggle Flip 🔄
        return;
      }

      // 0 = вернуть слово в Банк. Ручных перемещений по уровням с клавиатуры больше нет:
      // уровень ставится только оценкой или явно в модалке редактирования.
      if (key === '0') {
        e.preventDefault();
        e.stopPropagation();
        if (activeEl && activeEl.blur && activeEl !== document.body) activeEl.blur();
        if (!currentTrainingItem) { showToast('No card to return to the Bank.', 'info'); return; }
        const bankCard = cardById(currentTrainingItem.cardId);
        if (!bankCard) { showToast('No card to return to the Bank.', 'info'); return; }
        const today = srsToday();
        sessionUndoStack.push({
          cardId: bankCard.id,
          cardSnapshot: JSON.parse(JSON.stringify(bankCard)),
          historySnapshot: appState.history[today] ? JSON.parse(JSON.stringify(appState.history[today])) : null,
          today,
          itemKey: currentTrainingItem.key,
          itemIndex: currentCardIndex,
          wasBank: SRS.isBank(bankCard),
          direction: currentTrainingItem.direction,
          answer: null
        });
        replaceCardById(SRS.returnToBank(bankCard));
        currentTrainingItem.done = true;
        currentCardIndex++;
        if (srsSession) srsSession.cursor = currentCardIndex;
        renderCurrentCard();
        renderDashboard();
        saveData().catch(err => console.error('[save] после возврата в Банк:', err && err.message));
        showToast(`🏦 “${bankCard.word}” returned to the Bank.`, 'info');
        return;
      }

      if (key === '1' || key === 'a' || key === 'ф' || key === 'arrowleft') {
        e.preventDefault();
        e.stopPropagation();
        if (activeEl && activeEl.blur && activeEl !== document.body) activeEl.blur();
        submitAnswer(SRS.ANSWERS.AGAIN);   // 1 / ← / A / Ф = Забыл 🔴
      } else if (key === '2') {
        e.preventDefault();
        e.stopPropagation();
        if (activeEl && activeEl.blur && activeEl !== document.body) activeEl.blur();
        submitAnswer(SRS.ANSWERS.HARD);    // 2 = Сложно 🟠 (уровень заморожен)
      } else if (key === '3' || key === 'd' || key === 'в' || key === 'arrowright') {
        e.preventDefault();
        e.stopPropagation();
        if (activeEl && activeEl.blur && activeEl !== document.body) activeEl.blur();
        submitAnswer(SRS.ANSWERS.EASY);    // 3 / → / D / В = Легко 🟢
      } else if (key === '4') {
        // Клавиша 4 освобождена: четвёртой оценки больше нет. Намеренно ничего не делаем.
      } else if (key === 'arrowdown') {
        e.preventDefault();
        e.stopPropagation();
        if (activeEl && activeEl.blur && activeEl !== document.body) activeEl.blur();
        undoPreviousCard(); // Down Arrow (↓) = Undo & Return to previous card
      } else if (key === 'arrowup' || key === 'w' || key === 'ц') {
        e.preventDefault();
        e.stopPropagation();
        if (activeEl && activeEl.blur && activeEl !== document.body) activeEl.blur();
        skipCardToEnd(); // Up Arrow (↑) / W / Ц = Skip card to end of session queue
      }
    }
  }, { capture: true });

  document.getElementById('btn-hint').addEventListener('click', (e) => {
    e.stopPropagation();
    useHint();
  });

  document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab).classList.add('active');
    });
  });

  document.getElementById('form-manual-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const word = document.getElementById('input-word').value.trim();
    const phonetic = document.getElementById('input-phonetic').value.trim();
    const translation = document.getElementById('input-translation').value.trim();
    const example = document.getElementById('input-example').value.trim();
    const exampleTrans = document.getElementById('input-example-trans').value.trim();

    if (!word || !translation) return;

    addSingleCard(word, translation, example, phonetic, exampleTrans, '', 'batch_manual', 'Single Additions');
    await saveData();
    
    renderDashboard();
    renderDictionary();
    renderGroupsScreen();
    renderStatistics();

    showToast(`✅ Word "${word}" successfully added & saved!`, 'success');
    e.target.reset();
  });

  document.getElementById('btn-copy-prompt').addEventListener('click', () => {
    const promptText = `I want to add new English words to my flashcard app.
Build a clean JSON array of objects with no extra text, markdown or explanations.
Each object must have these fields:
- "word": the English word or phrase
- "transcription": IPA transcription (for example, "[wɜːrk]")
- "translation": the exact Russian translation
- "part_of_speech": part of speech. Allowed values: "noun", "verb", "adjective", "adverb", "phrase" (phrase/idiom)
- "example": an example sentence in English
- "example_translation": the Russian translation of that example
- "batch_title": (optional) a theme or batch name`;
    navigator.clipboard.writeText(promptText);
    showToast('📋 Upgraded AI Prompt copied to clipboard!', 'success');
  });

  document.getElementById('btn-parse-antigravity').addEventListener('click', async () => {
    const rawText = document.getElementById('textarea-antigravity').value.trim();
    if (!rawText) {
      showToast('Please paste text or JSON to import!', 'error');
      return;
    }

    let addedCount = 0;
    let isJsonParsed = false;

    // Create a unique Batch ID & Name for this import session
    const batchId = 'batch_' + Date.now();
    const importDateStr = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    let batchName = `Import ${importDateStr}`;

    try {
      let cleanJsonText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsedData = JSON.parse(cleanJsonText);
      const items = Array.isArray(parsedData) ? parsedData : [parsedData];

      if (items.length > 0 && items[0].batch_title) {
        batchName = items[0].batch_title;
      }

      items.forEach(item => {
        if (item && item.word && (item.translation || item.meaning)) {
          const w = item.word.trim();
          let t = (item.translation || item.meaning || '').trim();
          const ex = (item.example || '').trim();
          const phon = (item.transcription || item.phonetic || '').trim();
          const exTr = (item.example_translation || item.example_rus || '').trim();
          const pos = item.part_of_speech || item.pos || '';

          addSingleCard(w, t, ex, phon, exTr, pos, batchId, item.batch_title || batchName);
          addedCount++;
        }
      });
      isJsonParsed = true;
    } catch (e) {
      isJsonParsed = false;
    }

    if (!isJsonParsed || addedCount === 0) {
      const lines = rawText.split('\n');
      lines.forEach(line => {
        if (!line.trim()) return;
        let parts = line.split('|');
        if (parts.length < 2) parts = line.split('\t');

        if (parts.length >= 2) {
          const w = parts[0].trim();
          let phon = '';
          let t = '';
          let ex = '';
          let exTr = '';

          if (parts.length >= 5) {
            phon = parts[1].trim();
            t = parts[2].trim();
            ex = parts[3].trim();
            exTr = parts[4].trim();
          } else if (parts.length === 3) {
            t = parts[1].trim();
            ex = parts[2].trim();
          } else {
            t = parts[1].trim();
            ex = parts[2] ? parts[2].trim() : '';
          }

          if (w && t) {
            addSingleCard(w, t, ex, phon, exTr, '', batchId, batchName);
            addedCount++;
          }
        }
      });
    }

    if (addedCount > 0) {
      await saveData();
      showToast(`🚀 Successfully imported ${addedCount} cards into batch "${batchName}"!`, 'success');
      document.getElementById('textarea-antigravity').value = '';
      switchScreen('groups');
    } else {
      showToast('Failed to parse text/JSON. Please check format!', 'error');
    }
  });

  const dropzone = document.getElementById('file-dropzone');
  const fileInput = document.getElementById('input-file-select');

  dropzone.addEventListener('click', () => fileInput.click());
  document.getElementById('btn-trigger-file').addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileSelected(e.target.files[0]);
    }
  });

  document.getElementById('dict-search-input').addEventListener('input', renderDictionary);
  const dictGroupFilter = document.getElementById('dict-filter-group');
  if (dictGroupFilter) dictGroupFilter.addEventListener('change', renderDictionary);

  // CSV Export
  document.getElementById('btn-export-csv').addEventListener('click', async () => {
    if (appState.cards.length === 0) {
      showToast('Dictionary is empty. Add words before exporting!', 'info');
      return;
    }

    // Колонки Box больше нет: вместо неё статус, производная группа и ОБА вектора.
    // Прежняя строка "${c.box}" после миграции печатала бы literal "undefined".
    const csvQ = (v) => String(v == null ? '' : v).replace(/"/g, '""');
    let csv = 'Word,Phonetic,Translation,Example,ExampleTranslation,Status,Group,LevelEnRu,NextEnRu,LevelRuEn,NextRuEn,FailCount,ReviewCount\n';
    appState.cards.forEach(c => {
      const lvlEn = Number(c.level_en_ru) || 0;
      const lvlRu = Number(c.level_ru_en) || 0;
      csv += `"${csvQ(c.word)}","${csvQ(c.phonetic)}","${csvQ(c.translation)}","${csvQ(c.example)}","${csvQ(c.example_translation)}","${String(c.status || 'BANK').toUpperCase()}","${SRS.derivedGroup(c)}",${lvlEn},"${csvQ(c.next_review_en_ru)}",${lvlRu},"${csvQ(c.next_review_ru_en)}",${Number(c.fail_count) || 0},${Number(c.review_count) || 0}\n`;
    });

    if (ipcRenderer) {
      const res = await ipcRenderer.invoke('export-csv', csv);
      if (res.success) {
        showToast('📥 CSV file exported successfully!', 'success');
      }
    } else {
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', 'leitner_words.csv');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  });

  // Copy English List
  document.getElementById('btn-copy-english-list').addEventListener('click', () => {
    if (!appState.cards || appState.cards.length === 0) {
      showToast('Dictionary is empty. Add words first!', 'info');
      return;
    }
    const englishWords = appState.cards
      .map(c => (c.word || '').trim())
      .filter(w => w.length > 0)
      .join(', ');

    navigator.clipboard.writeText(englishWords)
      .then(() => {
        showToast(`📋 Copied all ${appState.cards.length} English words to clipboard!`, 'success');
      })
      .catch(() => {
        showToast('Failed to copy to clipboard!', 'error');
      });
  });
}

function addSingleCard(word, translation, example, phonetic = '', example_translation = '', part_of_speech = '', batch_id = null, batch_name = null) {
  const finalBatchId = batch_id || 'batch_manual';
  const finalBatchName = batch_name || 'Single Additions';
  const pos = part_of_speech || inferPartOfSpeech({ word, translation });

  appState.cards.push({
    id: generateId(),
    word,
    phonetic,
    translation,
    part_of_speech: pos,
    partOfSpeech: pos,
    batch_id: finalBatchId,
    batch_name: finalBatchName,
    example,
    example_translation,
    box: 0,
    eng_to_rus: false,
    rus_to_eng: false,
    last_tested_eng: null,
    last_tested_rus: null,
    next_review_date: getTodayString(),
    created_at: getTodayString(),
    fail_count: 0
  });
}

let parsedFileCards = [];

function handleFileSelected(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text.split(/\r?\n/);
    parsedFileCards = [];

    lines.forEach(line => {
      if (!line.trim()) return;
      let parts = line.split(',');
      if (parts.length < 2) parts = line.split(';');
      if (parts.length < 2) parts = line.split('|');

      if (parts.length >= 2) {
        const w = parts[0].replace(/^["']|["']$/g, '').trim();
        const t = parts[1].replace(/^["']|["']$/g, '').trim();
        const ex = parts[2] ? parts[2].replace(/^["']|["']$/g, '').trim() : '';
        if (w && t) {
          parsedFileCards.push({ word: w, translation: t, example: ex });
        }
      }
    });

    const previewArea = document.getElementById('file-preview-area');
    const tbody = document.getElementById('preview-tbody');
    tbody.innerHTML = '';
    document.getElementById('preview-count').textContent = parsedFileCards.length;

    parsedFileCards.slice(0, 10).forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><b>${escapeHtml(item.word)}</b></td><td>${escapeHtml(item.translation)}</td><td><small>${item.example}</small></td>`;;
      tbody.appendChild(tr);
    });

    previewArea.classList.remove('hidden');
  };
  reader.readAsText(file);
}

document.getElementById('btn-confirm-file-import').addEventListener('click', async () => {
  if (parsedFileCards.length === 0) return;

  parsedFileCards.forEach(item => {
    addSingleCard(item.word, item.translation, item.example);
  });

  await saveData();
  showToast(`✅ Successfully imported ${parsedFileCards.length} words from file!`, 'success');
  document.getElementById('file-preview-area').classList.add('hidden');
  switchScreen('dashboard');
});

// ==========================================
// DICTIONARY TABLE RENDERER WITH EDIT MODAL & BOX PRACTICE
// ==========================================
/** Компактный бейдж группы знаний с обоими уровнями (L en→ru / L ru→en). */
function groupBadgeHtml(card) {
  const g = String(SRS.derivedGroup(card));
  const meta = SRS.GROUP_META[g] || { en: g };
  if (SRS.isBank(card)) {
    return '<span class="badge grp-badge grp-bank" title="Not activated yet — no review dates">🏦 Bank</span>';
  }
  const lEn = Number(card.level_en_ru) || 0;
  const lRu = Number(card.level_ru_en) || 0;
  return `<span class="badge grp-badge grp-${g.toLowerCase()}" title="EN→RU L${lEn} · RU→EN L${lRu}">${escapeHtml(String(meta.en || g))} · L${lEn}/L${lRu}</span>`;
}

/**
 * Выборка слов по «источнику» для режимов печати/аудирования/спеллинга.
 * Значения — те же бакеты, что и на дашборде (bank|new|learning|familiar|confident|
 * mastered) плюс all/random. Прежние box1/box2/box3 читали удалённое поле card.box
 * и после миграции молча давали пустой список.
 */
function cardsByGroupSource(src) {
  const all = appState.cards || [];
  const key = String(src == null ? '' : src).toLowerCase();
  if (key === '' || key === 'all') return all;
  if (key === 'random') return shuffleArray(all).slice(0, 10);
  const g = key.toUpperCase();
  if (SRS.BUCKETS.indexOf(g) === -1) return [];
  return all.filter(c => String(SRS.derivedGroup(c)) === g);
}

/**
 * Карточки пользовательской группы: в данных встречаются и card_ids (список id),
 * и cards (готовые объекты). buildQueueForMode('custom_group') понимает оба варианта,
 * остальные места раньше читали только group.cards и теряли группы первого типа.
 */
function customGroupCards(selectEl) {
  const groupId = selectEl ? selectEl.value : null;
  const grp = (appState.custom_groups || []).find(g => g && (g.id || g.name) === groupId);
  if (!grp) return [];
  if (Array.isArray(grp.cards) && grp.cards.length && grp.cards[0] && typeof grp.cards[0] === 'object') return grp.cards;
  const ids = Array.isArray(grp.card_ids) ? grp.card_ids : (Array.isArray(grp.cards) ? grp.cards : []);
  const idSet = new Set(ids.map(String));
  return (appState.cards || []).filter(c => idSet.has(String(c.id)));
}

/** Число слов в группе для подписи селекта (обе формы хранения). */
function customGroupCount(g) {
  if (!g) return 0;
  if (Array.isArray(g.card_ids)) return g.card_ids.length;
  if (Array.isArray(g.cards)) return g.cards.length;
  return 0;
}

/** Экранирование для вставки в innerHTML: слова приходят из CSV/AI-импорта. */
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderDictionary() {
  const grid = document.getElementById('dict-cards-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const searchInput = document.getElementById('dict-search-input');
  const groupSelect = document.getElementById('dict-filter-group');
  const subtitleEl = document.getElementById('dict-subtitle');
  const practiceBtn = document.getElementById('btn-practice-group');
  const today = srsToday();

  const searchQuery = (searchInput ? searchInput.value : '').toLowerCase().trim();
  // Значения селекта = бакеты ядра в нижнем регистре, плюс '' (все) и 'due' (к сроку).
  const groupFilter = groupSelect ? String(groupSelect.value || '') : '';

  const GROUP_NAMES = {
    '': 'all words', bank: 'Word Bank', new: 'NEW', learning: 'LEARNING',
    familiar: 'FAMILIAR', confident: 'CONFIDENT', mastered: 'MASTERED', due: 'due today'
  };
  const filterName = GROUP_NAMES[groupFilter] || groupFilter;

  if (practiceBtn) {
    if (groupFilter) {
      practiceBtn.classList.remove('hidden');
      practiceBtn.textContent = `🚀 Practice: ${filterName}`;
    } else {
      practiceBtn.classList.add('hidden');
    }
  }
  if (subtitleEl) {
    subtitleEl.textContent = groupFilter
      ? `Filtered view: ${filterName}. Every word shows both directions separately.`
      : 'Manage flashcards, search, edit, and export';
  }

  const filtered = appState.cards.filter(c => {
    if (searchQuery) {
      const w = String(c.word || '').toLowerCase();
      const t = String(c.translation || '').toLowerCase();
      if (!w.includes(searchQuery) && !t.includes(searchQuery)) return false;
    }
    if (!groupFilter) return true;
    if (groupFilter === 'due') return SRS.isDue(c, today);
    return String(SRS.derivedGroup(c)).toLowerCase() === groupFilter;
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="dict-empty" style="grid-column: 1 / -1; text-align:center; color: var(--text-muted); padding: 30px;">
      ${escapeHtml(groupFilter ? filterName : 'Dictionary')} is empty. Click “Add Words” to get started.</div>`;
    return;
  }

  filtered.forEach(card => {
    // Группа знания — производная от СЛАБЕЙШЕГО направления, поэтому бейдж показывает
    // её, а оба вектора видны отдельными чипами ниже.
    const group = String(SRS.derivedGroup(card));
    const gl = group.toLowerCase();
    const gmeta = SRS.GROUP_META[group] || { en: group };
    const inBank = SRS.isBank(card);

    // part_of_speech может быть МАССИВОМ (в реальной базе 9 таких карточек) — posText
    // склеивает его для отображения, не меняя сами данные.
    const rawPos = card.part_of_speech != null ? card.part_of_speech
      : (card.partOfSpeech != null ? card.partOfSpeech : inferPartOfSpeech(card));
    const posVal = SRS.posText(rawPos);
    let badgeClass = 'pos-other';
    const lowerPos = posVal.toLowerCase();
    if (lowerPos.includes('noun') || lowerPos.includes('сущ')) badgeClass = 'pos-noun';
    else if (lowerPos.includes('verb') || lowerPos.includes('гл')) badgeClass = 'pos-verb';
    else if (lowerPos.includes('adjective') || lowerPos.includes('adj') || lowerPos.includes('прил')) badgeClass = 'pos-adj';
    else if (lowerPos.includes('adverb') || lowerPos.includes('adv') || lowerPos.includes('нареч')) badgeClass = 'pos-adv';
    else if (lowerPos.includes('phrase') || lowerPos.includes('idiom') || lowerPos.includes('выраж') || lowerPos.includes('фраз')) badgeClass = 'pos-phrase';

    // Чип направления — КЛАССЫ, а не id: карточек десятки, id дублировался бы в сетке.
    const dirChip = (dir) => {
      const m = SRS.DIRECTION_META[dir] || {};
      const lvl = Number(card[SRS.levelKey(dir)]) || 0;
      const due = card[SRS.dueKey(dir)] || '';
      const dueNow = !inBank && SRS.isDirectionDue(card, dir, today);
      const overdue = !inBank && !!due && due < today;
      const cls = ['dict-dir-chip', `grp-${gl}`];
      if (dueNow) cls.push('is-due');
      if (overdue) cls.push('is-overdue');
      const when = inBank ? 'in bank' : (due || '—');
      return `<span class="${cls.join(' ')}" title="${escapeHtml(m.full || dir)}">${m.flag || ''} ${escapeHtml(m.short || dir)} · L${lvl} · ${escapeHtml(when)}</span>`;
    };

    const cardEl = document.createElement('div');
    cardEl.className = `dict-card grp-${gl}`;
    cardEl.innerHTML = `
      <div class="dict-card-header">
        <div class="dict-card-word">
          <span>${escapeHtml(card.word)}</span>
          <button class="btn-speak btn-speak-dict" title="Listen to pronunciation" aria-label="Listen to word">🔊</button>
        </div>
        <span class="badge ${badgeClass} dict-card-pos" style="text-transform: capitalize;">${escapeHtml(posVal)}</span>
      </div>
      <div class="dict-card-translation">${escapeHtml(card.translation)}</div>
      <div class="dict-card-dirs">${dirChip('en_ru')}${dirChip('ru_en')}</div>
      <div class="dict-card-footer">
        <div class="dict-card-box-label">
          <span class="badge grp-badge grp-${gl}" title="${inBank ? 'Not activated yet — no review dates' : 'Group is derived from the weaker direction'}">${escapeHtml(inBank ? '🏦 Bank' : String(gmeta.en || group))}</span>
        </div>
        <div class="dict-card-actions">
          <button class="btn-dict-edit">✏️ Edit</button>
          <button class="btn-dict-delete">🗑️ Delete</button>
        </div>
      </div>
    `;

    // Клик по карточке → тренировка этого слова ОБОИМИ сторонами.
    cardEl.addEventListener('click', (e) => {
      if (e.target.closest('.btn-dict-edit') || e.target.closest('.btn-dict-delete') || e.target.closest('.btn-speak')) return;
      startTrainingSession('single_word', null, card.id);
    });

    const dictSpeakBtn = cardEl.querySelector('.btn-speak-dict');
    if (dictSpeakBtn) attachSpeakHandler(dictSpeakBtn, card.word);

    cardEl.querySelector('.btn-dict-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openEditModal(card);
    });

    cardEl.querySelector('.btn-dict-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Are you sure you want to delete the word "${card.word}" from your dictionary?`)) return;
      const removedId = card.id;
      appState.cards = appState.cards.filter(c => c.id !== removedId);
      // Томбстон обязателен: без него следующее слияние кандидатов (localStorage,
      // резервная копия, data/*.json) вернуло бы удалённое слово обратно.
      if (!Array.isArray(appState.deleted_ids)) appState.deleted_ids = [];
      if (!appState.deleted_ids.includes(removedId)) appState.deleted_ids.push(removedId);
      // saveData сверяет состояние с последним снимком — честное удаление объявляем
      // через removedIds/allowShrink, иначе защита от потери базы заблокирует запись.
      const saved = await saveData({ removedIds: [removedId], allowShrink: true });
      renderDictionary();
      renderDashboard();
      if (typeof renderGroupsScreen === 'function') renderGroupsScreen();
      showToast(saved ? `🗑️ “${card.word}” deleted` : 'Removed locally, but saving was blocked — see console', saved ? 'info' : 'error');
    });

    grid.appendChild(cardEl);
  });
}

// STATISTICS & HEATMAP RENDERER
// ==========================================
function renderStatistics() {
  renderStatsScreen();
  const elTotal = document.getElementById('stat-total-added');
  if (!elTotal) return;

  const totalAdded = appState.cards.length;
  elTotal.textContent = totalAdded;

  renderHeatmap();
  renderMistakesTable();
}

function renderHeatmap() {
  const grid = document.getElementById('heatmap-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const daysToShow = 119;
  const todayStr = srsToday();

  for (let i = 0; i <= daysToShow; i++) {
    // Ключи ячеек — в ЛОКАЛЬНЫХ сутках, как и appState.history (SRS.todayString()).
    // Прежний toISOString() давал UTC-дату, поэтому в UTC+3 между 00:00 и 02:59 вся
    // карта съезжала на день назад и сегодняшняя активность исчезала (BUG-2).
    const dateStr = SRS.addDays(todayStr, i - daysToShow);

    const dayData = appState.history ? appState.history[dateStr] : null;
    const totalActivity = dayData ? dayData.total : 0;

    let levelClass = 'level-0';
    if (totalActivity > 0 && totalActivity <= 5) levelClass = 'level-1';
    else if (totalActivity > 5 && totalActivity <= 15) levelClass = 'level-2';
    else if (totalActivity > 15 && totalActivity <= 30) levelClass = 'level-3';
    else if (totalActivity > 30) levelClass = 'level-4';

    const cell = document.createElement('div');
    cell.className = `h-cell ${levelClass}`;
    cell.title = `${dateStr}: ${totalActivity} answers`;
    grid.appendChild(cell);
  }
}

function renderMistakesTable() {
  const tbody = document.getElementById('stat-mistakes-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const mistakes = appState.cards
    .filter(c => (c.fail_count || 0) > 0)
    .sort((a, b) => (b.fail_count || 0) - (a.fail_count || 0))
    .slice(0, 10);

  if (mistakes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color: var(--text-dark);">No difficult words yet.</td></tr>';
    return;
  }

  mistakes.forEach((card, rank) => {
    const tr = document.createElement('tr');
    // Медали топ-3 — «зал славы» самых упрямых слов. Слово/перевод экранируем:
    // innerHTML + nodeIntegration = пользовательские данные не должны парситься как HTML.
    const medal = rank < 3 ? `<span class="rank-medal">${['🥇', '🥈', '🥉'][rank]}</span>` : '';
    const resets = Number(card.fail_count) || 0;
    tr.innerHTML = `
      <td>${medal}<b>${escapeHtml(card.word)}</b></td>
      <td>${escapeHtml(card.translation)}</td>
      <td><span class="badge badge-resets">${resets} ${resets === 1 ? 'reset' : 'resets'}</span></td>
      <td>${groupBadgeHtml(card)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ==========================================
// TOAST NOTIFICATIONS
// ==========================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';

  toast.innerHTML = `<span>${icon}</span> <span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ==========================================
// WORD GROUPS, MANUAL PACKS & POS RENDERER
// ==========================================
let currentActiveGroupContext = null;

const POS_CATEGORIES = [
  // Подписи — только английские (интерфейс по умолчанию английский).
  // А вот keywords НАМЕРЕННО содержат русские варианты: в реальных данных part_of_speech
  // хранится как «сущ.»/«глагол», и без них фильтр частей речи не нашел бы ни одной карточки.
  { key: 'noun',      label: 'Nouns',            icon: '📘', badgeClass: 'pos-noun',   keywords: ['noun', 'сущ', 'существительное'] },
  { key: 'verb',      label: 'Verbs',            icon: '⚡', badgeClass: 'pos-verb',   keywords: ['verb', 'гл', 'глагол'] },
  { key: 'adjective', label: 'Adjectives',       icon: '🎨', badgeClass: 'pos-adj',    keywords: ['adjective', 'adj', 'прил', 'прилагательное'] },
  { key: 'adverb',    label: 'Adverbs',          icon: '🚀', badgeClass: 'pos-adv',    keywords: ['adverb', 'adv', 'нареч', 'наречие'] },
  { key: 'phrase',    label: 'Phrases & Idioms', icon: '💬', badgeClass: 'pos-phrase', keywords: ['phrase', 'idiom', 'фраза', 'идиома'] },
  { key: 'other',     label: 'Other / Pronouns', icon: '🧩', badgeClass: 'pos-other',  keywords: ['other', 'другое', 'предлог', 'местоимение', 'союз'] }
];

function getPosCards(posKey) {
  const cat = POS_CATEGORIES.find(c => c.key === posKey);
  if (!cat) return [];
  return appState.cards.filter(card => {
    const posVal = card.partOfSpeech || card.part_of_speech || inferPartOfSpeech(card);
    // part_of_speech легально бывает массивом (["noun","verb"]) — именно на этом
    // падал renderDictionary (posVal.toLowerCase is not a function) и уводил весь initApp().
    const posStr = SRS.posText(posVal).toLowerCase();
    if (posKey === 'other') {
      return !['noun','verb','adjective','adj','adverb','adv','phrase','idiom','сущ','гл','прил','нареч'].some(k => posStr.includes(k));
    }
    return cat.keywords.some(kw => posStr.includes(kw));
  });
}

function makeGroupCard(icon, title, count, previewWords, overflowCount, onClickFn) {
  const el = document.createElement('div');
  el.className = 'group-card group-card-clickable';
  el.style.cursor = 'pointer';
  el.innerHTML = `
    <div>
      <div class="group-header">
        <span class="group-title">${icon} ${title}</span>
        <span class="group-count-badge">${count} cards</span>
      </div>
      <div class="group-preview-words">
        <strong>Words:</strong> ${previewWords}${overflowCount}
      </div>
    </div>
    <div style="margin-top:12px; color: var(--text-muted); font-size:13px;">
      Tap to open →
    </div>
  `;
  el.addEventListener('click', onClickFn);
  return el;
}

function renderGroupsScreen() {
  const containerBatches = document.getElementById('groups-batches-container');
  const containerPos     = document.getElementById('groups-pos-container');
  const containerCustom  = document.getElementById('groups-custom-container');

  if (!containerBatches || !containerPos) return;
  if (!appState.custom_groups) appState.custom_groups = [];

  // Sub-tab switching
  document.querySelectorAll('.groups-tab-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.groups-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.groups-tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const target = document.getElementById(`groups-tab-${btn.dataset.groupsTab}`);
      if (target) target.classList.add('active');
    };
  });

  // ── 1. BATCH (Import Sessions) ──────────────────────────────
  const batchesMap = {};
  appState.cards.forEach(card => {
    let bId = card.batch_id;
    let bName = card.batch_name;
    if (!bId || bId === 'unbatched' || bId === 'batch_manual') {
      bId = 'batch_manual';
      bName = 'Single Additions';
    } else if (!bName) {
      bName = `Import Session (${card.created_at || getTodayString()})`;
    }
    if (!batchesMap[bId]) batchesMap[bId] = { id: bId, name: bName, cards: [] };
    batchesMap[bId].cards.push(card);
  });

  containerBatches.innerHTML = '';
  const batchKeys = Object.keys(batchesMap);

  if (batchKeys.length === 0) {
    containerBatches.innerHTML = `<div style="grid-column:1/-1;color:var(--text-dark);text-align:center;padding:40px;">No word batches found. Import words to auto-create sessions!</div>`;
  } else {
    batchKeys.reverse().forEach(key => {
      const batch = batchesMap[key];
      const preview = batch.cards.slice(0, 6).map(c => c.word).join(', ');
      const overflow = batch.cards.length > 6 ? ` +${batch.cards.length - 6} more` : '';
      const el = makeGroupCard('📦', batch.name, batch.cards.length, preview, overflow, () => {
        openGroupDetailModal({
          type: 'batch',
          title: batch.name,
          cards: batch.cards,
          batchId: batch.id,
          editable: true
        });
      });
      containerBatches.appendChild(el);
    });
  }

  // ── 2. PARTS OF SPEECH ─────────────────────────────────────
  containerPos.innerHTML = '';
  POS_CATEGORIES.forEach(cat => {
    const cards = getPosCards(cat.key);
    const preview = cards.length > 0 ? cards.slice(0, 6).map(c => c.word).join(', ') : 'No cards in this category yet';
    const overflow = cards.length > 6 ? ` +${cards.length - 6} more` : '';
    const el = makeGroupCard(cat.icon, cat.label, cards.length, preview, overflow, () => {
      openGroupDetailModal({
        type: 'pos',
        title: cat.label,
        cards,
        posKey: cat.key,
        editable: false
      });
    });
    containerPos.appendChild(el);
  });

  // ── 3. MANUAL CUSTOM GROUPS ─────────────────────────────────
  renderCustomGroupsScreen(containerCustom);
}

function renderCustomGroupsScreen(containerCustom) {
  if (!containerCustom) return;
  containerCustom.innerHTML = '';
  const groups = appState.custom_groups || [];

  if (groups.length === 0) {
    containerCustom.innerHTML = `<div style="grid-column:1/-1;color:var(--text-dark);text-align:center;padding:40px;">No custom groups yet. Click \"+ Create New Group\" to build your own word lists!</div>`;
  } else {
    groups.forEach(group => {
      const matchingCards = appState.cards.filter(c => (group.card_ids || []).includes(c.id));
      const preview  = matchingCards.length > 0 ? matchingCards.slice(0, 6).map(c => c.word).join(', ') : 'Empty group';
      const overflow = matchingCards.length > 6 ? ` +${matchingCards.length - 6} more` : '';

      const el = makeGroupCard('⭐', group.name, matchingCards.length, preview, overflow, () => {
        openGroupDetailModal({
          type: 'custom',
          title: group.name,
          cards: matchingCards,
          groupId: group.id,
          editable: true
        });
      });

      // Delete button (small, top-right corner overlay)
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-secondary';
      delBtn.style.cssText = 'position:absolute;top:10px;right:10px;padding:3px 8px;font-size:12px;color:#ef4444;z-index:2;';
      delBtn.textContent = '🗑️';
      delBtn.title = 'Delete group';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete group "${group.name}"? Words remain in dictionary.`)) {
          appState.custom_groups = appState.custom_groups.filter(g => g.id !== group.id);
          saveData();
          renderGroupsScreen();
          showToast('Group deleted!', 'info');
        }
      });
      el.style.position = 'relative';
      el.appendChild(delBtn);

      containerCustom.appendChild(el);
    });
  }

  // Create button
  const btnCreate = document.getElementById('btn-create-custom-group');
  if (btnCreate) {
    btnCreate.onclick = () => {
      const gName = prompt('Enter name for new custom group (e.g. Travel, IT Terms):');
      if (gName && gName.trim()) {
        const newGroup = { id: `custom_grp_${Date.now()}`, name: gName.trim(), card_ids: [] };
        appState.custom_groups.push(newGroup);
        saveData();
        renderGroupsScreen();
        openGroupDetailModal({ type: 'custom', title: newGroup.name, cards: [], groupId: newGroup.id, editable: true });
      }
    };
  }
}

// ==========================================
// UNIFIED GROUP DETAIL MODAL
// ==========================================
function openGroupDetailModal({ type, title, cards, batchId = null, posKey = null, groupId = null, editable = false }) {
  const modal       = document.getElementById('modal-group-detail');
  const titleEl     = document.getElementById('gd-title');
  const btnRename   = document.getElementById('gd-btn-rename');
  const btnPractice = document.getElementById('gd-btn-practice');
  const pracLabel   = document.getElementById('gd-practice-label');
  const pracSub     = document.getElementById('gd-practice-sub');
  const addPanel    = document.getElementById('gd-add-panel');
  const btnToggle   = document.getElementById('gd-btn-toggle-search');
  const searchArea  = document.getElementById('gd-search-area');
  const searchInput = document.getElementById('gd-search-input');
  const searchRes   = document.getElementById('gd-search-results');
  const tbody       = document.getElementById('gd-words-tbody');
  const btnClose    = document.getElementById('gd-btn-close');
  const btnCloseFt  = document.getElementById('gd-btn-close-footer');

  if (!modal) return;

  // ── State ──────────────────────
  let currentCards = [...cards];   // live reference for this session
  let currentTitle = title;

  // ── Header ─────────────────────
  titleEl.textContent = currentTitle;

  if (editable) {
    btnRename.classList.remove('hidden');
  } else {
    btnRename.classList.add('hidden');
  }

  btnRename.onclick = () => {
    const newName = prompt('Rename group:', currentTitle);
    if (!newName || !newName.trim()) return;
    currentTitle = newName.trim();
    titleEl.textContent = currentTitle;

    if (type === 'batch' && batchId) {
      appState.cards.forEach(c => { if (c.batch_id === batchId) c.batch_name = currentTitle; });
    } else if (type === 'custom' && groupId) {
      const grp = (appState.custom_groups || []).find(g => g.id === groupId);
      if (grp) grp.name = currentTitle;
    }
    saveData();
    renderGroupsScreen();
    showToast('Group renamed!', 'success');
  };

  // ── Practice button ────────────
  const updatePracticeBtn = () => {
    pracLabel.textContent = `Practice: ${currentTitle}`;
    pracSub.textContent   = `${currentCards.length} cards`;
    btnPractice.disabled  = currentCards.length === 0;
    btnPractice.style.opacity = currentCards.length === 0 ? '0.5' : '1';
  };
  updatePracticeBtn();

  btnPractice.onclick = () => {
    modal.classList.add('hidden');
    if (type === 'batch')        startTrainingSession('batch', null, batchId);
    else if (type === 'pos')     startTrainingSession('pos', null, posKey);
    else if (type === 'custom')  startTrainingSession('custom_group', null, groupId);
  };

  // ── Add-word panel (editable groups only) ──
  if (editable) {
    addPanel.classList.remove('hidden');
  } else {
    addPanel.classList.add('hidden');
  }

  // Collapse search on open
  searchArea.classList.add('hidden');
  searchInput.value = '';
  searchRes.innerHTML = '';

  btnToggle.onclick = () => {
    const isOpen = !searchArea.classList.contains('hidden');
    if (isOpen) {
      searchArea.classList.add('hidden');
    } else {
      searchArea.classList.remove('hidden');
      searchInput.focus();
      renderSearch('');
    }
  };

  const renderSearch = (q) => {
    searchRes.innerHTML = '';
    const lower = q.toLowerCase();
    const alreadyInGroup = new Set(currentCards.map(c => c.id));

    const matches = appState.cards.filter(c =>
      !alreadyInGroup.has(c.id) &&
      (c.word.toLowerCase().includes(lower) || (c.translation && c.translation.toLowerCase().includes(lower)))
    ).slice(0, 20);

    if (q.length > 0 && matches.length === 0) {
      searchRes.innerHTML = `<div style="color:var(--text-muted);padding:8px;font-size:13px;">No matching words found</div>`;
      return;
    }

    matches.forEach(card => {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(255,255,255,0.05);border-radius:8px;border:1px solid rgba(255,255,255,0.09);cursor:pointer;transition:background 0.15s;';
      item.innerHTML = `
        <div>
          <strong style="color:var(--text-main);font-size:14px;">${card.word}</strong>
          <span style="color:var(--text-muted);font-size:12px;margin-left:8px;">— ${card.translation}</span>
        </div>
        <button class="btn btn-primary" style="padding:3px 12px;font-size:12px;">+ Add</button>
      `;
      item.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        // Add to group
        if (type === 'batch' && batchId) {
          card.batch_id   = batchId;
          card.batch_name = currentTitle;
          currentCards.push(card);
          saveData();
          renderGroupsScreen();
        } else if (type === 'custom' && groupId) {
          const grp = (appState.custom_groups || []).find(g => g.id === groupId);
          if (grp) {
            if (!grp.card_ids.includes(card.id)) grp.card_ids.push(card.id);
            currentCards.push(card);
            saveData();
            renderGroupsScreen();
          }
        }
        updatePracticeBtn();
        renderWordTable();
        // refresh search
        renderSearch(searchInput.value);
        showToast(`"${card.word}" added to group!`, 'success');
      });
      searchRes.appendChild(item);
    });
  };

  searchInput.oninput = (e) => renderSearch(e.target.value);

  // ── Word table ──────────────────
  const renderWordTable = () => {
    tbody.innerHTML = '';
    if (currentCards.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-dark);padding:24px;">No words in this group yet.</td></tr>`;
      return;
    }
    currentCards.forEach(card => {
      const posDisplay = card.partOfSpeech || card.part_of_speech || inferPartOfSpeech(card);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <div style="display:inline-flex;align-items:center;gap:6px;">
            <b>${card.word}</b>
            <button class="btn-speak btn-speak-table" data-id="${card.id}" title="Listen to pronunciation" aria-label="Listen to word">🔊</button>
            ${card.phonetic ? `<small style="opacity:0.65;margin-left:2px;">${card.phonetic}</small>` : ''}
          </div>
        </td>
        <td>${card.translation}</td>
        <td><span class="badge pos-noun" style="text-transform:capitalize;">${posDisplay}</span></td>
        <td>${groupBadgeHtml(card)}</td>
        <td>
          <button class="btn btn-secondary btn-gd-edit" data-id="${card.id}" style="padding:3px 10px;font-size:12px;">✏️ Edit</button>
          ${editable ? `<button class="btn btn-secondary btn-gd-remove" data-id="${card.id}" style="padding:3px 8px;font-size:12px;color:#ef4444;margin-left:4px;" title="Remove from group">✖</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.btn-speak-table').forEach(btn => {
      const card = appState.cards.find(c => c.id === btn.dataset.id);
      if (card) {
        attachSpeakHandler(btn, card.word);
      }
    });

    tbody.querySelectorAll('.btn-gd-edit').forEach(btn => {
      btn.onclick = () => {
        const card = appState.cards.find(c => c.id === btn.dataset.id);
        if (card) openEditModal(card);
      };
    });

    tbody.querySelectorAll('.btn-gd-remove').forEach(btn => {
      btn.onclick = () => {
        const cid = btn.dataset.id;
        if (type === 'custom' && groupId) {
          const grp = (appState.custom_groups || []).find(g => g.id === groupId);
          if (grp) grp.card_ids = grp.card_ids.filter(id => id !== cid);
          currentCards = currentCards.filter(c => c.id !== cid);
          saveData();
          renderGroupsScreen();
        } else if (type === 'batch' && batchId) {
          // Move card to unbatched (remove from batch)
          const card = appState.cards.find(c => c.id === cid);
          if (card) { card.batch_id = 'unbatched'; card.batch_name = null; }
          currentCards = currentCards.filter(c => c.id !== cid);
          saveData();
          renderGroupsScreen();
        }
        updatePracticeBtn();
        renderWordTable();
        showToast('Word removed from group.', 'info');
      };
    });
  };

  renderWordTable();

  // ── Close handlers ─────────────
  const closeModal = () => modal.classList.add('hidden');
  btnClose.onclick   = closeModal;
  btnCloseFt.onclick = closeModal;

  modal.classList.remove('hidden');
}

// Legacy stubs – kept so old code references don't crash
function openGroupWordsModal() {}
function openManageGroupWordsModal() {}

// ==========================================
// SPELLING & DICTATION STUDIO MODULE
// ==========================================

let spellingState = {
  words: [], // Array of { word, translation, phonetic, done }
  currentIndex: 0,
  currentLetterIndex: -1,
  isPlaying: false,
  isPaused: false,
  isBlinded: false,
  sequenceToken: 0,
  settings: {
    letterDelay: 0.9,
    wordDelay: 2.5,
    speechRate: 0.88,
    repeatWord: true,
    blindMode: false
  }
};

let isSpellingInitialized = false;

const DEFAULT_SPELLING_SAMPLES = [
  'cat',
  'reluctant',
  'beautiful',
  'whisper',
  'atmosphere',
  'journey'
];

function setupSpellingScreen() {
  if (isSpellingInitialized) return;
  isSpellingInitialized = true;

  // 1. Load saved settings from localStorage if available
  try {
    const saved = localStorage.getItem('spelling_studio_settings');
    if (saved) {
      const parsed = JSON.parse(saved);
      spellingState.settings = { ...spellingState.settings, ...parsed };
      ['letterDelay', 'wordDelay', 'speechRate'].forEach(k => {
        const v = parseFloat(spellingState.settings[k]);
        spellingState.settings[k] = Number.isFinite(v) ? Math.min(8, Math.max(0, v)) : { letterDelay: 0.9, wordDelay: 2.5, speechRate: 0.88 }[k];
      });
    }
  } catch (e) {}

  // 2. Bind settings controls
  const sliderLetterDelay = document.getElementById('spelling-letter-delay');
  const valLetterDelay = document.getElementById('val-letter-delay');
  const sliderWordDelay = document.getElementById('spelling-word-delay');
  const valWordDelay = document.getElementById('val-word-delay');
  const sliderSpeechRate = document.getElementById('spelling-speech-rate');
  const valSpeechRate = document.getElementById('val-speech-rate');
  const chkRepeat = document.getElementById('spelling-repeat-word');
  const chkBlind = document.getElementById('spelling-blind-mode');

  if (sliderLetterDelay && valLetterDelay) {
    sliderLetterDelay.value = spellingState.settings.letterDelay;
    const formatLetterDelay = (v) => v === 0 ? '0.0s (Instant)' : `${parseFloat(v).toFixed(1)} s`;
    valLetterDelay.textContent = formatLetterDelay(spellingState.settings.letterDelay);
    sliderLetterDelay.addEventListener('input', (e) => {
      spellingState.settings.letterDelay = parseFloat(e.target.value);
      valLetterDelay.textContent = formatLetterDelay(spellingState.settings.letterDelay);
      saveSpellingSettings();
    });
  }

  if (sliderWordDelay && valWordDelay) {
    sliderWordDelay.value = spellingState.settings.wordDelay;
    const formatWordDelay = (v) => v === 0 ? '0.0s (Instant)' : `${parseFloat(v).toFixed(1)} s`;
    valWordDelay.textContent = formatWordDelay(spellingState.settings.wordDelay);
    sliderWordDelay.addEventListener('input', (e) => {
      spellingState.settings.wordDelay = parseFloat(e.target.value);
      valWordDelay.textContent = formatWordDelay(spellingState.settings.wordDelay);
      saveSpellingSettings();
    });
  }

  if (sliderSpeechRate && valSpeechRate) {
    sliderSpeechRate.value = spellingState.settings.speechRate;
    valSpeechRate.textContent = `${parseFloat(spellingState.settings.speechRate).toFixed(2)}x`;
    sliderSpeechRate.addEventListener('input', (e) => {
      spellingState.settings.speechRate = parseFloat(e.target.value);
      valSpeechRate.textContent = `${spellingState.settings.speechRate.toFixed(2)}x`;
      saveSpellingSettings();
    });
  }

  if (chkRepeat) {
    chkRepeat.checked = !!spellingState.settings.repeatWord;
    chkRepeat.addEventListener('change', (e) => {
      spellingState.settings.repeatWord = e.target.checked;
      saveSpellingSettings();
    });
  }

  if (chkBlind) {
    chkBlind.checked = !!spellingState.settings.blindMode;
    spellingState.isBlinded = !!spellingState.settings.blindMode;
    chkBlind.addEventListener('change', (e) => {
      spellingState.settings.blindMode = e.target.checked;
      spellingState.isBlinded = e.target.checked;
      saveSpellingSettings();
      updateSpellingStage();
      updateSpellingQueue();
    });
  }

  // 3. Preset chips
  const btnPresetSample = document.getElementById('btn-spelling-preset-sample');
  const btnPresetBox1 = document.getElementById('btn-spelling-preset-box1');
  const btnPresetBank = document.getElementById('btn-spelling-preset-bank');
  const btnPresetRandom = document.getElementById('btn-spelling-preset-random');
  const btnClear = document.getElementById('btn-spelling-clear');
  const textareaInput = document.getElementById('spelling-input-text');

  if (btnPresetSample) {
    btnPresetSample.onclick = (e) => {
      e.preventDefault();
      stopSpellingDictation();
      if (textareaInput) textareaInput.value = DEFAULT_SPELLING_SAMPLES.join('\n');
      parseSpellingInput();
      showToast('Sample spelling words loaded ✨', 'info');
    };
  }

  if (btnPresetBox1) {
    btnPresetBox1.onclick = (e) => {
      e.preventDefault();
      stopSpellingDictation();
      const box1Cards = cardsByGroupSource('learning');
      if (box1Cards.length === 0) {
        showToast('No words in the LEARNING group yet. Using random sample cards.', 'warning');
        if (appState.cards && appState.cards.length > 0) {
          const sample = appState.cards.slice(0, 10).map(c => c.word).filter(Boolean);
          if (textareaInput) textareaInput.value = sample.join('\n');
          parseSpellingInput();
        }
        return;
      }
      const words = box1Cards.map(c => c.word).filter(Boolean);
      if (textareaInput) textareaInput.value = words.join('\n');
      parseSpellingInput();
      showToast(`Loaded ${words.length} words from LEARNING 🧠`, 'success');
    };
  }

  if (btnPresetBank) {
    btnPresetBank.onclick = (e) => {
      e.preventDefault();
      stopSpellingDictation();
      const bankCards = cardsByGroupSource('bank');
      if (bankCards.length === 0) {
        showToast('No words in the Word Bank yet.', 'warning');
        return;
      }
      const words = bankCards.slice(0, 30).map(c => c.word).filter(Boolean);
      if (textareaInput) textareaInput.value = words.join('\n');
      parseSpellingInput();
      showToast(`Loaded ${words.length} words from Bank 🏦`, 'success');
    };
  }

  if (btnPresetRandom) {
    btnPresetRandom.onclick = (e) => {
      e.preventDefault();
      stopSpellingDictation();
      if (!appState.cards || appState.cards.length === 0) {
        if (textareaInput) textareaInput.value = DEFAULT_SPELLING_SAMPLES.join('\n');
        parseSpellingInput();
        showToast('Loaded sample words (dictionary empty)', 'info');
        return;
      }
      const shuffled = shuffleArray(appState.cards.map(c => c.word).filter(Boolean));
      const sample = shuffled.slice(0, 10);
      if (textareaInput) textareaInput.value = sample.join('\n');
      parseSpellingInput();
      showToast(`Randomly selected ${sample.length} words 🎲`, 'info');
    };
  }

  if (btnClear) {
    btnClear.onclick = (e) => {
      e.preventDefault();
      stopSpellingDictation();
      if (textareaInput) textareaInput.value = '';
      spellingState.words = [];
      spellingState.currentIndex = 0;
      spellingState.currentLetterIndex = -1;
      updateSpellingUI();
      showToast('Word list cleared 🗑️', 'info');
    };
  }

  // 4. Apply input button
  const btnApply = document.getElementById('btn-spelling-apply-words');
  if (btnApply) {
    btnApply.onclick = (e) => {
      e.preventDefault();
      stopSpellingDictation();
      parseSpellingInput();
      showToast(`Dictation list updated: ${spellingState.words.length} words 📥`, 'success');
    };
  }

  // 5. Media Control Bar
  const btnPlayPause = document.getElementById('btn-spelling-play-pause');
  const btnStop = document.getElementById('btn-spelling-stop');
  const btnNext = document.getElementById('btn-spelling-next');
  const btnPrev = document.getElementById('btn-spelling-prev');
  const btnRepeat = document.getElementById('btn-spelling-repeat');
  const btnSpeakCurrent = document.getElementById('btn-spelling-speak-current');

  if (btnPlayPause) {
    btnPlayPause.onclick = (e) => {
      e.preventDefault();
      if (!spellingState.isPlaying) {
        startSpellingDictation();
      } else if (spellingState.isPaused) {
        resumeSpellingDictation();
      } else {
        pauseSpellingDictation();
      }
    };
  }

  if (btnStop) {
    btnStop.onclick = (e) => {
      e.preventDefault();
      stopSpellingDictation();
      showToast('Dictation stopped ⏹️', 'info');
    };
  }

  if (btnNext) {
    btnNext.onclick = (e) => {
      e.preventDefault();
      if (spellingState.words.length === 0) return;
      if (spellingState.currentIndex < spellingState.words.length - 1) {
        const wasPlaying = spellingState.isPlaying && !spellingState.isPaused;
        stopCurrentAudio();
        spellingState.currentIndex++;
        spellingState.currentLetterIndex = -1;
        updateSpellingStage();
        updateSpellingQueue();
        if (wasPlaying) {
          runSpellingSequence();
        }
      } else {
        showToast('You are on the last word', 'info');
      }
    };
  }

  if (btnPrev) {
    btnPrev.onclick = (e) => {
      e.preventDefault();
      if (spellingState.words.length === 0) return;
      if (spellingState.currentIndex > 0) {
        const wasPlaying = spellingState.isPlaying && !spellingState.isPaused;
        stopCurrentAudio();
        spellingState.currentIndex--;
        spellingState.currentLetterIndex = -1;
        updateSpellingStage();
        updateSpellingQueue();
        if (wasPlaying) {
          runSpellingSequence();
        }
      } else {
        showToast('You are on the first word', 'info');
      }
    };
  }

  if (btnRepeat) {
    btnRepeat.onclick = (e) => {
      e.preventDefault();
      if (spellingState.words.length === 0) return;
      stopCurrentAudio();
      spellingState.currentLetterIndex = -1;
      spellingState.oneShot = true;
      updateSpellingStage();
      runSpellingSequence();
    };
  }

  if (btnSpeakCurrent) {
    btnSpeakCurrent.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = spellingState.words[spellingState.currentIndex];
      if (cur && cur.word) {
        speakEnglish(cur.word);
      } else {
        showToast('No word to speak', 'warning');
      }
    };
  }

  // 6. Interactive quiz / check handlers
  const inputCheck = document.getElementById('spelling-check-input');
  const btnCheck = document.getElementById('btn-spelling-check-submit');
  const btnReveal = document.getElementById('btn-spelling-reveal');

  if (btnCheck) {
    btnCheck.onclick = (e) => {
      e.preventDefault();
      checkSpellingAttempt();
    };
  }
  if (inputCheck) {
    inputCheck.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        checkSpellingAttempt();
      }
    };
  }

  if (btnReveal) {
    btnReveal.onclick = (e) => {
      e.preventDefault();
      spellingState.isBlinded = !spellingState.isBlinded;
      btnReveal.textContent = spellingState.isBlinded ? '👁️ Reveal' : '🙈 Hide';
      updateSpellingStage();
      updateSpellingQueue();
    };
  }

  // Restore the user's last pasted list; seed samples only on a true first run
  if (textareaInput && (!textareaInput.value || textareaInput.value.trim() === '')) {
    const savedList = typeof spellingState.settings.lastInput === 'string' && spellingState.settings.lastInput.trim()
      ? spellingState.settings.lastInput
      : DEFAULT_SPELLING_SAMPLES.join('\n');
    textareaInput.value = savedList;
  }
  parseSpellingInput();
  setupTypingTestMode();
  setupListeningTestMode();
}

function saveSpellingSettings() {
  try {
    const ta = document.getElementById('spelling-input-text');
    if (ta) spellingState.settings.lastInput = ta.value;
  } catch (e) {}
  try {
    localStorage.setItem('spelling_studio_settings', JSON.stringify(spellingState.settings));
  } catch (e) {}
}

function renderSpellingScreen() {
  setupSpellingScreen();
  if (spellingState.words.length === 0) {
    parseSpellingInput();
  }
  updateSpellingUI();
}

// Helper: Extract clean words from input text and match with active vocabulary
function parseSpellingInput() {
  const textareaInput = document.getElementById('spelling-input-text');
  const rawText = textareaInput ? textareaInput.value : '';
  
  if (!rawText || rawText.trim() === '') {
    spellingState.words = [];
    spellingState.currentIndex = 0;
    spellingState.currentLetterIndex = -1;
    updateSpellingUI();
    return;
  }

  // One entry per line; optional "word <sep> translation" two-column paste.
  const lines = rawText.split(/[\r\n]+/);
  const wordsMap = new Map();

  lines.forEach(line => {
    let clean = line.replace(/^\s*(?:\d{1,3}[.)\]]|\(?[a-z][.)\]]|[•*\u2013\-]\s)\s*/i, '').trim();
    let tail = '';
    const cols = clean.split(/\t+|\s+[\u2013\-]{1,2}\s+|\s{2,}|;|,\s*(?=[\u0400-\u9fff])/);
    if (cols.filter(Boolean).length >= 2) {
      clean = cols[0].trim();
      tail = cols.slice(1).map(s => s.trim()).filter(Boolean).join(' ');
    }
    const wm = clean.match(/^[^\s]+/);
    if (wm && wm[0].length < clean.length) { tail = tail || clean.slice(wm[0].length).trim(); clean = wm[0]; }
    if (clean.length > 0) {
      const lower = clean.toLowerCase();
      if (!wordsMap.has(lower)) {
        // Find in appState.cards for definition and phonetic
        const match = (appState.cards || []).find(c => c.word && c.word.trim().toLowerCase() === lower);
        wordsMap.set(lower, {
          word: clean,
          translation: (match ? (match.translation || '') : '') || tail,
          phonetic: match ? (match.phonetic || match.transcription || '') : '',
          done: false
        });
      }
    }
  });

  spellingState.words = Array.from(wordsMap.values());
  if (spellingState.currentIndex >= spellingState.words.length) {
    spellingState.currentIndex = 0;
  }
  spellingState.currentLetterIndex = -1;
  updateSpellingUI();
}

function updateSpellingUI() {
  // Badge count
  const badge = document.getElementById('spelling-word-count-badge');
  if (badge) {
    badge.textContent = `${spellingState.words.length} words`;
  }

  // Status badge & play button styling
  const statusBadge = document.getElementById('spelling-status-badge');
  const playTitle = document.getElementById('spelling-play-title');
  const playSub = document.getElementById('spelling-play-sub');
  const playIcon = document.getElementById('spelling-play-icon');

  if (spellingState.isPlaying) {
    if (spellingState.isPaused) {
      if (statusBadge) {
        statusBadge.textContent = '⏸️ Paused';
        statusBadge.style.background = 'rgba(var(--accent-amber-rgb), 0.18)';
        statusBadge.style.color = 'var(--accent-amber)';
      }
      if (playTitle) playTitle.textContent = 'Resume';
      if (playSub) playSub.textContent = 'Resume dictation';
      if (playIcon) playIcon.textContent = '▶️';
    } else {
      if (statusBadge) {
        statusBadge.textContent = '🎧 Dictating';
        statusBadge.style.background = 'rgba(var(--accent-green-rgb), 0.18)';
        statusBadge.style.color = 'var(--accent-green)';
      }
      if (playTitle) playTitle.textContent = 'Pause';
      if (playSub) playSub.textContent = 'Pause playback';
      if (playIcon) playIcon.textContent = '⏸️';
    }
  } else {
    if (statusBadge) {
      statusBadge.textContent = 'Ready';
      statusBadge.style.background = 'rgba(var(--accent-primary-rgb), 0.18)';
      statusBadge.style.color = 'var(--accent-primary)';
    }
    if (playTitle) playTitle.textContent = 'Start Dictation';
    if (playSub) playSub.textContent = 'Word & Letter-by-letter';
    if (playIcon) playIcon.textContent = '▶️';
  }

  updateSpellingStage();
  updateSpellingQueue();
}

function updateSpellingStage() {
  const _rvl = document.getElementById('btn-spelling-reveal');
  if (_rvl) _rvl.textContent = spellingState.isBlinded ? '👁️ Reveal' : '🙈 Hide';
  const counterText = document.getElementById('spelling-counter-text');
  const progressBar = document.getElementById('spelling-progress-bar');
  const wordHero = document.getElementById('spelling-current-word');
  const phoneticEl = document.getElementById('spelling-current-phonetic');
  const transEl = document.getElementById('spelling-current-translation');
  const tilesContainer = document.getElementById('spelling-tiles-container');
  const checkContainer = document.getElementById('spelling-check-container');
  const inputCheck = document.getElementById('spelling-check-input');
  const feedbackEl = document.getElementById('spelling-check-feedback');

  const total = spellingState.words.length;
  if (total === 0) {
    if (counterText) counterText.textContent = 'Word 0 of 0';
    if (progressBar) progressBar.style.width = '0%';
    if (wordHero) {
      wordHero.textContent = 'Word list is empty';
      wordHero.classList.remove('blinded');
    }
    if (phoneticEl) phoneticEl.textContent = '';
    if (transEl) transEl.textContent = 'Enter words on the left and click "Update Dictation List"';
    if (tilesContainer) tilesContainer.innerHTML = '<span style="color: var(--text-dark); font-size: 14px;">Letter tiles will appear here</span>';
    if (checkContainer) checkContainer.classList.add('hidden');
    return;
  }

  const idx = Math.min(spellingState.currentIndex, total - 1);
  const current = spellingState.words[idx];
  const progressPct = Math.round(((idx + (current.done ? 1 : 0)) / total) * 100);

  if (counterText) counterText.textContent = `Word ${idx + 1} of ${total}`;
  if (progressBar) progressBar.style.width = `${progressPct}%`;

  const isBlind = spellingState.isBlinded;

  if (wordHero) {
    if (isBlind) {
      wordHero.textContent = current.word;
      wordHero.classList.add('blinded');
    } else {
      wordHero.textContent = current.word;
      wordHero.classList.remove('blinded');
    }
  }

  if (phoneticEl) {
    phoneticEl.textContent = current.phonetic ? current.phonetic : '';
  }

  if (transEl) {
    transEl.textContent = current.translation ? current.translation : (isBlind ? 'Word is hidden (listen to dictation)' : 'English word');
  }

  // Render letter tiles
  if (tilesContainer) {
    tilesContainer.innerHTML = '';
    const chars = current.word.split('');
    chars.forEach((ch, i) => {
      const tile = document.createElement('span');
      if (ch === ' ') {
        tile.className = 'spelling-tile space-tile';
        tilesContainer.appendChild(tile);
        return;
      }

      const isActive = (i === spellingState.currentLetterIndex);
      const isDone = (spellingState.currentLetterIndex > i || current.done);
      
      let classes = 'spelling-tile';
      if (isActive) classes += ' active';
      if (isDone) classes += ' done';
      if (isBlind && !isActive && !isDone) classes += ' blind-hidden';

      tile.className = classes;
      tile.textContent = ch.toUpperCase();
      tilesContainer.appendChild(tile);
    });
  }

  // Blind mode interactive test input
  if (checkContainer) {
    if (spellingState.settings.blindMode) {
      checkContainer.classList.remove('hidden');
      if (feedbackEl && (!feedbackEl.dataset.forWord || feedbackEl.dataset.forWord !== current.word)) {
        feedbackEl.textContent = '';
        feedbackEl.className = 'spelling-check-feedback';
        if (inputCheck) inputCheck.value = '';
      }
    } else {
      checkContainer.classList.add('hidden');
    }
  }
}

function updateSpellingQueue() {
  const container = document.getElementById('spelling-queue-items');
  if (!container) return;

  container.innerHTML = '';
  if (spellingState.words.length === 0) {
    container.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px;">Queue is empty</div>';
    return;
  }

  spellingState.words.forEach((item, index) => {
    const row = document.createElement('div');
    const isActive = (index === spellingState.currentIndex);
    const isDone = item.done;

    let cls = 'spelling-queue-row';
    row.tabIndex = 0;
    if (isActive) cls += ' active';
    if (isDone) cls += ' done';
    row.className = cls;

    const numCol = document.createElement('span');
    numCol.className = 'queue-col-num';
    numCol.textContent = `${index + 1}.`;

    const wordCol = document.createElement('span');
    wordCol.className = 'queue-col-word';
    wordCol.textContent = spellingState.isBlinded && !isDone ? '•'.repeat(Math.min(item.word.length, 14)) : item.word;

    const transCol = document.createElement('span');
    transCol.className = 'queue-col-trans';
    transCol.textContent = spellingState.isBlinded && !isDone ? '•••' : (item.translation || (item.phonetic ? item.phonetic : '—'));

    const lettersCol = document.createElement('span');
    lettersCol.className = 'queue-col-letters';
    lettersCol.textContent = `${item.word.replace(/[^a-zA-Z]/g, '').length} letters`;

    const actionCol = document.createElement('button');
    actionCol.className = 'queue-col-action';
    actionCol.title = 'Speak this word';
    actionCol.textContent = isDone ? '✅' : (isActive ? '🔊' : '▶️');
    actionCol.onclick = (e) => {
      e.stopPropagation();
      jumpToSpellingWord(index, true, true);
    };

    row.appendChild(numCol);
    row.appendChild(wordCol);
    row.appendChild(transCol);
    row.appendChild(lettersCol);
    row.appendChild(actionCol);

    row.onclick = () => {
      jumpToSpellingWord(index, false);
    };
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
    };

    container.appendChild(row);
  });
}

function jumpToSpellingWord(index, autoPlay = false, oneShot = false) {
  if (index < 0 || index >= spellingState.words.length) return;
  const wasPlaying = spellingState.isPlaying && !spellingState.isPaused;
  stopCurrentAudio();
  spellingState.oneShot = oneShot;
  spellingState.currentIndex = index;
  spellingState.currentLetterIndex = -1;
  updateSpellingStage();
  updateSpellingQueue();

  if (autoPlay || wasPlaying) {
    runSpellingSequence();
  }
}

function checkSpellingAttempt() {
  const inputCheck = document.getElementById('spelling-check-input');
  const feedbackEl = document.getElementById('spelling-check-feedback');
  if (!inputCheck || !feedbackEl) return;

  const cur = spellingState.words[spellingState.currentIndex];
  if (!cur) return;

  const userVal = inputCheck.value.trim().toLowerCase();
  const targetVal = cur.word.trim().toLowerCase();
  if (!userVal) return;

  feedbackEl.dataset.forWord = cur.word;
  spellingState.checkAttempts = spellingState.checkAttempts || 0;

  if (userVal === targetVal) {
    spellingState.checkAttempts = 0;
    feedbackEl.textContent = '🎉 Excellent! Completely correct!';
    feedbackEl.className = 'spelling-check-feedback correct';
    spellingState.isBlinded = false;
    inputCheck.value = '';
    cur.done = true;
    updateSpellingStage();
    updateSpellingQueue();
    showToast(`Correct: ${cur.word} ✅`, 'success');
    if (!spellingState.isPlaying) setTimeout(advanceDictationQuiz, 900);
  } else if (spellingState.checkAttempts < 2) {
    spellingState.checkAttempts++;
    feedbackEl.textContent = `❌ Not quite — try again. Attempt ${spellingState.checkAttempts + 1} of 3`;
    feedbackEl.className = 'spelling-check-feedback wrong';
    inputCheck.select();
  } else {
    spellingState.checkAttempts = 0;
    feedbackEl.textContent = `❌ The word was: ${cur.word}`;
    feedbackEl.className = 'spelling-check-feedback wrong';
    inputCheck.value = '';
    cur.done = true;
    updateSpellingQueue();
    if (!spellingState.isPlaying) setTimeout(advanceDictationQuiz, 1600);
  }
}

function advanceDictationQuiz() {
  if (spellingState.isPlaying) return;
  if (spellingState.currentIndex >= spellingState.words.length - 1) return;
  spellingState.currentIndex++;
  spellingState.currentLetterIndex = -1;
  spellingState.checkAttempts = 0;
  updateSpellingUI();
}

// ==========================================
// SPELLING AUDIO & SEQUENCE ENGINE
// ==========================================

function stopCurrentAudio() {
  spellingState.sequenceToken++;
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch (e) {}
  }
}

function setSpellingStatus(statusText) {
  const statusBadge = document.getElementById('spelling-status-badge');
  if (statusBadge) {
    statusBadge.textContent = statusText;
  }
}

function sleepSpellingAsync(ms, token) {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (token && token !== spellingState.sequenceToken) {
        clearInterval(interval);
        resolve();
        return;
      }
      if (spellingState.isPaused) {
        return; // Wait asynchronously while paused
      }
      if (Date.now() - start >= ms) {
        clearInterval(interval);
        resolve();
      }
    }, 30);
  });
}

function speakUtteranceAsync(text, rate = 0.88, isLetter = false) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis || !text) {
      resolve();
      return;
    }

    try {
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }
    } catch (e) {}

    let textToSpeak = text;
    // For single letters, ensure uppercase so standard TTS pronounces the letter name ("ay", "bee", "see", etc.)
    if (isLetter && text.length === 1) {
      textToSpeak = text.toUpperCase();
    }

    const utt = new SpeechSynthesisUtterance(textToSpeak);
    if (!englishVoice) loadVoices();
    if (englishVoice) utt.voice = englishVoice;
    utt.lang = 'en-US';
    utt.rate = Math.max(0.5, Math.min(1.5, rate || 0.88));
    utt.pitch = 1;

    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };

    utt.onend = finish;
    utt.onerror = finish;

    // Safety timeout per speech chunk
    const maxTimeout = Math.max(2200, (textToSpeak.length * 280) + 900);
    setTimeout(finish, maxTimeout);

    try {
      window.speechSynthesis.speak(utt);
    } catch (e) {
      finish();
    }
  });
}

function speakEnglish(text) {
  if (!text) return;
  try { window.speechSynthesis.cancel(); } catch (e) {}
  const rate = (typeof spellingState !== 'undefined' && spellingState.settings && Number.isFinite(+spellingState.settings.speechRate))
    ? +spellingState.settings.speechRate : 0.88;
  speakUtteranceAsync(text, rate, false);
}

function startSpellingDictation() {
  spellingState.oneShot = false;
  if (spellingState.words.length === 0) {
    showToast('Please load words for dictation first.', 'warning');
    return;
  }
  if (!(window.speechSynthesis && window.speechSynthesis.getVoices().some(v => /^en/i.test(v.lang)))) {
    showToast('⚠️ No English system voice installed — tiles will advance in silence.', 'warning');
  }

  // If already reached end, restart from beginning
  if (spellingState.currentIndex >= spellingState.words.length) {
    spellingState.currentIndex = 0;
    spellingState.words.forEach(w => w.done = false);
  }

  runSpellingSequence();
}

function pauseSpellingDictation() {
  if (!spellingState.isPlaying) return;
  spellingState.isPaused = true;
  stopCurrentAudio();
  updateSpellingUI();
  showToast('Dictation paused ⏸️', 'info');
}

function resumeSpellingDictation() {
  if (!spellingState.isPlaying) return;
  spellingState.isPaused = false;
  updateSpellingUI();
  showToast('Dictation resumed ▶️', 'info');
  runSpellingSequence();
}

function stopSpellingDictation() {
  stopCurrentAudio();
  spellingState.isPlaying = false;
  spellingState.isPaused = false;
  spellingState.currentLetterIndex = -1;
  updateSpellingUI();
}

async function runSpellingSequence() {
  const token = ++spellingState.sequenceToken;
  spellingState.isPlaying = true;
  spellingState.isPaused = false;
  updateSpellingUI();

  while (spellingState.isPlaying && spellingState.currentIndex < spellingState.words.length) {
    if (token !== spellingState.sequenceToken) return;

    const currentItem = spellingState.words[spellingState.currentIndex];
    if (!currentItem) break;

    // Reset blind status for new word if blind mode is on
    if (spellingState.settings.blindMode) {
      spellingState.isBlinded = true;
    }

    // 1. Highlight current word
    if (spellingState.currentLetterIndex < 0) {
      spellingState.currentLetterIndex = -1;
    }
    updateSpellingStage();
    updateSpellingQueue();

    // 2. Speak the full word first
    setSpellingStatus('🔊 Reading word...');
    await speakUtteranceAsync(currentItem.word, spellingState.settings.speechRate, false);
    if (token !== spellingState.sequenceToken || !spellingState.isPlaying) return;

    // Wait gap between full word and letter dictation
    const letterDelayMs = Math.round(spellingState.settings.letterDelay * 1000);
    if (letterDelayMs > 0) {
      await sleepSpellingAsync(letterDelayMs, token);
      if (token !== spellingState.sequenceToken || !spellingState.isPlaying) return;
    }

    // 3. Dictate letter by letter
    setSpellingStatus('🔤 Dictating letters...');
    const chars = currentItem.word.split('');
    const startCharIdx = Math.max(0, spellingState.currentLetterIndex >= 0 ? spellingState.currentLetterIndex : 0);

    for (let i = startCharIdx; i < chars.length; i++) {
      if (token !== spellingState.sequenceToken || !spellingState.isPlaying) return;

      while (spellingState.isPaused) {
        await sleepSpellingAsync(150, token);
        if (token !== spellingState.sequenceToken || !spellingState.isPlaying) return;
      }

      const ch = chars[i];
      spellingState.currentLetterIndex = i;
      updateSpellingStage();

      if (/[a-zA-Z]/.test(ch)) {
        await speakUtteranceAsync(ch.toUpperCase(), spellingState.settings.speechRate, true);
      } else if (ch === ' ') {
        if (letterDelayMs > 0) await sleepSpellingAsync(Math.min(300, letterDelayMs), token);
      } else if (ch === '-') {
        await speakUtteranceAsync('hyphen', spellingState.settings.speechRate, false);
      } else if (ch === "'") {
        await speakUtteranceAsync('apostrophe', spellingState.settings.speechRate, false);
      } else {
        if (letterDelayMs > 0) await sleepSpellingAsync(Math.min(200, letterDelayMs), token);
      }

      if (token !== spellingState.sequenceToken || !spellingState.isPlaying) return;
      if (letterDelayMs > 0) {
        await sleepSpellingAsync(letterDelayMs, token);
        if (token !== spellingState.sequenceToken || !spellingState.isPlaying) return;
      }
    }

    // All letters completed
    spellingState.currentLetterIndex = chars.length;
    updateSpellingStage();

    // 4. Repeat word at end if option is enabled
    if (spellingState.settings.repeatWord) {
      if (letterDelayMs > 0) {
        await sleepSpellingAsync(Math.min(400, letterDelayMs), token);
        if (token !== spellingState.sequenceToken || !spellingState.isPlaying) return;
      }
      setSpellingStatus('🔊 Repeating word...');
      await speakUtteranceAsync(currentItem.word, spellingState.settings.speechRate, false);
      if (token !== spellingState.sequenceToken || !spellingState.isPlaying) return;
    }

    // Mark current word as done
    currentItem.done = true;
    updateSpellingQueue();

    if (spellingState.oneShot) {
      spellingState.oneShot = false;
      spellingState.isPlaying = false;
      setSpellingStatus('Ready');
      updateSpellingUI();
      return;
    }

    // 5. Check if there are more words in queue
    if (spellingState.currentIndex < spellingState.words.length - 1) {
      const wordDelayMs = Math.round(spellingState.settings.wordDelay * 1000);
      if (wordDelayMs > 0) {
        setSpellingStatus(`⏳ Pause before next word (${spellingState.settings.wordDelay}s)...`);
        await sleepSpellingAsync(wordDelayMs, token);
        if (token !== spellingState.sequenceToken || !spellingState.isPlaying) return;
      }
      spellingState.currentIndex++;
      spellingState.currentLetterIndex = -1;
    } else {
      // Finished all words!
      spellingState.isPlaying = false;
      spellingState.isPaused = false;
      spellingState.oneShot = false;
      spellingState.currentLetterIndex = -1;
      spellingState.currentIndex = spellingState.words.length;
      setSpellingStatus('🎉 Dictation finished!');
      updateSpellingUI();
      showToast('🎉 Dictation completed! All words finished.', 'success');
      return;
    }
  }

  spellingState.isPlaying = false;
  updateSpellingUI();
}

// ==========================================
// SPELLING TYPING TEST MODULE
// ==========================================

let typingTestState = {
  words: [],
  currentIndex: 0,
  source: 'all',
  submode: 'audio', // 'audio' | 'translation'
  score: { correct: 0, wrong: 0, skipped: 0 },
  history: [],
  isActive: false,
  hintUsed: false,
  advanceTimer: null
};

function setupTypingTestMode() {
  // Mode switch tabs (Dictation vs Typing Test vs Listening Test)
  const tabDictation = document.getElementById('spelling-tab-dictation');
  const tabTyping = document.getElementById('spelling-tab-typing');
  const tabListening = document.getElementById('spelling-tab-listening');
  
  const viewDictation = document.getElementById('spelling-view-dictation');
  const viewTyping = document.getElementById('spelling-view-typing');
  const viewListening = document.getElementById('spelling-view-listening');

  function switchSpellingTab(targetTab) {
    // any running typing/listening session: kill pending auto-advance + audio
    clearTimeout(typingTestState.advanceTimer); typingTestState.advanceTimer = null;
    clearTimeout(listeningTestState.advanceTimer); listeningTestState.advanceTimer = null;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    [tabDictation, tabTyping, tabListening].forEach(t => {
      if (t) t.classList.remove('active');
    });
    [viewDictation, viewTyping, viewListening].forEach(v => {
      if (v) v.classList.add('hidden');
    });

    [tabDictation, tabTyping, tabListening].forEach(t => t && t.setAttribute('aria-selected', String(t.id === 'spelling-tab-' + targetTab)));
    if (targetTab === 'dictation') {
      if (tabDictation) tabDictation.classList.add('active');
      if (viewDictation) viewDictation.classList.remove('hidden');
    } else if (targetTab === 'typing') {
      if (tabTyping) tabTyping.classList.add('active');
      if (viewTyping) viewTyping.classList.remove('hidden');
      stopSpellingDictation();
      populateTypingGroupSelect();
      loadTypingTestWords();
    } else if (targetTab === 'listening') {
      if (tabListening) tabListening.classList.add('active');
      if (viewListening) viewListening.classList.remove('hidden');
      stopSpellingDictation();
      if (typeof populateListeningGroupSelect === 'function') populateListeningGroupSelect();
      if (typeof loadListeningTestWords === 'function') loadListeningTestWords();
    }
  }

  if (tabDictation) tabDictation.onclick = (e) => { e.preventDefault(); switchSpellingTab('dictation'); };
  if (tabTyping) tabTyping.onclick = (e) => { e.preventDefault(); switchSpellingTab('typing'); };
  if (tabListening) tabListening.onclick = (e) => { e.preventDefault(); switchSpellingTab('listening'); };

  // Source selection preset buttons
  const sourceBtns = document.querySelectorAll('.typing-source-btn');
  sourceBtns.forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      sourceBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      typingTestState.source = btn.dataset.source || 'all';
      const groupSelect = document.getElementById('typing-group-select');
      if (groupSelect) groupSelect.value = '';
      loadTypingTestWords();
    };
  });

  // Group selector
  const groupSelect = document.getElementById('typing-group-select');
  if (groupSelect) {
    groupSelect.onchange = () => {
      if (groupSelect.value) {
        sourceBtns.forEach(b => b.classList.remove('active'));
        typingTestState.source = 'group';
        loadTypingTestWords();
      }
    };
  }

  // Submode toggle buttons (Audio vs Translation)
  const btnSubAudio = document.getElementById('btn-typing-submode-audio');
  const btnSubTrans = document.getElementById('btn-typing-submode-trans');

  if (btnSubAudio && btnSubTrans) {
    btnSubAudio.onclick = (e) => {
      e.preventDefault();
      btnSubAudio.classList.add('active');
      btnSubTrans.classList.remove('active');
      typingTestState.submode = 'audio';
    };
    btnSubTrans.onclick = (e) => {
      e.preventDefault();
      btnSubTrans.classList.add('active');
      btnSubAudio.classList.remove('active');
      typingTestState.submode = 'translation';
    };
  }

  // Quiz Control Buttons
  const btnStart = document.getElementById('btn-typing-start-quiz');
  if (btnStart) {
    btnStart.onclick = (e) => {
      e.preventDefault();
      startTypingTest();
    };
  }

  const btnPlayAudio = document.getElementById('btn-typing-play-audio');
  if (btnPlayAudio) {
    btnPlayAudio.onclick = (e) => {
      e.preventDefault();
      const cur = typingTestState.words[typingTestState.currentIndex];
      if (cur && cur.word) speakEnglish(cur.word);
    };
  }

  const btnCheckAns = document.getElementById('btn-typing-check-ans');
  const typingInput = document.getElementById('typing-input');
  if (btnCheckAns && typingInput) {
    btnCheckAns.onclick = (e) => {
      e.preventDefault();
      checkTypingTestAnswer();
    };
    typingInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        checkTypingTestAnswer();
      } else if (e.key === ' ' && typingTestState.submode === 'audio' && !typingInput.value.trim()) {
        e.preventDefault();
        const cur = typingTestState.words[typingTestState.currentIndex];
        if (cur && cur.word) speakEnglish(cur.word);
      }
    };
  }

  const btnHint = document.getElementById('btn-typing-hint');
  if (btnHint) {
    btnHint.onclick = (e) => {
      e.preventDefault();
      giveTypingTestHint();
    };
  }

  const btnSkip = document.getElementById('btn-typing-skip');
  if (btnSkip) {
    btnSkip.onclick = (e) => {
      e.preventDefault();
      skipTypingTestWord();
    };
  }

  const btnRestart = document.getElementById('btn-typing-restart-quiz');
  if (btnRestart) {
    btnRestart.onclick = (e) => {
      e.preventDefault();
      startTypingTest();
    };
  }
}

function populateTypingGroupSelect() {
  const select = document.getElementById('typing-group-select');
  if (!select) return;

  const currentVal = select.value;
  select.innerHTML = '<option value="">-- Select Group --</option>';

  const groups = appState.custom_groups || [];
  groups.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.id || g.name;
    opt.textContent = `${g.name} (${customGroupCount(g)} words)`;
    select.appendChild(opt);
  });

  if (currentVal) select.value = currentVal;
}

function loadTypingTestWords() {
  const src = typingTestState.source;
  let rawCards = [];

  if (src === 'group') {
    rawCards = customGroupCards(document.getElementById('typing-group-select'));
  } else {
    // all / random / bank / new / learning / familiar / confident / mastered
    rawCards = cardsByGroupSource(src);
  }

  // Fallback: If dictionary or selected source is empty, use current dictation words list
  if (rawCards.length === 0 && spellingState.words.length > 0) {
    typingTestState.words = spellingState.words.map(w => ({
      word: w.word.trim(),
      translation: w.translation || '',
      phonetic: w.phonetic || '',
      cardRef: null
    }));
  } else {
    typingTestState.words = rawCards.filter(c => c && c.word).map(c => ({
      word: c.word.trim(),
      translation: c.translation || '',
      phonetic: c.phonetic || c.transcription || '',
      cardRef: c
    }));
  }

  const badge = document.getElementById('typing-word-count-badge');
  if (badge) {
    badge.textContent = `${typingTestState.words.length} words`;
  }
}

function startTypingTest() {
  clearTimeout(typingTestState.advanceTimer);
  typingTestState.advanceTimer = null;
  loadTypingTestWords();

  if (typingTestState.words.length === 0) {
    showToast('No words available! Please load words into dictation list or dictionary first.', 'warning');
    return;
  }

  // Shuffle words for practice
  typingTestState.words = shuffleArray(typingTestState.words);
  typingTestState.currentIndex = 0;
  typingTestState.score = { correct: 0, wrong: 0, skipped: 0 };
  typingTestState.history = [];
  typingTestState.isActive = true;

  // Show active stage
  const stageInactive = document.getElementById('typing-stage-inactive');
  const stageActive = document.getElementById('typing-stage-active');
  const stageResults = document.getElementById('typing-stage-results');

  if (stageInactive) stageInactive.classList.add('hidden');
  if (stageResults) stageResults.classList.add('hidden');
  if (stageActive) stageActive.classList.remove('hidden');

  showTypingTestPrompt();
}

function showTypingTestPrompt() {
  const idx = typingTestState.currentIndex;
  const total = typingTestState.words.length;

  if (idx >= total) {
    finishTypingTest();
    return;
  }

  const cur = typingTestState.words[idx];
  typingTestState.hintUsed = false;

  // Reset input & feedback
  const input = document.getElementById('typing-input');
  const feedback = document.getElementById('typing-feedback-box');
  if (input) {
    input.value = '';
    input.className = 'typing-main-input';
    input.disabled = false;
    setTimeout(() => input.focus(), 50);
  }
  if (feedback) {
    feedback.textContent = '';
    feedback.className = '';
  }

  // Header stats
  const counter = document.getElementById('typing-quiz-counter');
  const progressBar = document.getElementById('typing-quiz-progress-bar');
  const scoreBadge = document.getElementById('typing-score-badge');

  if (counter) counter.textContent = `Word ${idx + 1} of ${total}`;
  if (progressBar) progressBar.style.width = `${Math.round((idx / total) * 100)}%`;
  if (scoreBadge) scoreBadge.textContent = `✅ ${typingTestState.score.correct}`;

  // Prompts
  const audioView = document.getElementById('typing-prompt-audio-view');
  const transView = document.getElementById('typing-prompt-trans-view');
  const transText = document.getElementById('typing-prompt-trans-text');

  if (typingTestState.submode === 'audio') {
    if (audioView) audioView.classList.remove('hidden');
    if (transView) transView.classList.add('hidden');
    // Speak automatically
    speakEnglish(cur.word);
  } else {
    if (transView) transView.classList.remove('hidden');
    if (audioView) audioView.classList.add('hidden');
    if (transText) transText.textContent = cur.translation || cur.word;
  }
}

function checkTypingTestAnswer() {
  const input = document.getElementById('typing-input');
  const feedback = document.getElementById('typing-feedback-box');
  if (!input || input.disabled) return;

  const userVal = input.value.trim().toLowerCase();
  const cur = typingTestState.words[typingTestState.currentIndex];
  if (!cur) return;

  const targetVal = cur.word.trim().toLowerCase();
  input.disabled = true;

  if (userVal === targetVal) {
    typingTestState.score.correct++;
    typingTestState.history.push({
      word: cur.word,
      translation: cur.translation,
      userAnswer: userVal,
      isCorrect: true
    });

    input.classList.add('correct');
    if (feedback) {
      feedback.textContent = '🎉 Great job! Completely correct!';
      feedback.style.color = 'var(--accent-green)';
    }

    clearTimeout(typingTestState.advanceTimer);
    typingTestState.advanceTimer = setTimeout(() => {
      typingTestState.advanceTimer = null;
      typingTestState.currentIndex++;
      showTypingTestPrompt();
    }, 700);
  } else {
    typingTestState.score.wrong++;
    typingTestState.history.push({
      word: cur.word,
      translation: cur.translation,
      userAnswer: userVal || '(empty)',
      isCorrect: false
    });

    input.classList.add('wrong');
    if (feedback) {
      feedback.textContent = `❌ Incorrect! Correct word: ${cur.word}`;
      feedback.style.color = 'var(--accent-red)';
    }

    // Speak correct pronunciation on mistake
    speakEnglish(cur.word);

    clearTimeout(typingTestState.advanceTimer);
    typingTestState.advanceTimer = setTimeout(() => {
      typingTestState.advanceTimer = null;
      typingTestState.currentIndex++;
      showTypingTestPrompt();
    }, 1800);
  }
}

function giveTypingTestHint() {
  const input = document.getElementById('typing-input');
  const cur = typingTestState.words[typingTestState.currentIndex];
  if (!input || !cur) return;

  const target = cur.word;
  const currentVal = input.value;

  if (currentVal.length < target.length) {
    input.value = target.substring(0, currentVal.length + 1);
  } else {
    input.value = target.charAt(0);
  }
  input.focus();
  typingTestState.hintUsed = true;
}

function skipTypingTestWord() {
  const cur = typingTestState.words[typingTestState.currentIndex];
  if (!cur) return;
  clearTimeout(typingTestState.advanceTimer);
  typingTestState.advanceTimer = null;

  typingTestState.score.skipped++;
  typingTestState.history.push({
    word: cur.word,
    translation: cur.translation,
    userAnswer: '(skipped)',
    isCorrect: false,
    skipped: true
  });

  typingTestState.currentIndex++;
  showTypingTestPrompt();
}

function finishTypingTest() {
  typingTestState.isActive = false;

  const stageActive = document.getElementById('typing-stage-active');
  const stageResults = document.getElementById('typing-stage-results');

  if (stageActive) stageActive.classList.add('hidden');
  if (stageResults) stageResults.classList.remove('hidden');

  const total = typingTestState.words.length;
  const correct = typingTestState.score.correct;
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;

  const accBadge = document.getElementById('typing-accuracy-badge');
  if (accBadge) accBadge.textContent = `${pct}%`;

  const resCorrect = document.getElementById('res-typing-correct');
  const resWrong = document.getElementById('res-typing-wrong');
  const resSkipped = document.getElementById('res-typing-skipped');

  if (resCorrect) resCorrect.textContent = typingTestState.score.correct;
  if (resWrong) resWrong.textContent = typingTestState.score.wrong;
  if (resSkipped) resSkipped.textContent = typingTestState.score.skipped;

  // Render mistakes list
  const listEl = document.getElementById('typing-mistakes-list');
  if (listEl) {
    listEl.innerHTML = '';
    typingTestState.history.forEach(item => {
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; justify-content: space-between; font-size: 13px; padding: 4px 8px; border-radius: 6px; background: rgba(var(--overlay-rgb),0.05);';
      
      const left = document.createElement('span');
      left.innerHTML = `${item.isCorrect ? '✅' : '❌'} <b>${escapeHtml(item.word)}</b> <span style="color: var(--text-muted);">(${item.translation || ''})</span>`;;
      
      const right = document.createElement('span');
      right.style.color = item.isCorrect ? 'var(--accent-green)' : 'var(--accent-red)';
      right.textContent = item.userAnswer;

      row.appendChild(left);
      row.appendChild(right);
      listEl.appendChild(row);
    });
  }

  if (pct >= 80) {
    if (typeof triggerConfetti === 'function') triggerConfetti();
  }
}

/* ==========================================
   LISTENING TEST MODE — AUDIO-ONLY SPELLING
   ========================================== */

const listeningTestState = {
  words: [],
  currentIndex: 0,
  source: 'all', // 'all', 'dictation', 'bank', 'box1', 'box2', 'random', 'group'
  group: '',
  errorMode: 'letters', // 'letters' | 'whole'
  maxAttempts: 3,
  autoNext: true,
  showTranslation: false,
  attemptsCount: 0,
  wordCompleted: false,
  score: { correct: 0, wrong: 0, skipped: 0 },
  history: [],
  isActive: false
};

function setupListeningTestMode() {
  // Preset source buttons
  const sourceBtns = document.querySelectorAll('.listen-source-btn');
  sourceBtns.forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      sourceBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      listeningTestState.source = btn.dataset.source || 'all';
      const groupSelect = document.getElementById('listen-group-select');
      if (groupSelect) groupSelect.value = '';
      loadListeningTestWords();
    };
  });

  // Group selector
  const groupSelect = document.getElementById('listen-group-select');
  if (groupSelect) {
    groupSelect.onchange = () => {
      if (groupSelect.value) {
        sourceBtns.forEach(b => b.classList.remove('active'));
        listeningTestState.source = 'group';
        loadListeningTestWords();
      }
    };
  }

  // Error mode toggle buttons
  const btnErrLetters = document.getElementById('btn-listen-err-letters');
  const btnErrWhole = document.getElementById('btn-listen-err-whole');
  if (btnErrLetters && btnErrWhole) {
    btnErrLetters.onclick = (e) => {
      e.preventDefault();
      btnErrLetters.classList.add('active');
      btnErrWhole.classList.remove('active');
      listeningTestState.errorMode = 'letters';
    };
    btnErrWhole.onclick = (e) => {
      e.preventDefault();
      btnErrWhole.classList.add('active');
      btnErrLetters.classList.remove('active');
      listeningTestState.errorMode = 'whole';
    };
  }

  // Max attempts slider
  const rangeAttempts = document.getElementById('listen-max-attempts');
  const valAttempts = document.getElementById('listen-attempts-val');
  if (rangeAttempts && valAttempts) {
    rangeAttempts.oninput = () => {
      listeningTestState.maxAttempts = parseInt(rangeAttempts.value, 10) || 3;
      valAttempts.textContent = listeningTestState.maxAttempts;
    };
  }

  // Checkboxes
  const chkAutoNext = document.getElementById('listen-auto-next');
  if (chkAutoNext) {
    chkAutoNext.onchange = () => {
      listeningTestState.autoNext = chkAutoNext.checked;
    };
  }
  const chkShowTrans = document.getElementById('listen-show-translation');
  if (chkShowTrans) {
    chkShowTrans.onchange = () => {
      listeningTestState.showTranslation = chkShowTrans.checked;
      const transEl = document.getElementById('listen-translation-hint');
      if (transEl) {
        transEl.style.display = chkShowTrans.checked ? 'block' : 'none';
      }
    };
  }

  // Start button
  const btnStart = document.getElementById('btn-listen-start');
  if (btnStart) {
    btnStart.onclick = (e) => {
      e.preventDefault();
      startListeningTest();
    };
  }

  // Replay Audio button
  const btnReplay = document.getElementById('btn-listen-replay');
  if (btnReplay) {
    btnReplay.onclick = (e) => {
      e.preventDefault();
      replayListeningAudio();
    };
  }

  // Input & Submit
  const inputEl = document.getElementById('listen-input');
  const btnSubmit = document.getElementById('btn-listen-submit');
  if (btnSubmit) {
    btnSubmit.onclick = (e) => {
      e.preventDefault();
      handleListeningSubmit();
    };
  }
  if (inputEl) {
    inputEl.onkeydown = (e) => {
      if (e.key.length === 1) listeningTestState._lastPrintTs = performance.now();
      if (e.key === 'Enter') {
        e.preventDefault();
        handleListeningSubmit();
      } else if (e.key === 'Shift' && !e.repeat && !e.ctrlKey && !e.altKey && performance.now() - (listeningTestState._lastPrintTs || 0) > 400) {
        e.preventDefault();
        replayListeningAudio();
      } else if (e.key === 'Shift' && e.ctrlKey) {
        e.preventDefault();
        playListeningExampleSentence();
      }
    };
  }

  // Global keydown fallback when active
  window.addEventListener('keydown', (e) => {
    if (!listeningTestState.isActive) return;
    const viewListening = document.getElementById('spelling-view-listening');
    if (!viewListening || viewListening.classList.contains('hidden')) return;

    if (e.key === 'Shift' && !e.repeat && !e.ctrlKey && !e.altKey && document.activeElement !== inputEl) {
      e.preventDefault();
      replayListeningAudio();
    } else if (e.key === 'Shift' && e.ctrlKey && document.activeElement !== inputEl) {
      e.preventDefault();
      playListeningExampleSentence();
    }
  });

  // Example sentence button
  const btnExample = document.getElementById('btn-listen-example');
  if (btnExample) {
    btnExample.onclick = (e) => {
      e.preventDefault();
      playListeningExampleSentence();
    };
  }

  // Hint button
  const btnHint = document.getElementById('btn-listen-hint');
  if (btnHint) {
    btnHint.onclick = (e) => {
      e.preventDefault();
      giveListeningHint();
    };
  }

  // Skip button
  const btnSkip = document.getElementById('btn-listen-skip');
  if (btnSkip) {
    btnSkip.onclick = (e) => {
      e.preventDefault();
      skipListeningTestWord();
    };
  }

  // Reveal button
  const btnReveal = document.getElementById('btn-listen-reveal');
  if (btnReveal) {
    btnReveal.onclick = (e) => {
      e.preventDefault();
      revealListeningTestWord();
    };
  }

  // Restart button
  const btnRestart = document.getElementById('btn-listen-restart');
  if (btnRestart) {
    btnRestart.onclick = (e) => {
      e.preventDefault();
      startListeningTest();
    };
  }

  populateListeningGroupSelect();
  loadListeningTestWords();
}

function populateListeningGroupSelect() {
  const select = document.getElementById('listen-group-select');
  if (!select) return;

  const currentVal = select.value;
  select.innerHTML = '<option value="">-- Select Group --</option>';

  const groups = appState.custom_groups || [];
  groups.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.id || g.name;
    opt.textContent = `${g.name} (${customGroupCount(g)} words)`;
    select.appendChild(opt);
  });

  if (currentVal) select.value = currentVal;
}

function loadListeningTestWords() {
  const src = listeningTestState.source;
  let rawCards = [];

  if (src === 'all') {
    rawCards = appState.cards || [];
  } else if (src === 'dictation') {
    rawCards = (spellingState.words || []).map(w => ({
      word: w.word,
      translation: w.translation || '',
      phonetic: w.phonetic || '',
      example: w.example || ''
    }));
  } else if (src === 'group') {
    rawCards = customGroupCards(document.getElementById('listen-group-select'));
  } else {
    // all / random / bank / new / learning / familiar / confident / mastered
    rawCards = cardsByGroupSource(src);
  }

  if (rawCards.length === 0 && spellingState.words.length > 0) {
    listeningTestState.words = spellingState.words.map(w => ({
      word: w.word.trim(),
      translation: w.translation || '',
      phonetic: w.phonetic || '',
      cardRef: null
    }));
  } else {
    listeningTestState.words = rawCards.filter(c => c && c.word).map(c => ({
      word: c.word.trim(),
      translation: c.translation || '',
      phonetic: c.phonetic || c.transcription || '',
      cardRef: c
    }));
  }

  const badge = document.getElementById('listen-word-count-badge');
  if (badge) {
    badge.textContent = `${listeningTestState.words.length} words`;
  }
}

function startListeningTest() {
  loadListeningTestWords();

  if (listeningTestState.words.length === 0) {
    showToast('No words found for this source!', 'warning');
    return;
  }

  listeningTestState.currentIndex = 0;
  listeningTestState.score = { correct: 0, wrong: 0, skipped: 0 };
  listeningTestState.history = [];
  listeningTestState.isActive = true;

  const stageIdle = document.getElementById('listen-stage-idle');
  const stageActive = document.getElementById('listen-stage-active');
  const stageResults = document.getElementById('listen-stage-results');

  if (stageIdle) stageIdle.classList.add('hidden');
  if (stageResults) stageResults.classList.add('hidden');
  if (stageActive) stageActive.classList.remove('hidden');

  showListeningTestPrompt();
}

function showListeningTestPrompt() {
  if (listeningTestState.currentIndex >= listeningTestState.words.length) {
    finishListeningTest();
    return;
  }

  const cur = listeningTestState.words[listeningTestState.currentIndex];
  listeningTestState.attemptsCount = 0;
  listeningTestState.wordCompleted = false;

  // Counter & Progress
  const total = listeningTestState.words.length;
  const counterEl = document.getElementById('listen-counter');
  if (counterEl) counterEl.textContent = `Word ${listeningTestState.currentIndex + 1} of ${total}`;

  const barEl = document.getElementById('listen-progress-bar');
  if (barEl) barEl.style.width = `${((listeningTestState.currentIndex) / total) * 100}%`;

  const scoreCorrect = document.getElementById('listen-score-correct');
  const scoreWrong = document.getElementById('listen-score-wrong');
  if (scoreCorrect) scoreCorrect.textContent = listeningTestState.score.correct;
  if (scoreWrong) scoreWrong.textContent = listeningTestState.score.wrong;

  // Reset Attempt Indicator
  const attInd = document.getElementById('listen-attempt-indicator');
  if (attInd) attInd.textContent = `Attempt 1 of ${listeningTestState.maxAttempts}`;

  // Reset fields
  const inputEl = document.getElementById('listen-input');
  if (inputEl) {
    inputEl.value = '';
    inputEl.style.borderColor = 'rgba(var(--overlay-rgb), 0.15)';
    inputEl.focus();
  }

  const feedbackEl = document.getElementById('listen-feedback');
  if (feedbackEl) {
    feedbackEl.innerHTML = '';
  }

  const compareEl = document.getElementById('listen-letter-compare');
  if (compareEl) {
    compareEl.innerHTML = '';
  }

  // Translation hint
  const transEl = document.getElementById('listen-translation-hint');
  if (transEl) {
    transEl.textContent = cur.translation ? `🇷🇺 ${cur.translation}` : '';
    transEl.style.display = listeningTestState.showTranslation && cur.translation ? 'block' : 'none';
  }

  // Auto speak word
  replayListeningAudio();
}

function replayListeningAudio() {
  const cur = listeningTestState.words[listeningTestState.currentIndex];
  if (cur && cur.word) {
    speakEnglish(cur.word);

    const btnReplay = document.getElementById('btn-listen-replay');
    if (btnReplay) {
      btnReplay.classList.add('playing-pulse');
      setTimeout(() => btnReplay.classList.remove('playing-pulse'), 800);
    }
  }
}

function playListeningExampleSentence() {
  const cur = listeningTestState.words[listeningTestState.currentIndex];
  if (!cur) return;

  const card = cur.cardRef;
  if (card && card.example && card.example.trim()) {
    speakEnglish(card.example.trim());
    showToast(`Sentence: "${card.example.trim()}"`, 'info');
  } else {
    speakEnglish(`The word is ${cur.word}`);
    showToast(`Sentence: "The word is ${cur.word}"`, 'info');
  }
}

function handleListeningSubmit() {
  if (listeningTestState.wordCompleted) {
    nextListeningTestWord();
    return;
  }

  const cur = listeningTestState.words[listeningTestState.currentIndex];
  if (!cur) return;

  const inputEl = document.getElementById('listen-input');
  const userText = inputEl ? inputEl.value.trim() : '';
  const targetWord = cur.word.trim();

  if (!userText) {
    showToast('Please type the word you hear!', 'info');
    return;
  }

  const isMatch = userText.toLowerCase() === targetWord.toLowerCase();

  if (isMatch) {
    // CORRECT!
    listeningTestState.wordCompleted = true;
    listeningTestState.score.correct++;
    listeningTestState.history.push({
      word: targetWord,
      translation: cur.translation,
      userAnswer: userText,
      isCorrect: true
    });

    renderLetterComparison(userText, targetWord);

    const feedbackEl = document.getElementById('listen-feedback');
    if (feedbackEl) {
      feedbackEl.innerHTML = `<span style="color: var(--accent-green);">🎉 Excellent! Correct answer!</span>`;
    }

    if (inputEl) inputEl.style.borderColor = 'var(--accent-green)';

    if (listeningTestState.autoNext) {
      clearTimeout(listeningTestState.advanceTimer);
      listeningTestState.advanceTimer = setTimeout(() => {
        listeningTestState.advanceTimer = null;
        nextListeningTestWord();
      }, 700);
    } else {
      showToast('Press Enter to move to next word', 'info');
    }
  } else {
    // WRONG
    listeningTestState.attemptsCount++;
    const max = listeningTestState.maxAttempts;

    const attInd = document.getElementById('listen-attempt-indicator');
    if (attInd) attInd.textContent = `Attempt ${Math.min(listeningTestState.attemptsCount + 1, max)} of ${max}`;

    if (listeningTestState.errorMode === 'letters') {
      renderLetterComparison(userText, targetWord);
    } else {
      if (inputEl) {
        inputEl.classList.add('shake-error');
        setTimeout(() => inputEl.classList.remove('shake-error'), 500);
        inputEl.value = '';
        inputEl.focus();
      }
    }

    if (listeningTestState.attemptsCount >= max) {
      // EXHAUSTED ATTEMPTS
      listeningTestState.wordCompleted = true;
      listeningTestState.score.wrong++;
      listeningTestState.history.push({
        word: targetWord,
        translation: cur.translation,
        userAnswer: userText,
        isCorrect: false
      });

      const feedbackEl = document.getElementById('listen-feedback');
      if (feedbackEl) {
        feedbackEl.innerHTML = `<span style="color: var(--accent-red);">❌ Out of attempts! Word: <b>${escapeHtml(targetWord)}</b></span>`;;
      }
      if (inputEl) inputEl.style.borderColor = 'var(--accent-red)';
    } else {
      const feedbackEl = document.getElementById('listen-feedback');
      if (feedbackEl) {
        feedbackEl.innerHTML = `<span style="color: var(--accent-red);">Try again! (${listeningTestState.attemptsCount}/${max})</span>`;
      }
    }
  }
}

function renderLetterComparison(userText, targetWord) {
  const container = document.getElementById('listen-letter-compare');
  if (!container) return;

  container.innerHTML = '';

  const userChars = userText.split('');
  const targetChars = targetWord.split('');

  targetChars.forEach((tChar, i) => {
    const tile = document.createElement('div');
    tile.className = 'letter-tile';
    
    const uChar = userChars[i];

    if (!uChar) {
      tile.classList.add('tile-missing');
      tile.textContent = '?';
    } else if (uChar.toLowerCase() === tChar.toLowerCase()) {
      tile.classList.add('tile-correct');
      tile.textContent = tChar;
    } else {
      tile.classList.add('tile-wrong');
      tile.textContent = uChar;
    }

    container.appendChild(tile);
  });
}

function giveListeningHint() {
  const cur = listeningTestState.words[listeningTestState.currentIndex];
  if (!cur) return;

  const targetWord = cur.word.trim();
  const firstLetter = targetWord.charAt(0).toUpperCase();

  showToast(`Hint: Starts with "${firstLetter}" (Length: ${targetWord.length} letters)`, 'info');

  const transEl = document.getElementById('listen-translation-hint');
  if (transEl && cur.translation) {
    transEl.textContent = `🇷🇺 ${cur.translation}`;
    transEl.style.display = 'block';
  }
}

function skipListeningTestWord() {
  const cur = listeningTestState.words[listeningTestState.currentIndex];
  if (!cur) return;

  listeningTestState.score.skipped++;
  listeningTestState.history.push({
    word: cur.word,
    translation: cur.translation,
    userAnswer: '(skipped)',
    isCorrect: false,
    skipped: true
  });

  nextListeningTestWord();
}

function revealListeningTestWord() {
  const _cur = listeningTestState.words[listeningTestState.currentIndex];
  if (_cur && !listeningTestState.wordCompleted) {
    listeningTestState.score.wrong++;
    listeningTestState.history.push({ word: _cur.word, translation: _cur.translation, userAnswer: '(revealed)', isCorrect: false, revealed: true });
  }
  const cur = listeningTestState.words[listeningTestState.currentIndex];
  if (!cur) return;

  listeningTestState.wordCompleted = true;
  const inputEl = document.getElementById('listen-input');
  if (inputEl) {
    inputEl.value = cur.word;
    inputEl.style.borderColor = 'var(--accent-amber)';
  }

  const feedbackEl = document.getElementById('listen-feedback');
  if (feedbackEl) {
    feedbackEl.innerHTML = `<span style="color: var(--accent-amber);">👁️ Answer revealed: <b>${escapeHtml(cur.word)}</b></span>`;;
  }
}

function nextListeningTestWord() {
  clearTimeout(listeningTestState.advanceTimer);
  listeningTestState.advanceTimer = null;
  listeningTestState.currentIndex++;
  showListeningTestPrompt();
}

function finishListeningTest() {
  listeningTestState.isActive = false;

  const stageActive = document.getElementById('listen-stage-active');
  const stageResults = document.getElementById('listen-stage-results');

  if (stageActive) stageActive.classList.add('hidden');
  if (stageResults) stageResults.classList.remove('hidden');

  const total = listeningTestState.words.length;
  const correct = listeningTestState.score.correct;
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;

  const accBadge = document.getElementById('listen-accuracy-badge');
  if (accBadge) accBadge.textContent = `${pct}%`;

  const resCorrect = document.getElementById('listen-res-correct');
  const resWrong = document.getElementById('listen-res-wrong');
  const resSkipped = document.getElementById('listen-res-skipped');

  if (resCorrect) resCorrect.textContent = listeningTestState.score.correct;
  if (resWrong) resWrong.textContent = listeningTestState.score.wrong;
  if (resSkipped) resSkipped.textContent = listeningTestState.score.skipped;

  // Breakdown list
  const listEl = document.getElementById('listen-results-list');
  if (listEl) {
    listEl.innerHTML = '';
    listeningTestState.history.forEach(item => {
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; justify-content: space-between; font-size: 13px; padding: 6px 10px; border-radius: 6px; background: rgba(var(--overlay-rgb),0.05); margin-bottom: 4px;';

      const left = document.createElement('span');
      left.innerHTML = `${item.isCorrect ? '✅' : '❌'} <b>${escapeHtml(item.word)}</b> <span style="color: var(--text-muted);">(${item.translation || ''})</span>`;;

      const right = document.createElement('span');
      right.style.color = item.isCorrect ? 'var(--accent-green)' : 'var(--accent-red)';
      right.textContent = item.userAnswer;

      row.appendChild(left);
      row.appendChild(right);
      listEl.appendChild(row);
    });
  }

  if (pct >= 80) {
    if (typeof triggerConfetti === 'function') triggerConfetti();
  }
}




