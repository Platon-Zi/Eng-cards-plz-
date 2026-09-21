# AI-CONTEXT — Vocaba (ENG CARDS): полный контекст проекта для нейросети

> **Назначение**: вставить в начало новой сессии ИИ-агента, чтобы он сразу работал как veteran проекта.
> Актуально на 2026-09-21, HEAD `02e7560`. Всё ниже — ПРАВДА о коде; если код расходится с этим
> документом, верить коду и сразу обновить документ. Смежные доки: `docs/PROJECT-CONTEXT.md`
> (история решений по разделам, местами устарел в счётчиках), `docs/SRS-V2-SPEC.md`
> (**контракт ядра, обязателен к исполнению**), `docs/UI-EN-STRINGS.md` (инвентарь кириллицы).

---

## 1. Что это за проект и кто заказчик

- **Vocaba / ENG CARDS** — офлайн Electron-приложение флеш-карточек для изучения английского
  русскоязычным пользователем (RU↔EN). Никакого интернета в рантайме: шрифты self-host
  (`fonts/`, 26 woff2), Chart.js НЕ подключён (графики — собственный canvas-код `drawFallback*`).
- Electron ^33 (Chromium 130 — современные CSS-фичи легальны), `nodeIntegration: true`,
  `contextIsolation: false` → все скрипты делят ОДИН глобальный лексический скоуп (см. §4).
- Рабочая папка: `/home/zinko/ENG CARDS` — **пробел в пути, кавычки в bash обязательны**.
- Запуск: `npm start` (electron .). Веб-отладка: `npm run serve` (python http.server 8123).
- Пользователь (единственный заказчик):
  - общается **по-русски**, неформально; отчёты агента — тоже по-русски;
  - **UI-тексты приложения — строго английские** (кириллица допустима только в RU-разделе гайда,
    комментариях кода и доках);
  - стоит над душой: «не спрашивай меня вопросы, делай по рекомендациям» — автономность ожидается;
  - тестирует приложение **перезапуском Electron** — после каждой фичи напоминать «перезапусти»;
  - ценит: минимализм («очень много текста» = плохо), симметрию, честные алгоритмы без надувательства,
    доказуемость («боевая проверка» — показать реальный прогон), короткие коммит-сообщения по делу;
  - раздражается на: асимметрию в UI, лишний текст на панелях, когда механика «не видна» глазу
    (фича работает, но пользователь её не воспринимает = фичи нет — добавляй явные индикаторы);
  - пишет КАПСОМ когда бесит — это сигнал «переделай по-моему», а не баг репорта;
  - GitHub-пуш разрешён БЕЗ спроса после каждой завершённой работы (см. §12).

## 2. Быстрый старт агента

```bash
cd "/home/zinko/ENG CARDS"
npm run verify        # ЕДИНСТВЕННЫЙ гейт качества; обязан быть ALL GREEN перед коммитом
git log --oneline -10 # где мы
git status            # чисто ли дерево (параллельная модель могла наследить)
```
- `npm run verify` = syntax + test:srs(122) + check:dom(44) + check:ui/interact(428) +
  check-polish(10) + check-datacare(82) + check-backup(58) + check:theme(3 инструмента) +
  check:wcag(369 пар). Итого ≈1100 автоматических проверок.
- Запускать так: `timeout 540 npm run verify > .scratch/vN.log 2>&1; echo EXIT=$?` и СМОТРЕТЬ НА
  EXIT (пайп в tail глотает код возврата). `.scratch/` — gitignored рабочая зона агента
  (/tmp изолирован между bash-вызовами харнесса — НЕ использовать).
- Зависимости тестов: `cd .verify && npm install` (jsdom ^26, в git не коммитится).
- `node --test .verify/` на Node 24 СЛОМАН — запускать файлы явно.

## 3. Карта файлов (строк ≈, кто владелец)

