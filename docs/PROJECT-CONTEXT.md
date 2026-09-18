# PROJECT CONTEXT — Leitner English (ENG CARDS)
> Холистка для новой сессии. Актуально на 2026-09-18, после завершения реформы SRS v2 и трёх UI-задач. Вставляй в новый чат целиком.

## 1. Что за проект
Офлайн-приложение **карточек для изучения английского** (RU↔EN), Electron ^33 (Chromium 130 — все современные CSS-фичи легальны). `package.json` v2.0.0. Рабочая папка: `/home/zinko/ENG CARDS` (пробел в пути — кавычки в bash обязательны).

## 2. Архитектура и карта файлов
- `main.js` — Electron main: окна + **PERSISTENCE HARDENING** (BOM-strip при чтении, атомарные write+fsync+rename, IPC-конверты `{ok,data,reason}`). Так же требует `./srs.js` (с graceful-fallback). IPC: `load-data`, `save-data`, `export-csv`, `save-backup-json`, `save-snapshot` + наш `theme:window` (см. §4).
- `srs.js` — ядро SRS v2 (браузерный глобал `window.SRS` + CommonJS-экспорт для main). ~72KB.
- `app.js` — весь UI-рендер/логика тренировки (221KB!). Порядок скриптов в `index.html`: `data → srs.js → app.js → theme.js → polish.js → datacare.js` (6, харнесс `check.cjs`/`verify_ui.cjs` проверяют это дословно — при добавлении скрипта синхронизировать ожидание + `check:syntax` в package.json).
- `datacare.js` — мозг экрана 🛡️ Data & Backup (бывш. нижний сайдбокс): KPI-строка (total/rotation/bank/due) + 2 новых copy-инструмента. Читает `appState`/`SRS`/`switchScreen`/`showToast` через общий global-lexical scope классических скриптов (в браузере работает; в jsdom-тестах — грузить склейкой в один eval, как `.verify/check-datacare.cjs`).
- `index.html` (~1990 строк) — статичная разметка **9** экранов (`#screen-dashboard|add-words|dictionary|groups|spelling|data|stats|guide|training`), таблицы хоткеев гайда (EN+RU), 4 модалки. В сайдбаре 8 nav-кнопок (Dashboard..Guide), мёртвый `.quick-train-box` удалён.
- `style.css` (~3560 строк) — все компоненты **токен-агностичны** (ни одного `html[data-theme]`-селектора); в конце файла секция `UI POLISH` (см. §5).
- `themes.css` — ТОЛЬКО скоупы токенов, 4 темы (см. §4).
- `theme.js` — мини-меню тем (верхний-левый titlebar) + синхронизация нативного окна. Единственный владелец localStorage-ключа `eng_cards_theme`.
- `polish.js` — 15 строк, reset скролла `.content-area` при смене активной `.screen` (MutationObserver). Пассивный, без правок app.js.
- `scripts/make_icon.cjs` — генератор `icon.png` (256px squircle, чистый Node/zlib, без зависимостей); запуск: `node scripts/make_icon.cjs`.
- `data/leitner_data.json` + зеркало `data/leitner_data.js` (`window.LEITNER_DATA = …`, over-head 23 байта) — 198 карточек, `"schema_version": 2`. Бэкапы до миграции: `data/leitner_data.pre-srs.*`.
- `icon.png` (256×256 RGBA) — иконка Electron, подключена в `main.js:65`; генерируется скриптом `scripts/make_icon.cjs` (чистый Node + zlib, без зависимостей).
- `scripts/add_words.js` — офлайн-докачка слов; `scripts/migrate-offline.cjs` — миграция v1→v2 (`npm run migrate[:dry]`).
- `tools/theme/` — **отслеживаемые** инструменты тем (перенесены из gitignored `.scratch/ui/`, иначе терялись при клонировании): `theme_lab.mjs` (генератор OKLCH→hex палитр; пишет только свой `theme_lab_out.css`, `themes.css` НЕ трогает), `theme_verify.mjs` (369 WCAG-пар), `css_check.cjs` (паритет beta≡:root, триплеты, литералы), `theme_test.cjs` (jsdom-функционалка theme.js), `verify_ui.cjs` (контракт разметки), `gen_doc.cjs` + `extract_ru.cjs` (регенератор `docs/UI-EN-STRINGS.md`; печатает в stdout).
- `.verify/` — харнесс проверок: `test-srs.cjs` (104 теста ядра, `node:test`), `check.cjs` (структура), `interact.cjs` (412 поведенческих проверок через реальные DOM-события), `check-backup.cjs` (58 проверок экспорта/восстановления), `check-polish.cjs` (сброс прокрутки), `helpers/dom-env.cjs` (загрузчик jsdom: инлайнит все пять скриптов в производственном порядке, пинит дату, читает let-связки app.js через `vm.runInContext`), `fixtures/legacy-198.json` (замороженная schema-1 база, md5 `9ae4f861…`). Зависимости: `cd .verify && npm install` (jsdom ^26). ⚠ `node --test .verify/` на Node 24 СЛОМАН (каталог исполняется как модуль) — запускать файл явно.
- `docs/SRS-V2-SPEC.md` — **контракт SRS v2, обязателен к исполнению** (модель данных, константы, решения пользователя — читать перед любым кодом повторений).
- `docs/UI-EN-STRINGS.md` — инвентарь кириллицы в app.js по категориям EN / KEEP-RU / OPT / CODE.

