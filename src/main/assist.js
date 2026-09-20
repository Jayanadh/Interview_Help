'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { MODELS, TUNING } = require('./config');
const { estimateTokens } = require('./context');

/**
 * Streams an answer for a detected question.
 *
 * Contract: calls onToken(text) repeatedly, resolves when done.
 * Pass an AbortSignal — the caller cancels the moment the interviewer
 * starts talking again, otherwise stale answers pile up on screen.
 */

// Claude's minimum cacheable prefix. Below this the breakpoint is a
// no-op and we pay full input price every turn, so warn once.
const CACHE_MIN_TOKENS = 1024;
let warnedAboutCacheSize = false;

function buildUserTurn(transcript, question, style) {
  // This trailing instruction is the last thing the model reads, so it wins
  // any disagreement with the system prompt. It must not contradict it —
  // a stale "then bullets" here silently overrode the prose format.
  const closer = style === 'brief'
    ? 'Write the answer. Bold headline, then short bullets. Under 80 words.'
    : 'Write the full answer, in flowing paragraphs, 150-220 words.';

  return [
    '## RECENT CONVERSATION',
    transcript || '(nothing captured yet)',
    '',
    '## THE QUESTION TO ANSWER NOW',
    question,
    '',
    closer,
  ].join('\n');
}

async function streamAnthropic({
  key, systemPrompt, contextBlock, transcript, question, mode, style, onToken, signal,
}) {
  const client = new Anthropic({ apiKey: key });
  const model = MODELS.anthropic[mode] || MODELS.anthropic.default;

  const prefixTokens =
    estimateTokens(systemPrompt) + estimateTokens(contextBlock);
  const cacheable = prefixTokens >= CACHE_MIN_TOKENS;

  if (!cacheable && !warnedAboutCacheSize) {
    warnedAboutCacheSize = true;
    console.warn(
      `[assist] Context is only ~${prefixTokens} tokens — below Claude's ` +
      `${CACHE_MIN_TOKENS}-token cache minimum, so prompt caching is off. ` +
      `Add the job description to .env setup to get faster, cheaper answers.`
    );
  }

  const system = [
    { type: 'text', text: systemPrompt },
    {
      type: 'text',
      text: contextBlock,
      ...(cacheable ? { cache_control: { type: 'ephemeral' } } : {}),
    },
  ];

  const params = {
    model,
    max_tokens: TUNING.maxAnswerTokens,
    system,
    messages: [{ role: 'user', content: buildUserTurn(transcript, question, style) }],
  };

  // Opus 5 thinks adaptively by default. We want it thinking (disabling it
  // on Opus 5 can leak tags into visible text) but thinking *cheaply*.
  if (model === 'claude-opus-5') {
    params.output_config = { effort: 'low' };
  }
  // Haiku 4.5 rejects `effort` outright — leave it off.

  let usage = null;

  const run = async (useFallbacks) => {
    const req = useFallbacks
      ? { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
      : params;
    const api = useFallbacks ? client.beta.messages : client.messages;

    const stream = api.stream(req, signal ? { signal } : undefined);
    stream.on('text', (t) => onToken(t));
    const final = await stream.finalMessage();
    usage = final.usage;

    if (final.stop_reason === 'refusal') {
      onToken('\n\n_(The model declined this one — rephrase or use the manual trigger.)_');
    }
    return final;
  };

  try {
    // Server-side fallback reroutes automatically if a request is refused.
    await run(true);
  } catch (err) {
    if (signal?.aborted) return null;
    // Older API surface or unsupported beta — retry on the plain path.
    const msg = String(err?.message || '');
    if (/beta|fallback|unsupported|unrecognized/i.test(msg)) {
      console.warn('[assist] Fallback beta unavailable, using standard path.');
      await run(false);
    } else {
      throw err;
    }
  }

  return usage;
}

/**
 * A rate-limit reply is the single most likely failure in normal use, and the
 * raw JSON body is unreadable at a glance mid-interview. Pull out the one
 * number that matters — how long to wait.
 */
async function httpError(provider, res) {
  const body = await res.text();
  if (res.status === 429) {
    let wait = res.headers.get('retry-after');
    if (!wait) {
      const m = body.match(/try again in ([\d.]+)s/i);
      if (m) wait = m[1];
    }
    const secs = wait ? Math.ceil(Number(wait)) : null;
    return new Error(
      `${provider} rate limit reached` +
      (secs ? ` — try again in ${secs}s.` : '.') +
      (/image|vision|ITPM|tokens per minute/i.test(body)
        ? ' Screenshots are token-heavy; on a free tier that is roughly two screen reads a minute.'
        : '')
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(`${provider} rejected the API key (${res.status}).`);
  }
  return new Error(`${provider} ${res.status}: ${body.slice(0, 220)}`);
}

/** Reads an OpenAI-style SSE stream, calling onToken for each delta. */
async function pumpSSE(res, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') return null;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) onToken(delta);
      } catch { /* keep-alive or partial frame */ }
    }
  }
  return null;
}