| Файл | Строк | Роль |
|---|---|---|
| `main.js` | 608 | Electron main: окна, IPC (`load-data`, `save-data`, `export-csv`, `save-backup-json`, `save-snapshot`, `theme:window`), PERSISTENCE HARDENING: BOM-strip, атомарный write+fsync+rename, конверты `{ok,data,reason}`, data-loss guard. Пишет `data/leitner_data.json` + зеркало `data/leitner_data.js` (`window.LEITNER_DATA = …;`). Тема окна: `userData/eng_cards_theme.txt` читается ДО создания окна (без тёмной вспышки). |
| `srs.js` | 1651 | **Ядро SRS v2** (IIFE → `window.SRS` + CommonJS для main.js). Ровно **96 замороженных экспортов** — `test-srs.cjs` сверяет состав и количество; менять набор = обновить API_NAMES и счётчик в тесте. |
| `app.js` | 6020 | Весь UI-рендер, тренировка, словари, спеллинг-студия, графики, импорт/экспорт, merge данных. Функции верхнего уровня — «протёкшие» глобалы (см. §4). |
| `index.html` | ~2200 | Статичная разметка 9 экранов (`#screen-dashboard|training|add-words|dictionary|guide|groups|spelling|data|stats`), 5 модалок (edit-card, **card-stats**, group-detail, group-words, manage-group-words), anti-FOUC shim темы, EN+RU гайд. |
| `style.css` | ~4240 | Все компоненты ТОКЕН-АГНОСТИЧНЫ (ни одного `html[data-theme]`-селектора); в конце — секции UI POLISH, STATS v3, DAILY MISSION, CARD STATS, TASK PROMPT, KPI-grid. |
| `themes.css` | — | ТОЛЬКО скоупы токенов 4 тем (см. §10). |
| `theme.js` | 303 | Мини-меню тем в тайтлбаре, единственный владелец localStorage `eng_cards_theme`, шлёт `themechange` (document+window) и IPC `theme:window`. |
| `polish.js` | 46 | Пассивный: reset скролла `.content-area` при смене экрана (MutationObserver). |
| `datacare.js` | 835 | **Мозг агента «второй модели»** (см. §13): экран Data & Backup, Today's Mission, VocabaCritical, VocabaCardStats, stats-экстра (Outcomes/Direction Strength/Mastery Ribbon/Highlights/Forecast/New Words). Один IIFE, глобалы только через `window.Vocaba*`. |
| `data/leitner_data.js` | 4056 | Сид-база `window.LEITNER_DATA` (198 карточек, schema 2). |
| `data/leitner_data.json` | — | Живые данные пользователя (пишет main.js). Рядом `*.pre-srs.*` — замороженная точка отката schema 1 (НАМЕРЕННО в git). |
| `scripts/` | — | `add_words.js` (офлайн-докачка), `migrate-offline.cjs` (`npm run migrate[:dry]`), `make_icon.cjs`. |
| `tools/theme/` | — | `css_check.cjs` (паритет beta≡:root 77 токенов, запрет литералов), `theme_test.cjs`, `verify_ui.cjs` (контракт разметки), `theme_verify.mjs` (369 WCAG-пар), `theme_lab.mjs`, `gen_doc.cjs`, `extract_ru.cjs`. |
| `.verify/` | — | Харнесс: `test-srs.cjs` (122 kernel-теста, node:test), `check.cjs` (статика/структура), `interact.cjs` (428 поведенческих через реальные DOM-события, `helpers/dom-env.cjs`), `check-datacare.cjs` (82), `check-polish.cjs` (10), `check-backup.cjs` (58), `fixtures/legacy-198.json` (замороженная schema-1 база). |
| `docs/` | — | Этот файл + PROJECT-CONTEXT.md + SRS-V2-SPEC.md + UI-EN-STRINGS.md. |
| Мусор | — | `fix_html.ps1`, `with space/` — исторический мусор, не трогать, не коммитить. |

**Порядок скриптов в index.html — КОНТРАКТ**: `data/leitner_data.js → srs.js → app.js → theme.js →
polish.js → datacare.js`. Проверяется дословно (check.cjs/verify_ui). Добавляешь скрипт —
синхронизируй ожидание харнесса + `check:syntax` в package.json.

## 4. Runtime-архитектура и её грабли

- Классические `<script>` (не модули) → **один global lexical scope**: top-level `let` из app.js
  (`appState`, `srsSession`, `currentTrainingQueue`, `currentCardIndex`, `isFlipped`, …) видны из
  theme.js/polish.js/datacare.js как из своего файла.
- **НО в jsdom-харнессах**: отдельные вызовы `w.eval()` НЕ разделяют эти `let`
  (`typeof appState === 'undefined'` из eval). Обходы:
  - `.verify/helpers/dom-env.cjs` (interact) — инлайнит все скрипты одной склейкой и читает
    let-связки через `vm.runInContext` → там `env.evalIn('appState…')`/`snapshotState()` РАБОТАЮТ;
  - `check-datacare.cjs` — склеивает 6 скриптов в ОДИН `w.eval(SRC)` (внутри него let видны),
    но ИЗВНЕ отдельным eval — нет → тесты пишутся «боевыми»: реальные клики/клавиши/вызовы
    протёкших функций, чтение результата ЧЕРЕЗ DOM (`#dm-learn-num`, `#train-counter`, tipFor…).
  - **Инъекции в историю извне невозможны**: `appState` — мигрированная КОПИЯ (loadData сливает
    кандидатов в новые объекты), не та же ссылка, что `LEITNER_DATA`.
- Протёкшие функции app.js, вызываемые из eval/тестов/datacare: `switchScreen`, `renderDictionary`,
  `startTrainingSession`, `submitAnswer`, `undoPreviousCard`, `srsToday`, `showToast`,
  `drawFallbackBarChart`, `drawFallbackDonutChart`, `attachSpeakHandler`, `escapeHtml`, `cardById`…
  (`function`-объявления, в отличие от `let`, из eval видны).
