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

## Additional code checks

- JSX parsing passed after the changes.
- Pure checks covered safe external/asset URL schemes, credential-bearing URLs, heading/block fragments, and malformed Base view/order/sort/property configurations.
- Earlier checks covered local graph topology, Canvas validation, YAML comments/body/newline preservation, and common Base filter expressions.
- The earlier application production build passed. The parent task performs the final production build/package after integration.

## Remaining compatibility boundaries

- Bases supports table views and a defined subset of filter expressions. Formulas, other layouts, advanced functions, and in-cell property editing are not complete.
- Canvas text nodes retain direct text editing. Markdown file nodes render reading content; supported media file nodes use the supplied attachment resolver. Web pages open externally rather than embedding third-party iframes. PDF cards open the application's PDF reader.
- Group background-image configuration is preserved but is not rendered. This verification does not cover every native Canvas interaction, large-vault performance, every media codec, or desktop attachment protocol playback end to end.
