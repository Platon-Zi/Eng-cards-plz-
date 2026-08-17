const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, '..', 'data', 'leitner_data.json');
const jsPath = path.join(__dirname, '..', 'data', 'leitner_data.js');
const today = new Date().toISOString().split('T')[0];

function loadData() {
  if (fs.existsSync(dataPath)) {
    try {
      return JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    } catch (e) {
      console.error('Error reading JSON:', e);
    }
  }
  return { cards: [], history: {}, streak: { count: 0, last_date: null } };
}

function saveData(data) {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.writeFileSync(jsPath, `window.LEITNER_DATA = ${JSON.stringify(data, null, 2)};`, 'utf-8');
}

const rawInput = process.argv[2];
if (rawInput) {
  try {
    const newItems = JSON.parse(rawInput);
    const db = loadData();
    let count = 0;

    newItems.forEach(item => {
      if (item.word && item.translation) {
        db.cards.push({
          id: 'card_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
          word: item.word.trim(),
          phonetic: (item.phonetic || '').trim(),
          translation: item.translation.trim(),
          example: (item.example || '').trim(),
          example_translation: (item.example_translation || item.example_rus || '').trim(),
          box: 1,
          eng_to_rus: false,
          rus_to_eng: false,
          last_tested_eng: null,
          last_tested_rus: null,
          next_review_date: today,
          created_at: today,
          fail_count: 0
        });
        count++;
      }
    });

    saveData(db);
    console.log(`Successfully added ${count} words to database!`);
  } catch (err) {
    console.error('Failed to parse input:', err);
  }
}
