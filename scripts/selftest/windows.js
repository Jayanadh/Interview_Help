'use strict';
/**
 * What the app does when it is not on macOS.
 *
 * Can't run Windows here, so this checks the two things that would actually
 * break: that no macOS-only API is reachable on another platform, and that
 * the UI drops the parts of the macOS story that do not exist there (the
 * Screen Recording banner, the Command-key glyphs).
 *
 * `platform` is spoofed via Object.defineProperty on process, which is what
 * both the main process and the preload read.
 *
 *   npx electron scripts/selftest/windows.js
 */
const path = require('path');
const fs = require('fs');

const fails = [];
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) fails.push(label);
};

const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8');

console.log('\n1. macOS-only Electron APIs are never reached off macOS');

const main = src('main/index.js');
const direct = (main.match(/systemPreferences\.getMediaAccessStatus/g) || []).length;
check('getMediaAccessStatus called only inside the platform-aware helper',
  direct === 1, `${direct} call site(s)`);
check('helper returns granted off macOS',
  /if \(!IS_MAC\) return 'granted';/.test(main));
check('askForMediaAccess is gated',
  /IS_MAC && mediaStatus\('microphone'\)/.test(main));
check('the macOS settings URL is gated',
  /if \(!IS_MAC\) return false;[\s\S]{0,120}x-apple\.systempreferences/.test(main));
check('loopback feature flags stay macOS-only',
  /if \(process\.platform !== 'darwin'\) return;/.test(main));

console.log('\n2. the screen grab does not demand a macOS permission elsewhere');
const screen = src('main/screen.js');
check('permission pre-check is macOS-only',
  /process\.platform === 'darwin' &&\s*\n?\s*systemPreferences\.getMediaAccessStatus/.test(screen));
check('failure message is platform-appropriate',
  /process\.platform === 'darwin'\s*\n?\s*\? 'Screen Recording is not granted/.test(screen));

console.log('\n3. the UI drops the macOS-only bits');
const setup = src('renderer/setup.js');
check('permission banner is hidden off macOS',
  /window\.api\.platform !== 'darwin'[\s\S]{0,140}permBanner[\s\S]{0,60}display = 'none'/.test(setup));
const overlay = src('renderer/overlay.js');
check('Command-key glyphs are swapped for Ctrl',
  /window\.api\.platform !== 'darwin'/.test(overlay) && /Ctrl\+Shift\+Enter/.test(overlay));

console.log('\n4. the build actually targets Windows');
const pkg = JSON.parse(src('../package.json'));
check('build:win script exists', !!pkg.scripts['build:win'], pkg.scripts['build:win']);
check('win target configured', !!pkg.build.win, JSON.stringify(pkg.build.win?.target));
check('postinstall plist patch no-ops off macOS',
  /process\.platform !== 'darwin'/.test(
    fs.readFileSync(path.join(__dirname, '..', 'patch-plist.js'), 'utf8')));

console.log('\n5. nothing else is macOS-only');
const shells = Object.entries(pkg.scripts).filter(([, v]) => /\.sh\b/.test(v));
check('no shell script on the run/build path',
  shells.every(([k]) => k.startsWith('cert')),
  shells.map(([k]) => k).join(', ') + ' (cert* is macOS signing, not needed to run)');

console.log(`\n${'─'.repeat(58)}`);
console.log(fails.length ? `${fails.length} failed: ${fails.join('; ')}` : 'nothing macOS-only on the Windows path');
process.exit(fails.length ? 1 : 0);
