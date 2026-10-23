# Views UI verification — 2026-10-23

Verification performed in Chromium through Playwright against the Vite application at `http://127.0.0.1:5178`, with an isolated browser profile. Times below use Asia/Hong_Kong. Browser preview data was isolated from the user's local vault. These checks establish the specific behaviors below; they do not establish full Obsidian compatibility.

## Actual application UI checks

| Time | View and steps | Observed result | Evidence |
| --- | --- | --- | --- |
| 13:41–13:42 | Open `灵感画布.canvas`; drag the first text card's right connection port onto the file card's left port. | Connection count changed from 1 to 2. The preview's persisted Canvas JSON contained a new edge with the expected `fromNode`, `fromSide`, `toNode`, `toSide`, and `toEnd: arrow`. | `output/playwright/canvas-connect.yml` |
| 13:42–13:43 | Open `笔记目录.base`; select `status`, operator “包含”, value `待整理`; apply the filter. | Six records became one: `项目/阅读清单.md`, with `status: 待整理` and tag `阅读`. | `output/playwright/base-filter.yml` |
| 13:43 | Open `开始.md`; open Properties; change `status` from `进行中` to `已完成`; blur the field. | Persisted Markdown contained `status: 已完成`. The body still contained `# 从一个想法开始`. | Initial property UI: `output/playwright/properties-before-edit.yml`; persisted text inspected after the UI edit. |
| 13:43–13:46 | Open Graph, then enable Local Graph. Select `开始.md`, then `知识网络.md` as the center note. | Global graph showed 7 nodes / 4 edges. Local `开始.md` showed 3 nodes / 2 edges; local `知识网络.md` showed 4 nodes / 3 edges. Automatic fitting kept nodes inside the viewport. | `output/playwright/graph-local.yml` |
| 14:05–14:06 | Open the Canvas file card for `知识网络.md`; inspect its rendered content; click the `开始` wiki link inside the card. | Card rendered four headings, two wiki links, and one KaTeX formula. Clicking the link opened the actual `开始.md` editor; the canvas was no longer the active view. | `output/playwright/canvas-markdown-preview.png` |

## Media and malformed-file component UI checks

The browser preview bridge does not supply attachment URLs. These checks therefore used the real `CanvasView` and `BasesView` components in an isolated fixture with an explicit `resolveAsset` callback, rather than claiming desktop host end-to-end coverage. The fixture is in the ignored `output/playwright/views-fixture.html` and `views-fixture.jsx` files. Image, WAV, and WebM media were generated locally; there was no media download.

| Time | Steps | Observed result | Evidence |
| --- | --- | --- | --- |
| 14:08–14:12 | Render Markdown, image, audio, video, safe-link, and deliberately invalid-protocol cards. | Image loaded at natural width 640. Audio reached `readyState: 4`, duration 0.3 seconds. Video reached `readyState: 4`, 320 × 180 pixels, duration approximately 0.404 seconds. Native playback controls were visible. This checks successful decoding and controls, not every codec or audible output. | `output/playwright/canvas-media-fixture.png` |
| 14:08–14:12 | Render `Note.md#Section`, which contains a heading, a task, a formula, and a script element. | Only the requested section appeared; the following section did not. The task checkbox was checked and disabled. Formula rendering succeeded. The script did not execute (`window.__fixtureAttack` remained false). | `output/playwright/canvas-media-fixture.png` |
| 14:10 | Click the safe external-link button using a fixture host callback; inspect a `javascript:` link and a resolver result beginning with `file:`. | The host callback received normalized `https://example.com/`. The JavaScript link's open button was disabled. The file-protocol image displayed a protocol error and was not embedded. | `output/playwright/canvas-media-fixture.png` |
| 14:10 | Open Base YAML with `order: [null]`. | A clear configuration error appeared, filtering was disabled, the component stayed mounted, and the write callback count remained zero. | `output/playwright/base-malformed-safe.png` |
| 14:11 | Select a valid Canvas card to open its inspector, then replace the incoming document with malformed JSON. | Error displayed; the stale inspector disappeared; add-card controls were disabled; write callback count remained zero. | `output/playwright/canvas-malformed-safe.png` |
| 14:12 | Toggle the fixture from dark to light CSS variables. | Cards, reading text, and controls remained visible in both themes. | `output/playwright/canvas-media-light.png` |

