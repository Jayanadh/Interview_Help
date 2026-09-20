'use strict';

const {
  app, BrowserWindow, session, desktopCapturer,
  ipcMain, globalShortcut, dialog, screen, systemPreferences, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');

// Capture failures are silent by nature — the OS hands back an empty stream
// rather than an error. Everything diagnostic goes to a file so problems can
// be read after the fact instead of guessed at.
let logPath = null;
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try {
    if (!logPath) logPath = path.join(app.getPath('userData'), 'debug.log');
    fs.appendFileSync(logPath, line + '\n');
  } catch { /* logging must never break the app */ }
}

const {
  resolveProviders, classifyKey, saveSettings, loadSettings, TUNING,
} = require('./config');
const { createTranscriber } = require('./stt');
const { TriggerEngine } = require('./trigger');
const { generateAnswer, generateCodeFromScreen } = require('./assist');
const { captureScreen } = require('./screen');
const { matchLanguage } = require('../shared/languages');
const {
  extractResume, buildSystemPrompt, buildContextBlock, estimateTokens,
} = require('./context');

const IS_MAC = process.platform === 'darwin';

/**
 * Media-permission status, everywhere.
 *
 * Only macOS gates screen capture behind a consent dialog. On Windows and
 * Linux `desktopCapturer` and WASAPI loopback just work, and Electron's
 * `getMediaAccessStatus`/`askForMediaAccess` are macOS APIs — calling them
 * elsewhere is at best meaningless and at worst throws. Report 'granted' off
 * macOS so every caller can treat permission as a solved problem there.
 */
function mediaStatus(kind) {
  if (!IS_MAC) return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus(kind);
  } catch (err) {
    log('getMediaAccessStatus failed:', kind, (err && err.message) || String(err));
    return 'unknown';
  }
}

/**
 * macOS system-audio capture is gated behind Chromium feature flags.
 *
 * Electron's own typings say loopback audio is "currently only supported on
 * Windows" — that is true of the DEFAULT build. On macOS the capability
 * exists but stays dark unless these flags are set, and they must be set
 * before the app is ready, hence the placement at module top level.
 *
 * Two backends can provide it. ScreenCaptureKit is the default; Core Audio
 * Tap (macOS 14.4+) is the newer path. If one yields a silent or missing
 * track, the other usually works — set AUDIO_BACKEND=coreaudio to switch.
 */
function enableMacLoopbackFlags() {
  if (process.platform !== 'darwin') return;

  const KEY = 'enable-features';
  const existing = app.commandLine.getSwitchValue(KEY);
  if (app.commandLine.hasSwitch(KEY)) app.commandLine.removeSwitch(KEY);

  const backend = (process.env.AUDIO_BACKEND || 'screencapturekit').toLowerCase();
  const flags = new Set([
    ...(existing ? existing.split(',').filter(Boolean) : []),
    'MacLoopbackAudioForScreenShare',
    backend === 'coreaudio'
      ? 'MacCatapSystemAudioLoopbackCapture'
      : 'MacSckSystemAudioLoopbackOverride',
  ]);

  app.commandLine.appendSwitch(KEY, [...flags].join(','));
  console.log(`[audio] macOS loopback backend: ${backend}`);
}

enableMacLoopbackFlags();

let setupWin = null;
let overlayWin = null;

const state = {
  providers: null,
  systemPrompt: buildSystemPrompt(),
  contextBlock: '',
  trigger: null,
  sttThem: null,
  sttMe: null,
  abort: null,
  running: false,
  style: (process.env.ANSWER_STYLE || 'full').toLowerCase(),
  // Language the screen-solver writes in. Set from the overlay, mid-interview.
  language: TUNING.defaultLanguage,
  solving: false,
};

// ── System audio capture ────────────────────────────────────────────
// macOS: loopback is only wired up when Electron's own picker drives the
//   capture end-to-end. With a custom picker the request is accepted and
//   then silently delivers nothing.
// Windows: WASAPI loopback, no system picker exists — pick the source here.
function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (!sources.length) {
            log('[audio] no capturable screens — Screen Recording likely denied');
            return callback({});
          }
          log('[audio] granting source:', sources[0].name, '+ loopback audio');
          callback({ video: sources[0], audio: 'loopback' });
        })
        .catch((err) => {
          log('[audio] desktopCapturer failed:', err.message);
          callback({});
        });
    },
    // MUST stay false. With the native system picker the handler is never
    // invoked at all, so `audio: 'loopback'` is never applied and the
    // resulting stream silently arrives with no audio track.
    { useSystemPicker: false }
  );
}

