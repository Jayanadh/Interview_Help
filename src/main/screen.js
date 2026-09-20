'use strict';

const { desktopCapturer, screen, systemPreferences, nativeImage } = require('electron');
const fs = require('fs');

/**
 * One-shot screen grab for the "solve what's on my screen" button.
 *
 * Deliberately NOT the video track from the audio pipeline. That track is
 * stopped immediately after capture starts (see overlay.js) precisely so a
 * continuous screen recording is not running for the whole interview — and
 * reviving it for the occasional screenshot would undo that. desktopCapturer
 * takes a single frame on demand, using the Screen Recording permission the
 * app already holds for audio.
 */

// Long side cap. Big enough that 11pt code in a browser stays legible after
// downscaling, small enough to stay well inside every provider's image limit.
const MAX_EDGE = 1600;

// Only macOS gates screen capture. Elsewhere a failure here is a real
// failure, not a missing checkbox, so do not send people to a settings pane
// that has nothing to do with it.
const NEEDS_PERMISSION = process.platform === 'darwin'
  ? 'Screen Recording is not granted, so there is nothing to read. Turn it on in ' +
    'System Settings → Privacy & Security → Screen Recording, then QUIT AND ' +
    'REOPEN the app — macOS does not apply a fresh grant to a running process.'
  : 'Could not capture the screen. No display was available to read.';

/**
 * desktopCapturer rejects with a bare string, not an Error, so `err.message`
 * on the caller's side is undefined and the user sees "failed: undefined".
 * Everything leaving this module is a real Error with a real message.
 */
function asError(err, fallback) {
  if (err instanceof Error) return err;
  const detail = typeof err === 'string' ? err : String(err && err.message || err);
  return new Error(`${fallback} (${detail})`);
}

function fit(width, height) {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE) return { width, height };
  const k = MAX_EDGE / longest;
  return { width: Math.round(width * k), height: Math.round(height * k) };
}

/**
 * Captures the display the pointer is on, as a base64 PNG.
 *
 * `hide` is a list of BrowserWindows to take off screen for the duration.
 * The overlay is always-on-top, so without this the model reads its own
 * previous answer back instead of the interview problem.
 */
async function captureScreen({ hide = [] } = {}) {
  // Dev escape hatch: stand a PNG in for the display. Screen Recording is a
  // manual, non-scriptable grant, so without this there is no way to exercise
  // the button end to end on a machine that has not been given it.
  //   SCREEN_FIXTURE=scripts/selftest/captured.png npm start
  if (process.env.SCREEN_FIXTURE) {
    const file = process.env.SCREEN_FIXTURE;
    if (!fs.existsSync(file)) {
      throw new Error(`SCREEN_FIXTURE points at a file that does not exist: ${file}`);
    }
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) throw new Error(`SCREEN_FIXTURE is not a readable image: ${file}`);

    const raw = img.getSize();
    const target = fit(raw.width, raw.height);
    const scaled = (target.width !== raw.width) ? img.resize(target) : img;
    const size = scaled.getSize();
    console.warn(`[screen] FIXTURE MODE — reading ${file} instead of the display`);
    return {
      base64: scaled.toPNG().toString('base64'),
      width: size.width,
      height: size.height,
      sourceName: `fixture:${require('path').basename(file)}`,
      fixture: true,
    };
  }

  const hidden = [];
  for (const win of hide) {
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.hide();
      hidden.push(win);
    }
  }

  // One frame for the compositor to actually drop the windows before the
  // grab. Without it the overlay is still in the captured frame.
  if (hidden.length) await new Promise((r) => setTimeout(r, 120));

  try {
    // Check first rather than interpreting the failure afterwards: a denied
    // grant and a genuinely broken capture produce the same opaque rejection.
    if (
      process.platform === 'darwin' &&
      systemPreferences.getMediaAccessStatus('screen') !== 'granted'
    ) {
      throw new Error(NEEDS_PERMISSION);
    }

    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const { width, height } = display.size;
    const scale = display.scaleFactor || 1;

    let sources;
    try {
      sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: fit(width * scale, height * scale),
        fetchWindowIcons: false,
      });
    } catch (err) {
      throw asError(err, NEEDS_PERMISSION);
    }

    if (!sources.length) throw new Error(NEEDS_PERMISSION);

    // display_id is a string on some platforms and empty on others; fall back
    // to the first screen rather than failing over an id mismatch.
    const match = sources.find(
      (s) => String(s.display_id) === String(display.id)
    ) || sources[0];

    const image = match.thumbnail;
    if (!image || image.isEmpty()) {
      throw new Error(
        'The captured frame was empty — this is what a revoked Screen Recording ' +
        'grant looks like. Re-grant it, then quit and reopen.'
      );
    }

    const size = image.getSize();
    return {
      base64: image.toPNG().toString('base64'),
      width: size.width,
      height: size.height,
      sourceName: match.name,
    };
  } finally {
    for (const win of hidden) {
      if (win && !win.isDestroyed()) win.showInactive();
    }
  }
}

module.exports = { captureScreen, MAX_EDGE, NEEDS_PERMISSION };
