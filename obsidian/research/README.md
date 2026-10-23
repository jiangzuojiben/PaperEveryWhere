# REA evidence and research boundary

Research date: 2026-10-23 (Asia/Hong_Kong). This directory contains factual observations and acceptance inputs for an independent implementation. It does not contain the original Obsidian implementation.

- `rea-scope-2026-10-23.json`: sanitized, reproducible projection of this round's two retained REA Evidence records, the 31 registered core plugin constructors, cloud entry names, source offsets and hashes.
- `raw/20261023-core-scope/`: ignored local raw output. Includes the original-ASAR REA record, targeted derived inputs and their provenance, stderr, and intermediate attempts. Do not distribute raw application slices or record user vault contents here.
- `compatibility/`: the separately maintained adapter corpus from the prior link-resolution and rename experiment. Its presence or a passing reference run is not evidence that this application passes.
- `../docs/parity.md`: all planned compatibility surfaces, with current implementation acceptance explicitly unverified.

## Actual execution and identity

REA `6.7.0`, Node `24.13.1`, Windows. Original core package version `1.13.7`:

```text
core ASAR SHA-256: a52a7daf1e2460bae03de80f2816604bd16a56cd374fbe5ce8d1a9ef5604059d
app.js SHA-256:    8efbf581e259cabef4f9c9a34814cfe3c02863757377e56b3603933c50e89898
```

| Analysis | New REA Evidence ID | Actual scope |
| --- | --- | --- |
| Original ASAR | `ev_a048f1b4e87af29d1b416e1ec0a35573ce510a521d2bc12e3739dc68b17a15bf` | Whole artifact identity/integrity; source selection `package.json`, `main.js`; one parsed JavaScript file, 27,491 visited AST nodes, zero parse failures |
| Targeted derived tree | `ev_e2864ebccbf0d9e2da9924351ded4444dd4fc2c6d015f70c124aa8370a443abc` | 57 exact source slices from app.js, 11,244 bytes, 3,496 visited AST nodes, zero parse failures |

The second subject is a derived tree, not the original ASAR. The extraction manifest maps each fragment to the original member's UTF-16 and UTF-8 byte offsets and both exact-slice/projected hashes. The plugin-to-constructor mapping is a supplemental AST inspection; REA independently parses the retained snippets. This is not a runtime registration or enablement observation. There were no cloud requests, no original-code execution, no credential access, and no application changes. The original ASAR hash was unchanged after analysis.

The first `targeted/` extraction attempt stopped on a duplicate helper filename and remains an incomplete artifact. `targeted-02/` and its REA evidence were successful but covered fewer cloud helpers. The final scope is `targeted-03/`; only its complete record is projected into the tracked summary. Failed or superseded attempts are not counted as completed final evidence.

## What the new evidence establishes

The 1.13.7 startup source contains 31 `loadPlugin(new ...)` registrations. The registry includes `editor-status` and `markdown-importer`, which can be missed by copying only the current help-site list. Publish and Sync are conditional on `Ab.publish` and `Ab.sync`; Web viewer additionally requires the desktop platform and `Ab.webViewer`. Constructor `defaultOn` values are not an enabled-plugin list; a missing value remains unknown in the projection.

Static account and remote-vault entry points include `/user/*`, `/vault/*`, `/publish/*`, and `/subscription/*`. The `/vault` family includes list/create/migrate/rename/access/share operations. It is therefore wrong to infer that Sync has no cloud interface merely because a search for a literal `/sync/` returns no matches. The API origin is assembled from string fragments; the published-site origin is literal. No requests were sent to either.

Selected Sync methods show host selection, status, and a request-scheduling entry point. Other method names identify filters, special-file policy, local file events, version history, deleted-file recovery and configuration-file handling. Publish methods identify includes/excludes, change scanning, passwords, custom URL, file upload/download/removal and site settings. These are names and code paths, not proven server contracts. The encryption path has multiple versions in the original sample; the current implementation must establish its own explicit protocol and key-migration rules rather than claiming protocol compatibility from a general AES-GCM description.

The replacement services should preserve product-level behaviors behind their own account, sync and publish interfaces. Exact original network endpoint names, account/session compatibility, commercial entitlement checks or access to the original service are not needed for a self-hosted implementation.

## Reproduce

From the `obsidian` directory:

```powershell
.\scripts\rea-reproduce.ps1
```

The script locates a cached package whose manifest is exactly REA 6.7.0, checks the fixed ASAR hash, creates a new ignored raw run, runs both analyses, and verifies that the source hash is unchanged. It performs no REA setup or MCP registration. Supply `-CoreAsar`, `-ReaPackageDirectory`, or `-OutputDirectory` for another local layout. `-SummaryOutput` optionally writes a new sanitized projection; existing outputs are never overwritten. The Babel parser is read from the package tree beside the cached REA package. The extractor deliberately fails if the pinned startup signature or count changes.

The complete reproduction script was executed successfully into `raw/20261023-reproduce-verified/`. Its before/after ASAR hashes match. The repeated host Evidence ID is identical; the repeated derived-tree Evidence ID is `ev_04d6f137267bd611fa10bb5c1633f1b2b9fed6b4cd884613f962967b2c11d78f`. The derived tree has a different local artifact identity/location; the source fragments, plugin count, statistics and original sample hashes are the same.

## Browser acceptance plan

REA `capture-browser-scenario SCENARIO.json --json` can capture the independent application's test URL directly. The original-app reference path already used a local controller and isolated API probes, not direct original UI control. Keep the two capture subjects distinct.

After launching the independent client's synthetic test session, a basic capture can be recorded with:

```powershell
node .\scripts\rea-capture-client.mjs --url http://127.0.0.1:5173/ --output .\research\raw\client-capture-01
```

This wrapper is syntax-checked but has not been run against a live independent client in this research round. Its default scenario only waits for a document and records its state. Supply `--scenario` with explicit feature actions to exercise a flow; the scenario's `start_url` must match `--url`. It neither creates a running app nor claims feature acceptance.

For the independent client, create a synthetic vault and stable `data-testid` selectors for: create note, edit/save, resolve Wiki link, follow backlink, rename target, close/reopen, PDF page jump, Canvas edit, Bases filter and service sync status. A scene should end by capturing DOM, accessibility and URL; persist operation results plus file hashes separately. UI screenshots, file-byte assertions and service logs must be compared together where the behavior depends on them. Do not report a successful DOM capture as proof of data persistence or cloud convergence.

Browser success is still pending for the complete product matrix. This round performed static REA analysis only.

## Primary public references

- [Core plugins](https://obsidian.md/help/Plugins/Core%2Bplugins): the live documentation is useful for feature scope, not a historical 1.13.7 manifest.
- [Bases](https://obsidian.md/help/bases), [Bases syntax](https://obsidian.md/help/bases/syntax), [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/).
- [Sync security](https://obsidian.md/help/sync/security), [Sync setup](https://obsidian.md/help/sync/setup).
- [Publish sites](https://obsidian.md/help/publish/sites), [Publish custom domains](https://obsidian.md/help/publish/domains).
- [CLI](https://obsidian.md/help/cli): a separate compatibility surface; support must be verified per version.