## 3. SRS v2 — текущее состояние (территория параллельной модели)
- Коробки Лейтнера **полностью заменены**: два независимых вектора `level_en_ru`/`level_ru_en` (0..6), `INTERVALS=[0,1,2,4,7,14,30]`, статусы `BANK|ACTIVE`, группы знаний `NEW/LEARNING/FAMILIAR/CONFIDENT/MASTERED` (`GROUP_OF_LEVEL {0:NEW,1:LEARNING,2-3:FAMILIAR,4-5:CONFIDENT,6:MASTERED}`); архива нет (MASTERED=30 дней, пожизненно). Миграция автоматом при старте + автобэкап.
- Данные уже v2: `bySource={"native":198}` — миграция фактически выполнена.
- Хоткеи тренировки: `Enter` = озвучка, `Shift+Enter` = хинт, `1/←`=Forgot, `2`=Hard, `3/→/D`=Easy, **`0` = вернуть карточку в Bank** (отмена `↓` через `sessionUndoStack`), `Escape` = закрыть модалку / выйти тренировки на источник / с любого экрана на Dashboard (работает даже при наборе текста).
- `test:srs` — **104/104 pass**.
- **Исправлено 2026-09-18 (найдено харнессом `.verify/interact.cjs`):**
  - *BUG-1, критичный.* Снимок до миграции и тост об обновлении были **недостижимы** при старте с legacy-базой: `loadData()` приводит карточки к v2 через `mergeCardInto → SRS.normalizeCard` ещё ДО `migrateState`, ядро поэтому видело `native` и возвращало `migratedCount === 0` → `firstMigration` ложно `false`. База конвертировалась и перезаписывала оба ключа localStorage, а единственная точка отката на модель коробок не создавалась. Починено: `createMergeContext` считает `legacyCards` и хранит **сырой** `rawLegacyState` (снапшот пишется из него, а не из уже нормализованного `before`); `migrateAppStateToSRS(sourceLabel, legacyHint)` принимает хинт; `lastMigrationReport.migrated` теперь = `max(migratedCount, legacyCards)` с разбивкой `migratedByKernel` / `migratedAtMerge`.
  - *BUG-2, отображение.* `renderHeatmap` ключевал ячейки через `toISOString()` (UTC), а `history` хранится по локальным суткам `SRS.todayString()`: в UTC+3 между 00:00 и 02:59 карта съезжала на день назад и сегодняшняя активность исчезала. Починено на `SRS.addDays(srsToday(), i - daysToShow)`.
  - *Пропуск карточки.* При двойном клике на оценку защита от повторного grade выполняла `currentCardIndex++`, а первый, ещё не завершённый вызов двигал курсор ещё раз — следующая НЕоцененная карточка молча выпадала из сессии. Теперь защита выходит БЕЗ продвижения.
  - `restoreDataFromJson` (восстановление резервной копии) переписан: прежде сливал карточки **по одному лишь слову** и схлопывал омографы (в реальной базе два разных «resilience»), не мигрировал legacy-бэкап и игнорировал надгробия. Теперь — общий с `loadData` алгоритм `mergeCardInto` (id → слово+перевод), `migrateState` на входе, учёт `deleted_ids`, валидация ДО изменения состояния. `exportDataToJson` пишет через `SRS.serializeState` (канонический порядок ключей + `schema_version`).
  - *Потеря карточек при восстановлении копии.* `restoreDataFromJson` отбрасывал карточку по надгробию `deleted_ids`, но не сообщал об этом стражу — тот видел уменьшение счётчика и отменял восстановление ЦЕЛИКОМ (`UNEXPLAINED-LOSS`). Теперь id отброшенных по надгробию собираются в `mergeCtx.tombstonedIds` и передаются как `removedIds` в `validateState` и `saveData`.
  - *Пустые карточки из битых файлов.* `SRS.normalizeCard` намеренно синтезирует id даже для записи без слова (`source: 'synth'`), чтобы миграция ничего не теряла, — но карточка с пустым словом необучаема. `mergeCardInto` теперь отсекает такие записи и считает их в `skippedJunk` (единообразно для `loadData` и восстановления).
  - `batch_name` нормализуется на загрузке (`LEGACY_BATCH_ALIASES` → `normalizeBatchName`): старая двуязычная подпись «Single Additions (Отдельные слова)» иначе расслоила бы одну группу надвое на экране Groups.