async function streamOpenAICompatible({
  provider, key, systemPrompt, contextBlock, transcript, question, mode, style, onToken, signal,
}) {
  const cfg = MODELS[provider];
  const model = cfg[mode] || cfg.default;

  const body = {
    model,
    stream: true,
    max_tokens: TUNING.maxAnswerTokens + 400,
    temperature: 0.4,
    messages: [
      { role: 'system', content: `${systemPrompt}\n\n${contextBlock}` },
      { role: 'user', content: buildUserTurn(transcript, question, style) },
    ],
  };

  // gpt-oss models reason before emitting. At default effort that reasoning
  // ate the whole token budget and truncated the answer mid-sentence;
  // 'low' cut time-to-first-token from 1327ms to 580ms.
  if (model.includes('gpt-oss')) body.reasoning_effort = 'low';

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    signal,
    body: JSON.stringify(body),
  });

  if (!res.ok) throw await httpError(provider, res);

  return pumpSSE(res, onToken);
}

// ── Screen -> code ──────────────────────────────────────────────────
/**
 * Reads a screenshot and writes the solution in a chosen language.
 *
 * Separate from generateAnswer on purpose. The spoken-answer prompt is tuned
 * to produce 150-220 words of natural speech grounded in a resume; pointing
 * that at a coding screen produces a lovely paragraph about an algorithm and
 * no algorithm. Different job, different prompt, different token budget.
 */
function codeSystemPrompt(language) {
  return [
    `You read a screenshot of the user's screen and write working ${language}.`,
    '',
    'The screen usually holds a coding problem — an online judge, a shared',
    'editor, a whiteboard tool, a terminal, a PDF. Find the actual task on it.',
    'Ignore chrome: tabs, sidebars, timers, chat panels, video tiles.',
    '',
    'ANSWER IN EXACTLY THIS SHAPE:',
    '',
    '**<one line: what the problem asks, in your own words>**',
    '',
    '<one or two sentences on the approach and why it works.>',
    '',
    '```' + languageFence(language),
    '<the complete solution. runnable, not a sketch. no TODOs.>',
    '```',
    '',
    '<one line: time and space complexity, then the edge case most likely to',
    'break a naive attempt.>',
    '',
    'RULES:',
    `- Write ${language}. Idiomatic ${language}, not translated pseudocode.`,
    '- If the screen already contains a partial solution or a required function',
    '  signature, keep it and build on it. Do not rename their function.',
    '- Match whatever input/output contract the problem states.',
    '- Comment only where the reasoning is not obvious from the code.',
    '- If you cannot find a problem on the screen, say so in one line and',
    '  describe what you did see. Do not invent a problem to solve.',
    '- No preamble. No "Here is". Start at the bold line.',
  ].join('\n');
}

