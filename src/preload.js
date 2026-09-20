'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only surface the renderer gets. API keys live in the main process
 * and never cross this boundary — that is the same trust split a hosted
 * gateway would enforce later, just without the network hop.
 */
contextBridge.exposeInMainWorld('api', {
  // setup window
  checkProviders: () => ipcRenderer.invoke('check-providers'),
  saveKey: (key) => ipcRenderer.invoke('save-key', key),
  pickResume: () => ipcRenderer.invoke('pick-resume'),
  startSession: (setup) => ipcRenderer.invoke('start-session', setup),
  stopSession: () => ipcRenderer.invoke('stop-session'),

  // overlay window -> main
  sendAudio: (channel, data) => ipcRenderer.send('audio-chunk', { channel, data }),
  reportCaptureError: (message, name, detail) =>
    ipcRenderer.send('capture-error', { message, name, detail }),
  reportCaptureOk: (info) => ipcRenderer.send('capture-ok', info),
  diagnose: () => ipcRenderer.invoke('diagnose'),
  screenStatus: () => ipcRenderer.invoke('screen-status'),
  requestScreenAccess: () => ipcRenderer.invoke('request-screen-access'),
  relaunch: () => ipcRenderer.invoke('relaunch'),
  openScreenSettings: () => ipcRenderer.invoke('open-screen-settings'),
  requestResize: (height) => ipcRenderer.send('overlay-resize', { height }),

  // screen -> code
  solveScreen: (payload) => ipcRenderer.invoke('solve-screen', payload || {}),
  setLanguage: (raw) => ipcRenderer.invoke('set-language', raw),
  getLanguage: () => ipcRenderer.invoke('get-language'),

  // main -> overlay
  on: (channel, handler) => {
    const allowed = new Set([
      'transcript', 'answer-start', 'answer-token', 'answer-done',
      'answer-ttft', 'answer-cancelled', 'status', 'clear', 'scale',
      'solve-screen',
    ]);
    if (!allowed.has(channel)) return () => {};
    const wrapped = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  platform: process.platform,
});
