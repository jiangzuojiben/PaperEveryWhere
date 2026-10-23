import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../app/views-model.mjs';

// Behavioral references: https://obsidian.md/help/bases/syntax,
// https://obsidian.md/help/bases/functions, https://obsidian.md/help/bases/views.
// These tests assert observable values, preserving independence from the AST implementation.
const files = {
  'Projects/Alpha.md': '---\nprice: 12.5\nquantity: 4\nstatus: active\npriority: 2\ncompleted: false\nrelease date: 2026-10-23\ntags: [work/project, important]\nvalues: [3, 1, 2, 2]\nowner:\n  name: Ada\n---\n# Alpha\n[[Beta#Heading|Alias]]\n#inline/topic\n',
  'Projects/Beta.md': '---\nprice: 5\nquantity: 2\nstatus: done\npriority: 1\ncompleted: true\n---\n# Beta\n',
  'Archive/Gamma.md': '---\nprice: 10\nquantity: 3\nstatus: active\npriority: 2\n---\n# Gamma\n',
  'README.md': '# Readme\n',
  'Assets/photo.png': '',
};
const record = () => model.baseRecords(files).find(row => row.path === 'Projects/Alpha.md');
const expression = source => model.evaluateBaseExpression(source, record());

test('frontmatter editing preserves the exact body, BOM, CRLF, comments and unrelated YAML', () => {
  const body = '\r\n# 正文\r\n```yaml\r\n---\r\nx: 1\r\n```\r\n尾行';
  const source = '\uFEFF---\r\n# retain this comment\r\nprice: 12.5 # numeric value\r\nplugin:\r\n  nested: [one, two]\r\nsummary: |\r\n  first line\r\n  second line\r\naliases: ["[[Alpha]]"]\r\n---\r\n' + body;
  const updated = model.writeFrontmatter(source, document => document.set('price', 20));
  const parsed = model.frontmatterDocument(updated);
  assert.equal(parsed.error, '');
  assert.equal(parsed.body, body);
  assert.equal(parsed.bom, '\uFEFF');
  assert.equal(parsed.newline, '\r\n');
  assert.equal(parsed.data.price, 20);
  assert.deepEqual(parsed.data.plugin, { nested: ['one', 'two'] });
  assert.equal(parsed.data.summary, 'first line\nsecond line\n');
  assert.deepEqual(parsed.data.aliases, ['[[Alpha]]']);
  assert.match(updated, /# retain this comment/);
  assert.match(updated, /# numeric value/);
  assert.doesNotMatch(updated, /(?<!\r)\n/);
});

test('creating and deleting properties does not consume Markdown thematic breaks or body text', () => {
  const source = '\uFEFF# Title\n\n---\nThematic break above.\n';
  const added = model.writeFrontmatter(source, document => {
    document.set('completed', false);
    document.set('tags', ['work', 'topic/child']);
  });
  const deleted = model.writeFrontmatter(added, document => document.delete('completed'));
  assert.equal(model.frontmatterDocument(added).body, source.slice(1));
  assert.equal(model.frontmatterDocument(deleted).body, source.slice(1));
  assert.deepEqual(model.frontmatterDocument(deleted).data, { tags: ['work', 'topic/child'] });
});

test('invalid frontmatter is rejected before invoking an edit callback', () => {
  for (const source of ['---\nprice: [unclosed\n---\nBody', '---\nprice: 1\nprice: 2\n---\nBody', '---\n- item\n---\nBody', '---\nprice: 1\nBody']) {
    let invoked = false;
    assert.throws(() => model.writeFrontmatter(source, () => { invoked = true; }), undefined, source);
    assert.equal(invoked, false);
  }
});

test('a Bases read-modify-write roundtrip preserves unknown global, view and property fields', () => {
  const source = 'pluginState:\n  version: 3\n  flags: [enabled, beta]\nformulas:\n  total: price * quantity\nproperties:\n  formula.total:\n    displayName: Total\n    customCell: {color: purple}\nviews:\n  - type: plugin-map\n    name: Custom view\n    pluginConfig: {zoom: 7, center: [22.3, 114.2]}\n    order: [file.name, formula.total]\n  - type: table\n    name: Table\n';
  const parsed = model.parseBase(source);
  assert.equal(parsed.error, '');
  const before = structuredClone(parsed.config);
  parsed.config.views[1].name = 'Renamed table';
  const roundtrip = model.parseBase(model.serializeBase(parsed.config));
  assert.equal(roundtrip.error, '');
  assert.deepEqual(roundtrip.config.pluginState, before.pluginState);
  assert.deepEqual(roundtrip.config.views[0], before.views[0]);
  assert.deepEqual(roundtrip.config.properties, before.properties);
  assert.deepEqual(roundtrip.config.formulas, before.formulas);
  assert.equal(roundtrip.config.views[1].name, 'Renamed table');
});

test('Bases include attachments and distinguish filename from basename and UTF-8 byte size', () => {
  const records = model.baseRecords({ 'Folder/笔记.md': '# 中文', 'Assets/picture.png': '' });
  assert.equal(records.length, 2);
  assert.equal(records[0].file.name, '笔记.md');
  assert.equal(records[0].file.basename, '笔记');
  assert.equal(records[0].file.folder, 'Folder');
  assert.equal(records[0].file.size, new TextEncoder().encode('# 中文').length);
  assert.equal(records[1].file.ext, 'png');
  assert.deepEqual(records[1].props, {});
});

test('expressions obey arithmetic, comparison and Boolean precedence', () => {
  for (const [source, expected] of [
    ['2 + 3 * 4', 14], ['(2 + 3) * 4', 20], ['20 / 2 / 5', 2],
    ['10 - 3 - 2', 5], ['-2 * -3 + 1', 7], ['17 % 5', 2],
    ['price * quantity >= 50 && status != "done"', true],
    ['true || false && false', true], ['(true || false) && false', false],
    ['!(price < 10) && !completed', true],
  ]) assert.equal(expression(source), expected, source);
});

test('literals keep operator characters and escaped quotes inside strings', () => {
  assert.equal(expression('"a && b || c >= d"'), 'a && b || c >= d');
  assert.equal(expression('"a \\"quote\\" and comma, tail"'), 'a "quote" and comma, tail');
  assert.equal(expression("'it\\'s a string'"), "it's a string");
  assert.equal(expression('"(a,b)".contains(",")'), true);
});

test('property access supports shorthand, spaced keys, nested values and list indices', () => {
  assert.equal(expression('price'), 12.5);
  assert.equal(expression('note.price'), 12.5);
  assert.equal(expression('note["release date"]'), '2026-10-23');
  assert.equal(expression('owner.name'), 'Ada');
  assert.equal(expression('note.owner["name"]'), 'Ada');
  assert.equal(expression('values[0]'), 3);
  assert.equal(expression('file.ext'), 'md');
});

test('Boolean and if branches only evaluate the selected expression', () => {
  assert.equal(expression('false && unknownFunction()'), false);
  assert.equal(expression('true || unknownFunction()'), true);
  assert.equal(expression('if(true, 7, unknownFunction())'), 7);
  assert.equal(expression('if(false, unknownFunction(), "fallback")'), 'fallback');
  assert.equal(expression('if(false, 7)'), null);
});

test('formula dependencies resolve lazily and keep output types and records independent', () => {
  const options = { formulas: {
    total: 'price * quantity',
    discounted: 'formula.total * 0.8',
    label: 'formula.discounted.toFixed(2) + " units"',
    unusedCycle: 'formula.unusedCycle',
  } };
  assert.equal(model.evaluateBaseExpression('formula.total', record(), options), 50);
  assert.equal(model.evaluateBaseExpression('formula.discounted', record(), options), 40);
  assert.equal(model.propertyValue(record(), 'formula.label', options), '40.00 units');
  const other = model.baseRecords(files).find(row => row.path === 'Projects/Beta.md');
  assert.equal(model.evaluateBaseExpression('formula.total', other, options), 10);
  assert.equal(model.evaluateBaseExpression('if(false, formula.unusedCycle, formula.total)', record(), options), 50);
});

test('direct and indirect formula cycles fail explicitly without poisoning later evaluations', () => {
  const options = { formulas: { self: 'formula.self + 1', first: 'formula.second', second: 'formula.third', third: 'formula.first', valid: 'price * 2' } };
  for (const formula of ['formula.self', 'formula.first']) {
    assert.throws(() => model.evaluateBaseExpression(formula, record(), options), error => {
      assert.ok(error instanceof Error);
      assert.notEqual(error.name, 'RangeError', 'cycle detection precedes recursion exhaustion');
      assert.match(error.message, /cycl|circular|循环/i);
      return true;
    });
  }
  assert.equal(model.evaluateBaseExpression('formula.valid', record(), options), 25);
});

test('formula references participate in both string and nested filters', () => {
  const options = { formulas: { total: 'price * quantity', active: 'status == "active"' } };
  assert.equal(model.matchesBaseFilter({ and: ['formula.total >= 40', 'formula.active'] }, record(), options), true);
  assert.equal(model.matchesBaseFilter('formula.total < 40', record(), options), false);
});

test('explicit thisRecord and clock contexts remain separate from the row being evaluated', () => {
  const context = model.baseRecords({ 'Dashboards/Home.base': 'views: []' })[0];
  const now = new Date(2026, 9, 23, 17, 45, 30);
  const options = { thisRecord: context, now };
  assert.equal(model.evaluateBaseExpression('this.file.folder', record(), options), 'Dashboards');
  assert.equal(model.evaluateBaseExpression('file.folder', record(), options), 'Projects');
  assert.equal(model.evaluateBaseExpression('number(now())', record(), options), now.getTime());
  assert.equal(model.evaluateBaseExpression('today().format("YYYY-MM-DD HH:mm:ss")', record(), options), '2026-10-23 00:00:00');
  assert.equal(now.getHours(), 17, 'today() must not mutate the injected clock');
});

test('number conversions and formatting keep numeric and string outputs distinct', () => {
  assert.equal(expression('number("3.5") * 2'), 7);
  assert.equal(expression('number(true) + number(false)'), 1);
  assert.equal(expression('(price / quantity).round(2)'), 3.13);
  assert.equal(expression('(price / quantity).toFixed(2)'), '3.13');
  assert.equal(expression('(-2.7).abs().ceil()'), 3);
  assert.equal(expression('min(price, 2, 9) + max(3, 9)'), 11);
  assert.throws(() => expression('number("not a number")'));
});

test('date arithmetic handles calendar months, durations, date fields and millisecond differences', () => {
  assert.equal(expression('(date("2024-12-01") + "1M" + "4h" + "3m").format("YYYY-MM-DD HH:mm:ss")'), '2025-01-01 04:03:00');
  assert.equal(expression('(date("2024-03-01") - "1d").format("YYYY-MM-DD")'), '2024-02-29');
  assert.equal(expression('date("2025-01-03") - date("2025-01-01")'), 172800000);
  assert.equal(expression('date("2025-05-27 14:15:16").month'), 5);
  assert.equal(expression('date("2025-05-27 14:15:16").date().format("HH:mm:ss")'), '00:00:00');
  assert.equal(expression('(date("2025-01-01") + duration("1d") * 2).format("YYYY-MM-DD")'), '2025-01-03');
});

test('list and string membership accept variadic arguments and zero-based indexing', () => {
  assert.equal(expression('"hello".containsAll("h", "e")'), true);
  assert.equal(expression('"hello".containsAny("x", "e")'), true);
  assert.equal(expression('[1, 2, 3].containsAll(2, 3)'), true);
  assert.equal(expression('[1, 2, 3].containsAll(2, 4)'), false);
  assert.equal(expression('[1, 2, 3].containsAny(3, 4)'), true);
  assert.deepEqual(expression('list("one")'), ['one']);
  assert.deepEqual(expression('list([1, 2])'), [1, 2]);
  assert.equal(expression('"  ALPHA  ".trim().lower()'), 'alpha');
  assert.equal(expression('"a:b:a".replace("a", "x")'), 'x:b:x');
});

test('list callbacks bind value, index and acc per item and support nested scopes', () => {
  assert.deepEqual(expression('[1, 2, 3, 4].filter(value > 2).map(value * 2 + index)'), [6, 9]);
  assert.equal(expression('[1, 2, 3].reduce(acc + value * (index + 1), 0)'), 14);
  assert.deepEqual(expression('[[1, 2], [3]].map(value.map(value * 2))'), [[2, 4], [6]]);
  assert.deepEqual(expression('values.unique().sort()'), [1, 2, 3]);
  assert.equal(expression('[1, [2, 3]].flat().join("-")'), '1-2-3');
});

test('nested AND, OR and NOT filter groups use none-of semantics for NOT', () => {
  const row = record();
  assert.equal(model.matchesBaseFilter({ and: ['file.ext == "md"', { or: ['status == "done"', 'price > 10'] }] }, row), true);
  assert.equal(model.matchesBaseFilter({ not: ['true', 'false'] }, row), false);
  assert.equal(model.matchesBaseFilter({ not: ['false', 'false'] }, row), true);
  assert.equal(model.matchesBaseFilter({ not: [] }, row), true);
  assert.equal(model.matchesBaseFilter({ and: [] }, row), true);
  assert.equal(model.matchesBaseFilter({ or: [] }, row), false);
});

test('file predicates honor subfolders, nested tags, inline tags and properties with false values', () => {
  assert.equal(expression('file.inFolder("Projects")'), true);
  assert.equal(expression('file.inFolder("Project")'), false);
  assert.equal(expression('file.hasTag("work")'), true);
  assert.equal(expression('file.hasTag("absent", "inline")'), true);
  assert.equal(expression('file.hasTag("wor")'), false);
  assert.equal(expression('file.hasProperty("completed")'), true);
  assert.equal(expression('file.hasProperty("missing")'), false);
});

test('file link predicates resolve note names with headings and aliases to vault paths', () => {
  assert.equal(expression('file.hasLink("Projects/Beta.md")'), true);
  assert.equal(expression('file.hasLink("Beta")'), true);
  assert.equal(expression('file.hasLink("Archive/Gamma.md")'), false);
});

test('object values expose own data only and cannot invoke arbitrary record callbacks', () => {
  const row = record();
  row.props.owner = Object.assign(Object.create({ inherited: 'hidden' }), { name: 'Ada' });
  let called = false;
  row.props.callback = () => { called = true; return 99; };
  assert.equal(model.evaluateBaseExpression('owner.inherited', row) == null, true);
  assert.deepEqual(model.evaluateBaseExpression('owner.keys()', row), ['name']);
  assert.throws(() => model.evaluateBaseExpression('callback()', row));
  assert.equal(called, false);
});

test('malformed syntax, host function calls and prototype traversal are rejected', () => {
  for (const source of [
    '2 +', '(2 * 3', '"unterminated', '[1, 2', 'price = 99',
    'globalThis.process.cwd()', 'eval("1 + 1")', 'Function("return 1")()',
    'note.constructor', 'note["__proto__"]', 'owner.constructor.constructor("return 1")()',
    'values.constructor', 'file.prototype',
  ]) assert.throws(() => expression(source), undefined, source);
  for (const source of ['process.env', 'globalThis.process', 'window.document']) {
    try { assert.equal(expression(source) == null, true, `${source} must not expose a host object`); }
    catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
  }
  assert.equal(expression('price'), 12.5, 'rejected expressions do not mutate note properties');
});

test('multi-property sorting compares numbers and formula results without mutating input rows', () => {
  const rows = model.baseRecords(files).filter(row => row.props.price != null);
  const originalOrder = rows.map(row => row.path);
  const byPriority = model.sortBaseRecords(rows, [{ property: 'priority', direction: 'ASC' }, { property: 'price', direction: 'DESC' }]);
  assert.deepEqual(byPriority.map(row => row.path), ['Projects/Beta.md', 'Projects/Alpha.md', 'Archive/Gamma.md']);
  const byFormula = model.sortBaseRecords(rows, [{ property: 'formula.total', direction: 'DESC' }], { formulas: { total: 'price * quantity' } });
  assert.deepEqual(byFormula.map(row => row.path), ['Projects/Alpha.md', 'Archive/Gamma.md', 'Projects/Beta.md']);
  assert.deepEqual(rows.map(row => row.path), originalOrder);
  assert.equal(byPriority[0], rows[1], 'sorting retains the original record identity');
});

test('automatic grouping sorts values and retains the sorted row order within each group', () => {
  const rows = model.sortBaseRecords(model.baseRecords(files), [{ property: 'price', direction: 'DESC' }]);
  const groups = model.groupBaseRecords(rows, { property: 'status', direction: 'DESC' });
  assert.deepEqual(groups.map(group => group.value), ['done', 'active', null]);
  assert.deepEqual(groups.find(group => group.value === 'active').rows.map(row => row.path), ['Projects/Alpha.md', 'Archive/Gamma.md']);
  assert.deepEqual(new Set(groups.find(group => group.value == null).rows.map(row => row.path)), new Set(['README.md', 'Assets/photo.png']));
  assert.equal(groups.reduce((sum, group) => sum + group.rows.length, 0), rows.length);
});

test('manual group order includes requested empty and missing-value groups and hides excluded groups', () => {
  const rows = model.baseRecords(files);
  const groupBy = { property: 'status', direction: 'ASC' };
  const groups = model.groupBaseRecords(rows, groupBy, ['done', 'planned', null]);
  assert.deepEqual(groups.map(group => group.value), ['done', 'planned', null]);
  assert.deepEqual(groups[1].rows, [], 'a user-created empty group remains visible');
  assert.equal(groups.some(group => group.rows.some(row => row.props.status === 'active')), false);
  assert.deepEqual(model.groupBaseRecords(rows, groupBy, []), []);
  assert.equal(model.groupBaseRecords(rows, groupBy).length, 3);
});

test('grouping works with formula values and distinguishes false, zero and missing properties', () => {
  const rows = model.baseRecords(files);
  const groups = model.groupBaseRecords(rows, { property: 'formula.bucket', direction: 'ASC' }, undefined, { formulas: { bucket: 'if(price >= 10, "high", "other")' } });
  assert.deepEqual(groups.find(group => group.value === 'high').rows.map(row => row.path), ['Projects/Alpha.md', 'Archive/Gamma.md']);
  const typedRows = model.baseRecords({ 'False.md': '---\nvalue: false\n---\n', 'Zero.md': '---\nvalue: 0\n---\n', 'Absent.md': '# absent' });
  const typedGroups = model.groupBaseRecords(typedRows, { property: 'value' });
  assert.equal(typedGroups.length, 3);
  for (const row of typedRows) assert.equal(typedGroups.filter(group => group.rows.includes(row)).length, 1);
});

test('numeric summaries ignore nonnumeric values and compute statistics across the result set', () => {
  const values = [2, 4, 4, 10, null, '100', false];
  for (const [name, expected] of [['Sum', 20], ['Average', 5], ['Min', 2], ['Max', 10], ['Range', 8], ['Median', 4]]) {
    assert.equal(model.summarizeBaseValues(name, values), expected, name);
  }
  assert.equal(model.summarizeBaseValues('Median', [9, 1, 5]), 5);
  assert.equal(model.summarizeBaseValues('Stddev', [4, 4, 4]), 0);
  assert.equal(model.summarizeBaseValues('Sum', []), 0);
  assert.equal(model.summarizeBaseValues('Average', []), null);
  assert.deepEqual(values, [2, 4, 4, 10, null, '100', false]);
});

test('date and Boolean summaries preserve types and treat false as filled', () => {
  const first = new Date('2025-01-01T00:00:00Z'), last = new Date('2025-01-03T00:00:00Z');
  assert.equal(model.summarizeBaseValues('Earliest', [last, first]).getTime(), first.getTime());
  assert.equal(model.summarizeBaseValues('Latest', [last, first]).getTime(), last.getTime());
  assert.equal(model.summarizeBaseValues('Range', [last, first]), 172800000);
  assert.equal(model.summarizeBaseValues('Checked', [true, false, true, null, 'true']), 2);
  assert.equal(model.summarizeBaseValues('Unchecked', [false, null, 0, false, 'false']), 2);
  assert.equal(model.summarizeBaseValues('Empty', [null, undefined, '', [], {}, 0, false]), 5);
  assert.equal(model.summarizeBaseValues('Filled', [null, undefined, '', [], {}, 0, false]), 2);
  assert.equal(model.summarizeBaseValues('Unique', ['x', 'x', 0, false, [1], [1]]), 4);
});

test('custom summary formulas bind all values and reuse the safe expression evaluator', () => {
  const options = { summaries: {
    rounded: 'values.mean().round(3)',
    numericTotal: 'values.filter(value.isType("number")).reduce(acc + value, 0)',
    unsafe: 'values.constructor.constructor("return 1")()',
  } };
  assert.equal(model.summarizeBaseValues('rounded', [1, 2, 5], options), 2.667);
  assert.equal(model.summarizeBaseValues('numericTotal', [1, '2', 3, null], options), 4);
  assert.throws(() => model.summarizeBaseValues('unsafe', [1], options));
  assert.throws(() => model.summarizeBaseValues('nonexistent', [1], options));
});

test('cell edits preserve property types, unrelated YAML and the exact note body', () => {
  const body = '\n# Body\n\n---\n[[Keep#Heading|Alias]]\n';
  const source = '---\n# existing note\nplugin: {version: 3, enabled: true}\nstatus: old\n---\n' + body;
  let changed = model.updateBaseProperty(source, 'note.status', '001');
  changed = model.updateBaseProperty(changed, 'completed', false);
  changed = model.updateBaseProperty(changed, 'note.price', 0);
  changed = model.updateBaseProperty(changed, 'note.release date', '2026-10-23');
  changed = model.updateBaseProperty(changed, 'tags', ['work/project', '[[Other]]']);
  const parsed = model.frontmatterDocument(changed);
  assert.equal(parsed.body, body);
  assert.equal(parsed.data.status, '001');
  assert.equal(parsed.data.completed, false);
  assert.equal(parsed.data.price, 0);
  assert.equal(parsed.data['release date'], '2026-10-23');
  assert.deepEqual(parsed.data.tags, ['work/project', '[[Other]]']);
  assert.deepEqual(parsed.data.plugin, { version: 3, enabled: true });
  assert.match(changed, /# existing note/);
});

test('cell edits reject readonly, unsafe and empty properties and invalid frontmatter', () => {
  const text = '---\nprice: 3\n---\n# Original\n';
  for (const property of ['file.name', 'formula.total', 'constructor', 'note.__proto__', '', 'note.']) {
    assert.throws(() => model.updateBaseProperty(text, property, 1), undefined, property);
  }
  assert.throws(() => model.updateBaseProperty('---\nprice: [broken\n---\n# Original\n', 'price', 1));
  assert.equal(model.frontmatterDocument(text).data.price, 3);
});

test('formula evaluation cannot inherit list callback value, index or accumulator bindings', () => {
  const row = record();
  Object.assign(row.props, { value: 10, index: 20, acc: 30 });
  const options = { formulas: { fromNote: 'value + index + acc' } };
  assert.equal(model.evaluateBaseExpression('formula.fromNote', row, options), 60);
  assert.deepEqual(model.evaluateBaseExpression('[1, 2].map(formula.fromNote + value)', row, options), [61, 62]);
  assert.equal(model.evaluateBaseExpression('[1, 2].reduce(acc + formula.fromNote, 0)', row, options), 120);
});

test('string expansion and nested list results remain bounded across all return paths', () => {
  for (const source of [
    'escapeHTML("&".repeat(30000))',
    '[1, 2].map("x".repeat(60000)).toString()',
    '"x".repeat(400).replace("x", "y".repeat(400))',
    '[1, 2, 3, 4, 5].map([1, 2, 3, 4, 5].map("x".repeat(100000)))',
  ]) assert.throws(() => expression(source), undefined, source);
});

test('built-in operations never execute accessors or coercion callbacks from record values', () => {
  const callbackPaths = [];
  for (const source of ['obj.values()', 'obj == obj', 'number(obj)', 'obj.toString()', 'arr[0]', 'arr.map(value)', 'dateValue.year', 'this.file.path']) {
    const row = record();
    let calls = 0;
    row.props.obj = { get hidden() { calls++; return 7; }, valueOf() { calls++; return 8; } };
    row.props.arr = [];
    Object.defineProperty(row.props.arr, 0, { enumerable: true, get() { calls++; return 9; } });
    row.props.dateValue = new Date(2026, 0, 1);
    row.props.dateValue.getFullYear = () => { calls++; return 2026; };
    const options = { thisRecord: { ...record(), props: { get unrelated() { calls++; return 1; } } } };
    try { model.evaluateBaseExpression(source, row, options); } catch { /* Rejecting the unsafe input is acceptable. */ }
    if (calls) callbackPaths.push(`${source}: ${calls}`);
  }
  assert.deepEqual(callbackPaths, []);
});

test('deep syntax and long formula cycles fail before exhausting the JavaScript call stack', () => {
  assert.throws(() => expression('('.repeat(200) + '1' + ')'.repeat(200)), error => {
    assert.notEqual(error.name, 'RangeError');
    return true;
  });
  const formulas = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`f${index}`, `formula.f${(index + 1) % 2000}`]));
  assert.throws(() => model.evaluateBaseExpression('formula.f0', record(), { formulas }), error => {
    assert.notEqual(error.name, 'RangeError', 'formula depth needs an explicit limit in addition to cycle detection');
    return true;
  });
});

