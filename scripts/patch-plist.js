#!/usr/bin/env node
'use strict';

/**
 * macOS dev-mode fix.
 *
 * On macOS 14.2+ system-audio capture requires NSAudioCaptureUsageDescription
 * in the Info.plist. In development you run Electron's own binary, so the key
 * has to go into *its* bundle — your app's plist isn't used yet.
 *
 * Skipping this does not throw. It gives you a perfectly valid audio track
 * that emits pure silence, forever, with no warning anywhere. That failure
 * mode costs people an afternoon, so we patch it automatically on install.
 *
 * No-op on Windows and Linux.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') {
  console.log('[patch-plist] Not macOS — nothing to do.');
  process.exit(0);
}

const plist = path.join(
  __dirname, '..', 'node_modules', 'electron', 'dist',
  'Electron.app', 'Contents', 'Info.plist'
);

if (!fs.existsSync(plist)) {
  console.log('[patch-plist] Electron binary not found yet — skipping.');
  process.exit(0);
}

const KEYS = {
  NSAudioCaptureUsageDescription:
    'Help_Interview captures interview audio so it can transcribe the conversation.',
  NSMicrophoneUsageDescription:
    'Help_Interview uses your microphone to transcribe what you say.',
};

const PB = '/usr/libexec/PlistBuddy';

for (const [key, value] of Object.entries(KEYS)) {
  try {
    execFileSync(PB, ['-c', `Print :${key}`, plist], { stdio: 'pipe' });
    // Already present — overwrite so the wording stays current.
    execFileSync(PB, ['-c', `Set :${key} ${value}`, plist], { stdio: 'pipe' });
    console.log(`[patch-plist] updated ${key}`);
  } catch {
    try {
      execFileSync(PB, ['-c', `Add :${key} string ${value}`, plist], { stdio: 'pipe' });
      console.log(`[patch-plist] added ${key}`);
    } catch (e) {
      console.warn(`[patch-plist] could not set ${key}: ${e.message}`);
    }
  }
}

console.log('[patch-plist] Done. System audio capture should now deliver samples.');
