import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '..', '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const corePath = path.join(root, 'core', 'windows-extras.mjs');
const coreHashBefore = hash(fs.readFileSync(corePath));
const { convertMarkdownFormat } = await import(pathToFileURL(corePath).href);
const referencePath = path.join(root, 'research', 'windows-round2-reference.json');
const referenceBytes = fs.readFileSync(referencePath);
const reference = JSON.parse(referenceBytes);
const referenceRun = reference.runs.find(run => run.tag === 'frontmatter02');
const fixtures = referenceRun.observations.results.find(result => result.id === 'frontmatter-conversion-matrix').fixtures;
if (fixtures.length !== 36) throw Error('Expected the frozen R2 36-fixture matrix');
const parts = source => {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  return match ? { frontmatter: parse(match[1]), body: source.slice(match[0].length) } : { frontmatter: null, body: source };
};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const results = fixtures.map(fixture => {
  let actual, error;
  try { actual = convertMarkdownFormat(fixture.input, { frontmatter: true }); } catch (reason) { error = String(reason.stack || reason); }
  const expectedParts = parts(fixture.after), actualParts = actual ? parts(actual.text) : null;
  let firstDifference = 0;
  if (actual) while (firstDifference < Math.min(fixture.after.length, actual.text.length) && fixture.after[firstDifference] === actual.text[firstDifference]) firstDifference++;
  return {
    id: fixture.id, name: fixture.name, path: fixture.path, input: fixture.input,
    expected: fixture.after, actual: actual?.text ?? null, error,
    byteEqual: actual?.text === fixture.after,
    semanticEqual: !!actualParts && JSON.stringify(canonical(actualParts)) === JSON.stringify(canonical(expectedParts)),
    bodyPreserved: !!actualParts && actualParts.body === parts(fixture.input).body,
    referenceChanged: fixture.changed, implementationChanged: actual?.changed,
    firstDifference: actual?.text === fixture.after ? null : firstDifference,
    warnings: actual?.warnings ?? [],
    expectedSha256: hash(fixture.after), actualSha256: actual ? hash(actual.text) : null,
  };
});
const coreHashAfter = hash(fs.readFileSync(corePath));
if (coreHashBefore !== coreHashAfter) throw Error('Implementation changed during comparison; retry to obtain an unambiguous result');
const totals = { fixtures: results.length, byteEqual: results.filter(x => x.byteEqual).length, semanticEqual: results.filter(x => x.semanticEqual).length, mismatches: results.filter(x => !x.byteEqual).length, errors: results.filter(x => x.error).length, bodyPreserved: results.filter(x => x.bodyPreserved).length };
const report = {
  schema: 'vaultdesk-windows-round2-frontmatter-differential-v1', date: new Date().toISOString(),
  referenceEvidenceId: referenceRun.evidenceId, originalReportSha256: referenceRun.reportSha256,
  referenceAggregateSha256: hash(referenceBytes), implementationFile: 'core/windows-extras.mjs', implementationSha256: coreHashBefore,
  invocation: 'convertMarkdownFormat(input, { frontmatter: true })', totals, results,
  limitations: ['A pure-function comparison with 36 frozen reference inputs; no renderer, file write, settings UI, rollback or concurrency behavior is tested.', 'Semantic equality parses YAML and compares values plus unchanged body; exact equality includes YAML formatting and all bytes.', 'Results apply only to the implementation SHA-256 recorded here; later edits require a rerun.'],
};
fs.writeFileSync(path.join(root, 'research', 'windows-round2-differential.json'), JSON.stringify(report, null, 2) + '\n');
const yes = value => value ? '一致' : '不一致';
const failures = results.filter(result => !result.byteEqual);
const sections = failures.map(result => `### ${result.id} ${result.name}\n\n输入：\n\n\`\`\`markdown\n${result.input}\`\`\`\n\n原版输出：\n\n\`\`\`markdown\n${result.expected}\`\`\`\n\n当前实现输出：\n\n\`\`\`markdown\n${result.actual ?? result.error}\`\`\`\n`).join('\n');
const markdown = `# Windows R2 Frontmatter 独立差分\n\n以 R2 原版的 36 份冻结输入逐一调用 \`convertMarkdownFormat(input, { frontmatter: true })\`：**字节一致 ${totals.byteEqual}/36，语义一致 ${totals.semanticEqual}/36，差异 ${totals.mismatches} 项，异常 ${totals.errors} 项**。正文保留 ${totals.bodyPreserved}/36。\n\n运行时间：${report.date}。被测 [windows-extras.mjs](../core/windows-extras.mjs) SHA-256：\`${coreHashBefore}\`；执行前后哈希相同。后续代码更改需要重跑，不能沿用该结果。\n\n参考 REA：\`${referenceRun.evidenceId}\`；原观察报告 SHA-256：\`${referenceRun.reportSha256}\`。原版输入及输出来自 [R2 汇总](../research/windows-round2-reference.json)，完整本次结果见 [差分 JSON](../research/windows-round2-differential.json)。\n\n## 逐项结果\n\n| ID | 合成场景 | 字节 | YAML 值与正文 |\n| --- | --- | --- | --- |\n${results.map(result => `| ${result.id} | ${result.name} | ${yes(result.byteEqual)} | ${yes(result.semanticEqual)} |`).join('\n')}\n\n## 差异原文\n\n${failures.length ? sections : '本次 36 项无差异。\n'}\n## 验证范围\n\n这是纯函数差分，不是完整转换器 UI 通过。没有运行 renderer、文件写入、设置界面、停止/撤销或并发失败恢复。语义比较解析 YAML 后比较属性值和正文；字节比较另包含序列化格式。\n\n重现：\n\n\`\`\`powershell\nnode research/windows-round2/differential.mjs\n\`\`\`\n`;
fs.writeFileSync(path.join(root, 'docs', 'windows-round2-differential.md'), markdown);
console.log(JSON.stringify({ implementationSha256: coreHashBefore, totals, differences: failures.map(result => ({ id: result.id, name: result.name, expected: parts(result.expected).frontmatter, actual: result.actual ? parts(result.actual).frontmatter : result.error })) }));
