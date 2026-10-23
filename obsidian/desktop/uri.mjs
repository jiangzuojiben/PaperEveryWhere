import path from 'node:path';
import { normalizeVaultPath } from './vault-store.mjs';

/** Parse our own URI format. This never opens a vault or executes filesystem work. */
export function parseVaultdeskUri(input) {
  if (typeof input !== 'string' || input.length > 1024 * 1024) throw new Error('Invalid VaultDesk URI');
  let url;
  try { url = new URL(input); } catch { throw new Error('Invalid VaultDesk URI'); }
  if (url.protocol !== 'vaultdesk:' || url.username || url.password || url.port || url.hash || (url.pathname && url.pathname !== '/')) throw new Error('Unsupported VaultDesk URI');
  const action = url.hostname;
  if (!['open', 'new'].includes(action)) throw new Error('Supported URI actions are open and new');
  const allowed = new Set(action === 'open' ? ['file', 'vault'] : ['name', 'content', 'vault']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new Error('Unknown or repeated URI parameter');
  }
  const vault = url.searchParams.get('vault') || null;
  if (vault?.includes('\0')) throw new Error('Invalid URI vault');
  const requested = url.searchParams.get(action === 'open' ? 'file' : 'name');
  if (!requested) throw new Error(action === 'open' ? 'The URI requires a file' : 'The URI requires a note name');
  let file = normalizeVaultPath(requested);
  if (action === 'new') {
    if (!path.posix.extname(file)) file += '.md';
    if (!file.toLowerCase().endsWith('.md')) throw new Error('The new URI action creates Markdown notes only');
  }
  return { action, vault, path: file, ...(action === 'new' ? { content: url.searchParams.get('content') || '' } : {}) };
}

export function matchesCurrentVault(requestedVault, currentRoot) {
  if (!requestedVault) return true;
  const fold = (value) => process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
  if (!/[\\/]/.test(requestedVault) && !path.isAbsolute(requestedVault)) return fold(requestedVault) === fold(path.basename(currentRoot));
  if (!path.isAbsolute(requestedVault)) return false;
  return fold(path.resolve(requestedVault)) === fold(path.resolve(currentRoot));
}

/** Apply only to the currently selected vault; callers display any errors to the user. */
export async function applyVaultdeskUri(store, input) {
  const request = parseVaultdeskUri(input);
  if (!matchesCurrentVault(request.vault, store.root)) {
    const error = new Error('This link names another vault. Open that vault with Open vault first, then use the link again.');
    error.code = 'URI_VAULT_MISMATCH';
    throw error;
  }
  if (request.action === 'new') await store.create(request.path, request.content);
  else await store.readBytes(request.path);
  return { type: 'open', path: request.path };
}
