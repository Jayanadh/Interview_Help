'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// In development the .env sits at the project root. A packaged .app has no
// project root, so keys live in the app's own settings file instead and the
// user types them into the setup screen. Both paths are supported.
dotenv.config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

function userDataDir() {
  try {
    return require('electron').app.getPath('userData');
  } catch {
    return null; // not in the Electron main process (tests, CLI)
  }
}

function settingsFile() {
  const dir = userDataDir();
  return dir ? path.join(dir, 'settings.json') : null;
}

function loadSettings() {
  const f = settingsFile();
  if (!f) return {};
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  const f = settingsFile();
  if (!f) return false;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ ...loadSettings(), ...patch }, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Provider routing.
 *
 * You give us whatever key(s) you have; this decides who does what.
 * The rest of the app never names a provider or a model — it asks for
 * `stt` and `llm` and gets back a config. That indirection is the only
 * thing standing between "my one key" today and a hosted multi-user
 * gateway later, so keep it.
 */
function resolveProviders() {
  const saved = loadSettings();
  const pick = (name) =>
    (saved[name] || process.env[name] || '').trim();

  const groq = pick('GROQ_API_KEY');
  const openai = pick('OPENAI_API_KEY');
  const anthropic = pick('ANTHROPIC_API_KEY');
  const deepgram = pick('DEEPGRAM_API_KEY');

  const has = (k) => k.length > 10; // guard against "" and placeholder junk

  // A subscription token pasted straight into .env never passes through the
  // setup screen's check, so catch it here too. Left alone it authenticates
  // as an API key, fails 401 on every answer, and looks like a broken app.
  if (anthropic && /^sk-ant-(oat|sid)/i.test(anthropic)) {
    return {
      mode: 'error',
      error:
        'ANTHROPIC_API_KEY holds a Claude subscription / Claude Code login ' +
        'token (sk-ant-oat…), not an API key.\n\n' +
        'Those authenticate as a bearer token tied to the Claude Code client, ' +
        'so this app cannot use one — every request would come back 401.\n\n' +
        'Create an API key at console.anthropic.com → Settings → API keys. ' +
        'It starts with sk-ant-api.',
    };
  }

  /*
   * Ears and brain are chosen separately.
   *
   * Anthropic has no streaming speech-to-text, so Claude always needs
   * somebody else's ears — but that somebody does not have to be Deepgram.
   * Any transcriber will do, and a Groq key you already have is the cheapest
   * pair of ears on the list. Pick the best available of each half rather
   * than insisting on a matched set.
   */
  const stt =
    (has(deepgram) && { provider: 'deepgram', key: deepgram, label: 'Deepgram' }) ||
    (has(groq) && { provider: 'groq', key: groq, label: 'Groq Whisper' }) ||
    (has(openai) && { provider: 'openai', key: openai, label: 'OpenAI' }) ||
    null;

  // Claude answers best, so it wins the brain whenever its key is present.
  if (has(anthropic)) {
    if (!stt) {
      return {
        mode: 'error',
        error:
          'Found ANTHROPIC_API_KEY but nothing that can hear.\n\n' +
          'Anthropic does not offer streaming speech-to-text, so Claude alone ' +
          'cannot hear the interview. Add one of these alongside it:\n' +
          '  \u2022 GROQ_API_KEY      (cheapest ears, and you may have one already)\n' +
          '  \u2022 DEEPGRAM_API_KEY  (best transcription quality)\n' +
          '  \u2022 OPENAI_API_KEY',
      };
    }
    return {
      mode: 'anthropic',
      stt,
      llm: { provider: 'anthropic', key: anthropic },
      note: `${stt.label} transcription + Claude answers`,
    };
  }

  // One key, both halves, and the fastest of the lot.
  if (has(groq)) {
    return {
      mode: 'groq',
      stt: { provider: 'groq', key: groq },
      llm: { provider: 'groq', key: groq },
      note: 'Groq Whisper + Groq LLM (single key)',
    };
  }

  // One key, everything through OpenAI.
  if (has(openai)) {
    return {
      mode: 'openai',
      stt: { provider: 'openai', key: openai },
      llm: { provider: 'openai', key: openai },
      note: 'OpenAI transcription + OpenAI answers (single key)',
    };
  }

  return {
    mode: 'needs-key',
    error:
      'Paste an API key below to get started.\n' +
      'A Groq key (starts with gsk_) is the fastest and cheapest option.',
  };
}

