import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendixTranslation, canInsertAfter, insertTranslations, translationNote, translationNoteTitle
} from '../src/document-translation.ts';

const source = 'First paragraph.\n\nSecond paragraph.';
const segments = [
  { from: 0, to: 16, faithful: '第一段。', natural: '第一段（自然）。' },
  { from: 18, to: source.length, faithful: '第二段。', natural: '第二段（自然）。' }
];

test('inserts each translation after its source paragraph', () => {
  const output = insertTranslations(source, segments, 'faithful');
  assert.match(output, /^First paragraph\.\n\n第一段。/);
  assert.match(output, /Second paragraph\.\n\n第二段。$/);
});

test('natural variant changes inserted text', () => {
  assert.match(insertTranslations(source, segments, 'natural'), /第一段（自然）。/);
});

test('appendix joins translations under a heading', () => {
  assert.equal(appendixTranslation(segments, 'faithful'), '## 译文\n\n第一段。\n\n第二段。');
});

test('note content uses a title and ordered translations', () => {
  const note = translationNote('My Article · 译文', segments, 'natural');
  assert.match(note, /^# My Article · 译文/);
  assert.match(note, /第二段（自然）。/);
  assert.equal(translationNoteTitle('Article.md'), 'Article · 译文');
});

test('only paragraph boundaries are safe for inline insertion', () => {
  assert.equal(canInsertAfter('Short block', { from: 0, to: 11, faithful: '', natural: '' }), true);
  assert.equal(canInsertAfter('Mid sentence split here', { from: 0, to: 12, faithful: '', natural: '' }), false);
  assert.equal(canInsertAfter('a\nb', { from: 0, to: 1, faithful: '', natural: '' }), true);
});
