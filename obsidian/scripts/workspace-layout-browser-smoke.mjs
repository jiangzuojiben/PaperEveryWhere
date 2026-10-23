import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'output', 'playwright');
const npmCandidates = [
  process.env.npm_execpath && path.join(path.dirname(process.env.npm_execpath), 'npx-cli.js'),
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
].filter(Boolean);
const npx = npmCandidates.find(candidate => existsSync(candidate));
assert.ok(npx, 'Node/npm is required; run this script with the Node installation that provides npx.');
const session = `workspace-layout-${process.pid}`;
await mkdir(output, { recursive: true });

async function cli(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npx, '--no-install', '--package', '@playwright/cli', 'playwright-cli', `-s=${session}`, ...args], { cwd: root, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`playwright-cli ${args[0]} exited ${code}: ${stderr || stdout}`)));
  });
}

const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = await createServer({ root, server: { host: '127.0.0.1', port, strictPort: true } });
await server.listen();
const url = `http://127.0.0.1:${port}/tests/fixtures/workspace-layout.html`;
try {
  await cli('open', url, '--browser', 'chrome', ...(process.argv.includes('--headed') ? ['--headed'] : []));
  await writeFile(path.join(output, 'workspace-layout-snapshot-before.txt'), await cli('snapshot'));
  const probes = JSON.parse(await cli('--raw', 'run-code', '--filename', 'tests/fixtures/workspace-layout-probes.js'));
  await writeFile(path.join(output, 'workspace-layout-probes.json'), JSON.stringify(probes, null, 2));
  assert.ok(probes.every(result => result.pass), `Geometry regression: ${JSON.stringify(probes.filter(result => !result.pass))}`);
  await cli('snapshot');
  const report = JSON.parse(await cli('--raw', 'run-code', '--filename', 'tests/fixtures/workspace-layout-actions.js'));
  assert.equal(report.status, 'passed');
  const consoleOutput = await cli('console', 'error');
  assert.ok(/Errors: 0/.test(consoleOutput), consoleOutput);
  await writeFile(path.join(output, 'workspace-layout-console.txt'), consoleOutput);
  await writeFile(path.join(output, 'workspace-layout-snapshot-after.txt'), await cli('snapshot'));
  await writeFile(path.join(output, 'workspace-layout-report.json'), JSON.stringify({ url, ...report }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: report.checks.length, geometryRegressions: probes.length, report: path.join(output, 'workspace-layout-report.json'), screenshot: path.join(output, 'workspace-layout.png') }, null, 2));
} finally {
  await cli('close').catch(() => {});
  await server.close();
}
