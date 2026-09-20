'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Turns the resume + four setup answers into ONE frozen text block.
 *
 * This block is byte-identical for the whole interview, which is the
 * entire point: it sits behind a cache breakpoint so every answer after
 * the first is a cache read instead of a fresh 4-6K token upload. That
 * is where most of the time-to-first-token savings come from.
 *
 * Corollary: never put a timestamp, a counter, or the current question
 * in here. One changed byte and the cache misses silently.
 */

async function extractResume(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.pdf', '.txt', '.md'].includes(ext)) {
    throw new Error(`Unsupported resume format "${ext || '(none)'}". Use PDF, TXT, or MD.`);
  }

  const buf = fs.readFileSync(filePath);

  if (ext === '.pdf') {
    // Lazy require: pdf-parse reads a test fixture at import time in some
    // versions, so only load it when we actually have a PDF.
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buf);
    return data.text.trim();
  }
  return buf.toString('utf8').trim();
}

const SHARED_RULES = [
  'GROUNDING — this matters more than anything else:',
  '- Every factual claim must come from the RESUME. Real project names, real',
  '  numbers, real technologies, real companies.',
  '- Never invent experience, employers, metrics, or timelines.',
  '- If the resume cannot support an answer, say so in one line and give the',
  '  clarifying question the candidate should ask back instead.',
  '- Connect to the TARGET ROLE or COMPANY only where it is genuinely apt.',
  '  A forced connection reads worse than none.',
  '- Write in first person, as the candidate ("I built", "I led").',
  '- Never open with filler: no "Great question", "Certainly", "I would say".',
].join('\n');

function buildSystemPrompt(style = 'full') {
  if (style === 'brief') {
    return [
      'You are an interview copilot. You draft what a candidate should say next.',
      '',
      'FORMAT:',
      'Line 1: the whole answer in ONE sentence, wrapped in **bold**, containing',
      '  a concrete specific from the resume.',
      'Then: 2-4 bullets, each under 12 words, each adding a new fact.',
      'Under 80 words total.',
      'Never write labels like "Situation:", "Action:", "Result:".',
      '',
      SHARED_RULES,
    ].join('\n');
  }

  return [
    'You are an interview copilot. You write the complete answer a candidate',
    'says out loud — the actual words, ready to be read straight off the screen.',
    '',
    'Your output is always ONE bold summary line, then flowing paragraphs.',
    'The paragraphs are spoken English: full sentences, contractions, natural',
    'rhythm. 150-220 words, which is 60-90 seconds of speech.',
    '',
    'Here is exactly what a correct answer looks like. Match this shape every',
    'time, whatever the question:',
    '',
    '---',
    '**I cut our deployment failure rate from 12% to under 1% by rebuilding the',
    'release pipeline around progressive rollouts.**',
    '',
    'When I joined the platform team at Northwind, we were losing about a day a',
    'week to bad deploys. Every release went to all regions at once, so one bad',
    'config took down everything, and rolling back meant a manual scramble',
    'across six services.',
    '',
    'So I rebuilt the pipeline around progressive delivery. Each release went to',
    'a single region first, sat behind automated health checks for fifteen',
    'minutes, then expanded outward. The part that mattered most was making',
    'rollback automatic instead of a decision someone had to make under',
    'pressure, because that is where we were actually losing the time.',
    '',
    'Within two quarters the failure rate went from twelve percent to under one,',
    'and mean time to recovery dropped from forty minutes to four. The bigger',
    'win was cultural, honestly. People started shipping on Fridays again.',
    '---',
    '',
    'Notice: no bullets, no labels, no fragments. Just a person talking.',
    '',
    'Shape the middle by question type. For a past-experience question, name the',
    'problem and its stakes, spend the middle on what you personally did and why,',
    'and close with how it turned out using a real figure. For a technical',
    'question, answer directly in the first sentence, then how you would build',
    'it, then something comparable you have actually shipped. For a motivation',
    'question, say what draws you, evidence it from the resume, then where you',
    'want to grow.',
    '',
    SHARED_RULES,
  ].join('\n');
}

function buildContextBlock({ resumeText, role, company, jobDescription, focus }) {
  const parts = [];

  parts.push('## TARGET ROLE\n' + (role || 'Not specified'));
  parts.push('## TARGET COMPANY\n' + (company || 'Not specified'));

  if (jobDescription && jobDescription.trim()) {
    parts.push('## JOB DESCRIPTION\n' + jobDescription.trim());
  }
  if (focus && focus.trim()) {
    parts.push(
      '## WHAT THE CANDIDATE WANTS EMPHASISED\n' + focus.trim()
    );
  }

  parts.push('## CANDIDATE RESUME\n' + (resumeText || 'Not provided'));

  return parts.join('\n\n');
}

/** Rough token estimate, good enough to warn about cache-minimum misses. */
function estimateTokens(text) {
  return Math.ceil(text.length / 3.7);
}

module.exports = {
  extractResume,
  buildSystemPrompt,
  buildContextBlock,
  estimateTokens,
};
