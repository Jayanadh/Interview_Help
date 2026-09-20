'use strict';
// Stand-in for the real preload: the overlay under test talks to this instead
// of the main process, so the UI can be driven with canned answers.
const { contextBridge, ipcRenderer } = require('electron');
const { matchLanguage } = require('../../src/shared/languages');

const handlers = {};

contextBridge.exposeInMainWorld('api', {
  sendAudio: () => {},
  reportCaptureError: () => {},
  reportCaptureOk: () => {},
  diagnose: async () => ({ screenAccess: 'granted', sourceCount: 1 }),
  screenStatus: async () => ({ screen: 'granted', mic: 'granted' }),
  requestResize: () => {},
  solveScreen: async () => { ipcRenderer.send('ui-solve-clicked'); return { ok: true }; },
  setLanguage: async (raw) => matchLanguage(raw),
  getLanguage: async () => matchLanguage('Python'),
  on: (channel, handler) => { (handlers[channel] ||= []).push(handler); return () => {}; },
  platform: process.platform,
});

// The test driver pushes fake main-process events in over this channel.
ipcRenderer.on('fake', (_e, { channel, payload }) => {
  for (const h of handlers[channel] || []) h(payload);
});
