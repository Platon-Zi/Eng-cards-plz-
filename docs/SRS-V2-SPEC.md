# SRS v2 — контракт переписки системы повторений

Статус: **обязателен к исполнению**. Любой код (ядро, UI, CSS, тесты, миграция) пишется строго по этому документу.
Автор контракта: основная сессия. Решения пользователя зафиксированы ниже — они не обсуждаются.

---

## 0. Решения пользователя (из опроса)

| Вопрос | Решение |
|---|---|
| Коробки в UI | **Полностью заменить** на группы знаний. Поля `box` нет ни в данных, ни в UI |
| Два направления | **Independent Direction Tracking** — два независимых вектора прогресса в одной карточке, без жёсткого гейта |
| Архив 🏆 | **Архива нет.** MASTERED = уровень 6 = возврат через 30 дней, слово пожизненно в ротации |
| Миграция | **Автоматически при запуске** + автобэкап прежней базы перед первым сохранением |

---

## 1. Модель данных

### 1.1 WordCard (канон, `schema_version: 2`)

```js
{
  id: String,                       // существующий, не перегенерировать
  // —— контент (без изменений) ——
  word: String,
  phonetic: String,                 // было также transcription/part_of_speech… см. 1.4
  translation: String,
  part_of_speech: String|Array,     // массив легален ("noun","verb"); приводится к строке только для отображения
  partOfSpeech: String|Array,       // зеркало part_of_speech (см. 1.4)
  example: String,
  example_translation: String,
  created_at: String(ISO),
  batch_id: String,
  batch_name: String,

  // —— расписание (НОВОЕ) ——
  status: 'BANK' | 'ACTIVE',
  level_en_ru: Integer 0..6,        // вектор ENG ➔ RUS
  next_review_en_ru: 'YYYY-MM-DD',
  level_ru_en: Integer 0..6,        // вектор RUS ➔ ENG
  next_review_ru_en: 'YYYY-MM-DD',

  // —— счётчики (сохраняем) ——
  fail_count: Integer,              // +1 на каждый «Забыл»
  review_count: Integer             // +1 на каждый ответ (замена накопленной статистики старых полей)
}
```

**Не храним:** `box`, `'archive'`, `srsStage`, `interval`, `easeFactor`, `repetitions`, `dueDate`, `eng_to_rus`, `rus_to_eng`, `last_tested_eng`, `last_tested_rus`, хранённый `knowledge_group`.
Значение `level` (единое) — **не используется**: всегда `level_en_ru` / `level_ru_en`.

### 1.2 Константы

```
INTERVALS      = [0, 1, 2, 4, 7, 14, 30]   // индекс = уровень, значение = дней
MAX_LEVEL      = 6
KNOWLEDGE_GROUPS = ['NEW','LEARNING','FAMILIAR','CONFIDENT','MASTERED']
GROUP_OF_LEVEL   = {0:'NEW', 1:'LEARNING', 2:'FAMILIAR', 3:'FAMILIAR', 4:'CONFIDENT', 5:'CONFIDENT', 6:'MASTERED'}
DIRECTIONS       = ['en_ru','ru_en']       // en_ru = ENG➔RUS, ru_en = RUS➔ENG
ANSWERS          = { AGAIN:'again', HARD:'hard', EASY:'easy' }
```

Русские подписи кнопок (единственно верные в UI): `again` → **🔴 Забыл**, `hard` → **🟠 Сложно**, `easy` → **🟢 Легко**.

### 1.3 Производные величины (никогда не сериализуются)

```
derivedGroup(card):
  card.status === 'BANK'  → 'BANK'
  иначе GROUP_OF_LEVEL[min(level_en_ru, level_ru_en)]      // самое слабое звено

directionLevel(card, dir)  = card['level_' + dir]
directionDue(card, dir, t) = card['next_review_' + dir] <= t
isDue(card, t) = status==='ACTIVE' && (due en_ru || due ru_en)
daysUntil(dateStr, t) = diffDays(t, dateStr)
```

### 1.4 Совместимость имён контента

Исторически в базе встречаются `phonetic`/`transcription`, `part_of_speech`/`partOfSpeech`, `example_translation`/`example_transliteration`.
Правило: **при чтении** — читать любой из синонимов (приоритет уже заполненному); **при записи** — держать оба зеркала (`part_of_speech` и `partOfSpeech`) одинаковыми, как это делает сейчас движок слияния. Массив `part_of_speech` не ломать: для отображения `Array.isArray(x) ? x.join(' / ') : String(x ?? '')`.

---

## 2. Алгоритм

### 2.1 Ответ применя ONLY к показанному направлению

