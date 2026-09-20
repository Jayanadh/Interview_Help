'use strict';
const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');

const BACKEND = (process.env.AUDIO_BACKEND || 'screencapturekit').toLowerCase();

const KEY = 'enable-features';
const existing = app.commandLine.getSwitchValue(KEY);
if (app.commandLine.hasSwitch(KEY)) app.commandLine.removeSwitch(KEY);
app.commandLine.appendSwitch(KEY, [...new Set([
  ...(existing ? existing.split(',').filter(Boolean) : []),
  'MacLoopbackAudioForScreenShare',
  BACKEND === 'coreaudio' ? 'MacCatapSystemAudioLoopbackCapture'
                          : 'MacSckSystemAudioLoopbackOverride',
])].join(','));

console.log(`BACKEND=${BACKEND}`);

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((s) => cb(s.length ? { video: s[0], audio: 'loopback' } : {}))
      .catch(() => cb({}));
  }, { useSystemPicker: false });

  ipcMain.on('result', (_e, r) => {
    console.log('RESULT ' + JSON.stringify(r));
    app.exit(r.ok ? 0 : 1);
  });

  const w = new BrowserWindow({
    width: 300, height: 200, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  w.loadFile(path.join(__dirname, 'index.html'));
});

setTimeout(() => { console.log('RESULT {"ok":false,"reason":"timeout"}'); app.exit(2); }, 25000);
