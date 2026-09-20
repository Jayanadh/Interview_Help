'use strict';
/**
 * The real thing: a genuine desktopCapturer grab of the actual display,
 * with a coding problem on screen and a loud magenta stand-in for the
 * overlay sitting on top of it.
 *
 * The magenta is the point. The overlay is always-on-top, so if the hide
 * step does not work the model reads the panel instead of the interview —
 * and that failure is invisible in a screenshot you only glance at. Scanning
 * the captured pixels for the colour proves it either way.
 *
 *   npx electron scripts/selftest/live.js [language]
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { resolveProviders } = require('../../src/main/config');
const { captureScreen } = require('../../src/main/screen');
const { generateCodeFromScreen } = require('../../src/main/assist');
const { matchLanguage } = require('../../src/shared/languages');

const MAGENTA = { r: 255, g: 0, b: 255 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Share of pixels within tolerance of the marker colour. */
function magentaShare(png) {
  const img = nativeImage.createFromBuffer(png);
  const bmp = img.toBitmap(); // BGRA
  let hits = 0;
  const total = bmp.length / 4;
  for (let i = 0; i < bmp.length; i += 4) {
    const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
    if (r > 200 && g < 60 && b > 200) hits++;
  }
  return hits / total;
}

/** Rough content check: a black or frozen frame is near-uniform. */
function variety(png) {
  const bmp = nativeImage.createFromBuffer(png).toBitmap();
  const seen = new Set();
  for (let i = 0; i < bmp.length; i += 4 * 97) {
    seen.add(`${bmp[i] >> 4},${bmp[i + 1] >> 4},${bmp[i + 2] >> 4}`);
  }
  return seen.size;
}

app.whenReady().then(async () => {
  const providers = resolveProviders();
  const lang = matchLanguage(process.argv[2] || 'python');
  const fails = [];
  const check = (label, ok, detail) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) fails.push(label);
  };

  // The "interview": a coding problem, full screen, behind everything.
  const problem = new BrowserWindow({ show: true, fullscreen: false });
  problem.maximize();
  await problem.loadFile(path.join(__dirname, 'problem.html'));

  // The "overlay": always-on-top, unmistakable.
  const overlay = new BrowserWindow({
    width: 520, height: 320, x: 120, y: 120,
    frame: false, alwaysOnTop: true, show: true,
  });
  overlay.setAlwaysOnTop(true, 'floating');
  await overlay.loadURL(
    'data:text/html,' + encodeURIComponent(
      `<body style="margin:0;background:rgb(${MAGENTA.r},${MAGENTA.g},${MAGENTA.b})">
       <h1 style="font:700 40px sans-serif;padding:24px">OVERLAY</h1></body>`)
  );
  await sleep(900);

  console.log('\n1. capture with the overlay up');
  const shot = await captureScreen({ hide: [overlay] });
  const png = Buffer.from(shot.base64, 'base64');
  fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'shots', 'live.png'), png);

  console.log(`  ${shot.width}x${shot.height} from "${shot.sourceName}", ${(png.length / 1024).toFixed(0)}KB`);
  check('frame has real content, not a black screen', variety(png) > 40, `${variety(png)} distinct tones`);
  const share = magentaShare(png);
  check('overlay is NOT in its own screenshot',
    share < 0.002, `${(share * 100).toFixed(3)}% marker pixels`);
  check('overlay came back after the grab', overlay.isVisible());

  console.log('\n2. control: the same grab without hiding');
  const shot2 = await captureScreen({ hide: [] });
  const share2 = magentaShare(Buffer.from(shot2.base64, 'base64'));
  check('marker IS present when we do not hide — so the test can detect it',
    share2 > 0.005, `${(share2 * 100).toFixed(3)}% marker pixels`);

  console.log(`\n3. solve it for real, in ${lang.name}`);
  if (providers.mode === 'error' || providers.mode === 'needs-key') {
    console.log('  skipped — no provider');
  } else {
    const startedAt = Date.now();
    let ttft = null, text = '';
    try {
      await generateCodeFromScreen({
        provider: providers.llm.provider,
        key: providers.llm.key,
        imageBase64: shot.base64,
        language: lang.name,
        transcript: '',
        onToken: (t) => { if (!ttft) ttft = Date.now() - startedAt; text += t; },
      });
      console.log(`  ttft=${ttft}ms total=${Date.now() - startedAt}ms`);
      check('produced a code block', /```/.test(text));
      check('read the problem off the real screen, not the overlay',
        /parenthes/i.test(text), text.slice(0, 90).replace(/\n/g, ' '));
      console.log(text.split('\n').slice(0, 6).map((l) => '  │ ' + l).join('\n') + '\n  │ …');
    } catch (err) {
      check('solve succeeded', false, err.message);
    }
  }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(fails.length ? `${fails.length} failed: ${fails.join('; ')}` : 'all live checks passed');
  app.exit(fails.length ? 1 : 0);
});