```
applyAnswer(card, dir, answer, TODAY):
  c = clone(card)
  if c.status === 'BANK':  c = activateCard(c, TODAY)     // см. 2.3
  lvl = c['level_'+dir]
  switch answer:
    'easy':  new = min(lvl + 1, 6)
    'hard':  new = lvl                                    // заморозка, интервал тот же
    'again': new = (lvl <= 3) ? 1 : 2                     // асимметричный сброс
  c['level_'+dir] = clamp(new)
  c['next_review_'+dir] = TODAY + INTERVALS[c['level_'+dir]]
  c.review_count++ ; if answer==='again' c.fail_count++
  return c
```

Другой направление **не трогается ни при каких обстоятельствах** (это главный инвариант и главный тест).

### 2.2 Ежедневная очередь (Practice)

```
buildReviewQueue(cards, TODAY, seed):
  entries = []
  for card of cards where status==='ACTIVE':
      if due en_ru: entries.push({cardId, direction:'en_ru'})
      if due ru_en: entries.push({cardId, direction:'ru_en'})
  sort by:  directionLevel asc            // слабые первыми, MASTERED-поддержка в конце
            , daysOverdue desc            // кто дольше в долге — тот раньше
            , seededHash(seed, cardId+direction)   // детерминированное разнообразие
  spread(entries)                         // анти-соседство: одна карточка не показываетcя подряд
  return entries
```

* Карточка с одним просроченным направлением даёт **одну** запись (показывается только эта сторона).
* Карточка с двумя — **две** записи, гарантированно не соседние.
* Капа бэклога нет: «Practice» отдаёт всё, что должно сегодня. Слабые слова идут первыми, поэтому длинная сессия естественно обрезается пользователем на самом важном.

### 2.3 Банк и активация

```
activateCard(card, TODAY):
  status = 'ACTIVE'; level_en_ru = 0; level_ru_en = 0
  next_review_en_ru = TODAY; next_review_ru_en = TODAY
```

* BANK-карточки **никогда** не попадают в `buildReviewQueue`.
* Режим «Learn» = `buildLearnQueue`: берём все BANK-карточки, каждая даёт две записи (`en_ru`, затем `ru_en`), перемешанные кругово, чтобы стороны одного слова шли не подряд и обе были продежурены за сессию.
* Порядок в learn-режиме: первый ответ (любой из трёх) вызывает `activateCard` **и затем** применяет ответ к показанному направлению. Второй проход по тому же слову оценивает уже независимое второе направление.
* Кнопка «Забыл» на уровне 0 уводит слово на уровень 1 (завтра) — это буквальное следствие правила сброса; фиксируем как осознанное поведение.

### 2.4 Защита от цикла на уровне 0

`INTERVALS[0] = 0` ⇒ «Сложно» на уровне 0 даёт `next_review = TODAY`, то есть слово снова Eligible **в тот же день**, но:
* очередь материализуется один раз при старте сессии и хранит `{cardId, direction}`;
* множество `sessionSeen = Set("cardId:direction")` не допускает второй встречи той же пары **в текущей сессии**;
* повторный нажатие «Practice» в тот же день слово покажет — так и задумано.

### 2.5 Дата: единственный источник правды

Канонический хелпер — **`todayString()`** (локальная дата, НЕ `toISOString().slice(0,10)`, который врёт около полуночи и в других таймзонах). Все старые `getTodayString` / `getTodayDateString` / `toISOString()`-даты в статистике и heatmap переводятся на него. Парсинг дат — через `new Date(y, m-1, d, 12)` (полдень локального времени), чтобы DST не сдвигал сутки.

### 2.6 Точность и история

`correct := (answer !== 'again')` — «Сложно» засчитывается как верный ответ с усилием. Запись в `appState.history[TODAY] = {total, correct}` и стрик — без изменений по смыслу.

---

## 3. Ядро `srs.js`

Подключается **до** `app.js`. Чистые функции: никакого DOM, `localStorage`, `fetch`, `Math.random()`; `new Date(...)` встречается только в `parseYMD`/`fromEpochDays`/`todayString`/`utcDate`, а единственный читатель часов — `todayString(now?, timeZone?)` (инжектируемый: тесты фиксируют дату). Дата во все функции приходит параметром `today`.

Хвост двойной загрузки обязателен: `<script src="srs.js">` → `window.SRS`, `require('./srs.js')` → `module.exports`. Корневой `package.json` не должен объявлять `"type": "module"`.

Фактический публичный API — **96 экспортов** (сверка: `Object.keys(require('./srs.js')).length`); тест pin'ит весь набор, поэтому любое добавление/удаление имени ломает прогон осознанно.