All evidence paths are relative to the `obsidian` project root. `output/` is intentionally ignored by Git; screenshots and UI snapshots are local verification artifacts, not shipped application assets.

## Second-round Bases component verification

On 2026-10-23 at 16:28–16:40, an isolated Chromium session rendered the real updated `BasesView` at `http://127.0.0.1:5178/output/playwright/bases-fixture.html`. The fixture source is `output/playwright/bases-fixture.jsx`. It supplied three Markdown records and one Base record, plus React state-backed `onChange` and `onEditFile(path, text)` callbacks. Callback results and displayed values were inspected after the UI actions.

These are **browser component checks, not desktop host end-to-end checks**. Writes below mean updated fixture file text through the actual callback contract, not writes to a filesystem vault. This round did not launch Electron, verify desktop persistence/reopening, or verify the desktop attachment resolver. The application integration now supplies `path`, `onEditFile`, and file metadata, but that wiring is not established by this fixture.

| Time | UI action or fixture configuration | Observed result | Evidence |
| --- | --- | --- | --- |
| 16:28–16:29 | Load `total: price * quantity` and `label: if(completed, "Done", "Open")`; configure descending `formula.total` sorting, `status` grouping, and `groupOrder: [planned, done, archived]`. | The planned group contained Alpha (24) then Gamma (9); done contained Beta (15). The explicitly configured archived group remained visible with zero rows. The total sum was 48. | Fixture source; initial accessibility snapshot `.playwright-cli/page-2026-10-23T08-28-48-080Z.yml`. |
| 16:30 | Click Alpha's price edit button, change the numeric input from 12 to 20, and save. | `onEditFile` received `Projects/Alpha.md` with numeric `price: 20`. The YAML comment, unrelated `extra` property, and exact Markdown body remained present. Its total changed from 24 to 40; the sum changed from 48 to 64. | Callback text and footer values inspected after saving; snapshot `.playwright-cli/page-2026-10-23T08-30-17-775Z.yml`. |
| 16:35 | Check Alpha's completed checkbox. | The note callback changed `completed` to Boolean `true`; its formula label changed from Open to Done. | The checked checkbox and Done output are visible in `output/playwright/bases-formula-filter.png`. |
| 16:35 | Open the formula editor; create `taxTotal` with `(formula.total * 1.1).round(2)`; save. | The Base configuration gained the formula and its visible column. Alpha's output was 44. Existing `unknownSetting: keep-me` and view-level `pluginSetting: keep-this-too` survived the update. | Saved configuration inspected through the fixture callback state; snapshot `.playwright-cli/page-2026-10-23T08-35-49-595Z.yml`. |
| 16:36 | Use the filter builder for this view: `formula.taxTotal`, greater than, 20. | The builder saved `formula["taxTotal"] > 20` under the view's `filters.and`, retaining the global Markdown filter. Three records became one (Alpha); the total sum became 40. The configured done and archived groups remained visible as empty groups. No evaluation error appeared. | `output/playwright/bases-formula-filter.png`; saved Base configuration and visible files inspected after applying. |
| 16:40 | Open Base YAML, replace the draft with incomplete `views:`, and click Apply. | The editor displayed `views 必须是视图数组`. The last valid saved configuration remained intact, including the unknown field; the write log remained at the four successful earlier writes. | Snapshot `.playwright-cli/page-2026-10-23T08-40-30-448Z.yml`; saved value and write count inspected after rejection. |

The screenshot was visually checked for table readability, group headers, formula values, filter controls, and the summary footer. This round rendered configured sorting and grouping; it did not separately exercise Shift-click multi-column sorting, every group selector action, or every cell editor type in the browser.

### Model and source checks

The final command `node --test tests/views-model.test.mjs` passed **39 tests, 0 failures**. These tests cover:

- YAML note edits preserving body text, comments, BOM, CRLF, unrelated fields, and value types; rejection of malformed note YAML and writes to file/formula properties.
- Base configuration round-trips preserving unknown global, view, and property fields.
- Expression precedence, escaped literals, shorthand/bracket/nested property access, short-circuit conditions, formula dependencies, direct/indirect cycles, per-record isolation, explicit `thisRecord`, and a fixed clock.
- Numeric conversion/formatting, calendar month-end arithmetic, durations, date fields, invalid date/overflow rejection, list membership, and nested map/filter/reduce scopes.
- Global/view-compatible recursive filters, including NOT's none-of semantics; folders, nested/inline tags, property existence, and internal link resolution.
- Multi-property and formula sorting without mutating the input records; automatic/manual grouping, explicit empty groups, missing values, and distinct false/zero values.
- Numeric/date/Boolean summaries, custom `values` summary formulas, and stable per-row/per-call-site `random()` values within a view cache.
- Rejection of host function calls and prototype traversal; no execution of data getters/coercion callbacks; bounded syntax/dependency depth, cyclic YAML handling, and bounded output expansion.

The `Views.jsx` source also passed Vite's standalone JSX transform. A separate model probe confirmed a frontmatter wikilink with an alias resolves through `related.asFile().basename`. No production build was run in this round; the parent integration build remains separate.

### Implemented Bases surface

- Formula columns are calculated through a tokenizer, AST, and whitelisted interpreter, with visible per-cell errors. The evaluator does not use `eval` or the `Function` constructor.
- Note cells expose text, number, checkbox, list, date, datetime, and JSON editors. Number and checkbox edits were exercised in the browser; the model tests verify typed value preservation and safe note updates. File metadata and formula columns are read-only.
- The table supports column visibility/order/display names, formula creation/editing, multi-column sorting, grouping with explicit group ordering/empty groups, and per-column built-in or custom summaries.
- The filter builder supports global or current-view scope, AND/OR/NOT composition, comparisons, containment, prefix/suffix, and empty-value checks. The YAML editor supports nested filter configuration.
- File names and basenames are distinct. File tags, links, embeds, and backlinks derive from vault content; sizes and created/modified times can use supplied metadata. The current Base path provides the main-view `this.file` context.

Format and behavior references: [official Bases syntax](https://obsidian.md/help/bases/syntax), [official functions](https://obsidian.md/help/bases/functions), and [official views documentation](https://obsidian.md/help/bases/views). The implementation and checks above cover the stated subset, not the complete reference product.

## Additional code checks

- JSX parsing passed after the changes.
- Pure checks covered safe external/asset URL schemes, credential-bearing URLs, heading/block fragments, and malformed Base view/order/sort/property configurations.
- Earlier checks covered local graph topology, Canvas validation, YAML comments/body/newline preservation, and common Base filter expressions.
- The earlier application production build passed. The parent task performs the final production build/package after integration.

## Remaining compatibility boundaries

- Bases now supports the table/formula/editing/filter/sort/group/summary surface described above. Non-table layouts are still not implemented; their configuration is preserved and the UI explicitly reports that it is showing a table fallback.
- Regular-expression literals/functions and plugin-provided formula functions are not implemented. Date formatting supports common numeric year/month/day/time tokens, not the full Moment format language. Untyped frontmatter date strings require explicit conversion such as `date(due)`; this round did not implement the full Obsidian property-type registry.
- Formula link/image/HTML renderers use the existing safe navigation, asset, and Markdown paths, but this second-round fixture did not independently verify all of those renderers. `icon()` renders a limited common icon set; unknown names display as text. Desktop asset URLs and full embedded/sidebar `this` context behavior are not established by these checks.
- Created/modified times require real host metadata and are not fabricated when absent. Large-vault performance, all function/type combinations, all cell editor interactions, and full desktop persistence remain outside this verification.
- Canvas text nodes retain direct text editing. Markdown file nodes render reading content; supported media file nodes use the supplied attachment resolver. Web pages open externally rather than embedding third-party iframes. PDF cards open the application's PDF reader.
- Group background-image configuration is preserved but is not rendered. This verification does not cover every native Canvas interaction, large-vault performance, every media codec, or desktop attachment protocol playback end to end.