// ── Windows ─────────────────────────────────────────────────────────
function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 780,
    height: 880,
    title: 'Help_Interview — Setup',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWin.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));
  setupWin.on('closed', () => { setupWin = null; });
}

function createOverlayWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  // Big enough to hold a complete spoken answer without scrolling, and
  // centred so there is one obvious place to look.
  const width = Math.min(760, Math.round(workArea.width * 0.55));
  const height = Math.min(660, Math.round(workArea.height * 0.68));

  overlayWin = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    minWidth: 420,
    minHeight: 320,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWin.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') {
    overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenScreens: true });
  }
  overlayWin.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  overlayWin.on('closed', () => { overlayWin = null; });
}

function toOverlay(channel, payload) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send(channel, payload);
  }
}

// ── Session lifecycle ───────────────────────────────────────────────
function startSession() {
  const { stt } = state.providers;

  state.trigger = new TriggerEngine();

  state.sttThem = createTranscriber({ ...stt, label: 'them' });
  state.sttMe = createTranscriber({ ...stt, label: 'me' });

  state.sttThem.on('partial', ({ text }) => state.trigger.onTheirPartial(text));
  state.sttThem.on('final', ({ text }) => state.trigger.onTheirFinal(text));
  state.sttThem.on('utteranceEnd', () => state.trigger.onTheirUtteranceEnd());
  state.sttThem.on('error', (e) => toOverlay('status', { level: 'error', message: `Transcription: ${e.message}` }));

  state.sttMe.on('final', ({ text }) => state.trigger.onMyFinal(text));
  state.sttMe.on('error', (e) => console.warn('[stt:me]', e.message));

  state.trigger.on('transcript', (snap) => toOverlay('transcript', snap));
  state.trigger.on('cancel', () => {
    // A spoken answer is stale the moment they start talking again. A screen
    // solve is not — you asked for it explicitly, and an interviewer saying
    // "take your time" should not throw the code away.
    if (state.solving) return;
    if (state.abort) {
      state.abort.abort();
      state.abort = null;
      toOverlay('answer-cancelled', {});
    }
  });
  state.trigger.on('question', (payload) => handleQuestion(payload));

  state.sttThem.connect();
  state.sttMe.connect();
  state.running = true;

  toOverlay('status', {
    level: 'ok',
    message: `Listening — ${state.providers.note}`,
  });
}

async function handleQuestion({ question, transcript, reason }) {
  // You pressed a button and asked for the screen. A question the heuristics
  // spotted in the meantime does not get to throw that away.
  if (state.solving) {
    log('QUESTION skipped — screen solve in flight:', question.slice(0, 60));
    state.trigger?.answerFinished();
    return;
  }
  if (state.abort) state.abort.abort();
  const controller = new AbortController();
  state.abort = controller;

  const startedAt = Date.now();
  let firstTokenAt = null;

  toOverlay('answer-start', { question, reason });

  try {
    const usage = await generateAnswer({
      provider: state.providers.llm.provider,
      key: state.providers.llm.key,
      systemPrompt: buildSystemPrompt(state.style),
      style: state.style,
      contextBlock: state.contextBlock,
      transcript,
      question,
      signal: controller.signal,
      onToken: (t) => {
        if (!firstTokenAt) {
          firstTokenAt = Date.now();
          toOverlay('answer-ttft', { ms: firstTokenAt - startedAt });
        }
        toOverlay('answer-token', { text: t });
      },
    });

    toOverlay('answer-done', {
      ms: Date.now() - startedAt,
      cached: usage?.cache_read_input_tokens ?? null,
    });
  } catch (err) {
    if (controller.signal.aborted) return;
    toOverlay('status', { level: 'error', message: `Answer failed: ${err.message}` });
  } finally {
    if (state.abort === controller) state.abort = null;
    state.trigger?.answerFinished();
  }
}