/**
 * Works out which provider a pasted key belongs to, from its prefix alone,
 * so the user never has to say.
 *
 * The case worth caring about is `sk-ant-oat…`. That is a Claude Code / Claude
 * subscription OAuth token, not an API key: it authenticates as
 * `Authorization: Bearer` with an extra beta header, where an API key goes in
 * `x-api-key`. The Anthropic API tells the two apart — "API key is invalid"
 * versus "OAuth access token is invalid" — but a plain `sk-ant-` prefix test
 * does not, so the token sails through setup and then fails 401 on every
 * single answer. Name it here instead.
 */
function classifyKey(raw) {
  const key = String(raw || '').trim();
  if (!key) return { error: 'Key is empty.' };

  if (/^sk-ant-(oat|sid)/i.test(key)) {
    return {
      error:
        'That is a Claude subscription / Claude Code login token, not an API key.\n\n' +
        'Those authenticate differently and are tied to the Claude Code client, ' +
        'so this app cannot use one. Create a real API key instead:\n' +
        '  console.anthropic.com → Settings → API keys\n' +
        'It will start with sk-ant-api.',
    };
  }

  if (key.startsWith('gsk_')) return { name: 'GROQ_API_KEY' };
  if (key.startsWith('sk-ant-')) return { name: 'ANTHROPIC_API_KEY' };
  if (key.startsWith('sk-')) return { name: 'OPENAI_API_KEY' };
  if (/^[a-f0-9]{32,48}$/i.test(key)) return { name: 'DEEPGRAM_API_KEY' };

  return {
    error:
      'Unrecognised key format.\n' +
      'Expected sk-ant-api… (Anthropic), gsk_… (Groq), sk-… (OpenAI), ' +
      'or a 32-character hex key (Deepgram).',
  };
}

const MODELS = {
  groq: {
    // Measured on this account: qwen 117ms TTFT, gpt-oss-20b 490ms,
    // gpt-oss-120b 580ms, compound-mini 2369ms. Speed wins here — the
    // answer is useless if it lands after you have already started talking.
    fast: 'qwen/qwen3.8-27b',
    default: 'qwen/qwen3.8-27b',
    deep: 'openai/gpt-oss-120b',
    stt: 'whisper-large-v3-turbo',
    // Screen reading. The only image-capable model on this account — verified
    // against GET /v1/models; the gpt-oss and compound models reject image
    // content blocks outright ("content must be a string").
    vision: 'qwen/qwen3.8-27b',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  anthropic: {
    fast: 'claude-haiku-4-5',
    default: 'claude-opus-5',
    vision: 'claude-opus-5',
  },
  openai: {
    fast: 'gpt-4o-mini',
    default: 'gpt-4o',
    deep: 'gpt-4o',
    stt: 'gpt-4o-transcribe',
    vision: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
  },
};

const TUNING = {
  // Interviewer pause before we consider their turn finished.
  silenceMs: Number(process.env.SILENCE_MS) || 600,
  // Ignore utterances shorter than this — filters "mhm", "right", "okay".
  minWords: 5,
  // Rolling transcript window handed to the model.
  transcriptWindowSec: 90,
  answerMode: (process.env.ANSWER_MODE || 'default').trim() || 'default',
  maxAnswerTokens: 900,
  // Code needs headroom a spoken answer does not: a working solution plus
  // its explanation routinely runs past 900.
  maxCodeTokens: Number(process.env.MAX_CODE_TOKENS) || 2200,
  // Language the screen-solver writes in until you change it in the overlay.
  defaultLanguage: (process.env.CODE_LANGUAGE || 'Python').trim() || 'Python',
};

module.exports = {
  resolveProviders, classifyKey, loadSettings, saveSettings, settingsFile,
  MODELS, TUNING,
};
