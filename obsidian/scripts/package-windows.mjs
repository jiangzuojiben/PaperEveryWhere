import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This script packages an installed Windows x64 Electron runtime.');
if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error('A valid package version is required for the output directory.');

const releaseDirectory = path.join(root, 'release');
const output = path.join(releaseDirectory, `VaultDesk-${manifest.version}-Windows-x64`);
const relativeOutput = path.relative(releaseDirectory, output);
if (!relativeOutput || relativeOutput.startsWith('..') || path.isAbsolute(relativeOutput)) throw new Error('Packaging output must stay inside release.');
const runtime = path.join(root, 'node_modules', 'electron', 'dist');
const exists = async (target) => fs.access(target).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
if (await exists(output)) throw new Error('Output already exists. Preserve it and choose a new version before packaging again.');

const requiredFiles = ['dist/index.html', 'desktop/main.cjs', 'core/vault.mjs', 'node_modules/yaml/package.json', 'README.md', 'THIRD_PARTY_NOTICES.md', 'scripts/start-cloud.ps1', 'cloud/app.py', 'compose.yaml'];
for (const filename of requiredFiles) await fs.access(path.join(root, filename));
for (const filename of ['electron.exe', 'LICENSE', 'LICENSES.chromium.html', 'version']) await fs.access(path.join(runtime, filename));
// Only a clean open-source Electron distribution may supply the runtime.
for (const filename of ['resources/app.asar', 'resources/app']) {
  if (await exists(path.join(runtime, filename))) throw new Error(`Unexpected application payload in Electron runtime: ${filename}`);
}
const electronVersion = (await fs.readFile(path.join(runtime, 'version'), 'utf8')).trim();
const installedElectron = JSON.parse(await fs.readFile(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'));
if (electronVersion !== installedElectron.version || electronVersion !== manifest.devDependencies.electron) throw new Error('The Electron runtime, installed package and pinned project version must match.');
const projectLicense = await exists(path.join(root, 'LICENSE')) ? path.join(root, 'LICENSE') : path.join(root, '..', 'LICENSE');
await fs.access(projectLicense);
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));

async function legalFiles(directory, relative = '') {
  const found = [];
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name === '.git') continue;
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) found.push(...await legalFiles(directory, next));
    else if (/^(?:license|licence|notice|copying|copyright|ofl)(?:[._-]|$)/i.test(entry.name)) found.push(next);
  }
  return found;
}

async function collectNotices() {
  const destination = path.join(output, 'third-party');
  await fs.mkdir(path.join(destination, 'notices'), { recursive: true });
  const packages = [];
  for (const [packagePath, locked] of Object.entries(lock.packages || {})) {
    if (!packagePath || locked.dev || !packagePath.startsWith('node_modules/')) continue;
    const source = path.resolve(root, packagePath);
    const boundary = path.relative(path.join(root, 'node_modules'), source);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) throw new Error('Dependency metadata points outside node_modules.');
    if (!await exists(path.join(source, 'package.json'))) continue; // Optional package for another platform.
    if ((await fs.lstat(source)).isSymbolicLink()) throw new Error('Linked dependencies must be vendored before packaging.');
    const metadata = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    const name = metadata.name || packagePath;
    const key = `${name}-${metadata.version}`.replace(/[^a-zA-Z0-9._-]/g, '_');
    const noticeDirectory = path.join(destination, 'notices', key);
    await fs.mkdir(noticeDirectory, { recursive: true });
    const files = await legalFiles(source);
    for (const file of files) {
      const target = path.join(noticeDirectory, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(source, file), target);
    }
    let readmeLicense = false;
    if (!files.length && await exists(path.join(source, 'README.md'))) {
      const readme = await fs.readFile(path.join(source, 'README.md'), 'utf8');
      const match = /^#{1,6}\s+Licen[cs](?:e|ing)\s*$/im.exec(readme);
      if (match) {
        await fs.writeFile(path.join(noticeDirectory, 'LICENSE-from-README.md'), readme.slice(match.index));
        readmeLicense = true;
      }
    }
    const entry = { name, version: metadata.version, license: metadata.license || locked.license || 'Not specified', repository: metadata.repository, author: metadata.author, contributors: metadata.contributors, installedPath: packagePath, noticeFiles: files.map((file) => file.replaceAll('\\', '/')), readmeLicense };
    await fs.writeFile(path.join(noticeDirectory, 'package-metadata.json'), JSON.stringify(entry, null, 2));
    packages.push(entry);
  }
  await fs.writeFile(path.join(destination, 'package-inventory.json'), JSON.stringify({ source: 'Installed non-development dependency graph; optional Node-only dependencies may not be shipped in the browser bundle.', packages }, null, 2));
  return packages.length;
}