### 3.1 Константы

| Имя | Значение / смысл |
|---|---|
| `VERSION` | `'srs-v2'` |
| `SCHEMA_VERSION`, `SUPPORTED_SCHEMA_MAX` | `2` |
| `INTERVALS` | `[0, 1, 2, 4, 7, 14, 30]` — дни по уровням 0..6 |
| `MAX_LEVEL`, `MIN_REST_LEVEL` | `6`, `1` |
| `KNOWLEDGE_GROUPS` | `['NEW','LEARNING','FAMILIAR','CONFIDENT','MASTERED']` |
| `BUCKETS` | `['BANK','NEW','LEARNING','FAMILIAR','CONFIDENT','MASTERED']` — порядок для UI и графиков |
| `GROUP_OF_LEVEL`, `LEVELS_OF_GROUP`, `groupForLevel`, `levelsForGroup` | уровень ↔ группа |
| `GROUP_RANK`, `groupRank` | `BANK:-1 … MASTERED:5` (сортировка «слабейшее вперёд») |
| `GROUP_META` | `{ru, en, color, levels, intervalRu, captionRu}` на группу |
| `STATUS` | `{BANK:'BANK', ACTIVE:'ACTIVE'}` |
| `DIRECTIONS` | `['en_ru','ru_en']` |
| `DIRECTION_META` | `{short:'EN → RU', full, ru, flag, ui}` |
| `DIRECTION_ALIASES` | все исторические написания → `en_ru`/`ru_en` |
| `ANSWERS`, `ANSWER_ORDER`, `ANSWER_META` | `again\|hard\|easy`, порядок, `{ru, en, icon, correct, hotkeys}` |
| `RESET_TABLE` | `{lowMaxLevel:3, lowTo:1, highTo:2}` — правило «Забыл» |
| `DEFAULTS` | `sameCardGap:3, learnBatchLimit:20, requeueDelay:4, maxRepeatsPerSession:1, reviewChunkSize:30, maxOverdueDisplay:365, shrinkThreshold:0.8, penalizeArchive:false, duePolicy:'stagger'` |
| `DEPRECATED_FIELDS` | 15 мёртвых полей, вычищаемых при сохранении |
| `BOX_TO_LEVEL`, `STAGE_TO_LEVEL` | карты соответствия для миграции |
| `CARD_KEY_ORDER`, `ROOT_KEY_ORDER` | порядок ключей при сериализации |
| `EVIDENCE_FIELDS` | поля-свидетельства, по которым миграция отличает выученное от непроверенного |

### 3.2 Даты (целые UTC-сутки эпохи)

`todayString(now?, timeZone?)`, `parseYMD(str)`, `isDateStr(str)`, `toEpochDays(str)`, `fromEpochDays(n)`, `addDays(str, n)`, `diffDays(a, b)`.

Арифметика идёт целыми сутками эпохи, поэтому DST и часовой пояс не влияют на результат. Формат строгий: `^\d{4}-\d{2}-\d{2}$` плюс календарная валидность (`2026-02-30` и `2100-02-29` отклоняются, `2400-02-29` принимается). Год в `fromEpochDays` дополняется до четырёх цифр, а `parseYMD` задаёт год через `setUTCFullYear` — иначе `Date.UTC` отображает годы 0..99 в `1900+y`, и round-trip рвался на годах < 1000 (исправленный баг закреплён отдельным тестом).

### 3.3 Уровни и направления

`clampLevel`, `isValidLevel`, `intervalForLevel`, `normalizeDir` (бросает `TypeError` на мусор), `otherDir`, `levelKey`, `dueKey`, `directionLevel`, `directionDueDate`.

### 3.4 Предикаты

`isBank`, `isActive`, `isDirectionDue` (fail-open: невалидная дата считается просроченной, чтобы слово не «залипло» навсегда), `dueDirections`, `isDue`, `derivedGroup` (по слабейшему направлению), `derivedRank`, `sessionKey`, `hasEvidence`.

### 3.5 Мутации (чистые: вход не мутируется, возвращается копия)

`activateCard(card, today)` (идемпотентна), `returnToBank(card)`, `setCardStatus(card, status, today)`, `setDirectionLevel(card, dir, level, today)` (сама пересчитывает дату), `normalizeAnswer`, `applyAnswer(card, dir, answer, today)`, `answerBankCard`, `newCardSkeleton(content, opts)`.

`applyAnswer` возвращает не «новую карточку», а отчёт:

