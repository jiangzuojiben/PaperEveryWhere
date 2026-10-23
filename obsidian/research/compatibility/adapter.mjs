import { getReferences, planRename, resolveLink } from '../../core/vault.mjs';

const DEFAULT_SETTINGS = Object.freeze({
  alwaysUpdateLinks: true,
  newLinkFormat: 'shortest',
  useMarkdownLinks: false,
});

const isMarkdown = path => /\.md$/i.test(path);
const within = (path, parent) => path === parent || path.startsWith(`${parent}/`);
const normalizeReference = reference => ({
  kind: reference.kind,
  original: reference.original ?? null,
  link: reference.link,
  subpath: reference.subpath ?? '',
  path: reference.path ?? null,
});

function references(files, path) {
  if (!isMarkdown(path)) return [];
  return getReferences(files[path], path, Object.keys(files)).map(normalizeReference);
}

function snapshot(files, paths) {
  return Object.fromEntries(paths.map(path => [path, {
    text: files[path],
    references: references(files, path),
  }]));
}

// A case's namespace is derived from its input, not the expected result. Keep
// explicitly moved files too, so an operation crossing a namespace is observable.
function scopedPaths(files, test) {
  const initial = Object.keys(test.files);
  const roots = new Set(initial.filter(path => path.includes('/')).map(path => path.split('/')[0]));
  const rootFiles = new Set(initial.filter(path => !path.includes('/')));
  const action = test.action;
  return Object.keys(files).filter(path =>
    roots.has(path.split('/')[0]) || rootFiles.has(path) ||
    (action.kind === 'create' && path === action.path) ||
    (action.kind === 'rename' && within(path, action.newPath))
  ).sort();
}

function needsPrompt(files, action, settings) {
  if (action.kind !== 'rename' || action.via !== 'managed' || settings.alwaysUpdateLinks) return false;
  try {
    const preview = planRename(files, action.path, action.newPath, {
      ...settings, via: 'managed', decision: 'once',
    });
    return preview.changes.some(change => change.before !== change.after);
  } catch {
    // Report an invalid operation through the real operation's error field.
    return false;
  }
}

/** Execute the frozen declarative protocol against the independent core. */
export async function runSuite(corpus) {
  const results = [];
  try {
    if (corpus?.schema !== 'obsidian-compat-input-v1' ||
        !Array.isArray(corpus.resolution) || !Array.isArray(corpus.renames)) {
      throw new TypeError('Expected an obsidian-compat-input-v1 corpus');
    }
    let files = Object.assign({}, ...[...corpus.resolution, ...corpus.renames].map(test => test.files));
    let settings = { ...DEFAULT_SETTINGS };

    for (const test of corpus.resolution) {
      const paths = Object.keys(files);
      results.push({
        id: test.id,
        kind: 'resolve',
        settle: { status: 'stable-observed' },
        queries: test.queries.map(query => ({
          ...query,
          path: resolveLink(query.linkpath, query.sourcePath, paths) ?? null,
        })),
        references: Object.fromEntries(Object.keys(test.files)
          .filter(isMarkdown).map(path => [path, references(files, path)])),
      });
    }

    for (const test of corpus.renames) {
      settings = { ...settings, ...test.settings };
      const action = test.action;
      const prompt = needsPrompt(files, action, settings)
        ? { kind: 'update-links', decision: action.decision } : null;
      let operationError = null;
      try {
        if (action.kind === 'rename') {
          const planned = planRename(files, action.path, action.newPath, {
            ...settings, via: action.via, decision: action.decision,
          });
          files = planned.files;
          settings = Object.fromEntries(Object.keys(DEFAULT_SETTINGS)
            .map(key => [key, planned.settings?.[key] ?? settings[key]]));
        } else if (action.kind === 'create') {
          if (Object.hasOwn(files, action.path)) throw new Error(`File already exists: ${action.path}`);
          files = { ...files, [action.path]: action.text };
        } else {
          throw new Error(`Unsupported action: ${action.kind}`);
        }
      } catch (error) {
        operationError = error.message;
      }
      results.push({
        id: test.id,
        kind: action.kind,
        settle: { status: 'stable-observed' },
        operationError,
        prompt,
        after: {
          files: snapshot(files, scopedPaths(files, test)),
          settings: { ...settings },
        },
      });
    }
    return { status: 'complete', results };
  } catch (error) {
    return { status: 'failed', results, error: error.message };
  }
}
