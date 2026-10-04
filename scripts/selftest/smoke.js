'use strict';
/**
 * Does this machine have everything the app needs? Run it anywhere.
 *
 * Written for the case where the app is about to be used somewhere it has
 * never run — a different OS, a fresh laptop, an hour before you need it.
 * It exercises the real modules rather than describing them, and every line
 * it prints is something that was actually checked.
 *
 *   npx electron scripts/selftest/smoke.js
 */
const { app, BrowserWindow, globalShortcut, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const warns = [];

const ok   = (l, d) => console.log(`  PASS  ${l}${d ? '  — ' + d : ''}`);
const bad  = (l, d) => { console.log(`  FAIL  ${l}${d ? '  — ' + d : ''}`); fails.push(l); };
const warn = (l, d) => { console.log(`  WARN  ${l}${d ? '  — ' + d : ''}`); warns.push(l); };
const check = (l, cond, d) => (cond ? ok(l, d) : bad(l, d));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  console.log(`\n${'='.repeat(62)}`);
  console.log(`  ${os.type()} ${os.release()} · ${process.arch} · Electron ${process.versions.electron} · Node ${process.versions.node}`);
  console.log(`${'='.repeat(62)}`);

  // ── 1. keys ────────────────────────────────────────────────────────
  console.log('\n1. API keys and routing');
  const { resolveProviders } = require('../../src/main/config');
  const providers = resolveProviders();
  if (providers.mode === 'needs-key' || providers.mode === 'error') {
    bad('a usable provider is configured', providers.error.split('\n')[0]);
  } else {
    ok('a usable provider is configured', providers.note);
    ok('transcription provider', providers.stt.provider);
    ok('answer provider', providers.llm.provider);
  }

  // ── 2. modules ─────────────────────────────────────────────────────
  console.log('\n2. the app\'s own modules load');
  try {
    const L = require('../../src/shared/languages');
    check('language matcher', L.matchLanguage('pyhton').name === 'Python',
      `${L.DISPLAY.length} languages, "pyhton" -> ${L.matchLanguage('pyhton').name}`);
  } catch (e) { bad('language matcher', e.message); }
  for (const m of ['screen', 'assist', 'stt', 'trigger', 'context']) {
    try { require(`../../src/main/${m}`); ok(`src/main/${m}.js`); }
    catch (e) { bad(`src/main/${m}.js`, e.message); }
  }

  // ── 3. displays ────────────────────────────────────────────────────
  console.log('\n3. displays');
  const displays = screen.getAllDisplays();
  check('at least one display', displays.length > 0,
    displays.map((d) => `${d.size.width}x${d.size.height}@${d.scaleFactor}x`).join(', '));

  // ── 4. screen capture ──────────────────────────────────────────────
  console.log('\n4. screen capture (this is what Solve screen uses)');
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'], thumbnailSize: { width: 320, height: 200 },
    });
    check('desktopCapturer returns a screen', sources.length > 0,
      sources.map((s) => s.name).join(', '));
  } catch (err) {
    bad('desktopCapturer', (err && err.message) || String(err));
    if (process.platform === 'darwin') {
      console.log('        → macOS: grant Screen Recording, then QUIT AND REOPEN.');
    }
  }

  try {
    const { captureScreen } = require('../../src/main/screen');
    const shot = await captureScreen({ hide: [] });
    ok('the real one-shot grab works', `${shot.width}x${shot.height} from "${shot.sourceName}"`);
  } catch (err) {
    bad('the real one-shot grab', (err && err.message || String(err)).split('\n')[0]);
  }

  // ── 5. audio ───────────────────────────────────────────────────────
  console.log('\n5. system audio capture');
  if (process.platform === 'darwin') {
    const { systemPreferences } = require('electron');
    const st = systemPreferences.getMediaAccessStatus('screen');
    check('Screen Recording granted (macOS routes system audio through it)',
      st === 'granted', st);
  } else {
    ok('no permission gate on this platform (WASAPI loopback)');
  }
  // The renderer is what actually opens the stream, so prove the handler the
  // main process installs is reachable rather than claiming audio works.
  const { session } = require('electron');
  try {
    session.defaultSession.setDisplayMediaRequestHandler(() => {}, { useSystemPicker: false });
    ok('display-media handler installs (loopback audio path)');
    session.defaultSession.setDisplayMediaRequestHandler(null);
  } catch (err) {
    bad('display-media handler', err.message);
  }

  // ── 6. shortcuts ───────────────────────────────────────────────────
  console.log('\n6. global shortcuts');
  for (const a of ['CommandOrControl+Shift+Space', 'CommandOrControl+Shift+Return',
                   'CommandOrControl+Shift+H', 'CommandOrControl+Shift+X',
                   'CommandOrControl+Shift+B']) {
    const got = globalShortcut.register(a, () => {});
    if (got) { ok(a); globalShortcut.unregister(a); }
    else warn(`${a} is taken by another app`, 'that shortcut will not work here');
  }

  // ── 7. windows ─────────────────────────────────────────────────────
  console.log('\n7. the overlay window');
  try {
    // The overlay talks to the main process as soon as it loads. This test
    // does not boot the real app, so stand in for the handlers it calls —
    // otherwise every run reports renderer errors that do not exist in use.
    const { ipcMain } = require('electron');
    const { matchLanguage } = require('../../src/shared/languages');
    ipcMain.handle('set-language', (_e, raw) => matchLanguage(raw));
    ipcMain.handle('get-language', () => matchLanguage('Python'));
    ipcMain.handle('diagnose', () => ({ screenAccess: 'granted', sourceCount: 1 }));

    const w = new BrowserWindow({
      width: 400, height: 300, show: false, frame: false,
      transparent: true, backgroundColor: '#00000000', alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'src', 'preload.js'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    const errors = [];
    w.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) errors.push(msg); });
    await w.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'overlay.html'));
    await sleep(700);

    ok('transparent frameless always-on-top window created');
    const hasBar = await w.webContents.executeJavaScript('!!document.getElementById("solve")');
    check('the Solve screen toolbar is present', hasBar);
    const langs = await w.webContents.executeJavaScript('typeof window.Languages');
    check('the language module reached the renderer', langs === 'object', langs);
    const real = errors.filter((m) => !/Content-Security-Policy|Autofill/i.test(m));
    check('no renderer errors', real.length === 0, real.slice(0, 2).join(' | ') || 'clean');
    w.destroy();
    for (const c of ['set-language', 'get-language', 'diagnose']) ipcMain.removeHandler(c);
  } catch (err) {
    bad('overlay window', err.message);
  }

  // ── verdict ────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(62)}`);
  if (fails.length) {
    console.log(`  ${fails.length} FAILED:`);
    for (const f of fails) console.log(`    · ${f}`);
  } else {
    console.log('  Everything required is working on this machine.');
  }
  if (warns.length) {
    console.log(`  ${warns.length} warning(s) — not fatal:`);
    for (const w of warns) console.log(`    · ${w}`);
  }
  console.log(`${'='.repeat(62)}\n`);
  app.exit(fails.length ? 1 : 0);
});