- Глобалы datacare: `window.VocabaCritical {CAP, score, select}`, `window.VocabaCardStats {open, close}`.
- **Событие `themechange`**: app.js слушает на `document` (графики), datacare — на `window`
  (синхронный путь тестов). Диспатчить: `window.dispatchEvent(new CustomEvent('themechange'))`
  для datacare; для app.js-графиков — на `document` с `bubbles:true`.
- **Клавиатурный контракт**: главный keydown-слушатель app.js на **`window` c `{capture:true}`**
  (~строка 2688) — срабатывает РАНЬШЕ любых document-слушателей. Escape-цепочка в нём:
  priority-1 список модалок (edit-card, group-detail, group-words, manage-group-words,
  **card-stats**) → возврат с тренировки на `trainingSourceScreen` → `switchScreen('dashboard')`.
  Хочешь, чтобы твоя модалка закрывалась по Escape без ухода с экрана — ДОБАВЬ её id в этот список.
- ID-покрытие: **каждый статический id, упомянутый в app.js/theme.js (`getElementById('x')`),
  обязан существовать в index.html** (check.cjs). datacare.js сканером НЕ проверяется, но если
  app.js ссылается на инжектируемый datacare элемент — скелет ставь статично в index.html
  (прецедент: `#modal-card-stats`).

## 5. Данные и персистентность

- **Карточка v2** (канон в SRS-V2-SPEC.md §1): `id, word, phonetic, translation, example,
  example_translation, part_of_speech (строка ИЛИ массив — оба легальны), batch_id, batch_name,
  created_at, status: 'BANK'|'ACTIVE', level_en_ru 0..6, next_review_en_ru 'YYYY-MM-DD'|null,
  last_review_en_ru, level_ru_en, next_review_ru_en, last_review_ru_en, review_count, fail_count`
  (+ deprecated v1-поля в старых записях — normalize их терпит).
- **History**: `appState.history['YYYY-MM-DD'] = {total, correct, byAnswer:{easy,hard,again},
  byDirection:{en_ru:{total,correct}, ru_en:{…}}, newWords, activatedIds[], newWordIds[]}`.
  Считает ОТВЕТЫ, не уникальные слова (D3 — задокументированный трейдофф). `activatedIds`/
  `newWordIds` — механизм правила «выучено» (§8).
- **Streak**: `appState.streak {count, last_date}`; `recordActivity()` вызывается в submitAnswer
  (идемпотентна внутри дня) — честная брошенная сессия серию не теряет.
- **Кандидаты при загрузке** (`loadData`, app.js ~294): window.LEITNER_DATA (файл), localStorage
  `leitner_data` + `leitner_data_backup`, IPC `load-data` (data/leitner_data.json) → merge
  (`mergeCardInto`: id → слово+перевод; MAX-уровни; tombstones `deleted_ids` отсекают воскресших;
  junk-карточки без слова → skippedJunk). `mergeHistoryInto`: inc.total > live.total → день
  забирается ЦЕЛИКОМ; иначе добираются недостающие поля (включая activatedIds/newWordIds).
- **Сохранение** (`saveData`): валидация `SRS.validateState` ДО записи; guard UNEXPLAINED-LOSS
  (уменьшение числа карточек без removedIds →сохранение ОТКЛОНЕНО, тост). Пишет localStorage
  `leitner_data` (+ротация в `leitner_data_backup`) и IPC save-data → json+js зеркало.
- Прочие localStorage: `eng_cards_theme` (theme.js), `vocaba_daily_goal` (datacare, default 15,
  clamp 1..200), `spelling_studio_settings`.
- Миграция v1→v2 автоматом при старте + pre-migration снапшот `leitner_data_pre_srs_backup`
  (localStorage) и `data/*.pre-srs.*`. `migrateState` ядра идемпотентна.
- Экспорт: CSV (round-trip-совместим с парсером импорта), JSON-бэкап (`SRS.serializeState` —
  канонический порядок ключей), восстановление через общий merge-алгоритм с migrateState на входе.

## 6. Ядро SRS (srs.js) — правила, которые НЕЛЬЗЯ ломать

Константы: `INTERVALS=[0,1,2,4,7,14,30]`, `MAX_LEVEL=6`, `MIN_REST_LEVEL=1`,
`ANSWERS={AGAIN:'again',HARD:'hard',EASY:'easy'}`, `DIRECTIONS=['en_ru','ru_en']`,
`RESET_TABLE={lowMaxLevel:3, lowTo:1, highTo:2}` (данные, не код — тест сверяет побайтово),
`DEFAULTS={sameCardGap:3, learnBatchLimit:20, requeueDelay:4, maxRepeatsPerSession:1,
reviewChunkSize:30, …}`. Группы: `GROUP_OF_LEVEL {0:NEW, 1:LEARNING, 2-3:FAMILIAR,
4-5:CONFIDENT, 6:MASTERED}`; архива нет, MASTERED=вечная ротация раз в 30 дней.

