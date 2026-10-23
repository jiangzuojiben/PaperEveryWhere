import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [runDirectory, outputPath, targetFolder = 'targeted', targetEvidence = 'rea-targeted.json'] = process.argv.slice(2);
if (!runDirectory || !outputPath) throw new Error('Usage: node rea-summarize.mjs RUN_DIR NEW_OUTPUT.json [TARGET_FOLDER] [TARGET_EVIDENCE]');
function read(name) { return JSON.parse(fs.readFileSync(path.join(runDirectory, name), 'utf8').replace(/^\uFEFF/, '')); }
function project(name, scope) {
  const raw = fs.readFileSync(path.join(runDirectory, name));
  const e = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
  if (!e.evidence_id || !e.normalized_result) throw new Error('Not a successful REA Evidence record: ' + name);
  return { scope, evidenceId: e.evidence_id, rawEvidenceSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    subjectSha256: e.subject.digest.sha256, provider: e.provider, parameters: e.parameters,
    statistics: e.normalized_result.statistics, confidence: e.confidence,
    limitations: e.limitations };
}
const manifest = read(path.join(targetFolder, 'scope-manifest.json'));
const summary = { schema: 'vaultdesk-rea-scope-summary-v1', researchDate: '2026-10-23', reaVersion: '6.7.0',
  applicationVersion: manifest.applicationVersion, sampleSha256: manifest.sampleSha256, appJsSha256: manifest.memberSha256,
  evidence: [project('rea-host.json', 'original-ASAR: package.json and main.js'), project(targetEvidence, 'derived exact app.js slices: plugin constructors/registration and selected cloud helpers/methods')],
  registration: manifest.registration, plugins: manifest.plugins,
  endpointLiterals: manifest.endpointLiterals, cloudMethods: manifest.cloudMethods,
  sourceSegments: manifest.segments,
  boundaries: manifest.limitations,
  implementationParity: 'not-assessed', runtimePluginEnablement: 'not-observed', cloudServerRequests: 'none',
  privacy: 'No user vault, account, credentials, or application runtime data collected. Local absolute paths and raw proprietary snippets omitted.' };
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ summary: outputPath, evidenceIds: summary.evidence.map(e => e.evidenceId), pluginCount: summary.plugins.length }));
