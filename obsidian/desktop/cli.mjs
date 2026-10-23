#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { VaultStore, isTextFile, normalizeVaultPath } from './vault-store.mjs';
import { searchFiles } from '../core/vault.mjs';

const HELP = {
  usage: 'node desktop/cli.mjs --vault PATH <command> [arguments]',
  commands: {
    list: 'list [folder] — list local paths and file metadata',
    read: 'read <path> — read text, or base64 for binary files',
    create: 'create <path> [text] — create without overwriting',
    append: 'append <path> [text] — append with an external-change check',
    rename: 'rename <oldPath> <newPath> — move and maintain note references',
    search: 'search <query> — search local text files',
  },
  options: { '--content TEXT': 'Text for create/append', '--stdin': 'Read create/append text from stdin', '--no-update-links': 'Rename storage only, leaving link text unchanged', '--help': 'Print this JSON help' },
  output: 'Successful commands print JSON to stdout. Errors print JSON to stderr with exit code 1.',
  safety: 'An explicit --vault is required. No saved desktop vault or environment fallback is used.',
};

async function stdinText(stream) {
  let value = '';
  for await (const chunk of stream) value += chunk;
  return value;
}

export async function runCli(argv, { input = process.stdin } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { vault: { type:'string' }, content: { type:'string' }, stdin: { type:'boolean' }, 'no-update-links': { type:'boolean' }, help: { type:'boolean', short:'h' } } });
  if (values.help) return HELP;
  const [command, ...args] = positionals;
  if (!Object.hasOwn(HELP.commands, command || '')) throw new Error('Choose a command: list, read, create, append, rename or search');
  if (!values.vault) throw new Error('An explicit --vault PATH is required');
  if (!path.isAbsolute(values.vault)) throw new Error('--vault must be an absolute directory path');
  if ((values.content !== undefined || values.stdin) && !['create', 'append'].includes(command)) throw new Error('--content and --stdin apply only to create and append');
  if (values['no-update-links'] && command !== 'rename') throw new Error('--no-update-links applies only to rename');
  if (values.stdin && (values.content !== undefined || args.length > 1)) throw new Error('Choose one content source: positional text, --content or --stdin');
  const required = command === 'rename' ? 2 : command === 'list' ? 0 : 1;
  if (args.length < required) throw new Error(`Missing arguments for ${command}`);
  if (['read', 'list'].includes(command) && args.length > 1 || command === 'rename' && args.length > 2 || ['create', 'append'].includes(command) && args.length > 2) throw new Error(`Too many arguments for ${command}`);
  if (values.content !== undefined && args.length > 1) throw new Error('Choose either positional text or --content');
  const store = await VaultStore.open(values.vault, { watchFiles: false });
  try {
    if (command === 'list') {
      const prefix = args[0] ? normalizeVaultPath(args[0]) : '';
      const snapshot = await store.snapshot();
      return { vaultPath: store.root, files: snapshot.files.filter((file) => !prefix || file.path === prefix || file.path.startsWith(`${prefix}/`)).map(({ content, text, ...metadata }) => metadata) };
    }
    if (command === 'read') {
      const { data, mtime } = await store.readBytes(args[0]);
      const encoding = isTextFile(args[0]) ? 'utf8' : 'base64';
      return { path: normalizeVaultPath(args[0]), content: data.toString(encoding), encoding, size: data.length, mtime };
    }
    if (command === 'create' || command === 'append') {
      const content = values.stdin ? await stdinText(input) : values.content ?? args[1] ?? '';
      if (command === 'create') return await store.create(args[0], content);
      if (!isTextFile(args[0])) throw new Error('Append supports text files only');
      const previous = await store.read(args[0]);
      return await store.write(args[0], previous.content + content, previous.mtime);
    }
    if (command === 'rename') return await store.rename(args[0], args[1], values['no-update-links'] ? { via: 'storage' } : {});
    const snapshot = await store.snapshot();
    const files = Object.fromEntries(snapshot.files.filter((file) => typeof file.content === 'string').map((file) => [file.path, file.content]));
    return { query: args.join(' '), results: searchFiles(files, args.join(' ')) };
  } finally { store.close(); }
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  try { process.stdout.write(`${JSON.stringify(await runCli(process.argv.slice(2)))}\n`); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ error: { message: error.message, code: error.code || 'CLI_ERROR' } })}\n`);
    process.exitCode = 1;
  }
}