```
{ card, direction, answer, activated, prev,
  next: { level, due, intervalDays, group },
  outcome, promotedFromNew, cardGroup, pendingDirections, warnings }
```

`pendingDirections` — вторая сторона только что активированного слова: вызывающий код обязан добавить её в текущую сессию через `sessionEnsure`.

### 3.6 Детерминизм

`fnv1a(str)`, `rngFromSeed(seed)` (mulberry32), `seededShuffle(arr, seed)`, `spreadSameCard(items, opts)` — разносит записи одной карточки (зазор `sameCardGap`, при недостижимости деградирует до «не подряд»; элементы не теряются никогда).

### 3.7 Очереди

`makeItem`, `compareItems`, `buildReviewQueue(cards, today, opts)`, `buildLearnQueue`, `buildCramQueue`, `buildSubsetQueue`.

`opts`: `{ seed, limit, excludeIds (массив или Set), direction, group, gap, allDirections, fallbackAllDirections, includeBank }`.

Порядок сортировки: `entryRank ↑ → overdue ↓ → tieBreak → cardId → индекс в DIRECTIONS`. Запись очереди — пара «слово × сторона» с уникальным `key = ${cardId}:${dir}` (инвариант A3).

### 3.8 Аналитика

`summarize(cards, today)`, `describeDirection(card, dir, today, lang)`, `describeCard(card, today, lang)`.

```
summarize -> { today, total, bank, active, dueCards, dueEntries, overdueEntries, brokenDates,
               dueByDirection:{en_ru, ru_en},
               groups:{BANK, NEW, LEARNING, FAMILIAR, CONFIDENT, MASTERED},
               levels:{en_ru:[7 чисел], ru_en:[7 чисел]},
               asymmetry:{pairs, lagGe2, lagGe3, worst}, masteredShare }
```

`dueCards` — слова, `dueEntries` — записи (слово × сторона). UI «на сегодня» показывает `dueEntries`: у слова два независимых вектора, и их просрочки не совпадают.

### 3.9 Слияние и миграция

`earlierDate`, `mergeRecords(a, b, today)`, `normalizeCard(raw, today, opts)` → `{card, migrated, source:'native'|'hybrid'|'legacy'|'synth'|'junk', issues}`, `convertLegacy`, `repairDates`, `stripDeprecated`, `finalizeContent`, `syntheticId`, `assertNoCardLoss`, `migrateState(state, today, opts)` → `{state, migratedCount, report}`.

### 3.10 Валидация и сериализация

`validateCard`, `validateState(next, prev, {today, allowShrink, removedIds, shrinkThreshold, maxErrors})` → `{ok, errors, warnings, shrinkRatio, removedIds, count}`, `serializeState(state, {savedAt})`.

### 3.11 Контейнер сессии

`createSession(items, {mode, today, seed})`, `sessionCurrent`, `sessionRemaining`, `sessionAdvance`, `sessionIsGraded`, `sessionMarkGraded`, `sessionRequeue(s, item, opts)` → `'requeued'|'capped'`, `sessionSkip(s, key)` → `'moved-to-tail'|'removed'|'absent'|'ignored'`, `sessionEnsure`, `sessionStats`.

Два правила вызывающей стороны, которые легко нарушить:
* `item.done = true` ставится **после** `sessionRequeue` (клон в очереди должен остаться неотмеченным);
* `sessionSkip` удаляет запись под курсором, поэтому `currentCardIndex` после неё **не** инкрементируется (splice сам сдвигает массив).

### 3.12 Утилиты

`posText(value, sep?)` (массив склеивает, не ломая данные), `pluralRu`, `stripBom`, `pipString`, `freezeDeep`.

---

## 4. Миграция legacy → v2

### 4.1 Правило подтверждения (исправлено по аудиту реальных данных)

Первая редакция этого раздела предлагала считать направлением «подтверждённым» флаг `eng_to_rus && rus_to_eng`. Аудит 198 реальных карточек показал: **оба флага стоят у 0 карточек** (распределение `(eng_to_rus, rus_to_eng)` = FF 144 / TF 34 / FT 20 / TT 0), то есть такое правило отбросило бы весь 30-дневный ярус на 7 дней.

Действующее правило:

* **Первичное свидетельство** — непустое `last_tested_eng` / `last_tested_rus` (в реальной базе: 107 и 70 карточек соответственно).
* **Вторичное** — флаг `eng_to_rus` / `rus_to_eng`, если дата отсутствует.
* Нет ни того, ни другого → направление считается непроверенным.

Штраф за непроверенное направление: `max(1, L(b) - 1)`, а не «сброс в 1» — именно эта формула воспроизводит эталонные гистограммы.