/**
 * Screenshot -> code, on demand.
 *
 * Shares the overlay's answer channels with handleQuestion, and the same
 * abort controller: the two are mutually exclusive by construction, because
 * you cannot read a spoken answer and a code block at the same time anyway.
 */
async function handleSolveScreen({ hint } = {}) {
  // Nowhere to render an answer means no reason to spend a screenshot on one.
  if (!overlayWin || overlayWin.isDestroyed()) {
    log('SOLVE-SCREEN ignored — no overlay, session not started');
    return { ok: false, error: 'Start a session first.' };
  }
  if (!state.providers) state.providers = resolveProviders();
  if (state.providers.mode === 'error' || state.providers.mode === 'needs-key') {
    toOverlay('status', { level: 'error', message: state.providers.error });
    return { ok: false, error: state.providers.error };
  }
  if (state.solving) return { ok: false, error: 'Already reading the screen.' };

  const language = state.language;

  if (state.abort) state.abort.abort();
  const controller = new AbortController();
  state.abort = controller;
  state.solving = true;

  const startedAt = Date.now();
  let firstTokenAt = null;

  toOverlay('answer-start', {
    question: `Reading your screen → ${language}`,
    reason: 'screen',
    kind: 'code',
  });

  try {
    const shot = await captureScreen({ hide: [overlayWin] });
    if (controller.signal.aborted) return { ok: false, error: 'cancelled' };

    log('SOLVE-SCREEN', `${shot.width}x${shot.height}`, shot.sourceName, '->', language);
    toOverlay('status', { level: 'ok', message: `Read ${shot.width}×${shot.height} screen — solving in ${language}` });

    const usage = await generateCodeFromScreen({
      provider: state.providers.llm.provider,
      key: state.providers.llm.key,
      imageBase64: shot.base64,
      language,
      hint,
      transcript: state.trigger ? state.trigger.transcriptWindow() : '',
      signal: controller.signal,
      onToken: (t) => {
        if (!firstTokenAt) {
          firstTokenAt = Date.now();
          toOverlay('answer-ttft', { ms: firstTokenAt - startedAt });
        }
        toOverlay('answer-token', { text: t });
      },
    });

    toOverlay('answer-done', {
      ms: Date.now() - startedAt,
      cached: usage?.cache_read_input_tokens ?? null,
    });
    return { ok: true };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, error: 'cancelled' };
    const message = (err && err.message) || String(err);
    log('SOLVE-SCREEN-ERROR', message);
    toOverlay('status', { level: 'error', message });
    // The status bar is one truncated line, and these messages are the ones
    // that actually tell you how to fix something. Put them where they can
    // be read — answer-start already cleared the panel for us.
    toOverlay('answer-token', { text: `**Could not read the screen.**\n\n${message}` });
    toOverlay('answer-done', { ms: Date.now() - startedAt, cached: null });
    return { ok: false, error: message };
  } finally {
    state.solving = false;
    if (state.abort === controller) state.abort = null;
  }
}

function stopSession() {
  state.abort?.abort();
  state.abort = null;
  state.sttThem?.close();
  state.sttMe?.close();
  state.sttThem = null;
  state.sttMe = null;
  state.trigger?.reset();
  state.running = false;
}

