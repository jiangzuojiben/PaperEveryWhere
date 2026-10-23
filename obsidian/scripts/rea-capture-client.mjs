import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Captures a synthetic local client session. It does not assert data persistence or parity.
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (!['--url', '--output', '--rea', '--browser', '--scenario'].includes(key) || !value) throw new Error('Usage: node rea-capture-client.mjs --url LOCAL_URL --output NEW_RAW_DIR [--rea REA_PACKAGE_DIR] [--browser CHROME_EXE] [--scenario SCENARIO.json]');
  options[key.slice(2)] = value;
}
if (!options.url || !options.output) throw new Error('--url and --output are required');
const url = new URL(options.url);
if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use a local synthetic-test client URL.');
if (fs.existsSync(options.output)) throw new Error('Output directory must be new.');
let reaPackage = options.rea;
if (!reaPackage) {
  const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  for (const cache of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!cache.isDirectory()) continue;
    const candidate = path.join(cacheRoot, cache.name, 'node_modules', 'rea-agents');
    const manifest = path.join(candidate, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).version === '6.7.0') { reaPackage = candidate; break; }
  }
}
if (!reaPackage || JSON.parse(fs.readFileSync(path.join(reaPackage, 'package.json'), 'utf8')).version !== '6.7.0') throw new Error('REA 6.7.0 is required.');
const browser = options.browser || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
if (!fs.existsSync(browser)) throw new Error('Supply a supported browser executable with --browser.');
const scenario = options.scenario ? JSON.parse(fs.readFileSync(options.scenario, 'utf8').replace(/^\uFEFF/, '')) : {
  browser: { mode: 'launch', executable_path: browser }, start_url: { url: url.href },
  actions: [{ step_id: 'wait-for-client-document', action: 'wait_for', locator: { kind: 'css', selector: 'body' }, state: 'visible', timeout_ms: 15000 }],
  capture: { at_end: ['dom', 'accessibility', 'url'] },
};
if (scenario.start_url?.url !== url.href) throw new Error('Scenario start_url must match --url.');
fs.mkdirSync(options.output, { recursive: true });
const scenarioPath = path.resolve(options.output, 'scenario.json');
fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2), { flag: 'wx' });
const stdout = fs.openSync(path.join(options.output, 'rea-browser.json'), 'wx');
const stderr = fs.openSync(path.join(options.output, 'rea-browser.stderr.txt'), 'wx');
try {
  const child = spawn(process.execPath, [path.join(reaPackage, 'scripts', 'rea.mjs'), 'capture-browser-scenario', scenarioPath, '--json'], { windowsHide: true, stdio: ['ignore', stdout, stderr] });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  fs.writeFileSync(path.join(options.output, 'capture-status.json'), JSON.stringify({ ...result, scope: 'independent-local-client', assertions: 'none', parity: 'not-assessed' }, null, 2), { flag: 'wx' });
  process.exitCode = result.code ?? 1;
  console.log(JSON.stringify({ output: options.output, ...result, parity: 'not-assessed' }));
} finally {
  fs.closeSync(stdout); fs.closeSync(stderr);
}
