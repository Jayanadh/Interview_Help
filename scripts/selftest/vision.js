'use strict';
/**
 * Checks the screen → code path without needing Screen Recording permission:
 * a fake coding-problem page is rendered off-screen and captured with
 * capturePage, which produces the same kind of PNG desktopCapturer would,
 * then pushed through the real generateCodeFromScreen for several languages.
 *
 *   npx electron scripts/selftest/vision.js [lang ...]
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { resolveProviders } = require('../../src/main/config');
const { generateCodeFromScreen } = require('../../src/main/assist');
const { matchLanguage } = require('../../src/shared/languages');
const { MAX_EDGE } = require('../../src/main/screen');

const LANGS = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const TESTS = LANGS.length ? LANGS : ['python', 'cpp', 'golang'];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const providers = resolveProviders();
  if (providers.mode === 'error' || providers.mode === 'needs-key') {
    console.error('No usable provider:', providers.error);
    return app.exit(1);
  }
  console.log(`provider: ${providers.note}\n`);

  const win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    webPreferences: { offscreen: false },
  });
  await win.loadFile(path.join(__dirname, 'problem.html'));
  await new Promise((r) => setTimeout(r, 400));

  const shot = await win.webContents.capturePage();
  // Downscale exactly as screen.js does, so this measures the real payload.
  const raw = shot.getSize();
  const k = MAX_EDGE / Math.max(raw.width, raw.height);
  const image = k < 1
    ? shot.resize({ width: Math.round(raw.width * k), height: Math.round(raw.height * k) })
    : shot;
  const png = image.toPNG();
  const out = path.join(__dirname, 'captured.png');
  fs.writeFileSync(out, png);
  const { width, height } = image.getSize();
  console.log(`captured ${width}x${height}, ${(png.length / 1024).toFixed(0)}KB -> ${out}\n`);

  let failures = 0;
  let first = true;

  for (const rawLang of TESTS) {
    // The free Groq tier allows ~7000 input tokens/min and a screenshot is
    // ~2400 of them. Space the calls out rather than measuring 429s.
    if (!first) await new Promise((r) => setTimeout(r, 22000));
    first = false;
    const raw = rawLang;
    const m = matchLanguage(raw);
    console.log(`${'─'.repeat(64)}\ntyped "${raw}"  →  ${m.name}  (exact=${m.exact} conf=${m.confidence})`);

    const startedAt = Date.now();
    let ttft = null;
    let text = '';

    try {
      await generateCodeFromScreen({
        provider: providers.llm.provider,
        key: providers.llm.key,
        imageBase64: png.toString('base64'),
        language: m.name,
        transcript: 'INTERVIEWER: Go ahead and take a look at the problem on the screen.',
        onToken: (t) => { if (!ttft) ttft = Date.now() - startedAt; text += t; },
      });
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      failures++;
      continue;
    }

    const fenced = /```/.test(text);
    console.log(`  ttft=${ttft}ms total=${Date.now() - startedAt}ms chars=${text.length} fenced=${fenced}`);
    console.log(text.split('\n').map((l) => '  │ ' + l).join('\n'));
    if (!fenced) { console.error('  FAILED: no code block in the answer'); failures++; }
  }

  console.log(`\n${'─'.repeat(64)}\n${TESTS.length - failures}/${TESTS.length} languages produced code.`);
  app.exit(failures ? 1 : 0);
});
