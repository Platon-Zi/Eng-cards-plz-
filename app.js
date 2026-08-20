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
let currentTrainingQueue = [];
let currentCardIndex = 0;
let currentTrainingItem = null;
let isFlipped = false;
let hintUsedForCurrentCard = false;
let sessionUndoStack = [];
let activeBoxFilterForPractice = null;
let trainingSourceScreen = null;
// Direction override for current session: null = auto/default, 'eng-rus', 'rus-eng'
let sessionDirectionOverride = null;


// Box intervals in days
const BOX_INTERVALS = { 0: 0, 1: 1, 2: 3, 3: 7, 4: 14, 5: 30 };

// Helper: Get Local Today's date YYYY-MM-DD
function getTodayString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper: Add days to date string
function addDaysToDate(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper: Fisher-Yates Array Shuffle
function shuffleArray(arr) {
  const array = [...arr];
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// ==========================================
// INITIALIZATION & TRIPLE-BULLETPROOF STORAGE ENGINE
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
  await loadData();
  setupNavigation();
  setupEventHandlers();
  setupSwipeGestures();
  setupEditModal();
  setupBackupRestoreHandlers();
  updateStreakOnLaunch();
  renderDashboard();
  renderDictionary();
  renderStatistics();
  renderGroupsScreen();
});

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

async function loadData() {
  try {
    let saved = null;

    // Tier 1: Electron IPC Desktop File (Highest priority in Desktop App)
    if (ipcRenderer) {
      saved = await ipcRenderer.invoke('load-data');
    }

    // Tier 2: Primary LocalStorage Key
    if (!saved) {
      const localRaw = localStorage.getItem('leitner_data');
      if (localRaw) {
        try {
          const parsed = JSON.parse(localRaw);
          if (parsed && Array.isArray(parsed.cards) && parsed.cards.length > 0) {
            saved = parsed;
          }
        } catch (e) {}
      }
    }

    // Tier 3: Backup LocalStorage Key (In case primary key was lost or cleared)
    if (!saved) {
      const backupRaw = localStorage.getItem('leitner_data_backup');
      if (backupRaw) {
        try {
          const parsed = JSON.parse(backupRaw);
          if (parsed && Array.isArray(parsed.cards) && parsed.cards.length > 0) {
            saved = parsed;
          }
        } catch (e) {}
      }
    }

    // Tier 4: Node.js filesystem fallback
    if (!saved && typeof require !== 'undefined') {
      try {
        const fs = require('fs');
        const path = require('path');
        const p = path.join(__dirname, 'data', 'leitner_data.json');
        if (fs.existsSync(p)) {
          saved = JSON.parse(fs.readFileSync(p, 'utf-8'));
        }
      } catch (e) {}
    }

    // Tier 5: Static fallback file
    if (!saved) {
      try {
        const resp = await fetch('./data/leitner_data.json');
        if (resp.ok) {
          saved = await resp.json();
        }
      } catch (e) {}
    }

    if (!saved && window.LEITNER_DATA && Array.isArray(window.LEITNER_DATA.cards) && window.LEITNER_DATA.cards.length > 0) {
      saved = window.LEITNER_DATA;
    }

    if (saved && Array.isArray(saved.cards)) {
      appState = saved;
      if (!appState.history) appState.history = {};
      if (!appState.streak) appState.streak = { count: 0, last_date: null };
      
      // Auto-migrate missing partOfSpeech for existing cards in local data
      let stateChanged = false;
      appState.cards.forEach(card => {
        if (!card.partOfSpeech) {
          card.partOfSpeech = inferPartOfSpeech(card);
          stateChanged = true;
        }
      });

      // Instantly synchronize storage keys
      const finalStr = JSON.stringify(appState);
      localStorage.setItem('leitner_data', finalStr);
      localStorage.setItem('leitner_data_backup', finalStr);
      if (stateChanged && ipcRenderer) {
        ipcRenderer.invoke('save-data', appState);
      }
    } else {
      appState = {
        cards: [],
        history: {},
        streak: { count: 0, last_date: null }
      };
    }
  } catch (e) {
    console.error('Failed to load data:', e);
  }
}

async function saveData() {
  try {
    const jsonString = JSON.stringify(appState);
    
    // Save to Primary LocalStorage Key
    localStorage.setItem('leitner_data', jsonString);
    
    // Save to Secondary Redundant Backup LocalStorage Key
    localStorage.setItem('leitner_data_backup', jsonString);

    // Save to Electron IPC Desktop file if running in Electron
    if (ipcRenderer) {
      await ipcRenderer.invoke('save-data', appState);
    }
  } catch (e) {
    console.error('Failed to save data:', e);
  }
}

