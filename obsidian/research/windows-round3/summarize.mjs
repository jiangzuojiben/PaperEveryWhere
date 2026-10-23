import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..', '..');
const tags = process.argv.slice(2);
if (!tags.length || tags.some(tag => !/^[a-z0-9-]+$/.test(tag))) throw Error('Provide adopted original-reference run tags');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const runs = [];
for (const tag of tags) {
  const run = path.join(root, 'research', 'raw', 'windows-round3-' + tag);
  const reportBytes = fs.readFileSync(path.join(run, 'observations.json'));
  const observations = JSON.parse(reportBytes);
  const lifecycle = JSON.parse(fs.readFileSync(path.join(run, 'lifecycle.json'), 'utf8'));
  const reaBytes = fs.readFileSync(path.join(run, 'rea-browser.json'));
  const rea = JSON.parse(reaBytes);
  if (observations.status !== 'complete' || lifecycle.exit.code !== 0 || lifecycle.reaCode !== 0 || !lifecycle.sourceUnchanged || !rea.evidence_id) throw Error('Incomplete reference run: ' + tag);
  if (observations.results.some(result => result.status !== 'observed')) throw Error('Unreviewed probe result: ' + tag);
  if (!JSON.stringify(rea).includes(hash(reportBytes))) throw Error('REA capture does not bind report hash: ' + tag);
  const screenshotDir = path.join(import.meta.dirname, 'screenshots', tag);
  const screenshots = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.name === 'string' && /^[a-z0-9-]+\.png$/.test(value.name) && /^[0-9a-f]{64}$/.test(value.sha256 || '')) {
      const bytes = fs.readFileSync(path.join(run, value.name));
      if (hash(bytes) !== value.sha256) throw Error('Screenshot identity mismatch: ' + value.name);
      fs.mkdirSync(screenshotDir, { recursive: true });
      const target = path.join(screenshotDir, value.name); fs.writeFileSync(target, bytes);
      value.artifact = path.relative(root, target).replaceAll('\\', '/');
      if (!screenshots.some(item => item.name === value.name)) screenshots.push({ ...value });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(observations.results);
  const hostEvents = fs.readFileSync(path.join(run, 'host.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const httpFile = path.join(run, 'http-fixture.jsonl');
  runs.push({
    tag, evidenceId: rea.evidence_id, reportSha256: hash(reportBytes), reaFileSha256: hash(reaBytes),
    rawDirectory: 'research/raw/windows-round3-' + tag,
    copiedBootstrapSha256: hash(fs.readFileSync(path.join(run, 'bootstrap.cjs'))),
    copiedProbeSha256: hash(fs.readFileSync(path.join(run, 'probe.js'))),
    lifecycle, screenshots,
    blockedNetwork: hostEvents.filter(item => /blocked-(node|renderer)-network/.test(item.kind)),
    hostErrors: hostEvents.filter(item => ['error', 'unhandled-rejection', 'inject-error', 'watchdog'].includes(item.kind)),
    localHttpFixture: fs.existsSync(httpFile) ? fs.readFileSync(httpFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    observations,
  });
}
const sources = Object.fromEntries(fs.readdirSync(import.meta.dirname).filter(name => /\.(?:js|cjs|mjs)$/.test(name)).map(name => [name, hash(fs.readFileSync(path.join(import.meta.dirname, name)))]));
const summary = {
  schema: 'vaultdesk-original-windows-round3-reference-v1', date: new Date().toISOString(), referenceOnly: true,
  reference: { coreVersion: '1.13.7', coreSha256: 'a52a7daf1e2460bae03de80f2816604bd16a56cd374fbe5ce8d1a9ef5604059d', os: 'Windows', electron: '39.8.3', timezone: 'Asia/Hong_Kong', rea: '6.7.0' },
  method: 'REA drives a loopback controller. An independent laboratory bootstrap loads the unchanged original core in a fresh synthetic vault and profile. Self-authored fixture plugins are loaded by the original plugin manager and receive the original public API. The renderer invokes original APIs, observes DOM and files, and returns a report whose SHA-256 appears in REA DOM/accessibility capture. This is not a direct REA capture of the Electron surface and not an equality comparison with the independent implementation.',
  isolation: 'Fresh synthetic profile/session/vault per run; original core SHA-256 is pinned and rechecked. No real vault/account/credentials loaded. Guards deny remote Electron HTTP(S)/WS(S) and Node http/https.request/get, external URL opening and OS protocol registration. Only local synthetic HTTP request fixtures are allowed. The guard is not an operating-system sandbox. Original app and REA owned processes exit normally for every adopted run.',
  interpretation: 'complete/observed means that the probe completed and produced data. It does not mean that every attempted behavior was successful, that errors are desirable compatibility targets, or that the independent implementation passed. Findings apply only to the sampled core version, settings and inputs.',
  screenshotMethod: 'Original Electron windows are briefly shown without activation before capturePage, then hidden; PNG hashes are checked when copied into this reference bundle.',
  counts: { adoptedRuns: runs.length, observationRecords: runs.reduce((n,run)=>n+run.observations.results.length,0), screenshots: runs.reduce((n,run)=>n+run.screenshots.length,0), frontmatterFixtures: runs.find(run=>run.tag==='data02')?.observations.results.find(result=>result.id==='process-frontmatter-fixtures')?.fixtures.length || 0 },
  sources,
  layoutNotes: JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'layout-notes.json'), 'utf8')),
  excludedExploration: [
    { tag: 'discover01', reason: 'Plugin source did not run because the fresh profile started in restricted mode; superseded by explicit synthetic-profile enable in discover02.' },
    { tag: 'editor01', reason: 'Successful initial editor sample; editor02 adds main-selection parameter and valid Editor.exec command samples.' },
    { tag: 'data01', reason: 'Response HTTP status overwrote one top-level observation status field; renamed field and repeated as data02.' },
    { tag: 'render01', reason: 'A function-valued report field caused IPC serialization failure; owned original app exited normally after stop; no final report.' },
    { tag: 'render02', reason: 'Initial rendering observation; native snapshot was taken before fresh-paint callbacks completed.' },
    { tag: 'render03', reason: 'Superseded by full post-disable child cleanup and inactive-view observations.' },
    { tag: 'render04', reason: 'Superseded by explicit ItemView setState ordering in render05.' },
    { tag: 'layout01', reason: 'Initial layout observation; lacked visible-line calibration for ephemeral scrolling.' },
    { tag: 'layout02', reason: 'Superseded by additional fixed-scroll and sidebar DOM calibration in layout03.' },
  ],
  limitations: [
    'Programmatic original API and DOM operations do not establish physical keyboard/mouse usability.',
    'The synthetic composition run uses untrusted CompositionEvent plus document.execCommand. It does not reproduce the Windows IME candidate/pre-edit/input sequence and cannot establish native IME correctness or native data-loss behavior.',
    'The separately available API declaration file is version 1.14.4; it guided probe design but is not evidence that core 1.13.7 implements every current type contract.',
    'Layout restoration occurred within one original process; process restart, crash, DPI, multi-monitor geometry and arbitrary layout precision remain untested.',
    'Ephemeral scroll is not a pixel offset. The source-mode visible-line roundtrip succeeded for one case, but Live Preview and distant fixed-scroll samples differed; arbitrary exact scrolling is not established.',
    'HTTP fixtures cover loopback success, binary POST, redirect, error and decoding only; no original cloud, public internet, production security or authentication flow was exercised.',
    'No arbitrary community plugin, all public APIs, CodeMirror extension ecosystem or private API compatibility is established.',
    'Original source files were neither patched nor copied into this bundle; only self-authored probes, fixture inputs and observations are included.',
  ],
  runs,
};
const output=path.join(root,'research','windows-round3-reference.json');
fs.writeFileSync(output,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({output,counts:summary.counts,runs:runs.map(run=>({tag:run.tag,evidenceId:run.evidenceId,records:run.observations.results.length,screenshots:run.screenshots.length,hostErrors:run.hostErrors.length})),bytes:fs.statSync(output).size}));
