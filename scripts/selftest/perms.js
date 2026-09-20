'use strict';
/**
 * The permission banner in all four states.
 *
 * You cannot revoke a macOS grant from code, so the only way to check that
 * "grant it once and never be nagged again" actually holds is to drive the
 * UI against a stubbed status. The states that matter:
 *
 *   granted        no banner at all, ever
 *   not-determined a Grant button that genuinely raises the prompt
 *   denied         NO Grant button — macOS will never ask again, so offering
 *                  one is what made people click it over and over
 *   needsRestart   granted already, this process is just too old to see it
 *
 *   npx electron scripts/selftest/perms.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let requested = 0, settingsOpened = 0, relaunched = 0;
  ipcMain.on('perm-requested', () => { requested++; });
  ipcMain.on('perm-settings-opened', () => { settingsOpened++; });
  ipcMain.on('perm-relaunched', () => { relaunched++; });

  const win = new BrowserWindow({
    width: 780, height: 880, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'perms-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'setup.html'));
  await sleep(400);

  const js = (code) => win.webContents.executeJavaScript(code);
  const fails = [];
  const check = (label, ok, detail) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) fails.push(label);
  };
  const shown = (id) =>
    js(`(() => { const e = document.getElementById('${id}');
        return !!e && e.style.display !== 'none'; })()`);
  const text = (id) => js(`document.getElementById('${id}').textContent`);

  async function setState(s) {
    win.webContents.send('set-state', s);
    await js('checkPermissions()');
    await sleep(120);
  }

  console.log('\n1. granted — the only acceptable behaviour is silence');
  await setState({ screen: 'granted', mic: 'granted', appName: 'Help Interview',
                   canPrompt: false, needsRestart: false });
  check('no banner', !(await shown('permBanner')));

  console.log('\n2. not-determined — a prompt is still possible');
  await setState({ screen: 'not-determined', mic: 'not-determined', appName: 'Help Interview',
                   canPrompt: true, needsRestart: false });
  check('banner shown', await shown('permBanner'));
  check('Grant button offered', await shown('grantBtn'));
  check('no Settings detour yet', !(await shown('settingsBtn')));
  check('no Restart yet', !(await shown('relaunchBtn')));

  console.log('\n3. denied — macOS will never ask again');
  await setState({ screen: 'denied', mic: 'granted', appName: 'Help Interview',
                   canPrompt: false, needsRestart: false });
  check('Grant button HIDDEN (it cannot work, and inviting clicks is the bug)',
    !(await shown('grantBtn')));
  check('Settings button offered', await shown('settingsBtn'));
  check('Restart offered', await shown('relaunchBtn'));
  check('step-by-step instructions shown', await shown('permSteps'));
  check('tells you the toggle to look for', (await text('permAppName')) === 'Help Interview');

  console.log('\n4. dev build — the list says "Electron", not the product name');
  await setState({ screen: 'denied', mic: 'granted', appName: 'Electron',
                   canPrompt: false, needsRestart: false });
  check('names the dev binary correctly', (await text('permAppName')) === 'Electron');

  console.log('\n5. granted but this process is older than the grant');
  await setState({ screen: 'denied', mic: 'granted', appName: 'Help Interview',
                   canPrompt: false, needsRestart: true });
  check('says restart, not "go and grant it again"',
    /restart/i.test(await text('permBanner')) && !(await shown('settingsBtn')),
    (await js(`document.querySelector('#permBanner strong').textContent`)));
  check('Restart is the only button', await shown('relaunchBtn'));

  console.log('\n6. back to granted — banner must disappear again');
  await setState({ screen: 'granted', mic: 'granted', appName: 'Help Interview',
                   canPrompt: false, needsRestart: false });
  check('no banner', !(await shown('permBanner')));
  check('nothing was requested behind our back', requested === 0, `requests=${requested}`);

  console.log(`\n${'─'.repeat(58)}`);
  console.log(fails.length ? `${fails.length} failed: ${fails.join('; ')}` : 'all permission states behave');
  app.exit(fails.length ? 1 : 0);
});