### 4.2 Таблица преобразования

| Legacy | status | level_en_ru | level_ru_en | даты |
|---|---|---|---|---|
| `box` 0 / `'bank'` / отсутствует, свидетельств нет | BANK | 0 | 0 | `null` (BANK не участвует в повторении) |
| `box` 1..5, направление подтверждено | ACTIVE | `L(b)` | — | `TODAY + INTERVALS[L]` |
| `box` 1..5, направление НЕ подтверждено | ACTIVE | `max(1, L(b)-1)` | — | `TODAY + INTERVALS[L]` |
| `box` `'archive'` / 6 | ACTIVE | 6 | 6 (неподтверждённое → 5) | `TODAY + 30` |
| уже имеет `level_en_ru` (native v2) | — | без изменений | без изменений | только починка невалидных дат |
| `box` вне 0..6 / мусор (`'xyz'`, `7`, `-1`) | по свидетельствам | как выше | как выше | фиксируется в `issues` |

`L(b)` — `BOX_TO_LEVEL = {0:0, 1:1, 2:2, 3:4, 4:5, 5:6, 6:6, archive:6, bank:0}`.

Плюс: `fail_count` и `review_count` берутся как `max` из всех слитых источников; `created_at` — самая ранняя дата; контент (`word`, `translation`, `phonetic`, `example`, `example_translation`, `part_of_speech`) сохраняется **байт в байт**, включая массивный `part_of_speech` (в реальной базе 9 таких карточек) — он никогда не склеивается в строку.

### 4.3 Перенос просрочки (`duePolicy`)

* `'stagger'` (**по умолчанию**) — накопленный долг просрочки начисляется один раз на карточку, на слабейшее направление (при равенстве — на `en_ru`). Без этого в день перехода нагрузка была бы 218 записей вместо 96.
* `'fresh'` — все даты пересчитываются от сегодня; доступно через `--due-policy=fresh` в офлайн-скрипте.

### 4.4 Механика

1. `loadData()` → слияние источников (ранг кандидата: `schema_version ↓`, `saved_at ↓`, `cards.length ↓`) → `SRS.migrateState(state, TODAY)` → `saveData()`.
2. **Важно про порядок.** Движок слияния приводит каждую карточку к v2 (`mergeCardInto → SRS.normalizeCard`) ещё **до** вызова `migrateState`. Поэтому на легаси-старте ядро честно возвращает `migratedCount = 0` (`bySource.native = 198`): к моменту миграции прежних карточек уже нет. Признак первой миграции берётся не только из отчёта ядра, но и из счётчика движка слияния:
   ```
   firstMigration = result.migratedCount > 0 || legacyHint.legacyCards > 0
   ```
   `legacyCards` считает записи, у которых `normalizeCard` вернул `migrated` / `source ∈ {legacy, hybrid}`. Без этого снимок до миграции и тост об обновлении были недостижимы, хотя база уже конвертировалась и перезаписывала оба ключа localStorage (дефект найден харнессом `.verify/interact.cjs` §15, исправлен 2026-09-18).
3. Если `firstMigration`, **до** первой записи делается одноразовый снимок прежней базы: `data/leitner_data.pre-srs.{json,js}` плюс `localStorage.leitner_data_pre_srs_backup`. Файл никогда не перезаписывается — это единственная точка полного отката на модель коробок. Снимок пишется из **сырого** payload наивысшего по рангу legacy-источника (`legacyHint.rawLegacyState`), а не из `appState`: последний к этому моменту уже нормализован и для отката непригоден. Legacy-источник распознаётся по `schema_version < 2` **или** по наличию карточек без `level_en_ru` / с `box`.
4. `lastMigrationReport` несёт действительное число конвертаций: `migrated = max(migratedByKernel, migratedAtMerge)` плюс разбивка `migratedByKernel` (пересчитало ядро) и `migratedAtMerge` (привёл движок слияния). Тост и диагностика читают именно его, чтобы не рапортовать «0 cards upgraded» сразу после реальной миграции.
5. Идемпотентность: повторный прогон даёт `migratedCount = 0`, `legacyCards = 0` и побайтово те же карточки (проверяется тестом на живой базе).
6. Незнакомые корневые ключи сохраняются (`Object.assign({}, base)`); `deleted_ids` — надгробия, без которых удалённое слово вернулось бы при следующем слиянии.
7. Восстановление старого бэкапа новым приложением = обычный путь миграции: `restoreDataFromJson` сам вызывает `SRS.migrateState` на **сыром** файле копии, затем сливает её тем же `mergeCardInto` (по `id`, затем по паре «слово + перевод», поэтому омографы не схлопываются), учитывает надгробия и валидирует результат **до** изменения `appState`.
   - Карточка, отброшенная по надгробию `deleted_ids`, — **объяснённое** удаление: её id передаются в `validateState` и `saveData` как `removedIds`, иначе страж видел бы уменьшение счётчика и отменял восстановление целиком (`UNEXPLAINED-LOSS`).
   - Записи без слова отсекаются: `SRS.normalizeCard` намеренно синтезирует id даже для пустой записи (`source: 'synth'`, чтобы миграция ничего не теряла), но карточка с пустым `word` необучаема — она не показывается в тренировке, не ищется в словаре и не сливается по паре «слово + перевод». Такие записи идут в `skippedJunk`.
   - Покрыто тестом `.verify/check-backup.cjs` (58 проверок): экспорт → валидный schema-2 и обратим; legacy-бэкап мигрирует; оба омографа `resilience` уцелевают и сохраняют прежние id; `box 0 → BANK` (даты `null`, в очередь не попадает) и `box 3 → уровень 4, ACTIVE`; надгробие не даёт слову воскреснуть; битый JSON, пустой список и файл с BOM обрабатываются без потери базы. Новый бэкап в старом приложении не поддерживается. `exportDataToJson` пишет через `SRS.serializeState` (канонический порядок ключей + `schema_version`), а не `JSON.stringify`.
