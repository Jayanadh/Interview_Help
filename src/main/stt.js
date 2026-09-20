'use strict';

const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { MODELS, TUNING } = require('./config');

const SPEECH_RMS = Number(process.env.SPEECH_RMS) || 450;
const MAX_CHUNK_MS = 20000;

/**
 * Streaming speech-to-text, normalised across providers.
 *
 * Whichever provider is behind it, a Transcriber emits the same three
 * events so nothing downstream has to care:
 *
 *   'partial'      { text }          interim, overwrites the previous partial
 *   'final'        { text }          committed segment, append it
 *   'utteranceEnd' {}                speaker appears to have stopped
 *   'error'        Error
 *
 * Audio in is always 24 kHz mono PCM16 (OpenAI's required rate; Deepgram
 * happily takes it too, so we run one capture pipeline for both).
 */

const SAMPLE_RATE = 24000;

class Transcriber extends EventEmitter {
  constructor({ provider, key, label }) {
    super();
    this.provider = provider;
    this.key = key;
    this.label = label; // 'them' or 'me' — for logging only
    this.ws = null;
    this.ready = false;
    this.queue = [];
    this.closed = false;
  }

  connect() {
    return this.provider === 'deepgram'
      ? this._connectDeepgram()
      : this._connectOpenAI();
  }

  _flush() {
    this.ready = true;
    for (const chunk of this.queue) this._rawSend(chunk);
    this.queue = [];
  }

  /** Accepts a Buffer/Uint8Array of 24 kHz mono PCM16. */
  send(pcm) {
    if (this.closed) return;
    if (!this.ready) {
      // Bound the pre-connect buffer so a failed handshake can't grow forever.
      if (this.queue.length < 100) this.queue.push(pcm);
      return;
    }
    this._rawSend(pcm);
  }

  _rawSend(pcm) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.provider === 'deepgram') {
      this.ws.send(pcm);
    } else {
      this.ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: Buffer.from(pcm).toString('base64'),
      }));
    }
  }

  close() {
    this.closed = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        if (this.provider === 'deepgram') {
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
      } catch { /* already gone */ }
      this.ws.close();
    }
    this.ws = null;
  }

  // ── Deepgram ──────────────────────────────────────────────────────
  _connectDeepgram() {
    // utterance_end_ms has a hard 1000ms floor and requires interim_results.
    // Our own faster silence timer in trigger.js sits on top of this; this
    // is the reliable backstop, not the fast path.
    const params = new URLSearchParams({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: String(SAMPLE_RATE),
      channels: '1',
      interim_results: 'true',
      utterance_end_ms: String(Math.max(1000, TUNING.silenceMs)),
      vad_events: 'true',
      punctuate: 'true',
      smart_format: 'true',
      endpointing: '300',
    });

    const ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen?${params}`,
      { headers: { Authorization: `Token ${this.key}` } }
    );
    this.ws = ws;

    ws.on('open', () => this._flush());

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'UtteranceEnd') {
        this.emit('utteranceEnd', {});
        return;
      }
      if (msg.type !== 'Results') return;

      const text = msg.channel?.alternatives?.[0]?.transcript?.trim();
      if (!text) return;

      if (msg.is_final) {
        this.emit('final', { text });
        if (msg.speech_final) this.emit('utteranceEnd', {});
      } else {
        this.emit('partial', { text });
      }
    });

    ws.on('error', (e) => this.emit('error', e));
    ws.on('close', (code, reason) => {
      this.ready = false;
      if (!this.closed && code !== 1000) {
        this.emit('error', new Error(
          `Deepgram closed (${code}) ${reason || ''}`.trim()
        ));
      }
    });
  }

  // ── OpenAI realtime transcription ─────────────────────────────────
  _connectOpenAI() {
    const ws = new WebSocket(
      'wss://api.openai.com/v1/realtime?intent=transcription',
      {
        headers: {
          Authorization: `Bearer ${this.key}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      }
    );
    this.ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'transcription_session.update',
        session: {
          input_audio_format: 'pcm16',
          input_audio_transcription: { model: MODELS.openai.stt },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: Math.max(200, TUNING.silenceMs),
          },
        },
      }));
      this._flush();
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.type) {
        case 'conversation.item.input_audio_transcription.delta':
          if (msg.delta) this.emit('partial', { text: msg.delta });
          break;
        case 'conversation.item.input_audio_transcription.completed':
          if (msg.transcript?.trim()) {
            this.emit('final', { text: msg.transcript.trim() });
          }
          break;
        case 'input_audio_buffer.speech_stopped':
          this.emit('utteranceEnd', {});
          break;
        case 'error':
          this.emit('error', new Error(msg.error?.message || 'OpenAI realtime error'));
          break;
      }
    });

    ws.on('error', (e) => this.emit('error', e));
    ws.on('close', (code, reason) => {
      this.ready = false;
      if (!this.closed && code !== 1000) {
        this.emit('error', new Error(
          `OpenAI realtime closed (${code}) ${reason || ''}`.trim()
        ));
      }
    });
  }
}

