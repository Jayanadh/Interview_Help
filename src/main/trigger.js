'use strict';

const { EventEmitter } = require('events');
const { TUNING } = require('./config');

/**
 * Decides WHEN to answer. This is the difference between a copilot that
 * feels telepathic and one that spams you mid-sentence.
 *
 * Fires 'question' when ALL of these hold:
 *   1. the interviewer has gone quiet for SILENCE_MS
 *   2. their utterance is at least minWords long
 *   3. it parses as a question or a prompt, not a backchannel grunt
 *
 * Emits 'cancel' the instant they start talking again, so the caller can
 * abort an in-flight answer. Without that, stale answers stack up and the
 * overlay becomes unreadable exactly when you need it.
 */

const BACKCHANNEL = new Set([
  'mhm', 'mm', 'mmhmm', 'uh huh', 'uhhuh', 'right', 'okay', 'ok', 'yeah',
  'yep', 'yes', 'sure', 'got it', 'gotcha', 'i see', 'makes sense', 'nice',
  'cool', 'interesting', 'great', 'perfect', 'awesome', 'exactly', 'sounds good',
]);

const OPENERS = /^(what|why|how|when|where|who|which|whose|can|could|would|will|should|do|did|does|are|is|was|were|have|has|had|tell|walk|describe|explain|give|talk|share|imagine|suppose|say|let's|lets|going|got)\b/i;

const PROMPTS = /(tell me about|walk me through|talk to me about|how would you|what would you|can you explain|give me an example|describe a time|tell us about|what's your|whats your|how do you|why do you|any questions)/i;

function looksLikeQuestion(text) {
  const t = text.trim();
  if (!t) return false;

  const normalized = t.toLowerCase().replace(/[.,!?]+$/g, '').trim();
  if (BACKCHANNEL.has(normalized)) return false;

  if (t.endsWith('?')) return true;
  if (PROMPTS.test(t)) return true;
  if (OPENERS.test(normalized)) return true;

  return false;
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

class TriggerEngine extends EventEmitter {
  constructor() {
    super();
    this.segments = [];        // { speaker, text, at }
    this.pending = '';         // interviewer speech since their last turn end
    this.partial = '';
    this.silenceTimer = null;
    this.answering = false;
  }

  _clearTimer() {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  /** Interviewer partial result — they are still talking. */
  onTheirPartial(text) {
    this.partial = text;
    this._clearTimer();
    if (this.answering) {
      this.answering = false;
      this.emit('cancel');
    }
    this.emit('transcript', this.snapshot());
  }

  /** Interviewer committed segment. */
  onTheirFinal(text) {
    if (!text.trim()) return;
    this.partial = '';
    this.pending = `${this.pending} ${text}`.trim();
    this.segments.push({ speaker: 'them', text: text.trim(), at: Date.now() });
    this.emit('transcript', this.snapshot());

    this._clearTimer();
    this.silenceTimer = setTimeout(
      () => this._evaluate('silence'),
      TUNING.silenceMs
    );
  }

  /** Provider says the utterance ended — the reliable backstop. */
  onTheirUtteranceEnd() {
    this._clearTimer();
    this._evaluate('utteranceEnd');
  }

  /** The candidate speaking. Recorded for context; never triggers an answer. */
  onMyFinal(text) {
    if (!text.trim()) return;
    this.segments.push({ speaker: 'me', text: text.trim(), at: Date.now() });
    this.emit('transcript', this.snapshot());
  }

  _evaluate(reason) {
    const question = this.pending.trim();
    if (!question) return;

    if (wordCount(question) < TUNING.minWords) return;
    if (!looksLikeQuestion(question)) return;

    this.pending = '';
    this.answering = true;
    this.emit('question', {
      question,
      transcript: this.transcriptWindow(),
      reason,
    });
  }

  /** Manual hotkey — bypasses every heuristic. Always fires. */
  forceTrigger() {
    const recent = this.segments
      .filter((s) => s.speaker === 'them')
      .slice(-3)
      .map((s) => s.text)
      .join(' ');

    const question = (this.pending || recent || this.partial).trim();
    if (!question) return false;

    this.pending = '';
    this.answering = true;
    this.emit('question', {
      question,
      transcript: this.transcriptWindow(),
      reason: 'manual',
    });
    return true;
  }

  answerFinished() {
    this.answering = false;
  }

  /** Last N seconds of dialogue, speaker-labelled. */
  transcriptWindow() {
    const cutoff = Date.now() - TUNING.transcriptWindowSec * 1000;
    return this.segments
      .filter((s) => s.at >= cutoff)
      .map((s) => `${s.speaker === 'me' ? 'CANDIDATE' : 'INTERVIEWER'}: ${s.text}`)
      .join('\n');
  }

  snapshot() {
    return {
      segments: this.segments.slice(-40),
      partial: this.partial,
    };
  }

  reset() {
    this._clearTimer();
    this.segments = [];
    this.pending = '';
    this.partial = '';
    this.answering = false;
  }
}

module.exports = { TriggerEngine, looksLikeQuestion, wordCount };