8. Офлайн-вариант: `node scripts/migrate-offline.cjs` (`--dry-run`, `--today=`, `--due-policy=`, `--data-dir=`). Перед записью срабатывают три стража: `assertNoCardLoss`, `validateState`, проверка `schema_version`.

### 4.5 Эталонные числа (реальные 198 карточек, `today = 2026-09-17`)

```
198 → 198   migratedCount = 198   collisions = 0   lostIds = 0
byStatus  {ACTIVE: 109, BANK: 89}
byGroup   {BANK: 89, NEW: 0, LEARNING: 41, FAMILIAR: 41, CONFIDENT: 27, MASTERED: 0}
levelHist en_ru [89,40,42,0,12,9,6]   ru_en [89,41,41,0,12,11,4]
pairs     {0/0: 89, 1/1: 40, 2/1: 1, 2/2: 41, 4/4: 12, 5/5: 5, 5/6: 4, 6/5: 6}
overdueCarried 96   buildReviewQueue(...).length = 96   dueByDirection {en_ru: 95, ru_en: 1}
```

`MASTERED = 0` — свойство данных, а не дефект правила: ни у одной карточки 5-й коробки не подтверждены оба направления. Числа воспроизведены независимо ядром, тест-сьютом и офлайн-скриптом; боевой прогон на `2026-09-18` дал те же значения.

## 5. DOM-контракт

Все имена фиксированы. `app.js`, разметка, CSS и тесты ссылаются только на них.

### 5.1 Панель ответов (тренировка) — заменяет `.tinder-controls` + `.srs-4-controls`

```html
<div class="answer-controls no-flip">
  <button class="btn-answer btn-answer-again" id="btn-answer-again" title="Forgot [1 / ← / A]">🔴 Forgot<kbd>1 / ←</kbd></button>
  <button class="btn-answer btn-answer-hard"  id="btn-answer-hard"  title="Hard [2]">🟠 Hard<kbd>2</kbd></button>
  <button class="btn-answer btn-answer-easy"  id="btn-answer-easy"  title="Easy [3 / → / D]">🟢 Easy<kbd>3 / →</kbd></button>
</div>
```

Ровно три элемента, подписи английские (интерфейс по умолчанию английский). `#btn-swipe-left`, `#btn-swipe-right`, `#btn-srs-again|hard|good|easy` — **удалены** вместе с обработчиками: механика «нравится / не нравится» не способна выразить третью оценку «Сложно». Перетаскивание карточки жестом сохранено как ускоритель: влево = `again`, вправо = `easy`.

Оценка применяется **исключительно к показанному направлению** (`currentTrainingItem.direction`). Двойная оценка одной записи отклоняется (инвариант A7).

### 5.2 Хромиум карточки (вместo номера коробки)

Лицевая и оборотная стороны:
```
#card-dir-indicator-front / -back    → «EN → RU» | «RU → EN»
#card-level-pill-front  / -back      → «L2 · FAMILIAR»  (+ класс .card-level-pill.grp-familiar)
#card-due-note-front    / -back      → «due today» / «back in 4 days» (+ .is-overdue, data-overdue)
```
Классы `.card-dir-indicator`, `.card-level-pill`, `.card-due-note`, модификаторы `.grp-new|.grp-learning|.grp-familiar|.grp-confident|.grp-mastered|.grp-bank` для цвета группы.