## 4. Система цветовых тем (моя территория)
- 4 темы: `html[data-theme="beta"|"midnight"|"light"|"sandstone"]`, id — контракт (`index.html` anti-FOUC shim + theme.js `THEMES[]` + localStorage).
  - **beta** — оригинальная vivid-палитра, **ДО NOT RESTYLE** (пользователь запретил). Её значения дублируют `:root` style.css; проверка `css_check.cjs` следит за паритетом token-for-token (77 токенов).
  - **midnight** — «Arctic»: ледниковая циан/тил-гамма на почти чёрном сине-зелёном (bg `#051219`, primary `#6bc8d3`).
  - **light** — «Frost/Moonlight»: морозный фарфор (bg `#e8f2f5`), текст тёмно-тил, комплементарная пара тил×танжарин (`primary #00617c`, warning `#9e4200`, danger `#b71f49`).
  - **sandstone** — тёплая кремовая (bg `#f5f0e4`, primary терракота `#923500`). Любима пользователем, не трогать без спроса.
- Каждая тема: все токены во всех скоупах; `color-scheme` (dark|light) объявлен в midnight/light/sandstone (beta не тронута).
- **Контракт с app.js**: шесть `--grp-*-rgb` триплетов (bare `R, G, B`) читаются getComputedStyle для донат-диаграммы `#chart-stages`; ре-рендер по document-событию `themechange` (его шлёт theme.js). Плюс 20 других rgb-токенов.
- Все палитры порождены из OKLCH-рамп и проверены 369-pair WCAG-аудитом (AA, ключевые AAA) — инструменты в `.scratch/ui/` (§6). Никакого #000/кислоты.
- **Нативное окно**: theme.js на boot и при смене шлёт IPC `theme:window {id,color,symbol}`; main.js красит `titleBarOverlay` (Win/mac) + пишет id в `userData/eng_cards_theme.txt` и читает его до создания окна (THEME_STARTUP_BG map) — старт светлых тем без тёмной вспышки. На Linux — graceful no-op.

## 5. Фронтенд-polish, сделанный сегодня (не дублировать!)
CSS-секция `UI POLISH` в конце `style.css` (16 пунктов): keyframes `screenIn/fadeIn/modalPop` + их навешивание на `.screen.active/.tab-content.active/.modal-*` (анимации ≤0.22s, по запросу пользователя — «не просмотр видео»); глобальные тонкие скроллбары; `::selection`; hover `.tab-btn`; `:active` на `.btn/.nav-btn/.btn-hero`; focus-visible на `.btn-speak/.range-slider`; микро-текст `--text-dark→--text-muted` (AA-фикс); `letter-spacing` заголовков таблиц; кнопка закрытия модалки; `kbd`-hover без хардкода чёрного; `prefers-reduced-motion`; `user-select:text` для учебного контента; theme-picker 28px; `#gd-search-results > div` пере-привязан к токенам (!important против JS-инлайнов).
`index.html`: исправлены строки EN/RU-гайда про `0`/`Escape` (были неправдой), `⇧Enter`-чип на #btn-hint, `(Enter)` в тултипах 🔊, «← Back to Dashboard» на экране Groups, `role="dialog"/aria-modal` модалкам, `aria-live` тостам, единый `<title>`, нормализован font URL, убран мёртвый `body.dark-theme`, подключён `polish.js`.

