'use strict';
// Stub preload for the permission-UI test: screenStatus returns whatever the
// driver last set, so all four states can be exercised in one run.
const { contextBridge, ipcRenderer } = require('electron');

let state = { screen: 'granted', mic: 'granted', appName: 'Help Interview',
              canPrompt: false, needsRestart: false };

contextBridge.exposeInMainWorld('api', {
  checkProviders: async () => ({ mode: 'groq', note: 'Groq (stub)', error: null }),
  saveKey: async () => ({ ok: true }),
  pickResume: async () => null,
  startSession: async () => ({ ok: true, contextTokens: 0 }),
  screenStatus: async () => state,
  requestScreenAccess: async () => {
    ipcRenderer.send('perm-requested');
    return { before: state.screen, after: state.screen, canPrompt: state.canPrompt };
  },
  openScreenSettings: () => ipcRenderer.send('perm-settings-opened'),
  relaunch: () => ipcRenderer.send('perm-relaunched'),
  on: () => () => {},
  platform: process.platform,
});

ipcRenderer.on('set-state', (_e, s) => { state = s; });