### 5.3 Dashboard — панель знаний (шесть рядов вместо семи коробок)

```
#knowledge-rows                      контейнер
ряд: <div class="kg-row" data-group="bank|new|learning|familiar|confident|mastered">
     #kg-count-bank … #kg-count-mastered     счётчики
     #kg-bar-bank   … #kg-bar-mastered       полос доли
#dash-due-now                        сколько всего на сегодня
#dash-due-en-ru / #dash-due-ru-en    разбивка по направлениям
```
Клик по ряду фильтрует словарь по этой группе (`openGroupInDictionary(groupKey)`). Классы `.box-row/.box-bar/...` переиспользуем как `.kg-row/.kg-bar`, старые семь рядов удаляем.

Герои: `#btn-hero-start-practice` (подпись «N слов на сегодня · M направлений»), `#btn-hero-start-learn` («N слов в банке»).

### 5.4 Словарь

```
#dict-filter-group   select: ""|bank|new|learning|familiar|confident|mastered|due
                     (значение «все слова» — ПУСТАЯ строка, не "all")
#btn-practice-group  кнопка «🚀 Practice»; app.js снимает .hidden и подставляет
                     «🚀 Practice: <group>», когда выбран фильтр
плитка карточки:     .dict-card.grp-*, бейдж .badge.grp-badge.grp-* («FAMILIAR · L3/L4»),
                     два чипа направлений .dict-dir-chip.grp-* (+ .is-due / .is-overdue)
```
Чипы направлений — **классы, а не id**: плиток десятки, `#dict-card-dir-en` дублировался бы по всей сетке и ломал `getElementById`.

`#dict-filter-box` удалён. Фильтр `due` = просрочено хотя бы одно направление (`SRS.isDue`). Удаление карточки из словаря обязательно кладёт id в `appState.deleted_ids` и передаёт `saveData({removedIds, allowShrink:true})`, иначе страж потери базы блокирует запись.

### 5.5 Статистика

KPI-иды сохраняются (`stats-total-cards`, `stats-due-cards`, `stats-mastered-cards`, `stats-accuracy`, `stats-streak`, `stat-total-added`), подписи пересматриваются («Выучено» → «MASTERED (30 дн)»). Донат `#chart-stages`: метки `['Bank','NEW','LEARNING','FAMILIAR','CONFIDENT','MASTERED']`, шесть цветов. Heatmap и `#stat-mistakes-body` без изменений по структуре.

### 5.6 Модалка редактирования

```
#edit-status        select: BANK|ACTIVE   (значения В ВЕРХНЕМ РЕГИСТРЕ — app.js пишет
                    String(status).toUpperCase(), lowercase-опции промахивались бы)
#edit-level-en-ru   select "0".."6"
#edit-level-ru-en   select "0".."6"
#edit-due-info      read-only <input>: «EN → RU: 2026-09-20 (due) · RU → EN: 2026-09-24»
```
`#edit-box` удалён. Смена уровня пересчитывает `next_review_* = TODAY + INTERVALS[level]` (это делает `SRS.setDirectionLevel`, а не код модалки); перевод в BANK обнуляет оба уровня и стирает обе даты.

Даты доступны только для чтения: расписание назначает алгоритм, ручная правка даты разошлась бы с историей оценок.

`part_of_speech` может быть массивом (9 реальных карточек), а поле ввода — строка. Значение перезаписывается только если пользователь действительно его изменил, иначе массив молча превратился бы в `"noun / verb"`.

### 5.7 Клавиши

| Клавиша | Действие |
|---|---|
| `Space` / `S` / `Ы` | перевернуть карточку |
| `Enter` | 🔊 слово |
| `Shift+Enter` | 💡 подсказка → 🔊 пример |
| `1` / `←` / `A` / `Ф` | 🔴 Forgot |
| `2` | 🟠 Hard |
| `3` / `→` / `D` / `В` | 🟢 Easy |
| `0` | 🏦 вернуть слово в Банк |
| `↓` | откат (undo) |
| `↑` / `W` / `Ц` | в конец очереди (без оценки) |
| `Esc` | закрыть модалку → выйти из тренировки → Dashboard |

Ручные переносы клавишами `0`–`5` и `Shift/Alt+0..5` **удалены** (коробок больше нет): они правили расписание в обход оценок и истории — главный источник тихого дрейфа прогресса. Клавиша `0` переиспользована под возврат в Банк, клавиша `4` намеренно свободна (четвёртой оценки больше нет). Кириллические `Ы/Ф/В/Ц` — поддержка русской раскладки, сохраняются.

