import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';

const tag = process.argv[2], probeName = process.argv[3] || 'discover.js';
if (!/^[a-z0-9-]+$/.test(tag || '') || !/^[a-z0-9-]+\.js$/.test(probeName)) throw Error('Usage: node research/windows-round2/run.mjs UNIQUE_TAG PROBE.js');
const root = path.resolve(import.meta.dirname, '..', '..');
const run = path.join(root, 'research', 'raw', 'windows-round2-' + tag);
if (fs.existsSync(run)) throw Error('A fresh tag is required');
fs.mkdirSync(run, { recursive: true });
const profile = path.join(run, 'profile'), vault = path.join(run, 'vault');
fs.mkdirSync(profile); fs.mkdirSync(vault);
const files = {
  'Start.md': '# Start\n\n[[Sources/Note#Section One]]\n[[Sources/Note#^anchor-one]]\n',
  'Sources/Note.md': '# Note\n\n## Section One\n\nBlock target text. ^anchor-one\n\n## Section Two\n\nSecond section.\n',
  'Sources/Other.md': '# Other\n\nAnother note.\n',
  'Templates/Daily.md': '# {{title}}\nDate={{date:YYYY/MM/DD}}\nTime={{time:HH:mm}}\nDefault={{date}}\n',
  'Templates/Unique.md': '# {{title}}\nUnique={{date:YYYY-MM-DD}}\n',
  'Present.md': '# First slide\n\nFirst body.\n\n---\n\n# Second slide\n\nSecond body.\n\n---\n\n# Third slide\n',
  'Convert.md': '# Conversion\n\n[[Page Name]] [[Page Name|Shown]]\n[[Page Name#Heading]]\n#tag #tag/sub\n==highlight==\n[Page](Page%20Name.md)\n',
};
for (const [name, text] of Object.entries(files)) { const target = path.join(vault, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
for (const name of ['Journal', 'Unique']) fs.mkdirSync(path.join(vault, name));
fs.mkdirSync(path.join(vault, '.obsidian'));
const plugins = ['file-explorer', 'global-search', 'switcher', 'backlink', 'outline', 'bookmarks', 'daily-notes', 'zk-prefixer', 'templates', 'workspaces', 'slides', 'markdown-importer', 'webviewer'];
fs.writeFileSync(path.join(vault, '.obsidian', 'app.json'), JSON.stringify({ alwaysUpdateLinks: true, newLinkFormat: 'shortest', useMarkdownLinks: false }));
fs.writeFileSync(path.join(vault, '.obsidian', 'core-plugins.json'), JSON.stringify(plugins));
fs.writeFileSync(path.join(vault, '.obsidian', 'community-plugins.json'), '[]');
fs.writeFileSync(path.join(vault, '.obsidian', 'daily-notes.json'), JSON.stringify({ folder: 'Journal', template: 'Templates/Daily.md', format: 'YYYY-MM-DD' }));
fs.writeFileSync(path.join(vault, '.obsidian', 'zk-prefixer.json'), JSON.stringify({ folder: 'Unique', template: 'Templates/Unique.md', format: 'YYYYMMDDHHmmss' }));
fs.writeFileSync(path.join(profile, 'obsidian.json'), JSON.stringify({ vaults: { 'round2-lab': { path: vault, ts: Date.now(), open: true } }, updateDisabled: true, language: 'en' }));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const coreAsar = path.join(process.env.APPDATA, 'obsidian', 'obsidian-1.13.7.asar');
const coreSha256 = hash(fs.readFileSync(coreAsar));
if (coreSha256 !== 'a52a7daf1e2460bae03de80f2816604bd16a56cd374fbe5ce8d1a9ef5604059d') throw Error('Unexpected original core');
const cfg = { run, profile, vault, coreAsar, coreSha256, shellAsar: path.join(process.env.LOCALAPPDATA, 'Programs', 'Obsidian', 'resources', 'app.asar'), probe: path.join(run, 'probe.js'), report: path.join(run, 'observations.json'), hostLog: path.join(run, 'host.jsonl'), plugins, fixtureSha256: hash(JSON.stringify(files)) };
fs.copyFileSync(path.join(import.meta.dirname, 'bootstrap.cjs'), path.join(run, 'bootstrap.cjs'));
fs.copyFileSync(path.join(import.meta.dirname, probeName), cfg.probe);
const page = `<!doctype html><meta charset="utf-8"><title>Isolated Windows reference research</title><h1>Original Obsidian 1.13.7 isolated API probe</h1><p>REA drives this controller; the untouched reference core executes the probes in a synthetic vault. Remote network is denied.</p><button id="start">Start isolated reference cases</button><pre id="result" data-state="pending">Waiting</pre><script>document.querySelector('#start').onclick=async e=>{e.target.disabled=true;await fetch('/start',{method:'POST'});const t=setInterval(async()=>{const r=await(await fetch('/status')).json();document.querySelector('#result').textContent=JSON.stringify(r,null,2);if(r.status==='complete'||r.status==='failed'){clearInterval(t);document.querySelector('#result').dataset.state='finished';}},200);};</script>`;
fs.writeFileSync(path.join(run, 'control.html'), page);
const server = http.createServer((req, res) => {
  if (req.url === '/start' && req.method === 'POST') { fs.writeFileSync(path.join(run, 'start.signal'), 'start'); return res.end('started'); }
  if (req.url === '/fixture') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end('<!doctype html><title>Local Reference Fixture</title><h1>Local web viewer fixture</h1><p id="marker">Synthetic offline content.</p><a href="/fixture-next">Next local page</a>'); }
  if (req.url === '/fixture-next') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end('<!doctype html><title>Local Fixture Next</title><h1>Local next page</h1>'); }
  if (req.url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    if (!fs.existsSync(cfg.report)) return res.end(JSON.stringify({ status: 'running' }));
    const bytes = fs.readFileSync(cfg.report), result = JSON.parse(bytes);
    return res.end(JSON.stringify({ status: result.status, error: result.error, reportSha256: hash(bytes), coreSha256, fixtureSha256: cfg.fixtureSha256, results: result.results }));
  }
  res.setHeader('Content-Type', 'text/html;charset=utf-8'); res.end(page);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
cfg.localUrl = `http://127.0.0.1:${server.address().port}`;
fs.writeFileSync(path.join(run, 'run-config.json'), JSON.stringify(cfg, null, 2));
let rea;
for (const cache of fs.readdirSync(path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'))) {
  const candidate = path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx', cache, 'node_modules', 'rea-agents');
  if (fs.existsSync(path.join(candidate, 'package.json')) && JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8')).version === '6.7.0') { rea = path.join(candidate, 'scripts', 'rea.mjs'); break; }
}
if (!rea) throw Error('REA 6.7.0 unavailable');
const output = fs.openSync(path.join(run, 'application.stdout.txt'), 'wx'), errorOutput = fs.openSync(path.join(run, 'application.stderr.txt'), 'wx');
const app = spawn(path.join(process.env.LOCALAPPDATA, 'Obsidian-REA-Lab', 'electron-39.8.3', 'electron.exe'), [path.join(run, 'bootstrap.cjs'), '--disable-gpu'], { windowsHide: true, stdio: ['ignore', output, errorOutput] });
const appExit = new Promise(resolve => app.once('exit', (code, signal) => resolve({ code, signal })));
const scenario = { browser: { mode: 'launch', executable_path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }, start_url: { url: cfg.localUrl + '/' }, actions: [{ step_id: 'start-isolated-original-windows-probes', action: 'click', locator: { kind: 'css', selector: '#start' }, timeout_ms: 10000 }, { step_id: 'capture-report-and-screenshot-hashes', action: 'wait_for', locator: { kind: 'css', selector: '#result[data-state="finished"]' }, state: 'visible', timeout_ms: 180000 }], capture: { at_end: ['dom', 'accessibility', 'url'] } };
const scenarioFile = path.join(run, 'browser-scenario.json'); fs.writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2));
console.log(JSON.stringify({ run, pid: app.pid, boundary: 'new synthetic vault/profile; original remote network denied; REA controls local controller' }));
let reaCode, status;
try {
  const out = fs.openSync(path.join(run, 'rea-browser.json'), 'wx'), err = fs.openSync(path.join(run, 'rea-browser.stderr.txt'), 'wx');
  const child = spawn(process.execPath, [rea, 'capture-browser-scenario', scenarioFile, '--json'], { windowsHide: true, stdio: ['ignore', out, err] });
  reaCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); fs.closeSync(out); fs.closeSync(err);
  status = fs.existsSync(cfg.report) ? JSON.parse(fs.readFileSync(cfg.report, 'utf8')).status : 'missing-report';
} finally {
  fs.writeFileSync(path.join(run, 'stop.signal'), 'stop');
  const exit = await Promise.race([appExit, new Promise(resolve => setTimeout(() => resolve({ unverified: true }), 12000))]);
  const lifecycle = { pid: app.pid, owned: true, exit, reaCode, status, sourceUnchanged: hash(fs.readFileSync(coreAsar)) === coreSha256 };
  fs.writeFileSync(path.join(run, 'lifecycle.json'), JSON.stringify(lifecycle, null, 2));
  server.close(); fs.closeSync(output); fs.closeSync(errorOutput); console.log(JSON.stringify(lifecycle));
  if (exit.unverified) { app.kill(); throw Error('Normal owned process cleanup timed out; terminate requested'); }
}
if (reaCode || status !== 'complete') process.exitCode = 1;