function generateId() {
  return 'card_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
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

function exportDataToJson() {
  const jsonStr = JSON.stringify(appState, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `leitner_cards_backup_${getTodayString()}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast('💾 Backup JSON file saved to your device!', 'success');
}

function restoreDataFromJson(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (parsed && Array.isArray(parsed.cards)) {
        appState = parsed;
        if (!appState.history) appState.history = {};
        if (!appState.streak) appState.streak = { count: 0, last_date: null };

        await saveData();
        renderDashboard();
        renderDictionary();
        renderStatistics();
        showToast(`✅ Successfully restored ${appState.cards.length} cards!`, 'success');
      } else {
        showToast('Invalid backup JSON format!', 'error');
      }
    } catch (err) {
      showToast('Error reading backup file!', 'error');
    }
  };
  reader.readAsText(file);
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
  if (screenId === 'statistics') renderStatistics();
}


// ==========================================
// DASHBOARD RENDERER & INTERACTIVE BOXES
// ==========================================
function renderDashboard() {
  const today = getTodayString();
  const total = appState.cards.length;
  const archived = appState.cards.filter(c => c.box === 'archive').length;
  
  const dueQueue = getDueCardsForSystem(today);
  const dueCount = dueQueue.length;

  const elTotal = document.getElementById('dash-total');
  const elLearned = document.getElementById('dash-learned');
  const elDue = document.getElementById('dash-due');
  const elStreak = document.getElementById('dash-streak');
  const elAccuracy = document.getElementById('dash-accuracy');

  if (elTotal) elTotal.textContent = total;
  if (elLearned) elLearned.textContent = archived;
  if (elDue) elDue.textContent = dueCount;
  if (elStreak) elStreak.textContent = appState.streak.count;
  
  if (total === 0) {
    document.getElementById('hero-due-text').textContent = 'Your dictionary is empty. Add new words to begin!';
  } else {
    document.getElementById('hero-due-text').textContent = dueCount > 0 
      ? `Due for review: ${dueCount} cards today`
      : 'All cards for today are reviewed! 💪';
  }

  if (elAccuracy) {
    const { accuracy } = calculateAccuracy();
    elAccuracy.textContent = `${accuracy}%`;
  }

  const boxCounts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, archive: 0 };
  appState.cards.forEach(c => {
    if (boxCounts[c.box] !== undefined) {
      boxCounts[c.box]++;
    }
  });

  for (let b = 0; b <= 5; b++) {
    const cnt = boxCounts[b];
    const barEl = document.getElementById(`box-bar-${b}`);
    const cntEl = document.getElementById(`box-count-${b}`);
    if (cntEl) cntEl.textContent = cnt;
    if (barEl) {
      const pct = Math.min(100, Math.round((cnt / Math.max(total, 1)) * 100));
      barEl.style.width = `${pct}%`;
    }
  }

  document.getElementById('box-count-archive').textContent = boxCounts.archive;
  const archPct = Math.min(100, Math.round((boxCounts.archive / Math.max(total, 1)) * 100));
  document.getElementById('box-bar-archive').style.width = `${archPct}%`;
}

function openBoxInDictionary(boxVal) {
  const filterSelect = document.getElementById('dict-filter-box');
  if (filterSelect) {
    filterSelect.value = boxVal;
  }
  activeBoxFilterForPractice = boxVal;
  switchScreen('dictionary');
  renderDictionary();
}

// ==========================================
// SMART SYSTEM SCHEDULER (BOX 0 -> BOX 5, SEAMLESSLY SKIPS EMPTY BOXES)
// ==========================================

// Helper: Pick direction for a card given override and smart logic
function pickDirection(card, todayDate) {
  // If there's an override, always use it (unless learn mode forces eng-rus)
  if (sessionDirectionOverride === 'eng-rus') return 'eng-rus';
  if (sessionDirectionOverride === 'rus-eng') return 'rus-eng';

  // Smart auto logic: prioritize untested direction
  const testedEngToday = card.last_tested_eng === todayDate;
  const testedRusToday = card.last_tested_rus === todayDate;

  if (!card.eng_to_rus && !testedEngToday) return 'eng-rus';
  if (!card.rus_to_eng && !testedRusToday) return 'rus-eng';
  return Math.random() > 0.5 ? 'eng-rus' : 'rus-eng';
}

// Helper: Pick direction for non-system modes (batch, box, groups etc.)
function pickDirectionSimple() {
  if (sessionDirectionOverride === 'eng-rus') return 'eng-rus';
  if (sessionDirectionOverride === 'rus-eng') return 'rus-eng';
  return Math.random() > 0.5 ? 'eng-rus' : 'rus-eng';
}

function getDueCardsForSystem(todayDate) {
  const finalQueue = [];

  for (let b = 1; b <= 5; b++) {
    const dueInBox = appState.cards.filter(card => {
      if (card.box !== b) return false;
      return b === 1 || !card.next_review_date || card.next_review_date <= todayDate;
    });

    if (dueInBox.length > 0) {
      const shuffled = shuffleArray(dueInBox);
      shuffled.forEach(card => {
        finalQueue.push({ card, direction: pickDirection(card, todayDate) });
      });
    }
  }

  return finalQueue;
}

function getLearnCardsForSystem(todayDate) {
  const finalQueue = [];
  const b = 0;

  const dueInBox = appState.cards.filter(card => {
    if (card.box !== b && card.box !== '0') return false;
    return true; // All cards in Box 0 (Bank) are ready to learn
  });

  if (dueInBox.length > 0) {
    const shuffled = shuffleArray(dueInBox);
    shuffled.forEach(card => {
      // In "Learn new words" (Box 0): always ENG→RUS regardless of override
      finalQueue.push({ card, direction: 'eng-rus' });
    });
  }

  return finalQueue;
}

// Update direction switcher UI to show active button
function updateDirectionSwitcherUI(isLearnMode = false) {
  const bar = document.getElementById('direction-switcher-bar');
  if (!bar) return;

  // Hide switcher entirely in learn mode (always eng-rus, not user-controlled)
  if (isLearnMode) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  // Update active state on buttons
  document.querySelectorAll('.dir-btn').forEach(btn => {
    btn.classList.remove('dir-btn-active');
  });

  const activeDir = sessionDirectionOverride || 'auto';
  const activeBtn = document.querySelector(`.dir-btn[data-dir="${activeDir}"]`);
  if (activeBtn) activeBtn.classList.add('dir-btn-active');
}

function startTrainingSession(mode, specificBox = null, specificFilter = null) {
  if (document.activeElement && document.activeElement.blur && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
  const today = getTodayString();

  if (appState.cards.length === 0) {
    showToast('Your dictionary is empty! Add words first.', 'info');
    switchScreen('add-words');
    return;
  }

  // Reset direction override to default at the start of every new session
  sessionDirectionOverride = null;

  const isLearnMode = mode === 'learn';

  if (specificFilter) {
    if (mode === 'single_word') {
      const card = appState.cards.find(c => c.id === specificFilter);
      if (!card) return;
      currentTrainingQueue = [{
        card,
        direction: pickDirectionSimple()
      }];
    } else if (mode === 'batch') {
      const batchCards = appState.cards.filter(c => (c.batch_id || 'unbatched') === specificFilter);
      if (batchCards.length === 0) {
        showToast('No cards in this batch!', 'info');
        return;
      }
      currentTrainingQueue = shuffleArray(batchCards).map(card => ({
        card,
        direction: pickDirectionSimple()
      }));
    } else if (mode === 'pos') {
      const posCategories = {
        noun: ['noun', 'сущ', 'существительное'],
        verb: ['verb', 'гл', 'глагол'],
        adjective: ['adjective', 'adj', 'прил', 'прилагательное'],
        adverb: ['adverb', 'adv', 'нареч', 'наречие'],
        phrase: ['phrase', 'idiom', 'фраза', 'идиома'],
        other: ['other', 'другое']
      };

      const keywords = posCategories[specificFilter] || [specificFilter];

      const posCards = appState.cards.filter(c => {
        const posVal = c.partOfSpeech || c.part_of_speech || inferPartOfSpeech(c);
        const posStr = String(posVal).toLowerCase();
        
        if (specificFilter === 'other') {
          const matchesAnyKnown = ['noun', 'verb', 'adjective', 'adj', 'adverb', 'adv', 'phrase', 'idiom', 'сущ', 'гл', 'прил', 'нареч'].some(k => posStr.includes(k));
          return !matchesAnyKnown;
        }

        return keywords.some(kw => posStr.includes(kw));
      });

      if (posCards.length === 0) {
        showToast(`No cards found for category "${specificFilter}"!`, 'info');
        return;
      }

      currentTrainingQueue = shuffleArray(posCards).map(card => ({
        card,
        direction: pickDirectionSimple()
      }));
    } else if (mode === 'custom_group') {
      const grp = (appState.custom_groups || []).find(g => g.id === specificFilter);
      const cardIds = grp ? grp.card_ids || [] : [];
      const customCards = appState.cards.filter(c => cardIds.includes(c.id));
      if (customCards.length === 0) {
        showToast('No cards in this group!', 'info');
        return;
      }
      currentTrainingQueue = shuffleArray(customCards).map(card => ({
        card,
        direction: pickDirectionSimple()
      }));
    }
  } else if (specificBox !== null) {
    const boxCards = appState.cards.filter(c => String(c.box) === String(specificBox));
    if (boxCards.length === 0) {
      showToast(`Box ${specificBox} is empty!`, 'info');
      return;
    }
    const shuffled = shuffleArray(boxCards);
    currentTrainingQueue = shuffled.map(card => ({
      card,
      direction: pickDirectionSimple()
    }));
  } else if (mode === 'system') {
    currentTrainingQueue = getDueCardsForSystem(today);
  } else if (mode === 'learn') {
    currentTrainingQueue = getLearnCardsForSystem(today);
  } else if (mode === 'eng-rus') {
    currentTrainingQueue = shuffleArray(appState.cards.filter(c => c.box !== 'archive' && c.box !== 0))
      .map(card => ({ card, direction: 'eng-rus' }));
  } else if (mode === 'rus-eng') {
    currentTrainingQueue = shuffleArray(appState.cards.filter(c => c.box !== 'archive' && c.box !== 0))
      .map(card => ({ card, direction: 'rus-eng' }));
  } else if (mode === 'mixed') {
    const activeCards = appState.cards.filter(c => c.box !== 'archive' && c.box !== 0);
    currentTrainingQueue = shuffleArray(activeCards).map(card => ({
      card,
      direction: pickDirectionSimple()
    }));
  }

  if (currentTrainingQueue.length === 0) {
    if (mode === 'system') {
      showToast('🎉 All review cards for today are completed!', 'success');
    } else if (mode === 'learn') {
      showToast('🏦 No new words in Word Bank (Box 0) to learn!', 'info');
    } else {
      showToast('No cards due for review in this mode!', 'info');
    }
    return;
  }

  sessionUndoStack = [];
  currentCardIndex = 0;
  
  if (mode === 'single_word') {
    trainingSourceScreen = 'dictionary';
  } else if (mode === 'batch' || mode === 'pos' || mode === 'custom_group') {
    trainingSourceScreen = 'groups';
  } else {
    trainingSourceScreen = 'dashboard';
  }

  switchScreen('training');
  updateDirectionSwitcherUI(isLearnMode);
  renderCurrentCard();
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

  currentTrainingItem = currentTrainingQueue[currentCardIndex];
  const { card, direction } = currentTrainingItem;
  
  isFlipped = false;
  hintUsedForCurrentCard = false;

  const flashcard = document.getElementById('flashcard');
  if (flashcard) {
    flashcard.style.transition = 'none';
    flashcard.style.transform = 'rotateY(0deg)';
    flashcard.classList.remove('flipped');
    requestAnimationFrame(() => {
      if (flashcard) flashcard.style.transition = 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)';
    });
  }

  // Reset hint UI
  const hintDisplay = document.getElementById('hint-display');
  hintDisplay.classList.add('hidden');
  hintDisplay.textContent = '';
  document.getElementById('btn-hint').disabled = false;

  document.getElementById('train-counter').textContent = `${currentCardIndex + 1} / ${currentTrainingQueue.length}`;

  const phoneticEl = document.getElementById('card-phonetic-text');

  if (direction === 'eng-rus') {
    document.getElementById('train-mode-title').textContent = 'Mode: ENG ➔ RUS';
    document.getElementById('card-word-text').textContent = card.word;
    
    // Show Phonetic Transcription on English front face (if available)
    if (card.phonetic && card.phonetic.trim() !== '') {
      phoneticEl.textContent = card.phonetic.trim();
      phoneticEl.classList.remove('hidden');
    } else {
      phoneticEl.textContent = '';
      phoneticEl.classList.add('hidden');
    }

    document.getElementById('card-back-original').textContent = card.word;
    document.getElementById('card-translation-text').textContent = card.translation;
  } else {
    document.getElementById('train-mode-title').textContent = 'Mode: RUS ➔ ENG';
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
  if (card.example_translation && card.example_translation.trim() !== '') {
    transEl.textContent = card.example_translation.trim();
    transEl.classList.remove('hidden');
  } else {
    transEl.textContent = '';
    transEl.classList.add('hidden');
  }

  // Box indicator: tiny label on both card faces
  const boxLabel = card.box === 'archive' ? '★' : String(card.box);
  const frontInd = document.getElementById('card-box-indicator-front');
  const backInd  = document.getElementById('card-box-indicator-back');
  if (frontInd) frontInd.textContent = boxLabel;
  if (backInd)  backInd.textContent  = boxLabel;

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
    if (direction === 'eng-rus') {
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

  const { card, direction } = currentTrainingItem;
  const hintContainer = document.getElementById('hint-container');
  const hintDisplay = document.getElementById('hint-display');
  const btnSpeakHint = document.getElementById('btn-speak-hint');
  
  if (direction === 'eng-rus') {
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

    if (!rusEx || rusEx.trim() === '') {
      hintDisplay.textContent = 'Нет примера предложения для этого слова.';
    } else {
      hintDisplay.textContent = `Пример: "${rusEx}"`;
    }
    if (btnSpeakHint) btnSpeakHint.classList.add('hidden');
  }

  if (hintContainer) hintContainer.classList.remove('hidden');
  hintDisplay.classList.remove('hidden');
  document.getElementById('btn-hint').disabled = true;

  showToast('⚠️ Hint requested! Card marked as unlearned.', 'info');
}

// Submit Answer (Right / D = Remembered 🟢, Left / A = Forgot 🔴)
async function processAnswer(isCorrect) {
  if (!currentTrainingItem) return;

  if (hintUsedForCurrentCard) {
    isCorrect = false;
  }

  const { card, direction } = currentTrainingItem;
  const today = getTodayString();

  // Save snapshot for Undo
  const cardSnapshot = JSON.parse(JSON.stringify(card));
  const historySnapshot = appState.history[today] ? JSON.parse(JSON.stringify(appState.history[today])) : null;
  
  sessionUndoStack.push({
    cardRef: card,
    snapshot: cardSnapshot,
    historySnapshot,
    today
  });

  if (!appState.history[today]) {
    appState.history[today] = { total: 0, correct: 0 };
  }
  appState.history[today].total = (appState.history[today].total || 0) + 1;

  const isBoxZero = card.box === 0 || card.box === '0';

  if (isCorrect) {
    appState.history[today].correct = (appState.history[today].correct || 0) + 1;

    if (direction === 'eng-rus') {
      card.eng_to_rus = true;
      card.last_tested_eng = today;
    } else {
      card.rus_to_eng = true;
      card.last_tested_rus = today;
    }

    if (isBoxZero) {
      // 🌟 In Box 0 (Learn new words): "Remembered" immediately moves the word to Box 1
      card.box = 1;
      card.eng_to_rus = false;
      card.rus_to_eng = false;
      card.next_review_date = addDaysToDate(today, BOX_INTERVALS[1]);
      showToast(`📦 Word "${card.word}" moved to Box 1!`, 'success');
    } else {
      // Auto-advance for Box 1-5: when remembered in both directions → move up one box
      if (card.eng_to_rus && card.rus_to_eng) {
        if (card.box < 5) {
          card.box += 1;
          card.eng_to_rus = false;
          card.rus_to_eng = false;
          card.next_review_date = addDaysToDate(today, BOX_INTERVALS[card.box]);
        } else {
          card.box = 'archive';
          card.next_review_date = null;
        }
      }
    }
  } else {
    // ❌ Forgot
    card.eng_to_rus = false;
    card.rus_to_eng = false;
    card.fail_count = (card.fail_count || 0) + 1;
    card.next_review_date = today;

    if (isBoxZero) {
      // 🏦 In Box 0 (Learn new words): "Forgot" keeps the word in Box 0
      card.box = 0;
    } else {
      // Regular boxes: drop to Box 1 (stay at 1 if already there)
      card.box = 1;
    }
  }

  await saveData();
  currentCardIndex++;
  renderCurrentCard();
}

// Manually move card to Box 0..5 via Number Keys (0-5)
async function manuallyMoveCardToBox(boxNum) {
  if (!currentTrainingItem) return;

  const { card } = currentTrainingItem;
  const today = getTodayString();

  card.box = boxNum;
  card.eng_to_rus = false;
  card.rus_to_eng = false;
  card.next_review_date = addDaysToDate(today, BOX_INTERVALS[boxNum] ?? 0);

  await saveData();
  const boxTitle = boxNum === 0 ? 'Box 0 (Word Bank)' : `Box ${boxNum}`;
  showToast(`📦 Card "${card.word}" moved to ${boxTitle}!`, 'info');
  currentCardIndex++;
  renderCurrentCard();
}

// Down Arrow (↓): Undo & Return to Previous Card
async function undoPreviousCard() {
  if (sessionUndoStack.length === 0 || currentCardIndex === 0) {
    showToast('No previous card to return to!', 'info');
    return;
  }

  const lastUndo = sessionUndoStack.pop();
  const { cardRef, snapshot, historySnapshot, today } = lastUndo;

  Object.assign(cardRef, snapshot);

  if (historySnapshot) {
    appState.history[today] = historySnapshot;
  } else if (appState.history[today]) {
    delete appState.history[today];
  }

  await saveData();
  currentCardIndex--;
  renderCurrentCard();
  showToast('↩ Returned to previous card!', 'info');
}

// Up Arrow (↑) / W: Skip current card & move to END of current training session queue
function skipCardToEnd() {
  if (!currentTrainingItem || currentCardIndex >= currentTrainingQueue.length) return;

  const itemToSkip = currentTrainingQueue[currentCardIndex];
  currentTrainingQueue.push(itemToSkip);

  currentCardIndex++;
  renderCurrentCard();
  showToast('⏭️ Card skipped to end of queue!', 'info');
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
      card.word = document.getElementById('edit-word').value.trim();
      card.phonetic = document.getElementById('edit-phonetic').value.trim();
      card.translation = document.getElementById('edit-translation').value.trim();
      card.part_of_speech = document.getElementById('edit-part-of-speech').value.trim();
      card.example = document.getElementById('edit-example').value.trim();
      card.example_translation = document.getElementById('edit-example-trans').value.trim();
      
      const rawBox = document.getElementById('edit-box').value;
      card.box = rawBox === 'archive' ? 'archive' : parseInt(rawBox);

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
  document.getElementById('edit-part-of-speech').value = card.part_of_speech || '';
  document.getElementById('edit-example').value = card.example || '';
  document.getElementById('edit-example-trans').value = card.example_translation || '';
  document.getElementById('edit-box').value = card.box || 0;

  document.getElementById('modal-edit-card').classList.remove('hidden');
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

  // In-session direction switcher buttons
  document.querySelectorAll('.dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.dir;

      // Set override: 'auto' means null (back to default)
      sessionDirectionOverride = (dir === 'auto') ? null : dir;

      // Rebuild the direction of remaining unseen cards in current session
      const today = getTodayString();
      for (let i = currentCardIndex; i < currentTrainingQueue.length; i++) {
        const item = currentTrainingQueue[i];
        if (sessionDirectionOverride) {
          item.direction = sessionDirectionOverride;
        } else {
          item.direction = pickDirection(item.card, today);
        }
      }
      // Also update the current card's direction (if still on front)
      if (currentTrainingItem && !isFlipped) {
        if (sessionDirectionOverride) {
          currentTrainingItem.direction = sessionDirectionOverride;
        } else {
          currentTrainingItem.direction = pickDirection(currentTrainingItem.card, today);
        }
        renderCurrentCard();
      }

      updateDirectionSwitcherUI(false);
      showToast(`Direction set to: ${btn.textContent.trim()}`, 'info');
    });
  });



  document.querySelectorAll('.box-row').forEach(row => {
    row.addEventListener('click', () => {
      let boxVal = row.dataset.box;
      if (!boxVal && row.classList.contains('archive-row')) {
        boxVal = 'archive';
      }
      if (boxVal) {
        openBoxInDictionary(boxVal);
      }
    });
  });

  // Practice Only Words in Current Box
  document.getElementById('btn-practice-box').addEventListener('click', () => {
    const currentBox = document.getElementById('dict-filter-box').value;
    if (currentBox && currentBox !== 'all') {
      startTrainingSession('mixed', currentBox);
    }
  });

  // Card click toggles flip (front <-> back)
  const flashcardContainer = document.getElementById('flashcard-container');
  flashcardContainer.addEventListener('click', (e) => {
    if (e.target.closest('button, .btn-speak, #btn-hint, .no-flip, a, input, select, textarea')) return;
    if (document.activeElement && document.activeElement.blur && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    toggleFlipCard();
  });

  // Controls: Right = Remembered 🟢, Left = Forgot 🔴
  document.getElementById('btn-swipe-right').addEventListener('click', (e) => {
    e.stopPropagation();
    processAnswer(true);
  });

  document.getElementById('btn-swipe-left').addEventListener('click', (e) => {
    e.stopPropagation();
    processAnswer(false);
  });

  document.getElementById('btn-undo-card').addEventListener('click', (e) => {
    e.stopPropagation();
    undoPreviousCard();
  });

  document.getElementById('btn-skip-card').addEventListener('click', (e) => {
    e.stopPropagation();
    skipCardToEnd();
  });

  // Keyboard Navigation Bindings (Window Capture Phase to guarantee instant response):
  // Space / S / Ы = Toggle Flip 🔄
  // Right Arrow / D / В = Remembered 🟢
  // Left Arrow / A / Ф = Forgot 🔴
  // Down Arrow (↓) = Undo & Return to Previous Card
  // Up Arrow (↑) / W / Ц = Skip Current Card to End of Queue
  // Number keys 0-5 = Manually assign card to Box 0..5
  // Escape = Close modal or return to Main Menu
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

        if (currentTrainingItem && currentTrainingItem.card) {
          if (e.shiftKey) {
            // Shift + Enter:
            if (!hintUsedForCurrentCard) {
              // 1st press: reveal hint
              useHint();
            } else {
              // 2nd press: speak hint (example sentence)
              const ex = currentTrainingItem.card.example;
              if (ex && ex.trim() !== '') {
                speakEnglish(ex.trim());
                showToast('🔊 Playing example sentence...', 'info');
              } else {
                showToast('No example sentence to play', 'info');
              }
            }
          } else {
            // Plain Enter: speak English word
            const w = currentTrainingItem.card.word;
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

      if (['0', '1', '2', '3', '4', '5'].includes(key)) {
        e.preventDefault();
        e.stopPropagation();
        if (activeEl && activeEl.blur && activeEl !== document.body) activeEl.blur();
        manuallyMoveCardToBox(parseInt(key)); // Move card to Box 0-5
      } else if (key === 'd' || key === 'в' || key === 'arrowright') {
        e.preventDefault();
        e.stopPropagation();
        if (activeEl && activeEl.blur && activeEl !== document.body) activeEl.blur();
        processAnswer(true); // Right / D / В = Remembered 🟢
      } else if (key === 'a' || key === 'ф' || key === 'arrowleft') {
        e.preventDefault();
        e.stopPropagation();
        if (activeEl && activeEl.blur && activeEl !== document.body) activeEl.blur();
        processAnswer(false); // Left / A / Ф = Forgot 🔴
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

    addSingleCard(word, translation, example, phonetic, exampleTrans);
    await saveData();
    
    showToast(`✅ Word "${word}" successfully added & saved!`, 'success');
    e.target.reset();
  });

  document.getElementById('btn-copy-prompt').addEventListener('click', () => {
    const promptText = `Я хочу добавить новые английские слова в приложение. 
Составь для них чистый JSON-массив объектов без какого-либо лишнего текста, маркдауна или пояснений. 
Каждый объект должен иметь следующие поля:
- "word": Английское слово или фраза
- "transcription": Транскрипция (например, "[wɜːrk]")
- "translation": Точный перевод на русский язык
- "part_of_speech": Часть речи. Допустимые значения: "noun" (сущ.), "verb" (глагол), "adjective" (прилаг.), "adverb" (наречие), "phrase" (фраза/идиома), "other" (другое). Если слово универсальное, можно передать массив: ["noun", "verb"].
- "example": Пример предложения на английском
- "example_translation": Перевод примера на русский
- "batch_title": (опционально) Название темы или подборки партий`;
    navigator.clipboard.writeText(promptText);
    showToast('📋 Upgraded AI Prompt copied to clipboard!', 'success');
  });

  const btnGuideCopy = document.getElementById('btn-guide-copy-prompt');
  if (btnGuideCopy) {
    btnGuideCopy.addEventListener('click', () => {
      const codeEl = document.getElementById('guide-prompt-code');
      if (codeEl) {
        navigator.clipboard.writeText(codeEl.textContent.trim());
        showToast('📋 Промпт для нейросети скопирован в буфер!', 'success');
      }
    });
  }

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
  document.getElementById('dict-filter-box').addEventListener('change', renderDictionary);

  // CSV Export
  document.getElementById('btn-export-csv').addEventListener('click', async () => {
    if (appState.cards.length === 0) {
      showToast('Dictionary is empty. Add words before exporting!', 'info');
      return;
    }

    let csv = 'Word,Phonetic,Translation,Example,ExampleTranslation,Box,FailCount\n';
    appState.cards.forEach(c => {
      const cleanEx = (c.example || '').replace(/"/g, '""');
      const cleanExTr = (c.example_translation || '').replace(/"/g, '""');
      csv += `"${c.word}","${c.phonetic || ''}","${c.translation}","${cleanEx}","${cleanExTr}","${c.box}",${c.fail_count || 0}\n`;
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
    if (appState.cards.length === 0) {
      showToast('Dictionary is empty. Add words first!', 'info');
      return;
    }
    const englishWords = appState.cards.map(c => c.word).join(', ');
    navigator.clipboard.writeText(englishWords)
      .then(() => {
        showToast('📋 English word list copied to clipboard!', 'success');
      })
      .catch(() => {
        showToast('Failed to copy to clipboard!', 'error');
      });
  });
}

function addSingleCard(word, translation, example, phonetic = '', example_translation = '', part_of_speech = '', batch_id = null, batch_name = null) {
  appState.cards.push({
    id: generateId(),
    word,
    phonetic,
    translation,
    part_of_speech: part_of_speech || '',
    batch_id: batch_id || ('batch_' + Date.now()),
    batch_name: batch_name || ('Import ' + new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })),
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
      tr.innerHTML = `<td><b>${item.word}</b></td><td>${item.translation}</td><td><small>${item.example}</small></td>`;
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
function renderDictionary() {
  const grid = document.getElementById('dict-cards-grid');
  grid.innerHTML = '';

  const searchQuery = document.getElementById('dict-search-input').value.toLowerCase().trim();
  const boxFilter = document.getElementById('dict-filter-box').value;
  const practiceBoxBtn = document.getElementById('btn-practice-box');
  const subtitleEl = document.getElementById('dict-subtitle');

  if (boxFilter !== 'all') {
    practiceBoxBtn.classList.remove('hidden');
    const boxTitle = boxFilter === 'archive' ? 'Learned Archive' : (boxFilter === '0' || boxFilter === 0 ? 'Box 0 (Word Bank)' : `Box ${boxFilter}`);
    practiceBoxBtn.textContent = `🚀 Practice Only ${boxTitle}`;
    subtitleEl.textContent = `Filtered view for ${boxTitle}. Click practice button to train these words.`;
  } else {
    practiceBoxBtn.classList.add('hidden');
    subtitleEl.textContent = 'Manage flashcards, search, edit, and export';
  }

  const filtered = appState.cards.filter(c => {
    const matchesSearch = c.word.toLowerCase().includes(searchQuery) || 
                          c.translation.toLowerCase().includes(searchQuery);
    
    let matchesBox = true;
    if (boxFilter !== 'all') {
      matchesBox = String(c.box) === boxFilter;
    }

    return matchesSearch && matchesBox;
  });

  if (filtered.length === 0) {
    const boxName = boxFilter === 'all' ? 'Dictionary' : (boxFilter === 'archive' ? 'Archive' : (boxFilter === '0' || boxFilter === 0 ? 'Box 0 (Word Bank)' : `Box ${boxFilter}`));
    grid.innerHTML = `<div style="grid-column: 1 / -1; text-align:center; color: var(--text-dark); padding: 30px;">${boxName} is empty. Click "Add Words" to add new flashcards!</div>`;
    return;
  }

  filtered.forEach(card => {
    const posVal = card.partOfSpeech || card.part_of_speech || inferPartOfSpeech(card);
    let badgeClass = 'pos-other';
    const lowerPos = posVal.toLowerCase();
    if (lowerPos.includes('noun') || lowerPos.includes('сущ')) badgeClass = 'pos-noun';
    else if (lowerPos.includes('verb') || lowerPos.includes('гл')) badgeClass = 'pos-verb';
    else if (lowerPos.includes('adjective') || lowerPos.includes('adj') || lowerPos.includes('прил')) badgeClass = 'pos-adj';
    else if (lowerPos.includes('adverb') || lowerPos.includes('adv') || lowerPos.includes('нареч')) badgeClass = 'pos-adv';
    else if (lowerPos.includes('phrase') || lowerPos.includes('idiom') || lowerPos.includes('выраж') || lowerPos.includes('фраз')) badgeClass = 'pos-phrase';

    const boxLabel = card.box === 'archive' 
      ? '<span class="badge" style="background: rgba(16,185,129,0.2); color:#10b981;">🏆 Archive</span>'
      : (card.box === 0 || card.box === '0'
          ? '<span class="badge" style="background: rgba(99,102,241,0.2); color:#818cf8;">📦 Box 0 (Bank)</span>'
          : `<span class="badge">📦 Box ${card.box}</span>`);

    const cardEl = document.createElement('div');
    cardEl.className = 'dict-card';
    
    cardEl.innerHTML = `
      <div class="dict-card-header">
        <div class="dict-card-word">
          <span>${card.word}</span>
          <button class="btn-speak btn-speak-dict" title="Listen to pronunciation" aria-label="Listen to word">🔊</button>
        </div>
        <span class="badge ${badgeClass} dict-card-pos" style="text-transform: capitalize;">${posVal}</span>
      </div>
      <div class="dict-card-translation">${card.translation}</div>
      <div class="dict-card-footer">
        <div class="dict-card-box-label">${boxLabel}</div>
        <div class="dict-card-actions">
          <button class="btn-dict-edit">✏️ Edit</button>
          <button class="btn-dict-delete">🗑️ Delete</button>
        </div>
      </div>
    `;

    // Click on the card body/area to practice this single word
    cardEl.addEventListener('click', (e) => {
      // Exclude edit, delete, and speak buttons
      if (e.target.closest('.btn-dict-edit') || e.target.closest('.btn-dict-delete') || e.target.closest('.btn-speak')) {
        return;
      }
      startTrainingSession('single_word', null, card.id);
    });

    const dictSpeakBtn = cardEl.querySelector('.btn-speak-dict');
    if (dictSpeakBtn) {
      attachSpeakHandler(dictSpeakBtn, card.word);
    }

    // Edit button click handler
    cardEl.querySelector('.btn-dict-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openEditModal(card);
    });

    // Delete button click handler
    cardEl.querySelector('.btn-dict-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Are you sure you want to delete the word "${card.word}" from your dictionary?`)) {
        appState.cards = appState.cards.filter(c => c.id !== card.id);
        await saveData();
        renderDictionary();
        renderDashboard();
        showToast('Card deleted', 'info');
      }
    });

    grid.appendChild(cardEl);
  });
}
// STATISTICS & HEATMAP RENDERER
// ==========================================
function renderStatistics() {
  const elTotal = document.getElementById('stat-total-added');
  if (!elTotal) return;

  const totalAdded = appState.cards.length;
  elTotal.textContent = totalAdded;

  const sevenDaysAgo = addDaysToDate(getTodayString(), -7);
  const addedWeek = appState.cards.filter(c => c.created_at >= sevenDaysAgo).length;
  const elWeek = document.getElementById('stat-added-week');
  if (elWeek) elWeek.textContent = addedWeek;

  const archived = appState.cards.filter(c => c.box === 'archive').length;
  const elArch = document.getElementById('stat-archived-count');
  if (elArch) elArch.textContent = archived;

  const { accuracy, totalAnswers, correctAnswers } = calculateAccuracy();
  const elAcc = document.getElementById('stat-accuracy');
  if (elAcc) elAcc.textContent = `${accuracy}%`;
  const elRatio = document.getElementById('stat-answers-ratio');
  if (elRatio) elRatio.textContent = `${correctAnswers} out of ${totalAnswers} answers`;

  renderHeatmap();
  renderMistakesTable();
}

