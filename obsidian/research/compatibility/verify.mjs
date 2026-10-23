import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { runSuite } from './adapter.mjs';
import { checkCompatibility } from './conformance.mjs';

const read = name => readFile(new URL(name, import.meta.url));
const [corpusBytes, oracleBytes] = await Promise.all([read('cases.json'), read('oracle.json')]);
const corpus = JSON.parse(corpusBytes.toString('utf8'));
const oracle = JSON.parse(oracleBytes.toString('utf8'));
const observations = await runSuite(corpus);
const strict = checkCompatibility(observations, oracle);
const portable = checkCompatibility(observations, oracle, { profile: 'portable-core' });

const controls = [
  ['wrong-root-precedence', value => { value.results.find(row => row.id === 'L02-root').queries[0].path = 'L02/A/NoteL02.md'; }],
  ['lost-collision-target', value => { value.results.find(row => row.id === 'R07-collision').after.files['R07/A/Source.md'].text = '[[NoteR07]]\n'; }],
  ['once-changes-preference', value => { value.results.find(row => row.id === 'R05').after.settings.alwaysUpdateLinks = true; }],
  ['missing-case', value => { value.results = value.results.filter(row => row.id !== 'R10-folder'); }],
];
const negativeControls = controls.map(([name, mutate]) => {
  const changed = structuredClone(observations);
  try {
    mutate(changed);
    const result = checkCompatibility(changed, oracle);
    return { name, rejected: !result.passed, failureLabels: result.failures.map(failure => failure.label) };
  } catch (error) {
    return { name, rejected: false, error: error.message };
  }
});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceNames = ['cases.json', 'oracle.json', 'conformance.mjs', 'run-adapter.mjs', 'negative-controls.mjs', 'adapter.d.ts', 'README.md', 'adapter.mjs', '../../core/vault.mjs'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, sha256(await read(name))])));
const report = {
  schema: 'vaultdesk-independent-compatibility-result-v1',
  generatedAt: new Date().toISOString(),
  implementation: 'VaultDesk independent core via research/compatibility/adapter.mjs',
  reference: oracle.reference,
  coverage: {
    cases: corpus.resolution.length + corpus.renames.length,
    resolutionQueries: corpus.resolution.reduce((count, row) => count + row.queries.length, 0),
    mutationCases: corpus.renames.length,
    boundary: 'Frozen link resolution and rename corpus only; this does not establish full Obsidian or UI compatibility.',
  },
  sourceHashes,
  passed: strict.passed && portable.passed && negativeControls.every(control => control.rejected),
  strict,
  portable,
  negativeControls,
};
await writeFile(new URL('independent-observations.json', import.meta.url), `${JSON.stringify(observations, null, 2)}\n`);
await writeFile(new URL('independent-result.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