test('cyclic YAML aliases cannot reach unbounded native flattening or stringification', () => {
  const row = model.baseRecords({ 'Cyclic.md': '---\na: &a [*a]\n---\n# Body\n' })[0];
  if (row.error) return;
  for (const source of ['a.toString()', 'a.flat()', 'a == a']) {
    try { model.evaluateBaseExpression(source, row); }
    catch (error) {
      assert.notEqual(error.name, 'RangeError', source);
      assert.notEqual(error.name, 'TypeError', source);
    }
  }
});

test('calendar arithmetic clamps month ends and rejects dates beyond the representable range', () => {
  assert.equal(expression('(date("2025-01-31") + "1M").format("YYYY-MM-DD")'), '2025-02-28');
  assert.equal(expression('(date("2024-01-31") + "1M").format("YYYY-MM-DD")'), '2024-02-29');
  for (const source of [
    'date("2025-01-01") + duration("1h") * 1e308',
    'date("2025-01-01") + "9999999999999y"',
  ]) assert.throws(() => expression(source), undefined, source);
});

test('a view random cache keeps formula sorting and repeated display stable independently for each row', t => {
  const rows = model.baseRecords(files).filter(row => row.path.startsWith('Projects/'));
  const [alpha, beta] = rows;
  const options = { formulas: { roll: 'random()' }, randomValues: new Map() };
  const sequence = [0.1, 0.8];
  let draws = 0;
  const random = t.mock.method(Math, 'random', () => sequence[draws++]);
  try {
    assert.equal(model.propertyValue(alpha, 'formula.roll', options), 0.1);
    assert.equal(model.propertyValue(beta, 'formula.roll', options), 0.8);
    const sorted = model.sortBaseRecords(rows, [{ property: 'formula.roll', direction: 'DESC' }], options);
    assert.deepEqual(sorted.map(row => row.path), ['Projects/Beta.md', 'Projects/Alpha.md']);
    assert.equal(model.propertyValue(alpha, 'formula.roll', options), 0.1);
    assert.equal(model.propertyValue(beta, 'formula.roll', options), 0.8);
    assert.equal(model.propertyValue(record(), 'formula.roll', options), 0.1, 'reloaded records with the same path retain the current view value');
    assert.equal(draws, 2, 'sort and display share the same cached draw for each row');
  } finally { random.mock.restore(); }
});

test('random call sites stay distinct and switching to a new view cache creates fresh values', t => {
  const row = record();
  const firstView = { randomValues: new Map() }, nextView = { randomValues: new Map() };
  const sequence = [0.1, 0.2, 0.3, 0.4];
  let draws = 0;
  const random = t.mock.method(Math, 'random', () => sequence[draws++]);
  try {
    assert.deepEqual(model.evaluateBaseExpression('[random(), random()]', row, firstView), [0.1, 0.2]);
    assert.deepEqual(model.evaluateBaseExpression('[random(), random()]', row, firstView), [0.1, 0.2]);
    assert.deepEqual(model.evaluateBaseExpression('[random(), random()]', row, nextView), [0.3, 0.4]);
    assert.deepEqual(model.evaluateBaseExpression('[random(), random()]', row, nextView), [0.3, 0.4]);
    assert.equal(draws, 4);
  } finally { random.mock.restore(); }
});