function renderHeatmap() {
  const grid = document.getElementById('heatmap-grid');
  grid.innerHTML = '';

  const today = new Date();
  const daysToShow = 119;
  const startDate = new Date();
  startDate.setDate(today.getDate() - daysToShow);

  for (let i = 0; i <= daysToShow; i++) {
    const curDate = new Date(startDate);
    curDate.setDate(startDate.getDate() + i);
    const dateStr = curDate.toISOString().split('T')[0];

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
  tbody.innerHTML = '';

  const mistakes = appState.cards
    .filter(c => (c.fail_count || 0) > 0)
    .sort((a, b) => (b.fail_count || 0) - (a.fail_count || 0))
    .slice(0, 10);

  if (mistakes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color: var(--text-dark);">No difficult words yet.</td></tr>';
    return;
  }

  mistakes.forEach(card => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${card.word}</b></td>
      <td>${card.translation}</td>
      <td><span class="badge" style="background:rgba(239,68,68,0.2); color:#ef4444;">${card.fail_count} resets</span></td>
      <td>📦 Box ${card.box}</td>
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

  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
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
  { key: 'noun',      label: 'Nouns (Существительные)',       icon: '📘', badgeClass: 'pos-noun',   keywords: ['noun', 'сущ', 'существительное'] },
  { key: 'verb',      label: 'Verbs (Глаголы)',               icon: '⚡', badgeClass: 'pos-verb',   keywords: ['verb', 'гл', 'глагол'] },
  { key: 'adjective', label: 'Adjectives (Прилагательные)',   icon: '🎨', badgeClass: 'pos-adj',    keywords: ['adjective', 'adj', 'прил', 'прилагательное'] },
  { key: 'adverb',    label: 'Adverbs (Наречия)',             icon: '🚀', badgeClass: 'pos-adv',    keywords: ['adverb', 'adv', 'нареч', 'наречие'] },
  { key: 'phrase',    label: 'Phrases & Idioms (Фразы)',      icon: '💬', badgeClass: 'pos-phrase', keywords: ['phrase', 'idiom', 'фраза', 'идиома'] },
  { key: 'other',     label: 'Other / Pronouns (Другое)',     icon: '🧩', badgeClass: 'pos-other',  keywords: ['other', 'другое', 'предлог', 'местоимение', 'союз'] }
];

function getPosCards(posKey) {
  const cat = POS_CATEGORIES.find(c => c.key === posKey);
  if (!cat) return [];
  return appState.cards.filter(card => {
    const posVal = card.partOfSpeech || card.part_of_speech || inferPartOfSpeech(card);
    const posStr = String(posVal).toLowerCase();
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
    const bId = card.batch_id || 'unbatched';
    let bName = card.batch_name;
    if (!bName) {
      bName = bId === 'unbatched'
        ? 'Single Additions (Отдельные слова)'
        : `Import Session (${card.created_at || getTodayString()})`;
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
        <td>📦 Box ${card.box}</td>
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

