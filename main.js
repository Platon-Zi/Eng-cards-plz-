const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 900,
    minHeight: 650,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f172a',
      symbolColor: '#94a3b8',
      height: 38
    },
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    backgroundColor: '#0f172a',
    icon: path.join(__dirname, 'icon.png')
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Stored in project ./data/leitner_data.json for instant Antigravity integration
function getDataPath() {
  const localDataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(localDataDir)) {
    fs.mkdirSync(localDataDir, { recursive: true });
  }
  return path.join(localDataDir, 'leitner_data.json');
}

ipcMain.handle('load-data', async () => {
  const dataPath = getDataPath();
  try {
    if (fs.existsSync(dataPath)) {
      const raw = await fs.promises.readFile(dataPath, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Error reading data:', e);
  }
  return null;
});

ipcMain.handle('save-data', async (event, data) => {
  const dataPath = getDataPath();
  const jsPath = path.join(path.dirname(dataPath), 'leitner_data.js');
  try {
    await fs.promises.mkdir(path.dirname(dataPath), { recursive: true });
    await fs.promises.writeFile(dataPath, JSON.stringify(data, null, 2), 'utf-8');
    await fs.promises.writeFile(jsPath, `window.LEITNER_DATA = ${JSON.stringify(data, null, 2)};`, 'utf-8');
    return true;
  } catch (e) {
    console.error('Error saving data:', e);
    return false;
  }
});

ipcMain.handle('export-csv', async (event, csvContent) => {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Export Flashcards to CSV',
    defaultPath: 'leitner_words.csv',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  
  if (filePath) {
    await fs.promises.writeFile(filePath, csvContent, 'utf-8');
    return { success: true, filePath };
  }
  return { success: false };
});