- **Два независимых вектора** на карточку (`level_/next_review_/last_review_` × {en_ru, ru_en}).
  `derivedGroup = groupForLevel(min(оба уровня))` — «слабое звено». Группа нигде не хранится.
- **applyAnswer(card, dir, answer, today)** → `{card, prev, next, outcome:'advance|hold|reset',
  activated, sameDayRepeat, earlyReview, daysEarly, warnings[], cardGroup}`:
  - **A1**: prevLevel 0 → ЛЮБОЙ ответ → L1 (активация; BANK→ACTIVE через activateCard).
  - **EASY**: +1 уровень (cap 6), НО guard'ы (ниже) могут заморозить.
  - **HARD**: заморозка уровня, due переставляется.
  - **AGAIN**: `RESET_TABLE` — L≤3 → L1; L4..6 → **L2** («забыл мастер-слово → FAMILIAR»).
    Пользователь подтвердил эту жёсткость; fail_count++.
  - due = today + INTERVALS[next].
- **Guard §3b same-day EASY**: `last_review_<dir> === today` и EASY при prevLevel>0 → уровень
  ЗАМОРАЖИВАЕТСЯ (warning `same_day_easy_hold`) — краткосрочная память не доказательство.
- **Guard §3c early EASY**: elapsed < INTERVALS[prevLevel] (cram/ранний повтор) → заморозка
  (warning `early_easy_hold`). Переходная ветка M1: нет штампа last_review → судить по prevDue
  (срок в будущем ⇒ рано). **Held-ответ штамп last_review НЕ двигает** — плановые часы идут от
  последнего ЧЕСТНОГО вспоминания (иначе ежедневный cram вечно морозил бы слово).
- **A8**: AGAIN/HARD/зачтённый EASY штамп last_review двигают. `setDirectionLevel` тоже штампует
  (L1 — ручной сменой уровня guard не обходится).
- `diffDays(a,b) = a − b` (в днях). `isDirectionDue`: due===null → TRUE (fail-open); BANK → никогда.
- **Очереди** (все из ядра, app.js только выбирает билдер):
  - `buildReviewQueue(cards, today, opts)` — только due-вектора ACTIVE-карточек; item =
    `{key:'id:dir', cardId, direction, kind:'review', level, intervalDays, entryGroup, entryRank,
    cardGroup, dueDate, overdue, overdueDisplay, tieBreak}`; сортировка «слабые/просроченные первыми»;
    `spreadSameCard(gap=3)` — стороны одного слова НЕ соседние.
  - `buildLearnQueue(cards, today, opts)` — BANK-слова, seededShuffle(соль=today|seed),
    limit=20 СЛОВ, и **каждое слово ПАРОЙ подряд**: W:en_ru, W:ru_en (spreadSameCard для learn
    УБРАН — фидбек пользователя §3i/3k; «несоседность» остаётся принципом ПОВТОРЕНИЙ).
  - `buildCramQueue` — все ACTIVE оба направления, BANK исключён, due игнорируется.
  - `buildSubsetQueue(subset, …, {includeBank, allDirections, fallbackAllDirections})` — для
    batch/pos/custom_group/single_word; BANK-записи получают kind:'learn'.
- **Сессия** (`createSession/sessionCurrent/sessionAdvance/sessionMarkGraded/sessionRequeue/
  sessionSkip/sessionStats`): AGAIN → requeue-копия ключа вставляется через requeueDelay=4,
  потолок maxRepeatsPerSession=1 на ключ; `order` ЗЕРКАЛИТ `items` (инвариант — undo режет оба);
  skip (W) — в конец.
- 96 экспортов заморожены составом (test-srs API_NAMES). Новые — только с обновлением теста.

## 7. Экраны и ключевые UI-системы

- **Dashboard**: hero-кнопки (Learn New Words → `startTrainingSession('learn')`; Practice →
  'system'), **Today's Mission strip** (§9), KNOWLEDGE GROUPS (кликабельные → словарь с фильтром),
  тонкие метрики.
- **Training**: флеш-карточка flip (front `#card-word-text` + **`#card-task-prompt`** — явное
  задание '🇬🇧 ➔ 🇷🇺 Translate to Russian' / '🇷🇺 ➔ 🇬🇧 Say it in English' (§3k — НЕ УБИРАТЬ:
  без него пользователь не видит обратное направление в learn-парах); back: `#card-back-original`
  (мелкий референс фронта) + `#card-translation-large` `#card-translation-text` (КРУПНОЙ ответ));
  corner-чипы направления/уровня/due; счётчик `#train-counter` «i / N (+M repeats)»;
  `#train-mode-title` «Mode: ENG ➔ RUS». Кнопки Again/Hard/Easy + Undo `#btn-undo-card` + Skip + Hint.
