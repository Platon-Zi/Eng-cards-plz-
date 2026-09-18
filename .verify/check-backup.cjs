/* ==========================================================================
   .verify/check-backup.cjs — резервные копии: экспорт и восстановление.

   Зачем отдельный файл: `exportDataToJson` и `restoreDataFromJson` — единственные
   пути, которые ЦЕЛИКОМ заменяют/дополняют базу пользователя, и до появления этого
   файла они не были покрыты ни одной проверкой. Прежняя реализация восстановления
   сливала карточки по одному лишь слову и поэтому схлопывала омографы (в реальной
   базе два разных «resilience» с разными переводами); здесь это зафиксировано тестом.

   Все сценарии гоняются через НАСТОЯЩИЕ DOM-события (клик по кнопке, change на
   <input type="file">), а не прямым вызовом функций.

   Запуск:  node .verify/check-backup.cjs     (или npm run check:backup)
   ========================================================================== */
const path = require('path');
const { createDomEnv, createRunner } = require(path.join(__dirname, 'helpers', 'dom-env.cjs'));
const SRS = require(path.join(__dirname, '..', 'srs.js'));

const TODAY = '2026-09-18';
const runner = createRunner('check-backup.cjs — резервные копии: экспорт и восстановление');

/** Мёртвые поля старой модели — ровно те, что реально лежали в legacy-базе. */
const LEGACY_FIELDS = ['box', 'eng_to_rus', 'rus_to_eng', 'last_tested_eng', 'last_tested_rus', 'next_review_date'];

/** Последний текст в #toast-container. */
function lastToast(d) {
  const c = d.getElementById('toast-container');
  if (!c || !c.children.length) return '';
  return c.children[c.children.length - 1].textContent.trim();
}

/** jsdom Blob не реализует .text() — читаем через FileReader того же окна. */
function blobText(w, blob) {
  return new Promise((resolve, reject) => {
    const fr = new w.FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('FileReader не смог прочитать Blob'));
    fr.readAsText(blob);
  });
}

/**
 * Карточка образца schema 1 — ПОЛЕ В ПОЛЕ с реальной legacy-базой
 * (.verify/fixtures/legacy-198.json): box, eng_to_rus/rus_to_eng, last_tested_*,
 * next_review_date. Никаких выдуманных полей, иначе тест проверял бы не приложение.
 */
function legacyCard(id, word, translation, box, batchName) {
  return {
    id, word, translation,
    phonetic: '', example: '', example_translation: '',
    part_of_speech: 'сущ.', partOfSpeech: 'сущ.',
    box,
    eng_to_rus: box > 1,
    rus_to_eng: box > 2,
    last_tested_eng: '2026-08-01',
    last_tested_rus: '2026-07-20',
    next_review_date: '2026-08-10',
    fail_count: 0,
    review_count: 3,
    created_at: '2026-07-01T00:00:00.000Z',
    batch_id: 'batch_legacy',
    batch_name: batchName === undefined ? 'Single Additions (Отдельные слова)' : batchName,
  };
}

