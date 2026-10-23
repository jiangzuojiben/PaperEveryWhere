import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { decodeBinary, encodeBinary, toArrayBuffer, transformFrontmatter } from '../app/plugin-files.mjs';

test('binary APIs preserve only the typed view range and return independent buffers', () => {
  const backing = new Uint8Array([8, 0, 255, 128, 9]), view = backing.subarray(1, 4);
  assert.equal(encodeBinary(view), 'AP+A');
  assert.deepEqual([...new Uint8Array(decodeBinary('AP+A'))], [0, 255, 128]);
  const result = toArrayBuffer(new DataView(backing.buffer, 1, 3));
  backing[2] = 7;
  assert.deepEqual([...new Uint8Array(result)], [0, 255, 128]);
  assert.equal(decodeBinary('').byteLength, 0);
  assert.throws(() => toArrayBuffer('bytes'), /ArrayBuffer/);
});

test('binary decoder rejects malformed and noncanonical encodings', () => {
  for (const value of ['A', 'AAA', 'AA=', 'AA===', 'A A=', 'AA==\n', '-_==', 'AB==', 42]) assert.throws(() => decodeBinary(value), /base64/);
  const bytes = Uint8Array.from({ length: 100000 }, (_, index) => index % 256);
  assert.deepEqual(new Uint8Array(decodeBinary(encodeBinary(bytes))), bytes);
});

test('frontmatter updates retain unrelated YAML comments and exact body including CRLF', () => {
  const source = '---\r\n# retained comment\r\ntitle: "Quoted"\r\ncount: 1\r\nremove: yes\r\n---\r\n# Body\r\n\r\nText.  \r\n';
  const updated = transformFrontmatter(source, value => { value.count++; delete value.remove; value.tags = ['one', '二']; });
  assert.match(updated, /# retained comment\r\ntitle: "Quoted"/);
  assert.equal(updated.slice(updated.indexOf('---\r\n', 5) + 5), '# Body\r\n\r\nText.  \r\n');
  assert.deepEqual(parse(updated.split('---\r\n')[1]), { title: 'Quoted', count: 2, tags: ['one', '二'] });
});

test('frontmatter creates a mapping only when changed and no-op keeps original bytes', () => {
  assert.equal(transformFrontmatter('# Plain\n', () => {}), '# Plain\n');
  const existing = '---\naliases: [A, B] # same\n---\n# Title\n';
  assert.equal(transformFrontmatter(existing, value => { value.aliases = ['A', 'B']; }), existing);
  assert.equal(transformFrontmatter('\uFEFF# Plain\n', value => { value.count = 1; }), '\uFEFF---\ncount: 1\n---\n# Plain\n');
  assert.equal(transformFrontmatter('---\nnull\n---\nBody\n', () => {}), 'Body\n');
  assert.equal(transformFrontmatter('---\nremove: true\n---\nBody\n', value => { delete value.remove; }), 'Body\n');
});

test('frontmatter rejects malformed/nonmapping YAML, promises and callback errors', () => {
  for (const source of ['---\ntitle: [\n---\nBody', '---\n- sequence\n---\nBody', '---\na: 1\na: 2\n---\n', '---\na: 1']) assert.throws(() => transformFrontmatter(source, () => {}), /frontmatter|Frontmatter/);
  assert.throws(() => transformFrontmatter('# Body', async value => { value.a = 1; }), /synchronous/);
  assert.throws(() => transformFrontmatter('# Body', () => { throw new Error('callback failure'); }), /callback failure/);
});

test('frontmatter property names cannot mutate the JavaScript prototype', () => {
  const source = '---\n__proto__: harmless\nconstructor: ordinary\n---\nBody\n';
  const updated = transformFrontmatter(source, value => { value.__proto__ = { marker: 'local' }; value.extra = true; });
  assert.equal({}.marker, undefined);
  assert.deepEqual(parse(updated.split('---\n')[1]), { ['__proto__']: { marker: 'local' }, constructor: 'ordinary', extra: true });
});