// ── IPC ─────────────────────────────────────────────────────────────
function installIpc() {
  ipcMain.handle('check-providers', () => {
    state.providers = resolveProviders();
    return {
      mode: state.providers.mode,
      note: state.providers.note || null,
      error: state.providers.error || null,
    };
  });

  ipcMain.handle('save-key', (_e, raw) => {
    const { name, error } = classifyKey(raw);
    if (error) return { ok: false, error };

    if (!saveSettings({ [name]: String(raw).trim() })) {
      return { ok: false, error: 'Could not write the settings file.' };
    }

    state.providers = resolveProviders();
    return {
      ok: true,
      provider: name.replace('_API_KEY', '').toLowerCase(),
      mode: state.providers.mode,
      note: state.providers.note || null,
      error: state.providers.error || null,
    };
  });

  ipcMain.handle('pick-resume', async () => {
    const res = await dialog.showOpenDialog(setupWin, {
      title: 'Select your resume',
      properties: ['openFile'],
      filters: [{ name: 'Resume', extensions: ['pdf', 'txt', 'md'] }],
    });
    if (res.canceled || !res.filePaths.length) return null;

    const filePath = res.filePaths[0];
    try {
      const text = await extractResume(filePath);
      return {
        name: path.basename(filePath),
        chars: text.length,
        text,
      };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('start-session', (_e, setup) => {
    state.providers = resolveProviders();
    if (state.providers.mode === 'error') {
      return { ok: false, error: state.providers.error };
    }

    state.contextBlock = buildContextBlock(setup);
    const tokens = estimateTokens(state.systemPrompt) + estimateTokens(state.contextBlock);

    createOverlayWindow();
    overlayWin.webContents.once('did-finish-load', () => startSession());

    if (setupWin && !setupWin.isDestroyed()) setupWin.hide();

    return { ok: true, contextTokens: tokens };
  });

  ipcMain.handle('stop-session', () => {
    stopSession();
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
    if (setupWin && !setupWin.isDestroyed()) setupWin.show();
    return { ok: true };
  });

  // Renderer captured audio -> route to the right transcriber.
  ipcMain.on('audio-chunk', (_e, { channel, data }) => {
    if (!state.running) return;
    const buf = Buffer.from(data);
    if (channel === 'them') state.sttThem?.send(buf);
    else state.sttMe?.send(buf);
  });

  ipcMain.handle('solve-screen', (_e, payload) => handleSolveScreen(payload || {}));

  // The overlay owns the language box; main owns the value the model sees.
  ipcMain.handle('set-language', (_e, raw) => {
    const m = matchLanguage(raw);
    state.language = m.name;
    saveSettings({ CODE_LANGUAGE: m.name });
    return m;
  });

  ipcMain.handle('get-language', () => matchLanguage(state.language));

  ipcMain.on('overlay-resize', (_e, { height }) => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      const [w] = overlayWin.getSize();
      overlayWin.setSize(w, Math.min(Math.max(height, 200), 900));
    }
  });

  ipcMain.on('capture-error', (_e, { message, name, detail }) => {
    log('CAPTURE-ERROR', name || '', message, detail ? JSON.stringify(detail) : '');
    toOverlay('status', { level: 'error', message });
  });

  ipcMain.on('capture-ok', (_e, info) => {
    log('CAPTURE-OK', JSON.stringify(info));
  });

  ipcMain.handle('diagnose', async () => {
    const screenAccess = mediaStatus('screen');
    const micAccess = mediaStatus('microphone');
    let sources = [];
    try {
      sources = (await desktopCapturer.getSources({ types: ['screen'] }))
        .map((s) => ({ id: s.id, name: s.name }));
    } catch (err) {
      log('DIAGNOSE getSources failed:', err.message);
    }
    const info = {
      screenAccess, micAccess,
      sourceCount: sources.length,
      sources,
      backend: process.env.AUDIO_BACKEND || 'screencapturekit',
      features: app.commandLine.getSwitchValue('enable-features'),
      platform: process.platform,
      logPath,
    };
    log('DIAGNOSE', JSON.stringify(info));
    return info;
  });

  /**
   * Screen Recording has three states that matter, and conflating them is
   * why this used to be so miserable:
   *
   *   not-determined  macOS has never asked. Requesting raises the prompt.
   *   denied          macOS asked once and was refused. It will NEVER ask
   *                   again — requesting silently fails forever. Only the
   *                   System Settings toggle works, and only after a restart.
   *   granted         done. Nothing should ever nag again.
   *
   * `canPrompt` is the bit the UI actually needs: it decides whether to offer
   * a button that works or instructions that do.
   */
  ipcMain.handle('screen-status', () => {
    const screen = mediaStatus('screen');
    const mic = mediaStatus('microphone');

    // Remember the grant so a later hiccup reading the status does not put
    // the banner back in front of someone who already sorted this out.
    if (screen === 'granted') saveSettings({ screenGranted: true });

    return {
      screen,
      mic,
      // What the row is actually called in System Settings. In development
      // you are running Electron's binary, so the list says "Electron" and
      // hunting for "Help Interview" finds nothing — worth being explicit
      // about rather than making people guess.
      appName: app.isPackaged ? app.getName() : 'Electron',
      canPrompt: screen === 'not-determined',
      // A grant only takes effect in a process started after it, so if we
      // have ever seen it granted and now do not, a restart is all that is
      // missing — not another trip to System Settings.
      needsRestart: screen !== 'granted' && loadSettings().screenGranted === true,
    };
  });

  // Asking desktopCapturer for sources is what actually makes macOS raise the
  // Screen Recording prompt. There is no direct "request" API for it.
  ipcMain.handle('request-screen-access', async () => {
    const before = mediaStatus('screen');

    // Only worth attempting when a prompt can still appear. Calling this on
    // 'denied' just fails, and repeated clicks produced nothing but log
    // noise and the impression that the button was broken.
    if (before === 'not-determined') {
      try {
        await desktopCapturer.getSources({ types: ['screen'] });
      } catch (err) {
        log('request-screen-access failed:',
            (err && err.message) || String(err) || '(no detail)');
      }
    }

    // askForMediaAccess is macOS-only; on Windows Chromium raises its own
    // prompt at getUserMedia time, which is the right moment anyway.
    if (IS_MAC && mediaStatus('microphone') === 'not-determined') {
      try {
        await systemPreferences.askForMediaAccess('microphone');
      } catch { /* mic is optional */ }
    }

    const after = mediaStatus('screen');
    log('request-screen-access:', before, '->', after);
    if (after === 'granted') saveSettings({ screenGranted: true });
    return { before, after, canPrompt: before === 'not-determined' };
  });

  ipcMain.handle('relaunch', () => {
    log('relaunching to apply permissions');
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('open-screen-settings', () => {
    // Windows has no equivalent pane to send anyone to, and nothing there
    // should be asking for this in the first place.
    if (!IS_MAC) return false;
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    );
    return true;
  });
}

function installShortcuts() {
  // register() returns false when something else already owns the combo, and
  // a silently dead hotkey is indistinguishable from a broken feature.
  const register = (accel, fn) => {
    if (!globalShortcut.register(accel, fn)) {
      log('SHORTCUT-TAKEN', accel, '— another app already owns it');
    }
  };

  register('CommandOrControl+Shift+Space', () => {
    if (state.trigger && !state.trigger.forceTrigger()) {
      toOverlay('status', { level: 'warn', message: 'Nothing heard yet to answer.' });
    }
  });

  register('CommandOrControl+Shift+H', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    overlayWin.isVisible() ? overlayWin.hide() : overlayWin.show();
  });

  register('CommandOrControl+Shift+X', () => {
    toOverlay('clear', {});
  });

  // Text size — everyone's comfortable glance distance is different.
  register('CommandOrControl+Shift+Up', () => {
    toOverlay('scale', { delta: 0.1 });
  });
  register('CommandOrControl+Shift+Down', () => {
    toOverlay('scale', { delta: -0.1 });
  });

  // Screen -> code. Return rather than a letter: every letter worth having
  // is already taken by the editor or the meeting app underneath.
  register('CommandOrControl+Shift+Return', () => {
    handleSolveScreen({});
  });

  // Toggle between a full spoken answer and a quick bullet summary.
  register('CommandOrControl+Shift+B', () => {
    state.style = state.style === 'full' ? 'brief' : 'full';
    toOverlay('status', {
      level: 'ok',
      message: `Answer style: ${state.style === 'full' ? 'full answer' : 'brief bullets'}`,
    });
  });
}

// ── Boot ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  log('--- app start ---');
  log('platform:', process.platform);
  log('screen access:', mediaStatus('screen'));
  log('mic access:', mediaStatus('microphone'));
  log('features:', app.commandLine.getSwitchValue('enable-features'));

  const saved = loadSettings();
  if (saved.CODE_LANGUAGE) state.language = matchLanguage(saved.CODE_LANGUAGE).name;
  log('code language:', state.language);

  installDisplayMediaHandler();
  installIpc();
  installShortcuts();
  createSetupWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createSetupWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopSession();
});