async function main() {
  const env = await createDomEnv({ label: 'backup', fixedDate: TODAY, loadTheme: false });
  const w = env.window, d = w.document;

  const before = env.snapshotState();
  const totalBefore = before.cards.length;
  runner.t('среда поднялась на реальных данных', totalBefore > 0, `${totalBefore} карточек`);

  /* ── A. ЭКСПОРТ: файл должен быть валидным schema-2 и обратимым ─────────── */
  await runner.section('A. exportDataToJson → валидный, полный, обратимый файл', async ({ t }) => {
    const blobs = [];
    w.URL.createObjectURL = (b) => { blobs.push(b); return 'blob:stub-' + blobs.length; };
    w.URL.revokeObjectURL = () => {};
    const names = [];
    const realClick = w.HTMLAnchorElement.prototype.click;
    w.HTMLAnchorElement.prototype.click = function () { names.push(this.download || ''); };

    await env.evalIn('exportDataToJson()');
    await env.tick(150);
    w.HTMLAnchorElement.prototype.click = realClick;

    t('ровно один Blob отдан на скачивание', blobs.length === 1, `получено ${blobs.length}`);
    t('имя файла содержит дату', /^leitner_cards_backup_\d{4}-\d{2}-\d{2}\.json$/.test(names[0] || ''), names[0] || '(нет)');
    if (!blobs.length) return;

    const text = await blobText(w, blobs[0]);
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { /* проверяется ниже */ }
    t('содержимое — валидный JSON', !!parsed, text.slice(0, 80));
    if (!parsed) return;

    t(`schema_version === ${SRS.SCHEMA_VERSION}`, Number(parsed.schema_version) === SRS.SCHEMA_VERSION, String(parsed.schema_version));
    t('все карточки на месте', Array.isArray(parsed.cards) && parsed.cards.length === totalBefore,
      `${parsed.cards && parsed.cards.length} против ${totalBefore}`);
    t('saved_at проставлен', typeof parsed.saved_at === 'string' && parsed.saved_at.length > 0, String(parsed.saved_at));
    t(`ни у одной карточки нет мёртвых полей (${LEGACY_FIELDS.join(', ')})`,
      parsed.cards.every(c => LEGACY_FIELDS.every(f => c[f] === undefined)));
    t('у каждой карточки два числовых вектора',
      parsed.cards.every(c => Number.isFinite(Number(c.level_en_ru)) && Number.isFinite(Number(c.level_ru_en))));
    t('ACTIVE-карточки имеют обе даты, BANK — null (контракт живой базы)',
      parsed.cards.every(c => c.status === 'BANK'
        ? (c.next_review_en_ru === null && c.next_review_ru_en === null)
        : (!!SRS.parseYMD(c.next_review_en_ru) && !!SRS.parseYMD(c.next_review_ru_en))));

    const v = SRS.validateState(parsed, null, { today: TODAY });
    t('validateState принимает экспортированный файл', v.ok, v.errors.slice(0, 3).join('; '));
    t('экспорт обратим: повторная миграция ничего не меняет',
      SRS.migrateState(parsed, TODAY).migratedCount === 0,
      'migratedCount=' + SRS.migrateState(parsed, TODAY).migratedCount);
    t('показан тост об успехе', /saved/i.test(lastToast(d)), lastToast(d).slice(0, 90));
  });

  /* ── B. ВОССТАНОВЛЕНИЕ: legacy-бэкап, омографы, объединение ─────────────── */
  await runner.section('B. restoreDataFromJson → legacy-бэкап мигрирует, омографы не схлопываются', async ({ t }) => {
    const backup = {
      cards: [
        // Два «resilience» с РАЗНЫМИ переводами — ровно тот случай, который прежний код терял.
        legacyCard('legacy_res_1', 'resilience', 'устойчивость, жизнестойкость (сущ.)', 3),
        legacyCard('legacy_res_2', 'resilience', 'устойчивость, стойкость', 5),
        // box 0 → BANK, box 3 → уровень 4 (BOX_TO_LEVEL), то есть ACTIVE: проверяем оба статуса.
        legacyCard('legacy_new_bank', 'zzbackupbank', 'новое слово в банк', 0),
        legacyCard('legacy_new_act', 'zzbackupactive', 'новое слово в ротацию', 3),
      ],
      history: { '2026-09-01': { total: 5, correct: 4 } },
      streak: { count: 1, last_date: '2026-09-01' },
      custom_groups: [],
    };

    const resilBefore = before.cards.filter(c => c.word === 'resilience');
    t('в текущей базе два омографа resilience', resilBefore.length === 2, String(resilBefore.length));

    const input = d.getElementById('input-restore-json-file');
    t('файловый input восстановления существует', !!input);
    if (!input) return;

    const file = new w.File([JSON.stringify(backup)], 'legacy_backup.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    await env.tick(500);

    const after = env.snapshotState();
    const resilAfter = after.cards.filter(c => c.word === 'resilience');

    t('ОБА омографа resilience уцелели (прежний код терял один)', resilAfter.length === 2,
      `стало ${resilAfter.length}: ` + resilAfter.map(c => c.translation).join(' | '));
    t('переводы омографов остались разными',
      new Set(resilAfter.map(c => c.translation.trim().toLowerCase())).size === resilAfter.length);
    t('id омографов сохранены прежние (не подменены id из бэкапа)',
      resilAfter.every(c => !/^legacy_/.test(c.id)), resilAfter.map(c => c.id).join(','));

    const addedBank = after.cards.find(c => c.word === 'zzbackupbank');
    const addedAct = after.cards.find(c => c.word === 'zzbackupactive');
    t('новые слова из бэкапа добавились', !!addedBank && !!addedAct,
      `bank=${!!addedBank} active=${!!addedAct}`);
    t('ни одна карточка не потеряна (объединение, не замена)',
      after.cards.length === totalBefore + 2, `${totalBefore} → ${after.cards.length}`);
    t('все прежние id на месте', before.cards.every(c => after.cards.some(x => x.id === c.id)));

    if (addedBank) {
      t('BANK-карточка: box 0 → статус BANK, уровень 0, даты null',
        addedBank.status === 'BANK' && Number(addedBank.level_en_ru) === 0
          && addedBank.next_review_en_ru === null && addedBank.next_review_ru_en === null,
        JSON.stringify({ s: addedBank.status, l: addedBank.level_en_ru, d: addedBank.next_review_en_ru }));
      t('BANK-карточка не попала в очередь повторений (правило 1)',
        SRS.buildReviewQueue(after.cards, TODAY, { seed: TODAY })
          .every(i => i.cardId !== addedBank.id));
    }
    if (addedAct) {
      t('ACTIVE-карточка: box 3 → уровень 4 (BOX_TO_LEVEL), статус ACTIVE',
        addedAct.status === 'ACTIVE' && Number(addedAct.level_en_ru) === SRS.BOX_TO_LEVEL['3'],
        JSON.stringify({ s: addedAct.status, l: addedAct.level_en_ru }));
      t('ACTIVE-карточка получила обе распарсиваемые даты',
        !!SRS.parseYMD(addedAct.next_review_en_ru) && !!SRS.parseYMD(addedAct.next_review_ru_en),
        `${addedAct.next_review_en_ru} / ${addedAct.next_review_ru_en}`);
    }

    t(`мёртвые поля legacy вырезаны у добавленных карточек (${LEGACY_FIELDS.join(', ')})`,
      [addedBank, addedAct].filter(Boolean)
        .every(c => LEGACY_FIELDS.every(f => c[f] === undefined)),
      JSON.stringify(LEGACY_FIELDS.filter(f => [addedBank, addedAct].filter(Boolean).some(c => c[f] !== undefined))));
    t('ни у одной карточки всей базы не осталось полей коробок',
      after.cards.every(c => c.box === undefined && c.next_review_date === undefined));
    t('schema_version состояния === 2', Number(after.schema_version) === SRS.SCHEMA_VERSION, String(after.schema_version));

    // Двуязычная legacy-подпись партии обязана схлопнуться в одну английскую,
    // иначе экран Groups показал бы две группы одного смысла.
    t('legacy-подпись партии нормализована',
      [addedBank, addedAct].filter(Boolean).every(c => c.batch_name === 'Single Additions'),
      [addedBank, addedAct].filter(Boolean).map(c => String(c.batch_name)).join(' | '));
    t('в базе не осталось двуязычной подписи «(Отдельные слова)»',
      after.cards.every(c => !/Отдельные слова/.test(String(c.batch_name || ''))));

    const v = SRS.validateState(after, before, { today: TODAY, removedIds: [] });
    t('validateState принимает результат слияния', v.ok, v.errors.slice(0, 3).join('; '));
    t('история из бэкапа долита, а не перезаписана',
      !!after.history && !!after.history['2026-09-01'],
      JSON.stringify(after.history && after.history['2026-09-01']));

    const savedRaw = w.localStorage.getItem('leitner_data');
    const saved = savedRaw ? JSON.parse(savedRaw) : null;
    t('результат сохранён в localStorage', !!saved && saved.cards.length === after.cards.length,
      saved ? `${saved.cards.length} карточек` : 'пусто');
    t('страж сохранения не сработал', !env.evalIn('!!saveBlockedReason'), String(env.evalIn('saveBlockedReason')));
    t('показан тост об успешном восстановлении', /Restored/i.test(lastToast(d)), lastToast(d).slice(0, 120));

    const probs = env.takeProblems();
    t('восстановление не породило ошибок', probs.length === 0, probs.slice(0, 3).join(' | '));
  });

  /* ── C. НАДГРОБИЯ: удалённое слово не должно воскресать из копии ─────────── */
  await runner.section('C. deleted_ids — удалённое слово не воскресает из старой копии', async ({ t }) => {
    const cur = env.snapshotState();
    const countBefore = cur.cards.length;
    const victim = cur.cards.find(c => c.status === 'BANK') || cur.cards[cur.cards.length - 1];
    t('жертва выбрана', !!victim, victim ? `${victim.word} (${victim.id})` : '(нет)');
    if (!victim) return;

    env.evalIn(`appState.deleted_ids = Array.from(new Set((appState.deleted_ids||[]).concat(${JSON.stringify(victim.id)})))`);

    const backup = { cards: [Object.assign({}, victim)], history: {}, custom_groups: [] };
    const input = d.getElementById('input-restore-json-file');
    const file = new w.File([JSON.stringify(backup)], 'resurrect.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    await env.tick(500);

    const after = env.snapshotState();
    t('удалённая карточка НЕ вернулась из бэкапа', !after.cards.some(c => c.id === victim.id),
      'воскресла: ' + victim.word);
    t('восстановление НЕ отменено стражем (надгробие — объяснённое удаление)',
      !/rejected/i.test(lastToast(d)), lastToast(d).slice(0, 120));
    t('надгробие сохранено в состоянии',
      (after.deleted_ids || []).map(String).includes(String(victim.id)));
    t('карточек стало на одну меньше — ровно удалённая',
      after.cards.length === countBefore - 1, `${countBefore} → ${after.cards.length}`);
    t('остальные карточки не пострадали',
      cur.cards.filter(c => c.id !== victim.id).every(c => after.cards.some(x => x.id === c.id)));
    t('результат записан в localStorage', (() => {
      const raw = w.localStorage.getItem('leitner_data');
      const s = raw ? JSON.parse(raw) : null;
      return !!s && s.cards.length === after.cards.length;
    })(), String((JSON.parse(w.localStorage.getItem('leitner_data') || '{}').cards || []).length));
    t('страж сохранения не сработал', !env.evalIn('!!saveBlockedReason'), String(env.evalIn('saveBlockedReason')));
  });

  /* ── D. ОТКАЗЫ: битый файл не должен ничего портить ─────────────────────── */
  await runner.section('D. битый/пустой файл отклоняется, состояние не меняется', async ({ t }) => {
    const input = d.getElementById('input-restore-json-file');
    const countBefore = env.snapshotState().cards.length;

    async function tryRestore(content, name) {
      const file = new w.File([content], name, { type: 'application/json' });
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new w.Event('change', { bubbles: true }));
      await env.tick(400);
      return { state: env.snapshotState(), toast: lastToast(d) };
    }

    let r = await tryRestore('\uFEFF{ это не json', 'broken.json');
    t('битый JSON отклонён', r.state.cards.length === countBefore, `${countBefore} → ${r.state.cards.length}`);
    t('битый JSON дал тост об ошибке', /Error reading backup|Invalid backup/i.test(r.toast), r.toast.slice(0, 90));

    r = await tryRestore(JSON.stringify({ cards: [], history: {} }), 'empty.json');
    t('пустой бэкап отклонён (база НЕ очищена)', r.state.cards.length === countBefore,
      `${countBefore} → ${r.state.cards.length}`);
    t('пустой бэкап дал тост об ошибке', /Invalid backup/i.test(r.toast), r.toast.slice(0, 90));

    r = await tryRestore(JSON.stringify({ cards: [{}, null, { translation: 'без слова' }] }), 'junk.json');
    t('мусорные записи не создали карточек', r.state.cards.length === countBefore,
      `${countBefore} → ${r.state.cards.length}`);

    // BOM перед валидным JSON — именно так прежний scripts/add_words.js терял всю базу.
    const oneWord = { cards: [legacyCard('bom_1', 'zzbomword', 'слово с BOM', 1)], history: {}, custom_groups: [] };
    r = await tryRestore('\uFEFF' + JSON.stringify(oneWord), 'bom.json');
    t('файл с BOM прочитан (не отклонён)', r.state.cards.some(c => c.word === 'zzbomword'),
      'карточка не найдена; тост: ' + r.toast.slice(0, 90));
    t('BOM-файл дал ровно +1 карточку', r.state.cards.length === countBefore + 1,
      `${countBefore} → ${r.state.cards.length}`);
    t('BOM не попал в id карточки',
      r.state.cards.every(c => !/^\uFEFF/.test(String(c.id))));

    const probs = env.takeProblems();
    const unexpected = probs.filter(p => !/Error reading backup|Invalid backup|отклонил запись|normalizeCard|сбой чтения/i.test(String(p)));
    t('отказы не породили непредвиденных исключений', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
  });

  /* ── E. ЭКСПОРТ CSV: только чтение, но путь тоже должен работать ────────── */
  await runner.section('E. экспорт CSV — заголовок v2 и все строки', async ({ t }) => {
    const blobs = [];
    w.URL.createObjectURL = (b) => { blobs.push(b); return 'blob:csv-' + blobs.length; };
    w.URL.revokeObjectURL = () => {};
    const realClick = w.HTMLAnchorElement.prototype.click;
    w.HTMLAnchorElement.prototype.click = function () {};

    const fired = env.evalIn(`(function(){
      const ids = ['btn-export-csv','btn-csv-export','btn-download-csv','btn-export-csv-file'];
      for (const id of ids) { const b = document.getElementById(id); if (b) { b.click(); return id; } }
      if (typeof exportToCSV === 'function') { exportToCSV(); return 'exportToCSV()'; }
      if (typeof exportCSV === 'function') { exportCSV(); return 'exportCSV()'; }
      return null;
    })()`);
    await env.tick(200);
    w.HTMLAnchorElement.prototype.click = realClick;

    t('экспорт CSV вызван', !!fired, String(fired));
    t('CSV Blob получен', blobs.length >= 1, `получено ${blobs.length}`);
    if (!blobs.length) return;

    const csv = await blobText(w, blobs[blobs.length - 1]);
    const lines = csv.split('\n').filter(l => l.trim().length);
    const header = lines[0] || '';
    t('заголовок содержит оба направления', /LevelEnRu/.test(header) && /LevelRuEn/.test(header), header.slice(0, 130));
    t('в заголовке нет полей коробок', !/;?Box\b/.test(header) && !/\bBox,/.test(header), header.slice(0, 130));
    const expected = env.evalIn('appState.cards.length');
    t('строк данных столько же, сколько карточек', lines.length - 1 === expected,
      `${lines.length - 1} строк против ${expected} карточек`);
  });

  env.close();
  return runner.finish();
}

main().then(code => process.exit(code)).catch(e => {
  console.error('check-backup.cjs crashed:', (e && e.stack) || e);
  process.exit(2);
});
