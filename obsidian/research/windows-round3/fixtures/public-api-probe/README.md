# Reference Public API Probe

Import **manifest.json** and **main.js** together through the host's plugin UI, then enable **Reference Public API Probe**. These are the only runtime files. The plugin requires only `obsidian`; it does not use Node filesystem APIs, Electron, network access, private plugin managers, or private command registries.

This reusable wrapper was extracted from the independently authored round-three probes whose original-host observations are in `research/raw/windows-round3-*`. **This exact manifest/main pair was subsequently executed in the isolated original application as `wrapper01`: all 10 cases and 29 assertions passed.** See the [original execution report](../../../../docs/windows-round3-wrapper-reference.md) for source hashes, REA identity and boundaries. Results become a same-script comparison only after the independent host runs this same manifest/main pair and its hashes match. Registration or method availability is never counted as a behavior pass.

## Commands

Use the command palette; the host may prefix these names with **Reference Public API Probe:**.

1. **01 Prepare dedicated editor note** — creates or resets the marked `Reference API Lab/Editor.md` and opens source mode. Keep that note active.
2. **02 Editor transaction undo redo** — an actual `editorCallback` command. It refuses all other files and any unmarked editor document. It tests two changes in original coordinates, one undo, and redo. The synthetic note remains changed to the final redo value.
3. **03 View split lifecycle** — creates two custom views, including one vertical split, records `onOpen`/`setState`, detaches the first, and leaves the second open for a later manual disable test.
4. **04 Render and resources** — tests temporary ribbon/status creation, callback and removal; opens the marked `Render.md` in reading mode; records postprocessor order, section info, code-block source and child callbacks; separately exercises `MarkdownRenderer.render` with a parent `Component`.
5. **05 Frontmatter and binary** — runs three minimal frontmatter cases (update, callback throw, two concurrent counter updates) and an ArrayBuffer create/read/modify/append roundtrip. It does not claim complete YAML formatting parity.
6. **06 Show saved observations** — displays the current structured JSON. The ribbon flask icon opens the same dialog. **Refresh JSON**, **Save observations**, **Select JSON**, and **Close** are available.
7. **07 Save and show observations** — awaits a save attempt, then displays the report.

Commands 02–05 show the report after they finish; close it before the next command. Command 01 deliberately leaves the editor visible for command 02. An unsupported optional API is recorded independently; the preparation and report commands remain available. `pass` requires successful recorded checks; `fail`, `unsupported`, and `error` remain distinct.

## Ownership and writes

All vault writes are inside `Reference API Lab/`. A new root gets `Fixture Marker.md`. If that root already exists without the exact marker, the plugin refuses to proceed. Every existing text fixture must contain `<!-- reference-public-api-probe:v1:synthetic-only -->` before it can be overwritten. `Bytes.bin` must begin with the ASCII bytes `REFERENCE-PUBLIC-API-PROBE:v1\n`. A mismatch is refused; no backup, reset, recursive operation, or delete is provided.

Files: `Fixture Marker.md`, `Editor.md`, `Render.md`, `Frontmatter Update.md`, `Frontmatter Throw.md`, `Frontmatter Counter.md`, and `Bytes.bin`. `Virtual.md` is a source-path label for in-memory Markdown rendering and is not written. Reports use the plugin's public `saveData` API; the persistence location is host-defined. Use the report dialog for this run. Re-enabling preserves prior report sessions when that host successfully persisted them.

## Manual disable boundary

After commands 03 and 04, close the report and disable the plugin through the host UI. Inspect the persistent custom tab, primary ribbon icon, and status item externally. The reference observations showed a surviving custom leaf with its type/state preserved in an inactive-plugin placeholder, while the prior view received `onClose`. Ordinary postprocessor children can remain alive until their rendered note is replaced; plugin disable is not a universal immediate child-unload contract.

`onunload` records a best-effort save attempt only. A host may revoke `saveData` before that hook or may not await it, and a disabled plugin cannot reliably observe later teardown. The report explicitly marks that completion unverified. Use external UI evidence for the disabled placeholder and resource cleanup; do not count a missing final log as a pass. There is no automated disable/re-enable command.

## Validation of this package

JavaScript syntax and manifest JSON validation passed. The original application then loaded the exact frozen files through its real plugin manager, and its command registry invoked commands 01–05 and 07 under the REA-controlled isolated harness. The harness did not call wrapper test functions directly; it did not use physical command-palette gestures. Independent native UI behavior remains a separate report. No production build is part of this fixture package.
