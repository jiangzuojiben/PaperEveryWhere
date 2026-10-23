import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCli } from '../desktop/cli.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vaultdesk-cli-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('vaultdesk-cli-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, invoke: (...args) => runCli(['--vault', root, ...args]) };
}

test('CLI requires an explicit absolute vault and reports errors as JSON', async () => {
  await assert.rejects(runCli(['list']), /explicit --vault/);
  await assert.rejects(runCli(['--vault','relative','list']), /absolute/);
  assert.ok((await runCli(['--help'])).commands.rename);
  const entry = fileURLToPath(new URL('../desktop/cli.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry, 'list'], { windowsHide:true, env:{ ...process.env, VAULTDESK_VAULT:'C:\\ShouldNeverBeOpened' } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(JSON.parse(stderr).error.message, /explicit --vault/);
});

test('CLI creates, reads, appends, lists, searches and maintains rename references', async (t) => {
  const { root, invoke } = await fixture(t);
  await invoke('create','Notes/Target.md','first');
  await invoke('create','Source.md','[[Notes/Target]]');
  await invoke('append','Notes/Target.md','--content','\nsecond searchable');
  assert.equal((await invoke('read','Notes/Target.md')).content, 'first\nsecond searchable');
  assert.equal((await invoke('read','Notes/Target.md')).encoding, 'utf8');
  assert.ok((await invoke('list','Notes')).files.some((file) => file.path === 'Notes/Target.md' && !Object.hasOwn(file, 'content')));
  assert.equal((await invoke('search','searchable')).results[0].path, 'Notes/Target.md');
  await invoke('rename','Notes/Target.md','Renamed.md');
  assert.equal((await invoke('read','Source.md')).content, '[[Renamed]]');
  await assert.rejects(invoke('create','Renamed.md','overwrite'), /already exists/);
  await assert.rejects(invoke('create','../escape.md','no'), /unsafe/);
  await runCli(['--vault',root,'create','Stdin.md','--stdin'], { input: Readable.from(['line one\n','line two']) });
  assert.equal((await invoke('read','Stdin.md')).content, 'line one\nline two');
});

test('CLI supports storage-only rename and lossless binary reads', async (t) => {
  const { root, invoke } = await fixture(t);
  await invoke('create','Original.md','body');
  await invoke('create','Source.md','[[Original]]');
  await invoke('rename','Original.md','Moved.md','--no-update-links');
  assert.equal((await invoke('read','Source.md')).content, '[[Original]]');
  const binary = Buffer.from([0,255,42,0]);
  await fs.writeFile(path.join(root,'data.bin'),binary);
  const result = await invoke('read','data.bin');
  assert.equal(result.encoding,'base64');
  assert.deepEqual(Buffer.from(result.content,'base64'),binary);
  await assert.rejects(invoke('append','data.bin','bad'),/text files only/);
});