## 6. Проверки (запускать перед и после правок)
```
npm run verify        # ВСЁ: syntax + test:srs + check:dom + check:ui + check:polish + check:theme + check:wcag
npm run check:syntax  # 7 файлов, polish.js включён
npm run test:srs      # 104 теста ядра (node --test .verify/test-srs.cjs)
npm run check:dom     # .verify/check.cjs     — структура разметки и контракты
npm run check:ui      # .verify/interact.cjs  — 412 поведенческих проверок через реальные DOM-события
npm run check:polish  # .verify/check-polish.cjs — сброс прокрутки при смене экрана
npm run check:backup  # .verify/check-backup.cjs — экспорт/восстановление резервных копий
npm run check:theme   # tools/theme: css_check + theme_test + verify_ui
npm run check:wcag    # tools/theme/theme_verify.mjs — 369 пар контрастности
npm run migrate:dry   # миграция базы без записи
```
**Текущий статус (2026-09-18, всё зелёное, `npm run verify` → exit 0):**
`check:syntax` OK · `test:srs` **104/104** · `check:dom` **44/44** · `check:ui` **412/412** · `check:polish` **10/10** · `check:backup` **58/58** · `check:theme` ALL PASS ×3 · `check:wcag` **369/369**. Итого ≈1000 автоматических проверок.
Прежние падения закрыты: `check:dom` 42/43 (assert не знал про `polish.js`) и `check:ui` 411/412 (BUG-1) — см. §3.
Зависимости харнесса ставятся отдельно: `cd .verify && npm install` (jsdom ^26, в git не коммитится).

## 7. ⚠️ Мульти-агентная обстановка (важно!)
Реформа делалась **двумя параллельными агентами** (ядро+данные+харнесс и UI+темы). К 2026-09-18 оба завершили работу, конкурента в дереве больше нет. Разделение территории сохранено ниже на случай нового параллельного запуска. Правила:
1. **Перед любой правкой файла — перечитать его заново** (mtime мог уйти на минуты назад; edit-tool это ловит, не игнорировать ошибки «file changed since read»).
2. Не переписывать чужие файлы целиком; только точечные `edit` с уникальными якорями.
3. Не «чинить» чужие падающие проверки без спроса — докладывать пользователю.
4. Территория UI-агента была: `themes.css`, `theme.js`, `polish.js`, секция POLISH в `style.css`, мелкие правки `index.html` (шим/разметка), `tools/theme/*`. Территория ядра: `srs.js`, `app.js`, `main.js`, `data/`, `scripts/`, `.verify/`.

## 8. Открытые хвосты (по убыванию полезности)
Закрыто 2026-09-18: порядок скриптов в `.verify/check.cjs` (+`polish.js`), `polish.js` в `check:syntax`, BUG-1/BUG-2 и пропуск карточки (§3), перенос инструментов тем в отслеживаемый `tools/theme/`.

Осталось:
- **Ничего не закоммичено.** `git status`: изменены `.gitignore app.js data/* index.html main.js package.json scripts/add_words.js style.css`, не отслеживаются `.verify/ docs/ polish.js srs.js theme.js themes.css tools/ scripts/migrate-offline.cjs data/leitner_data.pre-srs.*`. Решение о коммите — за пользователем.
- **Не проверяемо headless — нужен живой браузер:** реальная геометрия training-экрана на 1920×1080 / 1440×900 / 1366×768 / 1280×720 / 1024×600 (нет page-скроллбара, кнопки видны; бюджет `102px` = 38px тайтлбар + 2×32px паддинг `.content-area`, выведен из объявленных CSS-значений, а не замерен); flip-анимация карточки в новом flex-контейнере; pixel-identity beta вживую; Electron drag-region тайтлбара против пикера тем; донат `#chart-stages` и heatmap по всем четырём темам.
- Шрифты с Google CDN при бейдже «100% Offline» — self-host woff2 (средний объём правок `index.html` + `style.css`).
- Escape не «съедает» набор в инпутах, exit-анимация тостов, confetti под `prefers-reduced-motion` — требуют app.js/main.js. (Иконка `icon.png` сделана и подключена в `main.js:65`.)
- ~34 русских строки консольной диагностики (`[load]/[SRS]/[ipc]/[save]/[train]/[answer]/[merge]/[restore]`) оставлены **намеренно**: это developer-вывод, а не интерфейс. В `docs/UI-EN-STRINGS.md` — категория OPT.
- Мусор в корне: `fix_html.ps1` (мёртвый одноразовый скрипт починки разметки от 21 авг., в git не отслеживается — удаление невосстановимо, поэтому оставлен) и пустой `гембота.txt`.
- `.scratch/` удалён; `.verify/node_modules/` и `.scratch/` в `.gitignore`, `docs/` и `tools/` — коммитить.

## 9. Предпочтения пользователя (не обсуждаются)
Бета-тема неприкосновенна. Sandstone оставить. Анимации — только быстрые и незаметные, приложение не должно «развлекать». WCAG AA минимум. Светлая и тёмная темы — «холодные и красивые», новые цветовые семьи, а не перекрас старых. Работать аккуратно из-за параллельной модели. Язык общения — русский.
