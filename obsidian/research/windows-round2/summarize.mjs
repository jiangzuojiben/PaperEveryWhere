import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..', '..');
const tags = process.argv.slice(2);
if (!tags.length || tags.some(tag => !/^[a-z0-9-]+$/.test(tag))) throw Error('Provide successful reference run tags');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const runs = [];
for (const tag of tags) {
  const run = path.join(root, 'research', 'raw', 'windows-round2-' + tag);
  const reportBytes = fs.readFileSync(path.join(run, 'observations.json'));
  const observations = JSON.parse(reportBytes);
  const lifecycle = JSON.parse(fs.readFileSync(path.join(run, 'lifecycle.json'), 'utf8'));
  const rea = JSON.parse(fs.readFileSync(path.join(run, 'rea-browser.json'), 'utf8'));
  if (observations.status !== 'complete' || lifecycle.exit.code !== 0 || lifecycle.reaCode !== 0 || !lifecycle.sourceUnchanged || !rea.evidence_id) throw Error('Incomplete reference run: ' + tag);
  if (!JSON.stringify(rea).includes(hash(reportBytes))) throw Error('REA capture does not bind report hash: ' + tag);
  const screenshotDir = path.join(import.meta.dirname, 'screenshots', tag);
  const screenshots = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.name === 'string' && /^[a-z0-9-]+\.png$/.test(value.name) && /^[0-9a-f]{64}$/.test(value.sha256 || '')) {
      const bytes = fs.readFileSync(path.join(run, value.name));
      if (hash(bytes) !== value.sha256) throw Error('Screenshot identity mismatch: ' + value.name);
      fs.mkdirSync(screenshotDir, { recursive: true });
      const target = path.join(screenshotDir, value.name);
      fs.writeFileSync(target, bytes);
      value.artifact = path.relative(root, target).replaceAll('\\', '/');
      if (!screenshots.some(item => item.name === value.name)) screenshots.push({ ...value });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(observations.results);
  const hostEvents = fs.readFileSync(path.join(run, 'host.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  runs.push({
    tag, evidenceId: rea.evidence_id, reportSha256: hash(reportBytes), reaFileSha256: hash(fs.readFileSync(path.join(run, 'rea-browser.json'))),
    rawDirectory: 'research/raw/windows-round2-' + tag,
    copiedBootstrapSha256: hash(fs.readFileSync(path.join(run, 'bootstrap.cjs'))),
    copiedProbeSha256: hash(fs.readFileSync(path.join(run, 'probe.js'))),
    lifecycle, screenshots,
    blockedNetwork: hostEvents.filter(item => /blocked-(node|renderer)-network/.test(item.kind)),
    observations,
  });
}
const summary = {
  schema: 'vaultdesk-original-windows-round2-reference-v1',
  date: '2026-10-23', referenceOnly: true,
  reference: { coreVersion: '1.13.7', coreSha256: 'a52a7daf1e2460bae03de80f2816604bd16a56cd374fbe5ce8d1a9ef5604059d', os: 'Windows', electron: '39.8.3', timezone: 'Asia/Hong_Kong', rea: '6.7.0' },
  method: 'REA drives a loopback controller. An independent laboratory bootstrap loads the unchanged original core in a fresh synthetic vault and profile. The renderer invokes original commands/APIs, reads DOM and files, and returns a report whose SHA-256 is included in the REA capture. This is not a direct REA capture of the Electron surface and not an equality comparison with VaultDesk.',
  isolation: 'Fresh profile/session/vault per run; no real vault/account/credentials loaded. Guards deny remote Electron HTTP(S)/WS(S) requests and Node http/https.request/get; external URL opening and OS protocol registration are denied. This is an experimental network guard, not an operating-system sandbox. Owned application process exits and original core hash is rechecked.',
  interpretation: 'complete/observed means the probe sequence produced observations. It does not mean that every requested behavior succeeded or that the independent implementation passed. Individual results and limitations govern.',
  screenshotMethod: 'Original Electron window is briefly shown without activating it before capturePage, then hidden again, so Chromium paints the current DOM. PNG SHA-256 is verified during aggregation.',
  excludedExploration: [
    { tag: 'discover01', reason: 'Bootstrap attempted ASAR hash through Electron virtual filesystem; no report. Owned process stopped; source unchanged.' },
    { tag: 'discover02', reason: 'Successful API/options discovery; hidden-window screenshots are stale and excluded from visual evidence.' },
    { tag: 'features01', reason: 'Importer dialog cleanup errors and hidden-window screenshots; replaced by features02.' },
    { tag: 'daily01', reason: 'Exploratory run included missing configured-folder precondition and hidden-window screenshots; replaced by daily02.' },
    { tag: 'workspace01', reason: 'Hidden-window popout promise did not complete before sequence timeout; no full report; replaced by workspace02.' },
    { tag: 'frontmatter01', reason: 'Completion control existed before conversion finished; premature sampling. Replaced by frontmatter02 with a visible-completion wait.' },
  ],
  limitations: [
    'Original methods and DOM controls are driven programmatically; this does not establish physical mouse/keyboard usability or timing.',
    'Reference behavior is limited to the exact synthetic inputs, settings, platform and observed output; no copied original implementation is included.',
    'Web viewer remained disabled after startup despite listing it in core-plugins; no product condition was overridden and web navigation is unverified.',
    'Date/template options were assigned on the active original plugin instance; settings UI and restart persistence were not tested.',
    'Each run uses fresh storage; evidence is local reference research, not independent-product acceptance.',
  ],
  runs,
};
const out = path.join(root, 'research', 'windows-round2-reference.json');
fs.writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ output: out, runs: runs.map(run => ({ tag: run.tag, evidenceId: run.evidenceId, records: run.observations.results.length, screenshots: run.screenshots.length })), bytes: fs.statSync(out).size }));
