'use strict';

const SAMPLE_RATE = 24000;

const $ = (id) => document.getElementById(id);
const dot = $('dot');
const statusEl = $('status');
const ttftEl = $('ttft');
const questionEl = $('question');
const heardEl = $('heard');
const answerEl = $('answer');
const langEl = $('lang');
const langEchoEl = $('langEcho');
const suggestEl = $('suggest');
const solveEl = $('solve');

// The header glyphs are baked into the HTML as macOS symbols; on Windows
// they are just noise. Swap them once at load rather than shipping two
// copies of the markup.
if (window.api.platform !== 'darwin') {
  const sk = document.querySelector('#solve .sk');
  if (sk) sk.textContent = 'Ctrl+Shift+Enter';
  for (const kbd of document.querySelectorAll('kbd')) {
    if (kbd.textContent === '⌘/Ctrl') kbd.textContent = 'Ctrl';
    if (kbd.textContent === '⏎') kbd.textContent = 'Enter';
  }
}

let scale = Number(localStorage.getItem('scale')) || 1;
document.documentElement.style.setProperty('--scale', scale);

let answerText = '';
let bodyEl = null;
let answerKind = 'speech'; // 'speech' | 'code' — changes how it is rendered

// ── Audio capture ───────────────────────────────────────────────────
/**
 * Two streams, kept separate end to end:
 *   'them' = system/loopback audio (the interviewer)
 *   'me'   = microphone (the candidate)
 *
 * Separate STT connections per channel beats one connection with speaker
 * diarization: attribution becomes structurally exact instead of a guess,
 * at the same cost.
 */
async function pipe(track, channel) {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule('pcm-worklet.js');

  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const node = new AudioWorkletNode(ctx, 'pcm-processor');

  node.port.onmessage = (e) => {
    window.api.sendAudio(channel, new Uint8Array(e.data));
  };

  // A worklet with no downstream connection may never be pulled, so route
  // it into a muted gain node. Nothing is audible; this just keeps the
  // graph running.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

async function startCapture() {
  // Interviewer — system audio.
  let sysStream;
  try {
    sysStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,      // required: loopback is only granted alongside video
      audio: true,
    });
  } catch (err) {
    const d = await window.api.diagnose();
    let hint;
    if (err.name === 'NotAllowedError') {
      hint = d.screenAccess === 'granted'
        ? 'Permission shows as granted but was refused — quit and reopen the app.'
        : 'Screen Recording is not granted. Allow it, then QUIT AND REOPEN.';
    } else if (err.name === 'NotFoundError' || d.sourceCount === 0) {
      hint = 'macOS reported no capturable screens. Screen Recording is almost certainly off.';
    } else if (err.name === 'NotReadableError') {
      hint = 'macOS refused the capture device. Try relaunching with AUDIO_BACKEND=coreaudio.';
    } else {
      hint = 'Unexpected capture failure.';
    }
    window.api.reportCaptureError(
      `${hint}  (${err.name}: ${err.message} · screen=${d.screenAccess} · sources=${d.sourceCount})`,
      err.name,
      d
    );
    return;
  }

  const [sysTrack] = sysStream.getAudioTracks();
  if (!sysTrack) {
    window.api.reportCaptureError(
      'No system audio track. The macOS loopback backend did not attach one — ' +
      'try relaunching with AUDIO_BACKEND=coreaudio.'
    );
    return;
  }

  // Video is only requested because loopback audio is granted alongside it.
  // Once the stream exists the video track is dead weight, and dropping it
  // saves a continuous screen capture running for the whole interview.
  for (const v of sysStream.getVideoTracks()) {
    v.stop();
    sysStream.removeTrack(v);
  }

  window.api.reportCaptureOk({
    label: sysTrack.label,
    settings: sysTrack.getSettings ? sysTrack.getSettings() : null,
  });
  await pipe(sysTrack, 'them');

  // Candidate — microphone.
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const [micTrack] = micStream.getAudioTracks();
    if (micTrack) await pipe(micTrack, 'me');
  } catch (err) {
    // Non-fatal: we can still hear the interviewer, which is the part
    // that actually drives answers.
    console.warn('Mic unavailable:', err.message);
  }
}

// ── Rendering ───────────────────────────────────────────────────────
function setStatus(level, message) {
  dot.className = 'dot ' + (level === 'ok' ? 'ok' : level === 'error' ? 'err' : level === 'warn' ? 'warn' : '');
  statusEl.textContent = message;
}