- **Хоткеи тренировки**: `←/1/A/Ф`=Again, `↑/2`=Hard, `→/3/D/В`=Easy, `↓`=Undo, `W/Ц`=Skip,
  `0`=вернуть слово в Bank (глушит ВСЕ записи слова в очереди, H1), `Space`=flip, `Enter`=озвучка,
  `Shift+Enter`=hint (hint → ответ принудительно AGAIN), `Escape`=выход по цепочке §4.
- **Dictionary**: поиск, фильтр групп, карточки с dir-чипами; действия: **📊 Stats** (модалка
  VocabaCardStats, §9) / ✏️ Edit / 🗑️ Delete (tombstone в deleted_ids обязателен); клик по
  карточке → тренировка single_word (обе стороны).
- **Groups**: knowledge groups + batches + parts-of-speech + custom groups; модалка group-detail
  (rename/practice/поиск-добавление).
- **Add words**: форма (через `SRS.newCardSkeleton`, дедуп по word+translation), JSON, текст,
  файл (CSV/TSV/pipe; `splitCsvLine` state-machine кавычки; детект делимителя; хедер по именам
  колонок; round-trip собственного экспорта не портит данные).
- **Spelling Studio**: три режима (dictation/typing/listening) с собственными очередями и
  настройками в localStorage.
- **Statistics**: KPI-ряд **ровно 4 карточки** (Total/Due today/Answer accuracy/Day streak;
  MASTERED-карточка УБРАНА пользователем — НЕ ВОССТАНАВЛИВАТЬ, §3m; сетка repeat(4,1fr),
  ≤900px 2×2, ≤520px колонка); 14-дневная активность (heatmap по ЛОКАЛЬНЫМ суткам); донат групп
  (клик-срез → словарь); 🎯 Answer Outcomes; ⚖️ Direction Strength; 🧗 Journey to Mastery
  (лента-кнопки); 🏅 Personal Highlights; 🔥 Hard Words (медали топ-3); **🌱 New Words per Day**
  (14 дней, history.newWords); **🔮 Upcoming Load** (14-дневный прогноз созревания векторов,
  bucket0=now=красный, клик → 'system' сессия). Все экстра-секции рендерит datacare
  (`renderStatsExtras`, каждая в try/catch).
- **Data & Backup**: KPI (4 карточки, тот же grid-класс), экспорт/восстановление JSON, CSV,
  copy-инструменты (список слов / «word — translation» для Spelling), переход в гайд.
- **Guide**: EN/RU вкладки, таблицы хоткеев (обновлять при изменении хоткеев!).
- **Canvas-графики**: `drawFallbackBarChart(canvas, labels, data, hoverIdx, colors?, unit?)`
  (unit — существительное тултипа с +s-плюрализацией, default 'review'; colors — пер-бар палитра),
  `drawFallbackDonutChart(canvas, labels, data, colors, centerWord?, hoverIdx?)`. Кэш макета в
  `canvas._chart {kind, hover, hit, tipFor, redraw, click}` (click переносится между redraw —
  баг «клик умирает после ховера» уже починен, не регрессировать). Интерактив: `bindChartHover`.

## 8. Правило «выученного слова» (пользовательское, НЕ МЕНЯТЬ)

