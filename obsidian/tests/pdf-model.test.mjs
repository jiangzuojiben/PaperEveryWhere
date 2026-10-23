import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePdfPage, buildPdfText, findPdfMatches, matchSegments, pdfReference,
} from '../app/pdf-model.mjs';

test('PDF pages default safely and clamp to the available page range', () => {
  for (const value of [undefined, null, '', 'invalid', NaN, Infinity]) {
    assert.equal(parsePdfPage(value, 12), 1, `invalid page ${String(value)}`);
  }
  assert.equal(parsePdfPage(-5, 12), 1);
  assert.equal(parsePdfPage(0, 12), 1);
  assert.equal(parsePdfPage(7, 12), 7);
  assert.equal(parsePdfPage(20, 12), 12);
  assert.equal(parsePdfPage(700), 700);
});

test('PDF page navigation reads fragments from local paths and full URLs', () => {
  assert.equal(parsePdfPage('资料/论文.pdf#page=6', 20), 6);
  assert.equal(parsePdfPage('https://example.com/paper.pdf#page=15', 20), 15);
  assert.equal(parsePdfPage('paper.pdf#page=99', 4), 4);
  assert.equal(parsePdfPage('paper.pdf#page=-2', 4), 1);
  assert.equal(parsePdfPage('paper.pdf#page=wrong', 4), 1);
  assert.equal(parsePdfPage('paper.pdf', 4), 1);
});

test('PDF text segments retain exact source offsets while excluding EOL characters', () => {
  const items = [
    { type: 'beginMarkedContent', id: 'section' },
    { str: '第一行', hasEOL: true },
    { str: 'Hello ', hasEOL: false },
    { type: 'endMarkedContent' },
    { str: 'world', hasEOL: true },
    { str: '结束' },
  ];
  const original = structuredClone(items);
  const result = buildPdfText(items);
  assert.deepEqual(result, {
    text: '第一行\nHello world\n结束',
    segments: [
      { index: 0, start: 0, end: 3, text: '第一行' },
      { index: 1, start: 4, end: 10, text: 'Hello ' },
      { index: 2, start: 10, end: 15, text: 'world' },
      { index: 3, start: 16, end: 18, text: '结束' },
    ],
  });
  for (const segment of result.segments) {
    assert.equal(result.text.slice(segment.start, segment.end), segment.text);
  }
  assert.deepEqual(items, original);
  assert.deepEqual(buildPdfText([]), { text: '', segments: [] });
});

test('PDF search matches Chinese and case-insensitive text across equivalent whitespace', () => {
  const text = '序：Hello\t \n世界；HELLO 世界。';
  const expected = [
    { start: 2, end: text.indexOf('；') },
    { start: text.indexOf('HELLO'), end: text.lastIndexOf('。') },
  ];
  assert.deepEqual(findPdfMatches(text, 'hello 世界'), expected);
  assert.deepEqual(findPdfMatches(text, 'HELLO \n\t世界'), expected);
  assert.deepEqual(findPdfMatches('🙂你好世界', '你好'), [{ start: 2, end: 4 }]);
});

test('PDF search treats punctuation literally and returns nonoverlapping matches', () => {
  assert.deepEqual(findPdfMatches('x [a].* [A].*', '[a].*'), [
    { start: 2, end: 7 }, { start: 8, end: 13 },
  ]);
  assert.deepEqual(findPdfMatches('banana', 'ana'), [{ start: 1, end: 4 }]);
  assert.deepEqual(findPdfMatches('a sentence', ''), []);
  assert.deepEqual(findPdfMatches('a sentence', ' \t\n'), []);
  assert.deepEqual(findPdfMatches('a sentence', 'missing'), []);
});

test('PDF highlights split a match across spans using offsets within each span', () => {
  const model = buildPdfText([
    { str: 'prefi' }, { str: 'x target ' }, { str: 'phrase' }, { str: ' suffix' },
  ]);
  const matches = findPdfMatches(model.text, 'target phrase');
  assert.deepEqual(matches, [{ start: 7, end: 20 }]);
  assert.deepEqual(matchSegments(model.segments, matches[0]), [
    { index: 1, start: 2, end: 9 },
    { index: 2, start: 0, end: 6 },
  ]);
});

test('PDF highlight mapping excludes line breaks and does not bleed into adjacent spans', () => {
  const model = buildPdfText([{ str: 'Alpha', hasEOL: true }, { str: 'Beta gamma' }]);
  const [match] = findPdfMatches(model.text, 'ha beta');
  assert.deepEqual(match, { start: 3, end: 10 });
  assert.deepEqual(matchSegments(model.segments, match), [
    { index: 0, start: 3, end: 5 },
    { index: 1, start: 0, end: 4 },
  ]);
  assert.deepEqual(matchSegments(model.segments, { start: 5, end: 6 }), []);
  assert.deepEqual(matchSegments(model.segments, { start: 0, end: 5 }), [
    { index: 0, start: 0, end: 5 },
  ]);
});

test('PDF references preserve vault paths and quote each selected line', () => {
  const path = '资料/研究 文献.pdf';
  const link = '[[资料/研究 文献.pdf#page=4]]';
  assert.equal(pdfReference({ path, page: 4 }), link);
  assert.equal(pdfReference({ path, page: 4, text: '' }), link);
  assert.equal(pdfReference({ path, page: 4, text: '第一段\n第二段\n\n末段' }),
    `> 第一段\n> 第二段\n> \n> 末段\n\n${link}`);
});
