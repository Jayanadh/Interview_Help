'use strict';
/**
 * Proves the Claude request shape is valid without owning a Claude key.
 *
 * A deliberately bogus key should come back as a 401 authentication error.
 * Anything else — a TypeError, a 400 invalid_request, an unknown parameter —
 * means the request we build is malformed, and that is a bug you would
 * otherwise only discover the first time you paste a real key in.
 *
 *   node scripts/selftest/anthropic-shape.js
 */
const path = require('path');
const fs = require('fs');

const { generateAnswer, generateCodeFromScreen } = require('../../src/main/assist');
const { buildSystemPrompt, buildContextBlock } = require('../../src/main/context');

const FAKE = 'sk-ant-api03-' + 'A'.repeat(80);
const PNG = path.join(__dirname, 'captured.png');

let fails = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) fails++;
};

/** An auth failure is the pass condition; anything else is a real defect. */
function classify(err) {
  const status = err?.status ?? err?.statusCode;
  const msg = String(err?.message || err);
  if (status === 401 || /authentication|invalid x-api-key|invalid_api_key/i.test(msg)) {
    return { ok: true, why: `401 auth (request shape accepted)` };
  }
  if (status === 400 || /invalid_request|unexpected|unknown|not supported|must be/i.test(msg)) {
    return { ok: false, why: `400 invalid request — ${msg.slice(0, 160)}` };
  }
  if (err instanceof TypeError) {
    return { ok: false, why: `TypeError before the request — ${msg.slice(0, 160)}` };
  }
  return { ok: false, why: `${status || '?'} ${msg.slice(0, 160)}` };
}

async function main() {
  console.log('\nspoken answer path (streamAnthropic)');
  try {
    await generateAnswer({
      provider: 'anthropic',
      key: FAKE,
      systemPrompt: buildSystemPrompt('full'),
      style: 'full',
      contextBlock: buildContextBlock({
        resumeText: fs.readFileSync(path.join(__dirname, '..', '..', 'sample-resume.txt'), 'utf8'),
        role: 'Backend Engineer', company: 'Stripe', jobDescription: '', focus: '',
      }),
      transcript: 'INTERVIEWER: Tell me about a hard bug.',
      question: 'Tell me about a hard bug.',
      onToken: () => {},
    });
    check('reached the API', false, 'a bogus key somehow succeeded');
  } catch (err) {
    const r = classify(err);
    check('request shape valid', r.ok, r.why);
  }

  console.log('\nscreen -> code path (streamAnthropicVision)');
  if (!fs.existsSync(PNG)) {
    console.log('  skipped — run `npm run test:vision` once to create captured.png');
  } else {
    try {
      await generateCodeFromScreen({
        provider: 'anthropic',
        key: FAKE,
        imageBase64: fs.readFileSync(PNG).toString('base64'),
        language: 'Python',
        transcript: '',
        onToken: () => {},
      });
      check('reached the API', false, 'a bogus key somehow succeeded');
    } catch (err) {
      const r = classify(err);
      check('image block + request shape valid', r.ok, r.why);
    }
  }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(fails ? `${fails} failed` : 'Claude paths are well-formed; only the key is missing');
  process.exit(fails ? 1 : 0);
}

main();