// Fence tag for syntax highlighting. Unknown languages get a bare fence
// rather than an invented tag.
const FENCE = {
  'Python': 'python', 'JavaScript': 'javascript', 'TypeScript': 'typescript',
  'Java': 'java', 'C': 'c', 'C++': 'cpp', 'C#': 'csharp', 'Go': 'go',
  'Rust': 'rust', 'Ruby': 'ruby', 'PHP': 'php', 'Swift': 'swift',
  'Kotlin': 'kotlin', 'Scala': 'scala', 'R': 'r', 'MATLAB': 'matlab',
  'Objective-C': 'objectivec', 'Perl': 'perl', 'Lua': 'lua',
  'Haskell': 'haskell', 'Elixir': 'elixir', 'Erlang': 'erlang',
  'Clojure': 'clojure', 'Dart': 'dart', 'Julia': 'julia', 'Bash': 'bash',
  'PowerShell': 'powershell', 'SQL': 'sql', 'HTML': 'html', 'CSS': 'css',
  'Assembly': 'asm', 'Solidity': 'solidity', 'Zig': 'zig', 'Nim': 'nim',
};
function languageFence(language) {
  return FENCE[language] || String(language).toLowerCase().replace(/[^a-z0-9+#]/g, '');
}

function codeUserTurn({ language, transcript, hint }) {
  const parts = [];
  if (transcript && transcript.trim()) {
    parts.push('## WHAT WAS SAID JUST NOW (for context — the screen is the task)');
    parts.push(transcript.trim());
    parts.push('');
  }
  if (hint && hint.trim()) {
    parts.push('## THE USER ADDED');
    parts.push(hint.trim());
    parts.push('');
  }
  parts.push(`Read the screenshot and solve what is on it. Write ${language}.`);
  return parts.join('\n');
}

async function streamAnthropicVision({
  key, imageBase64, language, transcript, hint, onToken, signal,
}) {
  const client = new Anthropic({ apiKey: key });
  const model = MODELS.anthropic.vision;

  const params = {
    model,
    max_tokens: TUNING.maxCodeTokens,
    system: codeSystemPrompt(language),
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
        },
        { type: 'text', text: codeUserTurn({ language, transcript, hint }) },
      ],
    }],
  };

  // Reading a screen and writing correct code is worth more thinking than a
  // spoken answer gets, but not so much that you are still waiting at the
  // whiteboard. Medium is the compromise.
  if (model === 'claude-opus-5') {
    params.output_config = { effort: 'medium' };
  }

  const stream = client.messages.stream(params, signal ? { signal } : undefined);
  stream.on('text', (t) => onToken(t));
  const final = await stream.finalMessage();

  if (final.stop_reason === 'refusal') {
    onToken('\n\n_(The model declined this screenshot.)_');
  }
  return final.usage;
}

async function streamOpenAICompatibleVision({
  provider, key, imageBase64, language, transcript, hint, onToken, signal,
}) {
  const cfg = MODELS[provider];
  const model = cfg.vision;
  if (!model) throw new Error(`${provider} has no image-capable model configured.`);

  const body = {
    model,
    stream: true,
    max_tokens: TUNING.maxCodeTokens,
    temperature: 0.2, // code, not conversation
    messages: [
      { role: 'system', content: codeSystemPrompt(language) },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${imageBase64}` },
          },
          { type: 'text', text: codeUserTurn({ language, transcript, hint }) },
        ],
      },
    ],
  };

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    signal,
    body: JSON.stringify(body),
  });

  if (!res.ok) throw await httpError(provider, res);

  return pumpSSE(res, onToken);
}

async function generateCodeFromScreen(opts) {
  if (opts.provider === 'anthropic') return streamAnthropicVision(opts);
  return streamOpenAICompatibleVision(opts);
}

async function generateAnswer(opts) {
  const mode = opts.mode || TUNING.answerMode;
  const style = opts.style || 'full';
  if (opts.provider === 'anthropic') {
    return streamAnthropic({ ...opts, mode, style });
  }
  return streamOpenAICompatible({ ...opts, mode, style });
}

module.exports = { generateAnswer, generateCodeFromScreen, languageFence };
