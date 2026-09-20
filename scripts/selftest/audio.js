'use strict';
/**
 * End-to-end check of the listen → detect → answer path, with no GUI and no
 * microphone: macOS `say` stands in for the interviewer, and the synthesised
 * speech is pushed through the real GroqTranscriber → TriggerEngine →
 * generateAnswer chain at roughly real time.
 *
 *   node scripts/selftest/audio.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { resolveProviders } = require('../../src/main/config');
const { createTranscriber, SAMPLE_RATE } = require('../../src/main/stt');
const { TriggerEngine } = require('../../src/main/trigger');
const { generateAnswer } = require('../../src/main/assist');
const { buildSystemPrompt, buildContextBlock } = require('../../src/main/context');

const QUESTIONS = [
  'So tell me about a time you had to debug a really difficult production issue.',
  'Thanks.',                       // must NOT trigger — too short, backchannel
  'How would you design a rate limiter for an API gateway?',
];

function synthesize(text) {
  const wav = path.join(os.tmpdir(), `hi-selftest-${Date.now()}.wav`);
  execFileSync('say', ['-o', wav, '--data-format=LEI16@24000', '--channels=1', text]);
  return wav;
}

/** Pull the PCM out of a WAV, whatever extra chunks CoreAudio put in it. */
function pcmFromWav(file) {
  const buf = fs.readFileSync(file);
  let off = 12; // past "RIFF....WAVE"
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in ' + file);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const providers = resolveProviders();
  if (providers.mode === 'error' || providers.mode === 'needs-key') {
    console.error('No usable provider:', providers.error);
    process.exit(1);
  }
  console.log(`provider: ${providers.note}\n`);

  const stt = createTranscriber({ ...providers.stt, label: 'them' });
  const trigger = new TriggerEngine();

  stt.on('final', ({ text }) => {
    console.log(`  [heard] ${text}`);
    trigger.onTheirFinal(text);
  });
  stt.on('utteranceEnd', () => trigger.onTheirUtteranceEnd());
  stt.on('error', (e) => console.error('  [stt error]', e.message));

  const contextBlock = buildContextBlock({
    resumeText: fs.readFileSync(
      path.join(__dirname, '..', '..', 'sample-resume.txt'), 'utf8'
    ),
    role: 'Senior Backend Engineer',
    company: 'Stripe',
    jobDescription: '',
    focus: '',
  });

  let fired = 0;
  const done = [];

  trigger.on('question', ({ question, transcript, reason }) => {
    fired++;
    console.log(`\n  [TRIGGER ${reason}] "${question}"`);
    const startedAt = Date.now();
    let ttft = null;
    let answer = '';

    done.push(
      generateAnswer({
        provider: providers.llm.provider,
        key: providers.llm.key,
        systemPrompt: buildSystemPrompt('full'),
        style: 'full',
        contextBlock,
        transcript,
        question,
        onToken: (t) => {
          if (!ttft) ttft = Date.now() - startedAt;
          answer += t;
        },
      }).then(() => {
        console.log(`  [answer] ttft=${ttft}ms total=${Date.now() - startedAt}ms ` +
                    `words=${answer.trim().split(/\s+/).length}`);
        console.log('  ┌─────');
        for (const line of answer.trim().split('\n')) {
          console.log('  │ ' + line);
        }
        console.log('  └─────');
        trigger.answerFinished();
      }).catch((e) => console.error('  [answer error]', e.message))
    );
  });

  stt.connect();

  for (const q of QUESTIONS) {
    console.log(`\n── speaking: "${q}"`);
    const wav = synthesize(q);
    const pcm = pcmFromWav(wav);
    fs.unlinkSync(wav);

    // 100ms frames, paced like a live capture so the energy VAD behaves the
    // way it does against a real stream.
    const frame = SAMPLE_RATE * 2 * 0.1;
    for (let i = 0; i < pcm.length; i += frame) {
      stt.send(pcm.subarray(i, Math.min(i + frame, pcm.length)));
      await sleep(100);
    }
    // Trailing silence is what closes the utterance.
    const silence = Buffer.alloc(frame);
    for (let i = 0; i < 12; i++) { stt.send(silence); await sleep(100); }
    await sleep(1200);
  }

  await Promise.all(done);
  stt.close();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`questions fired: ${fired} (expected 2 — the bare "Thanks." must not)`);
  process.exit(fired === 2 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