// ── WAV framing ───────────────────────────────────────────────────────
function wavHeader(dataLen, rate) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);            // PCM
  b.writeUInt16LE(1, 22);            // mono
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);     // byte rate
  b.writeUInt16LE(2, 32);            // block align
  b.writeUInt16LE(16, 34);           // bits per sample
  b.write('data', 36);
  b.writeUInt32LE(dataLen, 40);
  return b;
}

// Whisper invents filler on near-silent audio. These are the usual suspects.
const HALLUCINATIONS = new Set([
  'you', 'thank you', 'thank you.', 'thanks for watching', 'thanks for watching!',
  'bye', 'bye.', '.', '...', 'okay', 'oh', 'mm', 'uh', 'um', 'so', 'the',
  'subtitles by the amara.org community', 'transcription by castingwords',
]);

function isHallucination(text) {
  return HALLUCINATIONS.has(text.trim().toLowerCase().replace(/[!?]+$/, ''));
}

/**
 * Groq has Whisper but no streaming socket, so we segment locally: an
 * energy VAD watches the PCM, and when the speaker stops we ship that
 * utterance to Whisper as one WAV.
 *
 * This turns out better than it sounds. The pause that ends a sentence is
 * exactly the pause that should trigger an answer, so one detector does
 * both jobs, and the chunk boundary always falls on a natural break rather
 * than mid-word. Measured end to end: ~290ms Whisper + ~120ms first token.
 */
class GroqTranscriber extends EventEmitter {
  constructor({ key, label }) {
    super();
    this.provider = 'groq';
    this.key = key;
    this.label = label;
    this.closed = false;

    this.frames = [];          // Buffers of PCM16 awaiting flush
    this.bytes = 0;
    this.speaking = false;
    this.speechFrames = 0;
    this.silenceMs = 0;
    this.inFlight = 0;
  }

  connect() {
    // Nothing to open — Whisper is request/response.
    this.emit('ready');
  }

  send(pcm) {
    if (this.closed) return;

    const buf = Buffer.from(pcm);
    const rms = this._rms(buf);
    const frameMs = (buf.length / 2 / SAMPLE_RATE) * 1000;

    if (rms > SPEECH_RMS) {
      this.speechFrames++;
      this.silenceMs = 0;
      if (!this.speaking && this.speechFrames >= 3) this.speaking = true;
    } else if (this.speaking) {
      this.silenceMs += frameMs;
    } else {
      // Keep a short pre-roll so we don't clip the first syllable.
      this.speechFrames = 0;
      if (this.bytes > SAMPLE_RATE * 2 * 0.3) {
        this.frames.shift();
        this.bytes -= buf.length;
      }
    }

    this.frames.push(buf);
    this.bytes += buf.length;

    const durationMs = (this.bytes / 2 / SAMPLE_RATE) * 1000;

    if (this.speaking && this.silenceMs >= TUNING.silenceMs && durationMs > 400) {
      this._flush();
    } else if (durationMs >= MAX_CHUNK_MS) {
      // Someone is monologuing. Ship what we have so the transcript keeps up.
      this._flush({ partialOnly: true });
    }
  }

  _rms(buf) {
    let sum = 0;
    const n = buf.length / 2;
    for (let i = 0; i < n; i++) {
      const v = buf.readInt16LE(i * 2);
      sum += v * v;
    }
    return Math.sqrt(sum / n);
  }

  _flush({ partialOnly = false } = {}) {
    const pcm = Buffer.concat(this.frames, this.bytes);
    this.frames = [];
    this.bytes = 0;
    this.speaking = false;
    this.speechFrames = 0;
    this.silenceMs = 0;

    if (pcm.length < SAMPLE_RATE * 2 * 0.3) return; // under 300ms, not worth it
    this._transcribe(pcm, partialOnly);
  }

  async _transcribe(pcm, partialOnly) {
    if (this.inFlight > 2) return; // shed load rather than queue up stale audio
    this.inFlight++;

    try {
      const wav = Buffer.concat([wavHeader(pcm.length, SAMPLE_RATE), pcm]);
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
      form.append('model', MODELS.groq.stt);
      form.append('response_format', 'json');
      form.append('language', 'en');
      form.append('temperature', '0');

      const res = await fetch(`${MODELS.groq.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key}` },
        body: form,
      });

      if (!res.ok) {
        const body = await res.text();
        this.emit('error', new Error(`Groq Whisper ${res.status}: ${body.slice(0, 200)}`));
        return;
      }

      const { text } = await res.json();
      const clean = (text || '').trim();
      if (!clean || isHallucination(clean)) return;

      this.emit('final', { text: clean });
      if (!partialOnly) this.emit('utteranceEnd', {});
    } catch (err) {
      if (!this.closed) this.emit('error', err);
    } finally {
      this.inFlight--;
    }
  }

  close() {
    this.closed = true;
    this.frames = [];
    this.bytes = 0;
  }
}

/** Picks the right implementation for the configured provider. */
function createTranscriber({ provider, key, label }) {
  if (provider === 'groq') return new GroqTranscriber({ key, label });
  return new Transcriber({ provider, key, label });
}

module.exports = { Transcriber, GroqTranscriber, createTranscriber, SAMPLE_RATE };

