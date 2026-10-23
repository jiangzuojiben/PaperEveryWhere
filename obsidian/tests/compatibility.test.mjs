import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runSuite } from '../research/compatibility/adapter.mjs';
import { checkCompatibility } from '../research/compatibility/conformance.mjs';

const readJson = async name => JSON.parse(await readFile(new URL(`../research/compatibility/${name}`, import.meta.url), 'utf8'));
const [corpus, oracle] = await Promise.all([readJson('cases.json'), readJson('oracle.json')]);
const actual = await runSuite(corpus);

test('independent core conforms to the frozen REA strict-reference corpus', () => {
  const result = checkCompatibility(actual, oracle);
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
  assert.equal(actual.results.length, 20);
  assert.equal(actual.results.filter(row => row.kind === 'resolve').reduce((count, row) => count + row.queries.length, 0), 34);
});

test('portable profile keeps every assertion outside the two declared quirks', () => {
  const result = checkCompatibility(actual, oracle, { profile: 'portable-core' });
  assert.equal(result.passed, true, JSON.stringify(result.failures, null, 2));
  assert.equal(result.diagnostics.filter(row => row.reason === 'observed quirk excluded by profile').length, 2);
});

test('comparator accepts settings key order and observed tied alternatives', () => {
  const reordered = structuredClone(actual);
  for (const row of reordered.results.filter(row => row.after)) {
    row.after.settings = Object.fromEntries(Object.entries(row.after.settings).reverse());
  }
  assert.equal(checkCompatibility(reordered, oracle).passed, true);

  const alternate = structuredClone(actual);
  const query = oracle.cases.find(row => row.id === 'L06-tie-forward').queries[0];
  alternate.results.find(row => row.id === 'L06-tie-forward').queries[0].path = query.acceptedPaths.at(-1);
  assert.equal(checkCompatibility(alternate, oracle).passed, true);
});

// These are the four deliberate defects in the unchanged frozen
// negative-controls.mjs, run here against the independent implementation.
const negativeControls = [
  ['wrong-root-precedence', observation => {
    observation.results.find(row => row.id === 'L02-root').queries[0].path = 'L02/A/NoteL02.md';
  }, 'L02-root: NoteL02 @ L02/A/Source.md'],
  ['lost-collision-target', observation => {
    observation.results.find(row => row.id === 'R07-collision').after.files['R07/A/Source.md'].text = '[[NoteR07]]\n';
  }, 'R07-collision.text:R07/A/Source.md'],
  ['once-changes-preference', observation => {
    observation.results.find(row => row.id === 'R05').after.settings.alwaysUpdateLinks = true;
  }, 'R05.settings'],
  ['missing-case', observation => {
    observation.results = observation.results.filter(row => row.id !== 'R10-folder');
  }, 'R10-folder'],
];

for (const [name, mutate, expectedFailure] of negativeControls) {
  test(`comparator rejects frozen negative control: ${name}`, () => {
    const changed = structuredClone(actual);
    mutate(changed);
    const result = checkCompatibility(changed, oracle);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some(failure => failure.label === expectedFailure), JSON.stringify(result.failures));
  });
}

test('adapter keeps its corpus and each settings snapshot isolated', async () => {
  const before = structuredClone(corpus);
  const rerun = await runSuite(corpus);
  assert.deepEqual(corpus, before);
  assert.deepEqual(rerun, actual);
  assert.equal(rerun.results.find(row => row.id === 'R05').after.settings.alwaysUpdateLinks, false);
  assert.equal(rerun.results.find(row => row.id === 'R06').after.settings.alwaysUpdateLinks, true);
});

test('adapter prompts when a new name would redirect a link to an unmoved target', async () => {
  const collision = structuredClone(corpus.renames.find(row => row.id === 'R07-collision'));
  collision.settings.alwaysUpdateLinks = false;
  collision.action.decision = 'once';
  const observed = await runSuite({ schema: corpus.schema, resolution: [], renames: [collision] });
  assert.equal(observed.status, 'complete');
  const row = observed.results[0];
  assert.equal(row.operationError, null);
  assert.equal(row.prompt?.decision, 'once');
  assert.equal(row.after.files['R07/A/Source.md'].text, '[[R07/B/NoteR07]]\n');
  assert.equal(row.after.files['R07/A/Source.md'].references[0].path, 'R07/B/NoteR07.md');
  assert.equal(row.after.settings.alwaysUpdateLinks, false);
});