/**
 * Only the interviewer's most recent line, one row, dimmed. A scrolling
 * transcript would be a second thing competing for your attention; the
 * answer should be the only place worth looking.
 */
function renderTranscript({ segments, partial }) {
  const last = partial ||
    [...segments].reverse().find((x) => x.speaker === 'them')?.text || '';
  if (!last) { heardEl.className = 'heard'; return; }
  heardEl.className = 'heard show';
  heardEl.textContent = last;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Splits a partially-streamed answer into prose and fenced code.
 *
 * Streaming means the last fence is routinely still open, so an unterminated
 * ``` is treated as code that runs to the end of what has arrived. Waiting
 * for the closing fence would leave the code block invisible until the very
 * last token, which is the opposite of useful.
 */
function splitFences(text) {
  const parts = [];
  const re = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'prose', text: text.slice(last, m.index) });
    parts.push({ type: 'code', lang: m[1].trim(), text: m[2] });
    last = re.lastIndex;
    if (!m[0].endsWith('```')) break; // open fence — everything after is code
  }
  if (last < text.length) parts.push({ type: 'prose', text: text.slice(last) });
  return parts;
}

function renderCode(lang, code) {
  return (
    '<div class="code">' +
    (lang ? `<span class="tag">${escapeHtml(lang)}</span>` : '') +
    `<pre><code>${escapeHtml(code.replace(/\n+$/, ''))}</code></pre>` +
    '<button class="copy">Copy</button>' +
    '</div>'
  );
}

/**
 * Minimal markdown: first line becomes the sticky headline, blank-line
 * separated blocks become paragraphs, dash/asterisk lines become bullets,
 * fenced blocks become code.
 */
function renderAnswer(text, opts = {}) {
  let out = '';
  let headlineDone = opts.headline === false;

  for (const part of splitFences(text)) {
    if (part.type === 'code') {
      out += renderCode(part.lang, part.text);
      continue;
    }
    out += renderProse(part.text, () => headlineDone, () => { headlineDone = true; });
  }
  return out;
}

function renderProse(text, isHeadlineDone, markHeadlineDone) {
  const blocks = text.split(/\n\s*\n/);
  let out = '';

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    const bullets = lines.filter((l) => /^[-*•]\s+/.test(l));
    if (bullets.length && bullets.length === lines.length) {
      out += '<ul>' + bullets
        .map((l) => `<li>${inline(l.replace(/^[-*•]\s+/, ''))}</li>`)
        .join('') + '</ul>';
      continue;
    }

    const joined = lines.join(' ');
    if (!isHeadlineDone()) {
      out += `<span class="headline">${inline(joined.replace(/^\*\*|\*\*$/g, ''))}</span>`;
      markHeadlineDone();
    } else {
      out += `<p>${inline(joined)}</p>`;
    }
  }
  return out;
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>');
}

function paint() {
  if (!bodyEl) return;
  // The code answer already opens with its own bold restatement, so the
  // sticky-headline treatment would just duplicate it in a larger font.
  bodyEl.innerHTML = renderAnswer(answerText, { headline: answerKind !== 'code' });
}

function clearAnswer() {
  answerText = '';
  bodyEl = null;
  questionEl.textContent = '';
  answerEl.innerHTML =
    '<div class="empty">Listening.<br />' +
    '<kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> to answer on demand<br />' +
    '<kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>⏎</kbd> to read the screen and write code</div>';
  ttftEl.textContent = '';
}

function setScale(next) {
  scale = Math.min(1.6, Math.max(0.8, Number(next.toFixed(2))));
  document.documentElement.style.setProperty('--scale', scale);
  try { localStorage.setItem('scale', String(scale)); } catch {}
}

// ── Wire up ─────────────────────────────────────────────────────────
window.api.on('status', ({ level, message }) => setStatus(level, message));
window.api.on('transcript', renderTranscript);
window.api.on('clear', clearAnswer);

window.api.on('answer-start', ({ question, kind }) => {
  answerKind = kind === 'code' ? 'code' : 'speech';
  // The dropdown floats over the answer, and the keyboard shortcut can start
  // a solve while it is still open.
  hideSuggestions();
  solveEl.disabled = answerKind === 'code';
  answerText = '';
  ttftEl.textContent = '…';
  questionEl.textContent = question;
  answerEl.innerHTML = '<div class="body"><span class="cursor"></span></div>';
  bodyEl = answerEl.querySelector('.body');
  answerEl.scrollTop = 0;
});

