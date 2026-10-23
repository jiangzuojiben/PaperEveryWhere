import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';

const root = path.resolve(import.meta.dirname, '..', '..');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const implementationPath = path.join(root, 'app', 'plugin-files.mjs');
const implementationHashBefore = hash(fs.readFileSync(implementationPath));
const { transformFrontmatter } = await import(pathToFileURL(implementationPath).href);
const referencePath = path.join(root, 'research', 'windows-round3-reference.json');
const referenceBytes = fs.readFileSync(referencePath);
const reference = JSON.parse(referenceBytes);
const referenceRun = reference.runs.find(run => run.tag === 'data02');
const fixtures = referenceRun.observations.results.find(result => result.id === 'process-frontmatter-fixtures').fixtures;
if (fixtures.length !== 12) throw Error('Expected the frozen R3 12-fixture processFrontMatter matrix');

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => isDeepStrictEqual(canonical(a), canonical(b));
// Independent lexical split for evidence only. It recognizes BOM and does not
// rely on the tested implementation's frontmatter parser or serialization.
const parts = source => {
  const opening = /^(?:\uFEFF)?---[\t ]*\r?\n/.exec(source);
  const closing = opening ? /^(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/m.exec(source.slice(opening[0].length)) : null;
  if (!opening || !closing) return { hasFrontmatter: false, values: null, body: source.replace(/^\uFEFF/, ''), bom: source.startsWith('\uFEFF'), parseErrors: [] };
  const from = opening[0].length, to = from + closing.index, end = to + closing[0].length;
  const document = parseDocument(source.slice(from, to), { uniqueKeys: true });
  return { hasFrontmatter: true, values: document.errors.length ? null : document.toJS({ maxAliasCount: 100 }), body: source.slice(end), bom: source.startsWith('\uFEFF'), parseErrors: document.errors.map(error => ({ name: error.name, code: error.code })) };
};
const firstDifference = (expected, actual) => {
  if (expected === actual) return null;
  let index = 0;
  while (index < Math.min(expected.length, actual.length) && expected[index] === actual[index]) index++;
  return index;
};
const reasons = {
  'existing-comments': '独立实现保留注释及未修改节点；原版重新序列化并丢掉注释。',
  'crlf-bom': '独立实现识别并保留开头 BOM，更新现有 YAML；原版在 BOM 与旧内容之前追加另一块 YAML，callback 也因此收到空对象。',
  crlf: '独立实现使新 YAML 保持 CRLF；原版新 YAML 使用 LF，而围栏及正文仍为 CRLF。',
  'array-frontmatter': '独立实现拒绝非 mapping YAML，callback 未运行且输入不变；原版 callback 收到数组，新增命名属性未序列化。',
  'noop-comments': '独立实现对无改值 callback 保留原字节；原版仍重新序列化并移除注释。',
};

const results = fixtures.map(fixture => {
  let actual = fixture.input, callbackCalls = 0, callbackInput = null, callbackType = null, thrown = null;
  try {
    actual = transformFrontmatter(fixture.input, value => {
      callbackCalls++;
      callbackInput = JSON.parse(JSON.stringify(value));
      callbackType = { type: typeof value, array: Array.isArray(value), prototype: Object.getPrototypeOf(value)?.constructor?.name ?? null };
      if (fixture.operation === 'throw') { value.count = 99; throw Error('LAB CALLBACK FAILURE'); }
      if (fixture.operation === 'noop') return;
      if (fixture.operation === 'delete') { for (const key of Object.keys(value)) delete value[key]; return; }
      if (fixture.operation === 'return') return { ignored: true };
      value.count = 2;
      value.added = ['a', 'b'];
      delete value.untouched;
    });
  } catch (error) { thrown = { name: error.name, message: error.message }; }
  const expectedRejected = !!fixture.outcome.threw, actualRejected = !!thrown;
  const expectedParts = parts(fixture.after), actualParts = parts(actual), inputParts = parts(fixture.input);
  const bothAccepted = !expectedRejected && !actualRejected;
  const outcomeEqual = expectedRejected === actualRejected;
  const acceptedSemanticEqual = bothAccepted ? expectedParts.parseErrors.length === 0 && actualParts.parseErrors.length === 0 && same({ values: expectedParts.values, body: expectedParts.body }, { values: actualParts.values, body: actualParts.body }) : null;
  return {
    name: fixture.name, operation: fixture.operation, input: fixture.input,
    expected: { text: fixture.after, outcome: fixture.outcome, callbackCalls: fixture.callbackCalls, callbackInput: fixture.callbackInput, callbackType: fixture.callbackType, parts: expectedParts },
    actual: { text: actual, rejected: actualRejected, error: thrown, callbackCalls, callbackInput, callbackType, parts: actualParts },
    outcomeEqual, byteEqual: actual === fixture.after, acceptedSemanticEqual,
    outcomeAndSemanticEqual: outcomeEqual && (bothAccepted ? acceptedSemanticEqual : actual === fixture.input && fixture.after === fixture.input),
    callbackCallsEqual: callbackCalls === fixture.callbackCalls, callbackValuesEqual: same(callbackInput, fixture.callbackInput),
    actualBodyPreserved: actualParts.body === inputParts.body,
    referenceBodyPreserved: expectedParts.body === inputParts.body,
    rejectionLeavesInput: actualRejected ? actual === fixture.input : null,
    firstDifferenceUtf16: firstDifference(fixture.after, actual),
    reason: actual === fixture.after && outcomeEqual ? null : reasons[fixture.name] || '未分类差异；需要审查。',
    inputSha256: hash(fixture.input), expectedSha256: hash(fixture.after), actualSha256: hash(actual),
  };
});

if (implementationHashBefore !== hash(fs.readFileSync(implementationPath))) throw Error('Implementation changed during comparison; rerun for a stable result');
const totals = {
  fixtures: results.length,
  outcomeEqual: results.filter(result => result.outcomeEqual).length,
  byteEqual: results.filter(result => result.byteEqual).length,
  bothAccepted: results.filter(result => result.acceptedSemanticEqual !== null).length,
  acceptedSemanticEqual: results.filter(result => result.acceptedSemanticEqual === true).length,
  outcomeAndSemanticEqual: results.filter(result => result.outcomeAndSemanticEqual).length,
  callbackValuesEqual: results.filter(result => result.callbackValuesEqual).length,
  callbackBothCalled: results.filter(result => result.expected.callbackCalls > 0 && result.actual.callbackCalls > 0).length,
  callbackBothCalledValuesEqual: results.filter(result => result.expected.callbackCalls > 0 && result.actual.callbackCalls > 0 && result.callbackValuesEqual).length,
  implementationRejected: results.filter(result => result.actual.rejected).length,
  referenceRejected: results.filter(result => !!result.expected.outcome.threw).length,
  implementationBodyPreserved: results.filter(result => result.actualBodyPreserved).length,
  referenceBodyPreserved: results.filter(result => result.referenceBodyPreserved).length,
  outputOrOutcomeDifferences: results.filter(result => !result.byteEqual || !result.outcomeEqual).length,
};
const report = {
  schema: 'vaultdesk-windows-round3-process-frontmatter-differential-v1', date: new Date().toISOString(),
  referenceEvidenceId: referenceRun.evidenceId, originalReportSha256: referenceRun.reportSha256,
  referenceAggregateSha256: hash(referenceBytes), implementationFile: 'app/plugin-files.mjs', implementationSha256: implementationHashBefore,
  invocation: 'transformFrontmatter(input, callback); on rejection, retain unchanged input to model the file-write boundary',
  totals, results,
  limitations: [
    'Pure-function comparison using the 12 frozen original processFrontMatter inputs and callbacks, not a native plugin/UI or bridge/file-write test.',
    'The tested helper returns text; this does not prove that the public asynchronous processFrontMatter wrapper resolves undefined, serializes concurrent operations, or writes files correctly.',
    'Semantic comparison for jointly accepted cases compares parsed YAML values and the body after one initial frontmatter block; BOM is recognized and excluded from semantic body text.',
    'Rejected cases compare acceptance/rejection and unchanged output, not exact exception class or text. Byte equality alone does not imply equivalent behavior when an array input is rejected.',
    'The implementation passes a detached null-prototype mapping; callbackValuesEqual ignores the prototype difference and compares JSON values only.',
    'All safety/preservation differences are recorded, not counted as complete Obsidian parity. Results apply only to the recorded implementation hash.',
  ],
};
fs.writeFileSync(path.join(root, 'research', 'windows-round3-differential.json'), JSON.stringify(report, null, 2) + '\n');
const yes = value => value ? '一致' : '不同';
const differences = results.filter(result => !result.byteEqual || !result.outcomeEqual);
const markdown = `# Windows R3 processFrontMatter 独立差分

以原版 R3 的 **12 份冻结输入及同一 callback** 调用当前 \`transformFrontmatter\`：接受/拒绝一致 **${totals.outcomeEqual}/12**，输出字节一致 **${totals.byteEqual}/12**；两边均接受的 ${totals.bothAccepted} 项中，YAML 值与正文一致 **${totals.acceptedSemanticEqual}/${totals.bothAccepted}**。另计双方同样拒绝且输入不变的情形，结果语义一致 **${totals.outcomeAndSemanticEqual}/12**。这些是纯函数结果，不是插件 UI 通过或完整 API 等价。

独立实现正文保留 ${totals.implementationBodyPreserved}/12，原版 ${totals.referenceBodyPreserved}/12；差异来自原版 BOM 样本增加了第二块 Frontmatter。${totals.outputOrOutcomeDifferences} 项在输出或接受结果上不同，逐项列在下方。正文保留只指剥离开头一块 Frontmatter 后的字符串保持一致，不代表所有 Markdown 格式语义正确。

运行时间：${report.date}。被测 [plugin-files.mjs](../app/plugin-files.mjs) SHA-256：\`${implementationHashBefore}\`；执行前后相同。参考 REA：\`${referenceRun.evidenceId}\`，原观察报告 SHA-256：\`${referenceRun.reportSha256}\`。输入及原版结果来自 [R3 参考汇总](../research/windows-round3-reference.json)，本次全部结果与 callback 输入见 [差分 JSON](../research/windows-round3-differential.json)。产品文件修改后必须重跑。

## 逐项结果

| 合成场景 | 接受/拒绝 | 输出字节 | 两边接受时 YAML 值与正文 | 当前正文保留 |
| --- | --- | --- | --- | --- |
${results.map(result => `| ${result.name} | ${yes(result.outcomeEqual)} | ${yes(result.byteEqual)} | ${result.acceptedSemanticEqual === null ? '不适用（至少一边拒绝）' : yes(result.acceptedSemanticEqual)} | ${result.actualBodyPreserved ? '是' : '否'} |`).join('\n')}

## 已观察差异

${differences.map(result => `- **${result.name}**：${result.reason}`).join('\n')}

独立实现还把 callback 的 mapping 复制为无原型对象；原版普通 mapping 的 prototype 为 Object。双方实际调用 callback 的 ${totals.callbackBothCalled} 项里，JSON 输入值一致 ${totals.callbackBothCalledValuesEqual}/${totals.callbackBothCalled}（BOM 场景不同）。全部 12 条观察把未调用记为 null，有 ${totals.callbackValuesEqual}/12 条输入记录一致；数组场景只有原版调用。这些数量不表示 prototype 等价。注释、CRLF、BOM 的保留及拒绝非 mapping 是当前实现的明确取舍，不能报告为与原版所有字节相同。

\`invalid-yaml\` 与 \`callback-throws\` 在双方都拒绝且输入不变；没有比较异常名称或文案。\`array-frontmatter\` 的输出字节虽然相同，但原版运行 callback，独立实现提前拒绝，因此不能据字节相等判为兼容。

## 验证范围与重现

本轮只运行 helper，不调用 renderer、插件导入、Vault bridge 或实际文件写入，也不证明并发串行、公开异步方法的 undefined 返回值、元数据事件、撤销或故障恢复。12 个原版观察包含上述边界；其余 API 仍由实际客户端中的导入插件和专项测试验证。错误路径保留输入，是差分 runner 的文件边界模型，并非本轮观察到独立客户端写盘。

\`transformFrontmatter\` 返回更新文本；原版 \`processFrontMatter\` 返回 Promise<void>，二者并非同一层接口。本轮仅比较由相同输入及 callback 产生的候选文件结果。

\`\`\`powershell
node research/windows-round3/differential.mjs
\`\`\`
`;
fs.writeFileSync(path.join(root, 'docs', 'windows-round3-differential.md'), markdown);
console.log(JSON.stringify({ implementationSha256: implementationHashBefore, totals, differences: differences.map(result => ({ name: result.name, outcomeEqual: result.outcomeEqual, byteEqual: result.byteEqual, acceptedSemanticEqual: result.acceptedSemanticEqual, reason: result.reason })) }));
