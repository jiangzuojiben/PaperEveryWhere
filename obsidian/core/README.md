# Vault core

Independent JavaScript ESM operations with no Node or Electron imports. The only
parser dependency is `yaml`. Source strings and file maps are never mutated.

- `parseMarkdown(text)` returns `frontmatter`, YAML parse diagnostics, `headings`,
  `tags` (including `#`), block IDs and unresolved reference metadata. Lines are
  **1-based**; `start/end/pathStart/pathEnd` offsets use JavaScript UTF-16 indexes
  and exclusive end positions. Wiki references in `%%` comments participate;
  code spans, fenced/indented code and HTML comments are masked.
- `resolveLink(linkpath, sourcePath, paths)` accepts a file path array, Set, Map,
  or file record. `sourcePath` includes the source filename. Raw paths are not
  URL-decoded. Explicit `/`, `./`, `../` paths do not fall back to fuzzy matches.
  Bare paths use the frozen reference's root precedence, raw suffix/prefix
  matching and short-path preference. Equal candidates use a stable lexical
  tiebreaker; the reference suite accepts observed ties, not a required ordering.
- `getReferences(text, sourcePath, paths)` resolves metadata and returns ordinary
  links, embeds, then frontmatter references, preserving source order within each
  group. `link` includes the heading/block `subpath`; `linkpath` does not.
- `planRename(files, oldPath, newPath, settings)` plans a complete file or folder
  move. It returns `{files, changes, settings}`. Changes are
  `{path, oldPath?, before, after, kind: 'rename'|'edit'}`. All preexisting resolved
  target identities are protected, including links to unmoved files affected by
  a newly introduced name collision. Unresolved links are left verbatim.
  Markdown and Canvas entries are maintained. Other entries contribute paths but
  their bytes are not parsed. Canvas `file` nodes retain vault-root target paths,
  including attachments; Markdown within `text` nodes uses the same target
  preservation rules. Unknown node fields, edges and file-node `subpath` are
  preserved. An edited Canvas is serialized as two-space JSON; an unchanged or
  invalid Canvas retains its exact bytes. This behavior has independent unit
  tests and is **outside the frozen REA compatibility corpus**. Bases query and
  expression strings are deliberately not rewritten.
  Settings default to `alwaysUpdateLinks: true`, `newLinkFormat: 'shortest'`,
  `useMarkdownLinks: false`; `via: 'storage'` disables maintenance.
  With automatic updates disabled, `decision: 'once'|'always'` enables this
  operation, and only `always` updates the returned preference. The caller owns
  the user prompt and filesystem transaction. `relative` and `absolute` output
  formats are supported in addition to the frozen `shortest` cases.
- `searchFiles(files, query)` returns `{path, matches: [{line,text}], score,
  snippet}`. Supported expressions include implicit AND, AND/OR/NOT, `-term`,
  parentheses, quoted terms, regular expressions, `path:`, `file:`, `content:`,
  `tag:`, task status filters and `[property:value]`.

The frozen strict-reference corpus validates a bounded set of link/rename
semantics. It is not a claim of complete Markdown or Obsidian compatibility.
Reference-style Markdown definitions, Bases references, and plugin-defined
syntaxes are not included in this parser or the frozen corpus.
