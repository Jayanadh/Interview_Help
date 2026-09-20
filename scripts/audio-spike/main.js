'use strict';
const { app, BrowserWindow, session, desktopCapturer } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback(sources.length ? { video: sources[0], audio: 'loopback' } : {});
      });
    },
    { useSystemPicker: process.platform === 'darwin' }
  );

  new BrowserWindow({
    width: 560, height: 420, title: 'Audio Spike',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  }).loadFile(path.join(__dirname, 'index.html'));
});

app.on('window-all-closed', () => app.quit());