window.api.on('scale', ({ delta }) => setScale(scale + delta));

window.api.on('answer-ttft', ({ ms }) => {
  ttftEl.textContent = `${ms}ms`;
});

window.api.on('answer-token', ({ text }) => {
  answerText += text;
  if (bodyEl) {
    bodyEl.innerHTML =
      renderAnswer(answerText, { headline: answerKind !== 'code' }) +
      '<span class="cursor"></span>';
    // Deliberately do NOT auto-scroll. The headline is the most important
    // line; yanking it off-screen mid-stream is the opposite of helpful.
  }
});

window.api.on('answer-done', ({ ms, cached }) => {
  paint();
  solveEl.disabled = false;
  const cacheNote = cached ? ` · ${cached.toLocaleString()} cached` : '';
  ttftEl.textContent = `${ms}ms${cacheNote}`;
});

window.api.on('answer-cancelled', () => {
  solveEl.disabled = false;
  if (bodyEl && !answerText) clearAnswer();
});

// ── Language box + solve button ─────────────────────────────────────
// Namespaced, not destructured: this file and languages.js share one global
// scope, so a bare `const matchLanguage` here collides with the module's own.
const Lang = window.Languages;

let suggestions = [];
let selIndex = -1;

/**
 * Shows where the typed text is heading, while it is being typed. Once the
 * box is committed it holds the canonical name itself and the echo clears —
 * otherwise it just says "Python → Python" at you.
 */
function showEcho(m) {
  if (!m.typed || m.name.toLowerCase() === m.typed.toLowerCase()) {
    langEchoEl.textContent = '';
    langEchoEl.className = '';
    return;
  }
  langEchoEl.textContent = `→ ${m.name}`;
  // Amber for a guess, green for a name we recognise outright.
  langEchoEl.className = m.exact ? '' : 'guess';
}

function renderSuggestions() {
  if (!suggestions.length) { suggestEl.className = ''; return; }
  suggestEl.className = 'show';
  suggestEl.innerHTML = suggestions
    .map((n, i) => `<div class="${i === selIndex ? 'sel' : ''}">${escapeHtml(n)}</div>`)
    .join('');
}

function hideSuggestions() {
  suggestions = [];
  selIndex = -1;
  suggestEl.className = '';
}

async function commitLanguage(value) {
  hideSuggestions();
  const m = await window.api.setLanguage(value);
  // Rewrite the box to what the model will actually be told. Showing the
  // typo back while quietly sending something else is the one thing this
  // control must not do.
  langEl.value = m.name;
  showEcho({ ...m, typed: m.name });
  try { localStorage.setItem('language', m.name); } catch {}
}

langEl.addEventListener('input', () => {
  const v = langEl.value;
  showEcho(Lang.matchLanguage(v));
  suggestions = v.trim() ? Lang.suggestLanguages(v, 6) : [];
  selIndex = -1;
  renderSuggestions();
});

langEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!suggestions.length) return;
    e.preventDefault();
    selIndex = (selIndex + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    commitLanguage(selIndex >= 0 ? suggestions[selIndex] : langEl.value);
    langEl.blur();
  } else if (e.key === 'Escape') {
    hideSuggestions();
    langEl.blur();
  }
});

langEl.addEventListener('blur', () => {
  // Late enough for a click on a suggestion to land first.
  setTimeout(() => { hideSuggestions(); commitLanguage(langEl.value); }, 140);
});

suggestEl.addEventListener('mousedown', (e) => {
  const row = e.target.closest('div');
  if (row) { e.preventDefault(); commitLanguage(row.textContent); }
});

solveEl.addEventListener('click', () => solve());

async function solve() {
  solveEl.disabled = true;
  const res = await window.api.solveScreen({});
  // answer-done re-enables on the happy path; this covers the failures that
  // never produce an answer at all (no permission, rate limit, no provider).
  if (!res || !res.ok) solveEl.disabled = false;
}

// Copy button on any code block, however it got there.
answerEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy');
  if (!btn) return;
  const code = btn.parentElement.querySelector('code');
  navigator.clipboard.writeText(code.textContent).then(() => {
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  });
});

(async () => {
  let initial = '';
  try { initial = localStorage.getItem('language') || ''; } catch {}
  const m = initial
    ? await window.api.setLanguage(initial)
    : await window.api.getLanguage();
  langEl.value = m.name;
  showEcho({ ...m, typed: m.name });
})();

startCapture();
