'use strict';
/**
 * Exercises the one-shot screen grab on its own, including the failure it
 * produces when Screen Recording is not granted — which is the state every
 * fresh install starts in.
 *
 *   npx electron scripts/selftest/capture.js
 */
const { app, systemPreferences, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { captureScreen } = require('../../src/main/screen');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  console.log('screen permission:', systemPreferences.getMediaAccessStatus('screen'));

  // A stand-in for the overlay, to prove the hide/restore cycle works.
  const overlay = new BrowserWindow({ width: 300, height: 200, show: true, frame: false });
  await new Promise((r) => setTimeout(r, 300));
  console.log('stand-in overlay visible before:', overlay.isVisible());

  try {
    const shot = await captureScreen({ hide: [overlay] });
    const out = path.join(__dirname, 'shots', 'screen.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(shot.base64, 'base64'));
    console.log(`captured ${shot.width}x${shot.height} from "${shot.sourceName}"`);
    console.log(`base64 ${(shot.base64.length / 1024).toFixed(0)}KB -> ${out}`);
  } catch (err) {
    console.log('captureScreen failed:');
    console.log('  typeof:', typeof err, '| ctor:', err && err.constructor && err.constructor.name);
    console.log('  raw:', require('util').inspect(err).slice(0, 400));
  }

  console.log('stand-in overlay visible after:', overlay.isVisible());
  app.exit(0);
});
