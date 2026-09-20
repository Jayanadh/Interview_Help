'use strict';
/**
 * Drives the real overlay.html with canned answers and screenshots it, so the
 * toolbar, the language box and the code-block rendering can be checked
 * without an interview, a screen grant, or an API call.
 *
 *   npx electron scripts/selftest/ui.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODE_ANSWER = `**Remove the fewest parentheses so the string becomes valid.**

Use a stack of indices: push every \`(\`, and on each \`)\` either pop a match or
mark that \`)\` for removal. Whatever is left on the stack is unmatched too.

\`\`\`python
class Solution:
    def minRemoveToMakeValid(self, s: str) -> str:
        to_remove, stack = set(), []
        for i, ch in enumerate(s):
            if ch == '(':
                stack.append(i)
            elif ch == ')':
                stack.pop() if stack else to_remove.add(i)
        to_remove.update(stack)
        return ''.join(c for i, c in enumerate(s) if i not in to_remove)
\`\`\`

Time O(n), space O(n). Edge case: \`"))(("\` — every character is dropped and the
empty string is a valid answer.`;

const SPEECH_ANSWER = `**I cut deployment failures from 12% to under 1% by rebuilding the release pipeline around progressive rollouts.**

When I joined the platform team, we were losing a day a week to bad deploys. Every
release went to all regions at once, so one bad config took everything down.

So I rebuilt the pipeline around progressive delivery, and made rollback automatic
instead of a decision someone had to make under pressure.`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let solveClicks = 0;
  ipcMain.on('ui-solve-clicked', () => { solveClicks++; });

  const win = new BrowserWindow({
    width: 760, height: 660, show: false, frame: false, transparent: false,
    backgroundColor: '#11131a',
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.js'),
      contextIsolation: true, nodeIntegration: false,
      sandbox: false, // the stub preload requires a project file
    },
  });
  await win.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'overlay.html'));
  await sleep(500);

  const send = (channel, payload) => win.webContents.send('fake', { channel, payload });
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    const f = path.join(OUT, `${name}.png`);
    fs.writeFileSync(f, img.toPNG());
    console.log('  shot:', path.relative(process.cwd(), f));
  };
  const js = (code) => win.webContents.executeJavaScript(code);

  const fails = [];
  const check = (label, ok, detail) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) fails.push(label);
  };

  console.log('\n1. idle');
  send('status', { level: 'ok', message: 'Listening — Groq Whisper + Groq LLM' });
  await sleep(200);
  check('language box defaults to Python',
    (await js('document.getElementById("lang").value')) === 'Python');
  check('solve button present',
    await js('!!document.getElementById("solve")'));
  await shot('1-idle');

  console.log('\n2. language typing + suggestions');
  await js(`(() => { const l = document.getElementById('lang');
    l.focus(); l.value = 'ja';
    l.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  const sugg = await js(`[...document.querySelectorAll('#suggest div')].map(d => d.textContent)`);
  check('suggestions appear for "ja"', sugg.length > 0, sugg.join(', '));
  check('JavaScript is suggested', sugg.includes('JavaScript'));
  await shot('2-suggestions');

  console.log('\n3. fuzzy match echo');
  await js(`(() => { const l = document.getElementById('lang');
    l.value = 'pyhton'; l.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(200);
  check('typo echoes the corrected language',
    /Python/.test(await js('document.getElementById("langEcho").textContent')),
    await js('document.getElementById("langEcho").textContent'));
  await shot('3-typo-echo');

  console.log('\n4. streamed code answer');
  // An offscreen window never really holds focus, so .blur() alone fires
  // nothing — dispatch the event the handler actually listens for.
  await js(`document.getElementById('lang').dispatchEvent(new FocusEvent('blur'))`);
  await sleep(350);
  check('dropdown closes when the box is left',
    !(await js(`document.getElementById('suggest').classList.contains('show')`)));
  check('box rewrites itself to the matched language',
    (await js('document.getElementById("lang").value')) === 'Python',
    await js('document.getElementById("lang").value'));
  send('answer-start', { question: 'Reading your screen → Python', kind: 'code' });
  await sleep(150);
  // Stream it in chunks, the way the model actually delivers it — this is
  // what exercises the open-fence handling.
  for (let i = 0; i < CODE_ANSWER.length; i += 90) {
    send('answer-token', { text: CODE_ANSWER.slice(i, i + 90) });
    await sleep(25);
  }
  send('answer-ttft', { ms: 524 });
  send('answer-done', { ms: 1153, cached: null });
  await sleep(300);

  check('code block rendered', (await js('document.querySelectorAll(".code pre").length')) === 1);
  check('indentation preserved',
    (await js(`document.querySelector('.code code').textContent`)).includes('\n        to_remove, stack'));
  check('language tag shown',
    (await js(`document.querySelector('.code .tag')?.textContent`)) === 'python');
  check('copy button present', await js('!!document.querySelector(".code .copy")'));
  check('no giant headline on a code answer',
    (await js('document.querySelectorAll(".headline").length')) === 0);
  check('prose around the code survived',
    (await js('document.querySelectorAll(".body p").length')) >= 2);
  check('Solve re-enables once the answer lands',
    !(await js('document.getElementById("solve").disabled')));
  await shot('4-code-answer');

  console.log('\n5. mid-stream open fence');
  send('clear', {});
  send('answer-start', { question: 'Reading your screen → Python', kind: 'code' });
  send('answer-token', { text: '**Partial.**\n\n```python\ndef f(x):\n    return x' });
  await sleep(250);
  check('unterminated fence still renders as code',
    (await js('document.querySelectorAll(".code pre").length')) === 1);
  await shot('5-open-fence');

  console.log('\n6. spoken answer still looks like a spoken answer');
  send('clear', {});
  send('answer-start', { question: 'Tell me about a hard bug.', reason: 'silence' });
  send('answer-token', { text: SPEECH_ANSWER });
  send('answer-done', { ms: 692, cached: null });
  await sleep(300);
  check('headline restored for speech answers',
    (await js('document.querySelectorAll(".headline").length')) === 1);
  check('no stray code block', (await js('document.querySelectorAll(".code").length')) === 0);
  await shot('6-speech-answer');

  console.log('\n7. solve button');
  await js(`document.getElementById('solve').click()`);
  await sleep(300);
  check('clicking Solve reaches the main process', solveClicks === 1, `clicks=${solveClicks}`);

  console.log(`\n${'─'.repeat(52)}`);
  if (fails.length) {
    console.log(`${fails.length} failed: ${fails.join('; ')}`);
    app.exit(1);
  } else {
    console.log('all UI checks passed');
    app.exit(0);
  }
});