await fs.mkdir(releaseDirectory, { recursive: true });
await fs.cp(runtime, output, { recursive: true, errorOnExist: true, force: false });
await fs.rename(path.join(output, 'electron.exe'), path.join(output, 'VaultDesk.exe'));
// Known file inside this newly created output; no recursive deletion or cleanup.
await fs.unlink(path.join(output, 'resources', 'default_app.asar')).catch((error) => { if (error.code !== 'ENOENT') throw error; });
const app = path.join(output, 'resources', 'app');
await fs.mkdir(path.join(app, 'node_modules'), { recursive: true });
for (const folder of ['dist', 'desktop', 'core']) await fs.cp(path.join(root, folder), path.join(app, folder), { recursive: true });
await fs.cp(path.join(root, 'node_modules', 'yaml'), path.join(app, 'node_modules', 'yaml'), { recursive: true });
await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'vaultdesk', productName: 'VaultDesk', version: manifest.version, type: 'module', main: 'desktop/main.cjs', dependencies: { yaml: manifest.dependencies.yaml } }, null, 2));
await fs.copyFile(projectLicense, path.join(app, 'LICENSE'));
await fs.copyFile(projectLicense, path.join(output, 'LICENSE-VaultDesk.txt'));

for (const filename of ['README.md', 'THIRD_PARTY_NOTICES.md', 'compose.yaml']) await fs.copyFile(path.join(root, filename), path.join(output, filename));
await fs.cp(path.join(root, 'docs'), path.join(output, 'docs'), { recursive: true });
await fs.mkdir(path.join(output, 'desktop'), { recursive: true });
await fs.copyFile(path.join(root, 'desktop', 'README.md'), path.join(output, 'desktop', 'README.md'));
await fs.mkdir(path.join(output, 'scripts'), { recursive: true });
await fs.copyFile(path.join(root, 'scripts', 'start-cloud.ps1'), path.join(output, 'scripts', 'start-cloud.ps1'));
await fs.mkdir(path.join(output, 'cloud'), { recursive: true });
// Explicit allowlist: never package a local database, credentials or vault data.
for (const filename of ['__init__.py', 'app.py', 'requirements.txt', 'README.md', 'Dockerfile', '.dockerignore', '.env.example']) await fs.copyFile(path.join(root, 'cloud', filename), path.join(output, 'cloud', filename));
const dependencyCount = await collectNotices();

await fs.writeFile(path.join(output, '使用说明.txt'), 'VaultDesk Windows 开发预览\r\n\r\n双击 VaultDesk.exe，保留整个同目录运行时。无需安装 Node.js。\r\n应用数据在 %APPDATA%\\VaultDesk，笔记在您选择的知识库目录。\r\n云服务为可选：需要 Python，运行 scripts\\start-cloud.ps1 -Setup。\r\n自有账号不属于 Obsidian 官方，当前不支持端到端加密。\r\n本版未签名，未注册系统协议，无自动更新器。\r\n请阅读 README.md、docs\\parity.md 与 THIRD_PARTY_NOTICES.md。\r\npackage-manifest.json 与 integrity.json 记录构建及文件哈希。\r\n本开发预览尚未达到 Obsidian 全量行为或社区插件兼容。\r\n', 'utf8');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = [];
async function inventory(directory, relative = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link in output: ${name}`);
    if (entry.isDirectory()) await inventory(absolute, name);
    else {
      const bytes = await fs.readFile(absolute);
      files.push({ path: name, size: bytes.length, sha256: sha256(bytes) });
    }
  }
}
await inventory(output);
const integrityText = JSON.stringify({ algorithm: 'sha256', excludes: ['integrity.json', 'package-manifest.json'], files }, null, 2);
await fs.writeFile(path.join(output, 'integrity.json'), integrityText);
const executableSha256 = files.find((file) => file.path === 'VaultDesk.exe').sha256;
const packageInfo = { name: 'VaultDesk', version: manifest.version, platform: 'win32-x64', electron: electronVersion, executableSha256, integritySha256: sha256(integrityText), integrityFile: 'integrity.json', fileCount: files.length, dependencyNotices: dependencyCount, output, packagedAt: new Date().toISOString(), codeSigned: false, service: 'Optional source included; Python and its packages are not bundled.' };
await fs.writeFile(path.join(output, 'package-manifest.json'), JSON.stringify(packageInfo, null, 2));
await fs.writeFile(path.join(releaseDirectory, 'package-manifest.json'), JSON.stringify(packageInfo, null, 2));
console.log(JSON.stringify({ output, executableSha256, integritySha256: packageInfo.integritySha256 }));
