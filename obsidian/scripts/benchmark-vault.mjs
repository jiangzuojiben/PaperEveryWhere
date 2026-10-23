/** Temp-only host/index baseline. This does not measure rendering or input latency.
 * Run: node --expose-gc scripts/benchmark-vault.mjs
 * Optional: --sizes=100,1000,10000 --warm-runs=2 (no vault path is accepted).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {setImmediate as yieldEventLoop} from 'node:timers/promises';
import {VaultStore} from '../desktop/vault-store.mjs';
import {parseMarkdown, getReferences, createLinkIndex} from '../core/vault.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(project, 'research', 'windows-performance.json');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const rounded = value => Math.round(value * 100) / 100;
const allowedSizes = [100, 1000, 10000];
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--(sizes|warm-runs)=(.+)$/);
  if (!match) throw new Error('Supported options: --sizes=100,1000,10000 --warm-runs=2');
  return [match[1], match[2]];
}));
const sizes = options.sizes ? options.sizes.split(',').map(Number) : allowedSizes;
assert.ok(sizes.length && new Set(sizes).size === sizes.length && sizes.every(size => allowedSizes.includes(size)), 'Sizes must be a subset of 100,1000,10000');
const warmRuns = Number(options['warm-runs'] || 2);
const unpreparedLimitMs = 30000;
assert.ok(Number.isInteger(warmRuns) && warmRuns >= 1 && warmRuns <= 5, 'Warm runs must be from 1 to 5');
const sourcePaths = ['desktop/vault-store.mjs', 'core/vault.mjs', 'app/App.jsx', 'app/FileTree.jsx'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, sha256(await fs.readFile(path.join(project, file)))])));
const fixedMtime = new Date('2024-01-02T03:04:05.000Z');
const noteBytes = 1536;
const report = {
  schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(),
  syntheticDataOnly: true, measuresUiLatency: false,
  environment: {platform: process.platform, release: os.release(), arch: process.arch, node: process.version, logicalCpus: os.cpus().length, cpuModel: os.cpus()[0]?.model || 'unknown', totalMemoryGiB: rounded(os.totalmem() / 1024 ** 3), gcExposed: typeof global.gc === 'function', uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE || 'Node default'},
  methodology: {sizes, warmRuns, unpreparedLimitMs, bytesPerNote: noteBytes, internalReferencesPerNote: 2, folders: 10, fileWatcher: false, creationConcurrency: 32,
    coldMeaning: 'First snapshot of a newly opened VaultStore. OS disk cache is not flushed; generated files may already be cached.',
    warmMeaning: 'Repeated unchanged snapshots in the same process and store; VaultStore currently has no snapshot content cache.',
    heapMeaning: 'heapUsed after minus before each stage, GC requested before timing when exposed; not peak memory or retained memory.',
    indexMeaning: 'Sequential parseMarkdown over every note; unprepared getReferences receives the full path array and parses again, capped at 30 seconds after finishing the current note; prepared getReferences always processes all notes with createLinkIndex and already parsed metadata. Index preparation is timed separately. Partial results are not extrapolated. Chunk yields/progress are included in elapsed wall time.',
    exclusions: ['Electron IPC', 'React render/commit', 'file tree DOM', 'editor input latency', 'OS cold disk cache', 'network/cloud', 'real user data']},
  sourceSha256: await sourceHashes(), results: [], cleanup: {temporaryDataRemoved: false},
};
let temporaryRoot, activeStore, cancelled = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cancelled = true; process.exitCode = signal === 'SIGINT' ? 130 : 143; });
const checkCancelled = () => { if (cancelled) throw Object.assign(new Error('Benchmark interrupted; partial results retained'), {code: 'INTERRUPTED'}); };
const persist = () => fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const progress = async (scale, phase, completed, total, elapsedMs) => {
  report.progress = {files: scale, phase, completed, total, elapsedMs: rounded(elapsedMs)};
  await persist();
  console.log(`${scale} files: ${phase} ${completed}/${total}, ${rounded(elapsedMs)} ms`);
  await yieldEventLoop(); checkCancelled();
};
const notePath = index => `Group-${String(index % 10).padStart(2, '0')}/Note-${String(index).padStart(6, '0')}.md`;
function noteText(index, size) {
  const next = notePath((index + 1) % size).replace(/\.md$/, ''), previous = notePath((index + size - 1) % size);
  const text = `---\ntitle: Synthetic note ${index}\nstatus: active\ntags: [benchmark, group-${index % 10}]\n---\n# 标题 ${index}\n\n[[${next}|next]] and [previous](${previous})\n\n## Tasks\n- [ ] Review synthetic content\n- [x] Keep real files untouched\n\nParagraph for deterministic indexing. **Bold** and *italic*. #benchmark\n\n`;
  return text + 'x'.repeat(noteBytes - Buffer.byteLength(text, 'utf8') - 1) + '\n';
}
async function timed(operation) {
  global.gc?.();
  const before = process.memoryUsage(), start = performance.now();
  const value = await operation();
  const elapsedMs = performance.now() - start, after = process.memoryUsage();
  return {value, metrics: {elapsedMs: rounded(elapsedMs), heapBeforeBytes: before.heapUsed, heapAfterBytes: after.heapUsed, heapDeltaBytes: after.heapUsed - before.heapUsed, rssDeltaBytes: after.rss - before.rss}};
}
function validateSnapshot(snapshot, size) {
  const notes = snapshot.files.filter(file => !file.isDirectory), expected = new Set(Array.from({length: size}, (_, i) => notePath(i)));
  assert.equal(notes.length, size);
  let verified = 0;
  for (const file of notes) {
    assert.ok(expected.delete(file.path));
    const index = Number(file.path.match(/Note-(\d+)\.md$/)[1]), text = noteText(index, size);
    assert.equal(file.content, text); assert.equal(file.size, noteBytes); assert.equal(file.version, sha256(text));
    assert.ok(Number.isFinite(file.mtime) && Math.abs(file.mtime - fixedMtime.getTime()) <= 1);
    verified++;
  }
  assert.equal(expected.size, 0);
  return {verifiedFiles: verified, totalBytes: notes.reduce((sum, file) => sum + file.size, 0), manifestSha256: sha256(JSON.stringify(notes.map(({path, size, mtime, version}) => [path, size, mtime, version]))), allMtimesMatchSyntheticTimestamp: true, allContentHashesMatch: true};
}

try {
  await fs.mkdir(path.dirname(output), {recursive: true});
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vaultdesk-performance-'));
  await persist();
  for (const size of sizes) {
    checkCancelled();
    const item = {files: size, status: 'running', snapshotWarm: []}; report.results.push(item);
    const root = path.join(temporaryRoot, `vault-${size}`); await fs.mkdir(root);
    for (let group = 0; group < 10; group++) await fs.mkdir(path.join(root, `Group-${String(group).padStart(2, '0')}`));
    const creationStart = performance.now();
    for (let offset = 0; offset < size; offset += 32) {
      await Promise.all(Array.from({length: Math.min(32, size - offset)}, async (_, j) => {
        const index = offset + j, file = path.join(root, ...notePath(index).split('/'));
        await fs.writeFile(file, noteText(index, size), {flag: 'wx'}); await fs.utimes(file, fixedMtime, fixedMtime);
      }));
      checkCancelled();
    }
    item.fixtureCreationMs = rounded(performance.now() - creationStart);
    activeStore = await VaultStore.open(root, {watchFiles: false});
    activeStore.on('warning', () => { item.storeWarnings = (item.storeWarnings || 0) + 1; });
    let measurement = await timed(() => activeStore.snapshot());
    item.snapshotCold = measurement.metrics; item.integrity = validateSnapshot(measurement.value, size);
    measurement = null;
    await progress(size, 'snapshot first-open', size, size, item.snapshotCold.elapsedMs);
    let snapshot;
    for (let run = 0; run < warmRuns; run++) {
      snapshot = null;
      measurement = await timed(() => activeStore.snapshot());
      const integrity = validateSnapshot(measurement.value, size);
      assert.equal(integrity.manifestSha256, item.integrity.manifestSha256);
      item.snapshotWarm.push(measurement.metrics); snapshot = measurement.value; measurement = null;
      await progress(size, `snapshot warm ${run + 1}`, size, size, item.snapshotWarm.at(-1).elapsedMs);
    }
    const notes = snapshot.files.filter(file => !file.isDirectory), paths = notes.map(file => file.path);
    let parseCount = 0, references = 0, resolved = 0, unpreparedFiles = 0;
    measurement = await timed(async () => {
      const result = []; const start = performance.now();
      for (let i = 0; i < notes.length; i++) {
        result.push(parseMarkdown(notes[i].content)); parseCount++;
        if ((i + 1) % 500 === 0) await progress(size, 'parseMarkdown', i + 1, size, performance.now() - start);
      }
      return result;
    });
    const parsed = measurement.value;
    item.parseMarkdown = {...measurement.metrics, parsedFiles: parseCount}; measurement = null;
    await progress(size, 'parseMarkdown done', size, size, item.parseMarkdown.elapsedMs);
    measurement = await timed(async () => {
      const result = []; const start = performance.now();
      for (let i = 0; i < notes.length; i++) {
        const refs = getReferences(notes[i].content, notes[i].path, paths);
        references += refs.length; resolved += refs.filter(ref => ref.path).length; result.push(refs);
        unpreparedFiles++;
        if ((i + 1) % 100 === 0) await progress(size, 'getReferences unprepared', i + 1, size, performance.now() - start);
        if (performance.now() - start >= unpreparedLimitMs) break;
      }
      return result;
    });
    const unpreparedHash = sha256(JSON.stringify(measurement.value));
    item.getReferencesUnprepared = {...measurement.metrics, status: unpreparedFiles === size ? 'completed' : 'time-limited', indexedFiles: unpreparedFiles, totalFiles: size, references, resolvedReferences: resolved,
      ...(unpreparedFiles < size ? {fullIndexLowerBoundMs: measurement.metrics.elapsedMs, extrapolated: false} : {})}; measurement = null;
    assert.equal(references, unpreparedFiles * 2); assert.equal(resolved, references);
    measurement = await timed(() => createLinkIndex(paths));
    const linkIndex = measurement.value; item.createLinkIndex = measurement.metrics; measurement = null;
    measurement = await timed(async () => {
      const result = []; const start = performance.now();
      for (let i = 0; i < notes.length; i++) {
        result.push(getReferences(notes[i].content, notes[i].path, linkIndex, parsed[i]));
        if ((i + 1) % 500 === 0) await progress(size, 'getReferences prepared', i + 1, size, performance.now() - start);
      }
      return result;
    });
    assert.equal(sha256(JSON.stringify(measurement.value.slice(0, unpreparedFiles))), unpreparedHash);
    assert.equal(measurement.value.reduce((count, refs) => count + refs.length, 0), size * 2);
    assert.ok(measurement.value.every(refs => refs.every(ref => ref.path)));
    item.getReferencesPrepared = {...measurement.metrics, status: 'completed', indexedFiles: notes.length, references: size * 2, resolvedReferences: size * 2, comparedUnpreparedFiles: unpreparedFiles, sameReferencesForComparedPrefix: true}; measurement = null;
    const probePath = paths[0], original = await activeStore.read(probePath), absolute = path.join(root, ...probePath.split('/'));
    const altered = original.content.replace('Synthetic note', 'synthetic note'); assert.equal(Buffer.byteLength(altered), noteBytes);
    await fs.writeFile(absolute, altered); await fs.utimes(absolute, fixedMtime, fixedMtime);
    const changed = await activeStore.read(probePath);
    assert.equal(changed.mtime, original.mtime); assert.notEqual(changed.version, original.version); assert.equal(changed.version, sha256(altered));
    await fs.writeFile(absolute, original.content); await fs.utimes(absolute, fixedMtime, fixedMtime);
    const restored = await activeStore.read(probePath); assert.equal(restored.version, original.version);
    item.sameSizeSameMtimeProbe = {mtimePreserved: true, sizePreserved: true, contentHashChanged: true, originalHashRestored: true, method: 'VaultStore.read, also used by snapshot via readBytes'};
    item.status = 'completed'; activeStore.close(); activeStore = null;
    await progress(size, 'completed', size, size, item.getReferencesPrepared.elapsedMs);
  }
  report.status = 'completed';
} catch (error) {
  report.status = cancelled ? 'interrupted' : 'failed'; process.exitCode ||= 1;
  report.failure = {name: error.name, code: error.code || null, message: String(error.message).replaceAll(temporaryRoot || '\0', '[temporary]').replaceAll(project, '[project]').replaceAll(os.homedir(), '[home]').slice(0, 1000)};
  console.error(`${report.status}: ${report.failure.message}`);
} finally {
  activeStore?.close();
  try {
    if (temporaryRoot) {
      const parent = await fs.realpath(os.tmpdir()), resolved = await fs.realpath(temporaryRoot);
      assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
      assert.ok(path.basename(resolved).startsWith('vaultdesk-performance-'));
      assert.equal(resolved.toLowerCase(), path.resolve(temporaryRoot).toLowerCase());
      await fs.rm(resolved, {recursive: true, force: false, maxRetries: 4, retryDelay: 250});
      report.cleanup = {temporaryDataRemoved: !(await fs.stat(resolved).then(() => true, () => false)), boundaryVerified: true};
    }
  } catch (error) { report.status = 'failed'; report.cleanup = {temporaryDataRemoved: false, boundaryVerified: false, errorCode: error.code || error.name}; process.exitCode = 1; }
  report.sourceSha256After = await sourceHashes();
  report.sourceChangedDuringRun = sourcePaths.filter(file => report.sourceSha256[file] !== report.sourceSha256After[file]);
  report.finishedAt = new Date().toISOString();
  await persist(); console.log(`${report.status}: research/windows-performance.json; temporary cleanup=${report.cleanup.temporaryDataRemoved}`);
}
