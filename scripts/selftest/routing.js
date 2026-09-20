'use strict';
/**
 * Every combination of keys you might have, and what each one should do.
 *
 * This exists because the interesting combinations are the ones you cannot
 * try without owning four API keys — and the one that matters most (a Claude
 * key with Groq ears, no Deepgram) is exactly the one that used to be
 * rejected outright.
 *
 *   node scripts/selftest/routing.js
 */
const path = require('path');

// config.js calls dotenv.config() at module load, and this test re-requires
// it once per case — which would re-inject the real .env every time and make
// every case look like "you have a Groq key". Neutralise dotenv first; the
// env we build below is then the only input.
const dotenvPath = require.resolve('dotenv');
require.cache[dotenvPath] = {
  id: dotenvPath, filename: dotenvPath, loaded: true,
  exports: { config: () => ({ parsed: {} }) },
};

const K = {
  groq:      'gsk_' + 'x'.repeat(40),
  openai:    'sk-' + 'x'.repeat(40),
  anthropic: 'sk-ant-' + 'x'.repeat(40),
  deepgram:  'a1b2c3d4'.repeat(4),
  // A Claude Code / subscription login token. Looks like an Anthropic key,
  // authenticates completely differently.
  oauth:     'sk-ant-oat01-' + 'x'.repeat(40),
};

// resolveProviders reads process.env (and a settings file only under
// Electron, which this is not), so the env is the whole input.
function resolve(keys) {
  for (const n of ['GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPGRAM_API_KEY']) {
    delete process.env[n];
  }
  if (keys.groq) process.env.GROQ_API_KEY = K.groq;
  if (keys.openai) process.env.OPENAI_API_KEY = K.openai;
  if (keys.anthropic) process.env.ANTHROPIC_API_KEY = K.anthropic;
  if (keys.oauth) process.env.ANTHROPIC_API_KEY = K.oauth;
  if (keys.deepgram) process.env.DEEPGRAM_API_KEY = K.deepgram;

  delete require.cache[require.resolve('../../src/main/config')];
  return require('../../src/main/config').resolveProviders();
}

const CASES = [
  // held keys                              mode          stt         llm
  [{ groq: 1 },                             'groq',       'groq',     'groq'],
  [{ openai: 1 },                           'openai',     'openai',   'openai'],
  [{ anthropic: 1, deepgram: 1 },           'anthropic',  'deepgram', 'anthropic'],
  // The combination this change is for: Claude's brain, Groq's ears.
  [{ anthropic: 1, groq: 1 },               'anthropic',  'groq',     'anthropic'],
  [{ anthropic: 1, openai: 1 },             'anthropic',  'openai',   'anthropic'],
  [{ anthropic: 1, groq: 1, deepgram: 1 },  'anthropic',  'deepgram', 'anthropic'],
  [{ groq: 1, openai: 1 },                  'groq',       'groq',     'groq'],
  [{ anthropic: 1 },                        'error',      null,       null],
  [{},                                      'needs-key',  null,       null],
  // A subscription token must be rejected, even with good ears available —
  // otherwise it silently 401s on every answer instead of saying why.
  [{ oauth: 1 },                            'error',      null,       null],
  [{ oauth: 1, groq: 1 },                   'error',      null,       null],
];

let fails = 0;
console.log('keys held'.padEnd(34) + 'mode'.padEnd(12) + 'stt'.padEnd(11) + 'llm');
console.log('─'.repeat(72));

for (const [keys, mode, stt, llm] of CASES) {
  const got = resolve(keys);
  const ok =
    got.mode === mode &&
    (got.stt?.provider ?? null) === stt &&
    (got.llm?.provider ?? null) === llm;
  if (!ok) fails++;

  const held = Object.keys(keys).join('+').replace('oauth', 'claude-code-token') || '(none)';
  console.log(
    (ok ? '  ok  ' : '  FAIL') + held.padEnd(28) +
    String(got.mode).padEnd(12) +
    String(got.stt?.provider ?? '—').padEnd(11) +
    String(got.llm?.provider ?? '—') +
    (ok ? '' : `   expected ${mode}/${stt}/${llm}`)
  );
  if (got.note) console.log(' '.repeat(6) + `note: ${got.note}`);
  if (got.error) console.log(' '.repeat(6) + `error: ${got.error.split('\n')[0]}`);
}

console.log('─'.repeat(72));
console.log(fails ? `${fails} of ${CASES.length} failed` : `all ${CASES.length} routings correct`);
process.exit(fails ? 1 : 0);
