'use strict';
/**
 * The silent-capture watchdog, and the notice it raises.
 *
 * This is the failure that has no error: a revoked screen-recording grant
 * still yields a valid audio track, it just carries silence forever. The
 * watchdog has to fire on that and stay quiet on a merely quiet room, so
 * both halves are checked here.
 *
 *   npx electron scripts/selftest/watchdog.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (l, ok, d) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`);
  if (!ok) fails.push(l);
};

// Mirrors src/main/index.js. Kept in step by the assertion below.
const SILENCE_FLOOR = 180;
function hasSound(buf) {
  for (let i = 0; i + 1 < buf.length; i += 64) {
    if (Math.abs(buf.readInt16LE(i)) > SILENCE_FLOOR) return true;
  }
  return false;
}

const frame = (fill) => {
  const b = Buffer.alloc(4800); // 100ms of 24kHz PCM16
  if (fill) for (let i = 0; i < b.length; i += 2) {
    b.writeInt16LE(Math.round(Math.sin(i / 7) * fill), i);
  }
  return b;
};

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  console.log('\n1. the detector itself');
  check('pure digital silence reads as silent', !hasSound(frame(0)));
  check('a whisper-level signal reads as sound', hasSound(frame(900)));
  check('dither just above the floor reads as sound', hasSound(frame(200)));
  check('dither below the floor reads as silent', !hasSound(frame(60)));

  const fs = require('fs');
  const main = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'main', 'index.js'), 'utf8');
  check('this test still matches the real threshold',
    new RegExp(`SILENCE_FLOOR = ${SILENCE_FLOOR}\\b`).test(main));
  check('the grace period is long enough not to nag a quiet room',
    /AUDIO_GRACE_MS = (\d+)/.test(main) && Number(RegExp.$1) >= 30000,
    `${Number(RegExp.$1) / 1000}s`);

  console.log('\n2. the notice the overlay shows');
  const win = new BrowserWindow({
    width: 760, height: 660, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'overlay.html'));
  await sleep(500);

  const js = (c) => win.webContents.executeJavaScript(c);
  const visible = (id) =>
    js(`document.getElementById('${id}').className.includes('show')`);

  check('hidden while nothing is wrong', !(await visible('dead')));

  win.webContents.send('fake', { channel: 'audio-dead', payload: {
    message: 'Audio is arriving but it is completely silent, which is what a revoked Screen Recording grant looks like.',
    detail: 'macOS resets this permission on major OS updates, so it can vanish without you touching anything. Switch it back on, then restart.',
    canFix: true,
  }});
  await sleep(250);

  check('appears when the watchdog fires', await visible('dead'));
  check('names the likely cause',
    /revoked Screen Recording/.test(await js(`document.getElementById('deadTitle').textContent`)));
  check('explains that an OS update can do this',
    /OS update/i.test(await js(`document.getElementById('deadDetail').textContent`)));
  check('offers the settings pane',
    await js(`document.getElementById('deadSettings').offsetParent !== null`));
  check('offers a restart',
    await js(`document.getElementById('deadRestart').offsetParent !== null`));

  console.log('\n3. it clears itself when sound comes back');
  win.webContents.send('fake', { channel: 'status', payload: {
    level: 'ok', message: 'Listening — Groq Whisper + Groq LLM',
  }});
  await sleep(250);
  check('notice is taken down once audio returns', !(await visible('dead')));

  console.log('\n4. a platform with no fix to offer hides the buttons');
  win.webContents.send('fake', { channel: 'audio-dead', payload: {
    message: 'No audio is reaching the app at all — the capture never started.',
    detail: 'Check that something is actually playing.',
    canFix: false,
  }});
  await sleep(250);
  check('notice shown', await visible('dead'));
  check('macOS-only buttons hidden',
    (await js(`document.getElementById('deadActs').style.display`)) === 'none');

  win.destroy();
  console.log(`\n${'─'.repeat(58)}`);
  console.log(fails.length ? `${fails.length} failed: ${fails.join('; ')}` : 'the watchdog behaves');
  app.exit(fails.length ? 1 : 0);
});