---

## 6. Что удаляется совсем

`manuallyMoveCardToBox`, `openBoxInDictionary`, `migrateCardsToSRS`, `calculateNextSrs`, `getDueCardsForSystem`, `getLearnCardsForSystem`, `pickDirection` (гейт по `eng_to_rus/rus_to_eng`), логика номеров коробок в `renderCurrentCard`, обработка цифр `0`–`5` в keydown, `#edit-box`, `#dict-filter-box`, `#btn-practice-box`, `#btn-srs-*`, `#btn-swipe-*`, классы `.archive-bar/.box-*` в разметке, упоминания Box N / Archive в подписях (обе языковые версии гайда), режимы `startTrainingSession('mixed', box)` и `specificBox`, поле `card.box` во всех слоях (данные, UI, CSV-экспорт).

Вместо `pickDirection` направление — **свойство записи очереди** (`item.direction`), поэтому переключатель направления пересобирает очередь (`restartCurrentTrainingSession`), а не подменяет поле у уже построенных записей: прежняя подмена ломала связку «показанная сторона = оценённая сторона».

Исключение (намеренное): id кнопки пресета диктовки остался `btn-spelling-preset-box1`, хотя подпись теперь «🧠 Learning» и обработчик грузит `cardsByGroupSource('learning')`. Переименование id требует синхронной правки двух файлов и не влияет на пользователя.

Направления в тренировке остаются пользовательскими: `Auto` (по очереди из очереди), `🇬 ENG→RUS`, `🇷🇺 RUS→ENG` — но теперь они лишь **фильтруют** уже построенную очередь по `direction`, а не меняют прогрессию.

---

## 7. Правила приёмки

1. Ни одно слово не теряется: `ids(in) ⊇ ids(out)`, количество карточек до/после миграции совпадает (`assertNoCardLoss`).
2. Инвариант независимости направлений (A8) проверяется тестом: после ответа второй вектор побайтово неизменен, а список изменённых ключей — белый.
3. A1: ни один ответ не оставляет уровень 0 (`prev === 0 → next === 1`) — это исключает петли в тот же день.
4. A2: оценённое направление не может быть просрочено в тот же день.
5. A3: один `(cardId, direction)` — не более одного показа за сессию, ключи очереди уникальны.
6. A4: `sessionEnsure` идемпотентна; A5: `spreadSameCard` не теряет записи и не ставит одну карточку подряд.
7. A7: повторная оценка той же записи отклоняется.
8. Очередь детерминирована при фиксированном `seed`.
9. Сохранение отклоняется (refuse-to-save), если карточек стало меньше без явного `removedIds`, превышен `shrinkThreshold`, либо у ACTIVE-карточки `next_review_*` не парсится.
10. Прогоны зелёные (`npm run verify` → exit 0, состояние на 2026-09-18):

```
npm run check:syntax   # node --check по srs.js, app.js, main.js, theme.js, polish.js и обоим скриптам
npm run test:srs       # 104/104 — тесты ядра + золотые числа миграции + проверки живой базы
npm run check:dom      # 44/44  — структурные проверки разметки и её связности с app.js
npm run check:ui       # 412/412 — поведенческие проверки через реальные DOM-события
npm run check:polish   # 10/10  — сброс прокрутки .content-area при смене экрана
npm run check:backup   # 58/58  — экспорт и восстановление резервных копий
npm run check:theme    # ALL PASS ×3 — паритет токенов, функциональность theme.js, контракт разметки
npm run check:wcag     # 369/369 — контрастность всех четырёх тем
```

Итого ≈1000 автоматических проверок. Зависимости харнесса: `cd .verify && npm install` (jsdom ^26; каталог `node_modules` в git не попадает).

⚠ На Node 24 форма `node --test .verify/` **не работает**: каталог исполняется как модуль и падает с `MODULE_NOT_FOUND` независимо от содержимого. Рабочие варианты — точный путь (`node --test .verify/test-srs.cjs`), glob (`node --test ".verify/test-*.cjs"`) или `cd .verify && node --test`. Скрипты `package.json` используют точный путь.

11. Приложение открывается в браузере (`npm run serve` → http://127.0.0.1:8123) и работает офлайн; Electron в песочнице не запускается (postinstall требует недоступный `~/.cache`).
12. Экран тренировки не требует вертикальной прокрутки: всё нужное для ответа помещается в вьюпорт (секция `NO-SCROLL TRAINING SCREEN` в `style.css`, области `@media (max-height: 820px/700px/600px)`); прокрутка главного меню при этом сохранена.
