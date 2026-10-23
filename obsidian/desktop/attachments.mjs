import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeVaultPath } from './vault-store.mjs';

const PRIVATE_NAMES = new Set(['.vaultdesk', '.obsidian', '.git']);
const MAX_FILES = 10000;
const MAX_ENTRIES = 20000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const missing = (error) => error.code === 'ENOENT';
const collision = (error) => error.code === 'EEXIST' || /\balready exists\b/i.test(error.message || '');
const changed = () => Object.assign(new Error('An import source changed while it was being copied. Please try importing it again.'), { code: 'IMPORT_SOURCE_CHANGED' });

function absoluteSource(value) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) throw new Error('Import sources must be absolute filesystem paths');
  return path.resolve(value);
}

function privateSource(absolute) {
  return absolute.slice(path.parse(absolute).root.length).split(path.sep).some((part) => PRIVATE_NAMES.has(part.toLowerCase()));
}

// Check every ancestor, including a directly selected file reached through a junction.
async function inspectSource(absolute) {
  let current = path.parse(absolute).root;
  let stat = await fs.lstat(current);
  if (stat.isSymbolicLink()) return null;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    if (!stat.isDirectory()) throw new Error('An import source parent is not a directory');
    current = path.join(current, part);
    stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) return null;
  }
  return stat;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function inspectDestination(store, destinationFolder) {
  const folder = normalizeVaultPath(destinationFolder, true);
  const absolute = await store.checkedPath(folder, { allowMissing: true, allowRoot: true });
  const stat = await fs.lstat(absolute).catch((error) => { if (missing(error)) return null; throw error; });
  if (stat && !stat.isDirectory()) throw new Error('The attachment destination must be a folder');
  return folder;
}

async function planSource(absolute, counts, topLevel = false) {
  if (privateSource(absolute)) return null;
  const stat = await inspectSource(absolute);
  if (!stat) {
    if (topLevel) throw new Error('Symbolic links and junctions cannot be imported');
    return null;
  }
  const name = path.basename(absolute);
  normalizeVaultPath(name);
  if (++counts.entries > MAX_ENTRIES) throw new Error(`An import may contain at most ${MAX_ENTRIES} files and folders`);
  if (stat.isFile()) {
    if (++counts.files > MAX_FILES) throw new Error(`An import may contain at most ${MAX_FILES} files`);
    return { kind: 'file', source: absolute, name, stat };
  }
  if (!stat.isDirectory()) throw new Error('Only regular files and folders can be imported');
  const children = [];
  const entries = await fs.readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (PRIVATE_NAMES.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
    const child = await planSource(path.join(absolute, entry.name), counts);
    if (child) children.push(child);
  }
  const after = await inspectSource(absolute);
  if (!after || !after.isDirectory() || after.dev !== stat.dev || after.ino !== stat.ino) throw changed();
  return { kind: 'directory', source: absolute, name, children };
}

async function readSourceFile(entry) {
  const before = await inspectSource(entry.source);
  if (!before?.isFile() || !sameFile(before, entry.stat)) throw changed();
  const handle = await fs.open(entry.source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) throw changed();
    const current = await inspectSource(entry.source);
    if (!current?.isFile() || !sameFile(current, opened)) throw changed();
    const bytes = await handle.readFile();
    if (!sameFile(opened, await handle.stat()) || bytes.length !== opened.size) throw changed();
    return bytes;
  } finally { await handle.close(); }
}

async function createUnique(store, folder, name, operation, directory = false) {
  const extension = directory ? '' : path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let suffix = 0; suffix < MAX_ENTRIES; suffix++) {
    const candidate = suffix ? `${stem} ${suffix}${extension}` : name;
    const relative = normalizeVaultPath(folder ? `${folder}/${candidate}` : candidate);
    try { return { relative, result: await operation(relative) }; }
    catch (error) { if (!collision(error)) throw error; }
  }
  throw new Error('Too many attachments have this name. Choose another destination folder.');
}

/** Copy explicitly selected local files/directories into one already captured vault. */
export async function importExternalFiles(store, absolutePaths, destinationFolder = '') {
  const imported = [];
  try {
    if (!Array.isArray(absolutePaths)) throw new Error('Expected a list of absolute import paths');
    const folder = await inspectDestination(store, destinationFolder);
    const counts = { files: 0, entries: 0 };
    const plans = [];
    // Complete enumeration before creating anything, including when the source contains the vault.
    for (const value of absolutePaths) {
      const plan = await planSource(absoluteSource(value), counts, true);
      if (plan) plans.push(plan);
    }
    const copy = async (entry, destination) => {
      if (entry.kind === 'file') {
        const bytes = await readSourceFile(entry);
        const { result } = await createUnique(store, destination, entry.name, (relative) => store.createBytes(relative, bytes));
        imported.push(result);
        return;
      }
      const { relative } = await createUnique(store, destination, entry.name, (candidate) => store.mkdir(candidate), true);
      for (const child of entry.children) await copy(child, relative);
    };
    for (const plan of plans) await copy(plan, folder);
    return imported;
  } catch (error) {
    error.imported = [...imported];
    throw error;
  }
}

/** Persist clipboard image bytes only after checking the PNG signature. */
export async function saveClipboardPng(store, pngBuffer, destinationFolder = '') {
  if (!(pngBuffer instanceof Uint8Array)) throw new Error('Expected PNG image bytes');
  const bytes = Buffer.from(pngBuffer);
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('Clipboard image is not a PNG');
  const folder = await inspectDestination(store, destinationFolder);
  const name = `Pasted image ${Date.now()}-${crypto.randomBytes(6).toString('hex')}.png`;
  const { result } = await createUnique(store, folder, name, (relative) => store.createBytes(relative, bytes));
  return result;
}
