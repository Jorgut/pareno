import { test } from 'node:test';
import assert from 'node:assert/strict';
import { articleTextForDetection, buildMessages, parseCoachResponse, parsePangramReport, flaggedPangramWindows, findIssueRanges, makeLearningMarkdown, validateSelection } from '../src/core.ts';

test('review instructions preserve meaning and request exact spans', () => {
  const messages = buildMessages('review', 'I have been research.', 'professional');
  assert.match(messages[0].content, /Minimal must correct only genuine mistakes/);
  assert.match(messages[0].content, /exact substring/);
  assert.match(messages[1].content, /I have been research/);
});

test('translation detects Chinese input', () => {
  assert.match(buildMessages('translate', '最近我在研究空间设计。', 'podcast')[0].content, /Chinese to English/);
});

test('voice review preserves personal style and never claims AI detection', () => {
  const prompt = buildMessages('voice', 'I visited Danba last month.', 'professional')[0].content;
  assert.match(prompt, /author's own voice/);
  assert.match(prompt, /Do not guess whether AI wrote/);
});

test('Pangram result keeps real class fractions and marked segments', () => {
  const report = parsePangramReport({
    stage: 'STAGE_SUCCESS', headline: 'Mixed', prediction: 'Mixed human and AI-assisted',
    fraction_human: 0.6, fraction_ai_assisted: 0.3, fraction_ai: 0.1,
    windows: [
      { text: 'I visited Danba.', label: 'Human', confidence: 'High', start_index: 0, end_index: 15 },
      { text: 'It is important to note', label: 'AI-Generated', confidence: 'Medium', start_index: 16, end_index: 39 }
    ]
  });
  assert.equal(report.fractionHuman, 0.6);
  assert.equal(report.fractionAI, 0.1);
  assert.equal(flaggedPangramWindows(report).length, 1);
  assert.equal(flaggedPangramWindows(report)[0].text, 'It is important to note');
});

test('Pangram report rejects incomplete or failed responses', () => {
  assert.throws(() => parsePangramReport({ stage: 'STAGE_FAILED' }), /did not finish/);
  assert.throws(() => parsePangramReport({ stage: 'STAGE_SUCCESS', fraction_human: 1 }), /missing fraction_ai_assisted/);
});

test('article scan ignores Obsidian metadata and image markup', () => {
  const source = '---\ntags: [draft]\n---\n# A personal essay\n\nI visited **Danba**. [My notes](https://example.org)\n\n![Photo](photo.jpg)';
  const text = articleTextForDetection(source);
  assert.match(text, /^A personal essay/);
  assert.match(text, /I visited Danba\. My notes/);
  assert.doesNotMatch(text, /tags:|photo\.jpg|example\.org|\*\*/);
});

test('parse structured model response and issue range', () => {
  const source = 'I have been research.';
  const result = parseCoachResponse({ choices: [{ message: { content: JSON.stringify({
    minimal: 'I have been researching.', natural: 'I have been researching.', explanation: '动词形式',
    issues: [{ source: 'research', replacement: 'researching', type: 'grammar', reason: '使用进行形式' }],
    learning: { title: 'Present perfect continuous', rule: 'have been + V-ing', example: 'I have been working.' }
  }) } }] }, source);
  assert.equal(result.minimal, 'I have been researching.');
  assert.deepEqual(findIssueRanges(source, result.issues), [{ from: 12, to: 20, kind: 'grammar' }]);
  assert.match(makeLearningMarkdown(source, result, 'review', new Date('2026-10-29')), /Present perfect continuous/);
});

test('invalid output fails clearly and does not change input', () => {
  assert.throws(() => parseCoachResponse({ choices: [{ message: { content: 'Not JSON' } }] }, 'original'), /unexpected format/);
  assert.throws(() => validateSelection(' '.repeat(4)), /select/);
  assert.throws(() => validateSelection('a'.repeat(3501)), /3500/);
});

test('issue ranges do not overlap when source repeats', () => {
  const ranges = findIssueRanges('go go', [
    { source: 'go', replacement: 'went', type: 'grammar', reason: '' },
    { source: 'go', replacement: 'went', type: 'grammar', reason: '' }
  ]);
  assert.deepEqual(ranges.map(x => x.from), [0, 3]);
});