Слово засчитывается в дневную цель (Today's Mission / New Words chart) ТОЛЬКО если:
активировано из Банка сегодня (`result.activated` → `h.activatedIds`) И оценено **EASY или HARD**
(→ `h.newWordIds`, `h.newWords++`). **AGAIN при активации — НЕ выучено**; если вытянули позже
В ТОТ ЖЕ день (requeue/повтор) — засчитывается тогда. Hint-принуждённый AGAIN — не засчитывается.
Механика в `submitAnswer` (app.js ~2102): оба списка в дне истории; undo (`undoPreviousCard`)
глубоко копирует день (JSON) → списки откатываются. Старая строка `if (result.activated) h.newWords++`
УДАЛЕНА — не возвращать. merge истории добирает списки при частичном слиянии.

## 9. Свежие фичи (сентябрь 2026) — устройство и инварианты

- **Today's Mission** (dashboard, `#daily-mission`): одна strip-строка `.dm-strip`
  (grid 1fr auto 1fr: заголовок+дата слева, плитки по центру, goal справа; ≤700px — колонка).
  Плитки (ПОРЯДОК ЗАФИКСИРОВАН ТЕСТОМ: review СЛЕВА, learn СПРАВА) — кольца 38px
  conic-gradient из токенов: review-центр = ПОЛНЫЙ due-долг дня (записи, не слова), заполнение =
  completedToday/(completedToday+долг), долг 0 → 100% зелёное (`.dm-review-done`); learn-центр =
  «learned/goal», цель → зелёное (`.dm-goal-reached`). Минимум текста (≤22 символа на плитку) —
  подробности в title-тултипах. Клик review → `startTrainingSession('critical')`, learn → 'learn'.
  Goal-input: localStorage `vocaba_daily_goal`. Рендер: datacare (load + активация экрана через
  MutationObserver + window themechange). Удалённые классы dm-grid/dm-head/dm-flame/dm-title/
  dm-value/dm-caption/dm-text — НЕ ВОСКРЕШАТЬ.
- **Режим 'critical'** (app.js buildQueueForMode) + **VocabaCritical** (datacare): buildReviewQueue
  → select: `score = 2·(overdue/intervalDays) + 1.5·(fail_count/max(1,review_count)) + level/6 +
  0.5·(overdue>0)`; sort score↓, overdue↓, level↓; CAP=40 («минимум, с которым можно лечь спать»).
  Тост сессии: «🔥 Critical minimum: the worst N due words, most urgent first.»
- **Daily Reminders (VocabaReminder)** (sam 21.09): HTML5 Notification нативно в Electron renderer (без правок main.js). `missionStatus(today)` → {learned, goal, debt, completedToday, reviewDone, learnDone}; `maybeRemind(force)` будит, только если Mission НЕ закрыта (reviewDone && learnDone → не тревожить); троттл ≤ 1/час (localStorage `vocaba_last_reminder`); клик → window.focus + switchScreen('dashboard'); отключение `vocaba_reminders='0'`. `startReminders()` из init: requestPermission + 90с первая проверка + 25-мин интервал. `window.VocabaMission = {render: renderDailyMission}` — app.js зовёт после loadData (фикс F1 гонки: datacare.init бежит до резолва loadData → Mission стейл).
- **Learn-батч тост**: банк в СЛОВАХ, сессия в КАРТОЧКАХ (20 слов × 2 = 40). Если в банке больше
  слов, чем в батче: «🌱 Learn batch: 20 of 87 Bank words · 40 cards (each word from both sides).»
- **VocabaCardStats** (📊 модалка карточки из Dictionary): скелет `#modal-card-stats` статично в
  index.html; вход `window.VocabaCardStats.open(cardId)` по `.btn-dict-stats` (dataset.cardId;
  guard чтобы клик не запускал single_word). Контент: слово/🔊/транскрипция/перевод, pos+group
  бейджи, возраст, batch; BANK → жёлтый нотис; ACTIVE → два dir-блока (полоса 6 сегментов L1..L6
  в групповых цветах `--grp-*-rgb` inline, Next review с человеческой относительностью
  (overdue красный/today янтарный), Last recall, Pace из INTERVALS); Lifetime: answers/forgotten/
  success rate **clamp 0..100** (в данных бывает fail_count>review_count). Закрытие: ✖, backdrop,
  Escape (через priority-1 список app.js + свой capture-страховщик).

## 10. Темы и CSS-законодательство

- 4 темы: `html[data-theme="beta"|"midnight"|"light"|"sandstone"]`. **beta** = оригинальная vivid
  палитра — ЗАМОРОЖЕНА (пользователь запретил рестайл); её токены дублируют `:root` style.css —
  `css_check.cjs` требует паритет token-for-token (77 токенов). **sandstone** любима пользователем —
  не трогать без спроса.
- CSS-правила: **ни одного литерального hex** в style.css (только токены и `rgba(var(--x-rgb), a)`);
  transition/animation **≤ 0.22s** (кроме шиммера ds_fill 3.6s — санкционирован); `prefers-reduced-motion`
  глушит всё; UI-текст EN-only (check.cjs банит несанкционированную кириллицу в EN-атрибутах);
  WCAG AA минимум (369 пар проверяются `theme_verify.mjs`).
- Токены, которые читает JS: шесть `--grp-*-rgb` (bare `R,G,B`) для донат/лент, `--accent-primary-rgb`,
  `--accent-green/red/amber-rgb`, `--overlay-rgb`, `--bg-card`, `--text-main/soft/muted/bright`,
  `--border-color`, `--radius-sm/md/lg`, `--shadow-rgb`, `--accent-primary`, `--accent-green/amber/red`.
  Новый цвет = только через токены.
- Контракт app.js↔темы: ре-рендер графиков по `themechange`.

## 11. Тесты: как писать и не наступать на грабли

- **test-srs.cjs** (122): чистое ядро, node:test, без DOM. Меняешь ядро → добавляй/правь здесь;
  состав экспортов (API_NAMES + счётчик 96) — часть теста.
- **check.cjs** (44): статика — id-покрытие app.js/theme.js ↔ index.html, порядок скриптов,
  кириллица-скан, контракты динамических шаблонов.
- **interact.cjs** (428): поведение через dom-env (pin-дата T='2026-09-19'? — см. фикстуру; env
  видит let-связки: `env2.snapshotState()`, `evalIn`, `evalJson`). Секции нумерованы; §14 — learn
  (оба направления + task prompt). Новый режим/поток тренировки — добавляй секцию.
- **check-datacare.cjs** (82): бутстрап = склейка 6 файлов в один eval + `await wait(1500)`
  (loadData АСИНХРОННА — без ожидания словарь/даные пусты!). §10 пинит часы:
  `srsToday = function(){return '2026-09-19';}` (override живёт до конца файла). §11 mission,
  §12 new-words chart, §13 learned rule, §14 cardstats, §15 learn-батч тост.
- **Грабли харнесса** (все пережиты):
  - в шаблонах строк eval НЕ писать `\s` и т.п. — JS template-literal съест бэкслэш
    (`/\s+/` станет `/s+/`); нормализовать node-стороной;
  - `w.eval('…classList.contains(…)')` возвращает **boolean**, сравнивать с `true`, не `'true'`;
  - toast-container НАКАПЛИВАЕТ тосты — regex-матч может поймать ранний тост (проектировать
    инварианты чисел, а не «последний тост»);
  - keydown слать `document.dispatchEvent(new KeyboardEvent('keydown',{key:'1',bubbles:true}))`
    (всплывёт до window-capture app.js); Space = `{key:' '}`;
  - sed/grep с подстановкой команд, содержащими backtick/newline — ломает кавычки; патчи делать
    python-скриптом с `assert src.count(old) == N`;
  - после генерации русских комментариев сканировать CJK-утечки:
    `python3 -c "import re;print(re.findall(r'[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]', open('app.js').read()))"`
    (реальный прецедент: CJK-иероглиф, просочившийся в русский комментарий app.js).
- **check-backup.cjs** (58): экспорт/восстановление, tombstones, UNEXPLAINED-LOSS guard.
- Фикстуры: `.verify/fixtures/legacy-198.json` (md5 заморожен). Сид: 198 карточек, 89 BANK;
  на пин-дату 136 due-векторов, 208 в 14-дневном горизонте (эти числа зашиты в §10/§11 тесты).

## 12. Git-воркфлоу

- Remote: `https://github.com/Platon-Zi/Eng-cards-plz-.git`, ветка main. Пуш АВТОМАТИЧЕСКИЙ
  после каждой завершённой работы, БЕЗ спроса (credential store настроен). Коммит на английский,
  подробный (что/почему/тесты). После пуша: `git log origin/main --oneline -1` убедиться.
- 403 при пуше = fine-grained token истёк → пользователь перегенерирует (права Contents:RW).
  Токены НИКОГДА не писать в отслеживаемые файлы; в логах редactить
  `sed 's/github_pat_[A-Za-z0-9_]*/[REDACTED]/g'`.
- `.gitignore`: node_modules, .verify/node_modules, .scratch/, *.log, *.bak; `data/*.pre-srs.*` —
  НАМЕРЕННО отслеживаются (точка отката).
- Ритуал коммита: правки → `npm run verify` (EXIT=0, ALL GREEN) → CJK-скан → обновить доки
  (этот файл и/или PROJECT-CONTEXT) → `git add <конкретные файлы>` → commit → push → отчёт
  пользователю ПО-РУССКИ + «перезапусти приложение».

## 13. ⚠️ Мультиагентность (важно!)

Проект исторически пилят ДВЕ модели параллельно (иногда снова запускаются вместе):
- «Ядро+данные»: srs.js, app.js, main.js, data/, scripts/, .verify/;
- «UI+темы+datacare»: themes.css, theme.js, polish.js, datacare.js, POLISH-секция style.css,
  tools/theme/, мелкие правки index.html.
Правила сосуществования:
1. **Перед КАЖДОЙ правкой файла — перечитать целевой регион заново** (mtime мог уехать на минуты;
   ошибки «file changed since read» не игнорировать).
2. Только точечные edit'ы с уникальными якорями; НЕ переписывать чужие файлы целиком.
3. Чужие упавшие проверки молча не «чинить» — докладывать пользователю.
4. Раздел `docs/PROJECT-CONTEXT.md` §3a–3m — журнал «НЕ ТЕРЯТЬ»-решений; новые судьбоносные
   решения дублировать туда (или сюда) с пометкой даты и автора.

## 14. Инварианты, закреплённые тестами (слом = красный verify)

1. Learn-очередь: каждое банковское слово ПАРОЙ `en_ru,ru_en` подряд (test-srs, interact §14).
2. Task prompt: item en_ru → /Translate to Russian/, ru_en → /Say it in English/ (interact §14).
3. RESET_TABLE {lowMaxLevel:3, lowTo:1, highTo:2} побайтово (test-srs).
4. Guard'ы same-day/early EASY: hold + warnings + штамп не двигается (test-srs describes).
5. Mission: review-плитка ПЕРВАЯ (`#daily-mission .dm-tile`), текст плитки ≤22 символа,
   review-число = весь due-долг, клик → critical-сессия «1 / 40» (check-datacare §11).
6. Learned rule: AGAIN не учится, undo откатывает, EASY/HARD учитываются, график синхронен (§13).
7. KPI статистики: ровно 4, `#stats-mastered-cards` НЕ существует (interact/check.cjs id-скан).
8. Card stats: 198 кнопок, 2 блока/12 сегментов/on=сумма уровней, lifetime=данные карточки,
   BANK-нотис, ✖ и Escape закрывают БЕЗ ухода с экрана (§14).
9. Learn-батч тост: cards = words×2, bank > batch (§15).
10. 96 экспортов SRS (API_NAMES); порядок скриптов; id-покрытие; EN-only UI; токены-only CSS;
    β/sandstone палитры; анимации ≤0.22s; WCAG 369 пар.
11. `order` зеркалит `items` в сессии (interact §11); requeue-потолок 1/ключ; skip в конец.
12. Счётчики текущего HEAD: kernel 122, check 44, interact **428**, polish 10, datacare **87**,
    backup 58. (Обновляй эти числа при изменении тестов — и в этом доке тоже.)
13. **XSS-гигиена (sam 21.09, security-аудит)**: nodeIntegration=true → любой innerHTML с
    пользовательскими данными = RCE. ВСЕ интерполяции card.word/translation/phonetic/example/
    partOfSpeech/posDisplay/batch_name/group-name в innerHTML ОБЯЗАНЫ идти через `escapeHtml()`
    (app.js:3330). Закрыто: makeGroupCard, renderWordTable, renderSearch, handleFileSelected
    preview, typing/listening test results. renderDictionary/renderMistakesTable уже были чисты.
    **Новое innerHTML с данными карточки? → escapeHtml. Без исключений.**
14. **F3 undo '0'-банка**: кадры `answer===null` восстанавливают done для ВСЕХ записей cardId
    (не только frame.itemKey) — иначе второе направление молча пропускается в сессии.
15. **F7 criticalScore**: `fragility = rc > 0 ? fc / rc : 0` (нет отзывов — нет хрупкости).
16. **F4 toast cap**: showToast ≤ 5 одновременных (removeChild oldest).

## 15. История пользовательского фидбека (чтобы не наступать дважды)

- Стрелки переоформлены: ↑=Hard (не Undo); Undo на ↓; «0»=в Банк.
- TTS озвучка rate 1.0 (естественная), не замедленная.
- «Кнопки меньше, блок сплюснуть» → mission strip; «только кольца с цифрой, без текста» →
  ring-only плитки; «смести симметрично» → 1fr auto 1fr.
- «Повторение обязательное = самые важные слова, отдельный скрипт подбора» → VocabaCritical,
  НЕ вся due-очередь.
- «Много текста — хватит заголовка» → никаких объяснялок внутри плиток, всё в тултипы.
- «Выучено = Легко/Сложно из Банка; Забыл — не выучено» → §8.
- «Заучивание должно быть и так и так» → learn-пары (§6) + task prompt (§9) — ДВЕ итерации,
  потому что первая (пары) визуально не читалась.
- «В банке 87, а тут 40?» → объясняющий тост про батч (слова vs карточки).
- KPI статистики: «4 и 1 бесит» → flex-пирамида → «уродски, одна больше других» → убран MASTERED,
  жёсткие 4 колонки. **Урок: пользователь предпочтёт убрать элемент, чем терпеть кривой layout.**

## 16. Бэклог / идеи (не делать без запроса, но знать)

L2 midnight-край guard (Easy 23:59 + cram 00:01), L6 мёртвый warning still_due_today,
D1–D3 дизайн-трейдоффы задокументированы в §3d PROJECT-CONTEXT; session-summary экран
(тогда же починить L5 byAnswer), Anki-экспорт, мнемоники/AI, Electron-напоминания
(дневная цель!), авто-синк прогресса в GitHub, retention-аналитика по уровням,
адаптивная дневная цель по прогнозу Upcoming Load, learnBatchLimit привязать к цели.

## 17. Чек-лист агента на каждую задачу

1. Перечитать регион целевого файла (даже если «только что видел»).
2. Правка минимальная, якорная; русский комментарий с датой и причиной («20.09, фидбек …»).
3. Новый/изменённый контракт → тест в соответствующий харнесс (боевой, через DOM, если datacare).
4. `npm run verify` → EXIT=0 ALL GREEN; CJK-скан изменённых файлов.
5. Обновить `docs/AI-CONTEXT.md` (счётчики, инварианты) и при судьбоносности PROJECT-CONTEXT §3x.
6. Коммит (EN, что/почему/тесты) + пуш без спроса + `git log origin/main -1`.
7. Отчёт пользователю ПО-РУССКИ: что было не так → что сделано → как проверено → «перезапусти».
8. Никаких вопросов пользователю без крайней необходимости — действовать по рекомендациям.
