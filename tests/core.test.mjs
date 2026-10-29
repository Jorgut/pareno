import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, parseCoachResponse, findIssueRanges, makeLearningMarkdown, validateSelection } from '../src/core.ts';

test('review instructions preserve meaning and request exact spans', () => {
  const messages = buildMessages('review', 'I have been research.', 'professional');
  assert.match(messages[0].content, /Minimal must correct only genuine mistakes/);
  assert.match(messages[0].content, /exact substring/);
  assert.match(messages[1].content, /I have been research/);
});

test('translation detects Chinese input', () => {
  assert.match(buildMessages('translate', '最近我在研究空间设计。', 'podcast')[0].content, /Chinese to English/);
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
