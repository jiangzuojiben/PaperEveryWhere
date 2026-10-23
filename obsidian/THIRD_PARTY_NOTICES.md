# Third-party components

VaultDesk is an independent application. Obsidian is referenced only as the
behavioral compatibility target; its application code, branding assets and
proprietary cloud services are not included in the distribution.

Project code uses the parent repository's MIT license, copied into
`resources/app/LICENSE` by the portable packaging script. Dependency licenses
remain their respective authors' licenses.

## Desktop and frontend

Exact resolved versions are recorded in `package-lock.json`. The portable
package records the installed dependency inventory in
`third-party/package-inventory.json` and preserves upstream license/notice
files, or their README license section where no separate license is shipped,
under `third-party/notices/`. The inventory is conservative and may list optional
Node dependencies that are not included in the browser bundle.

| Component | License |
| --- | --- |
| Electron 39.8.3 | MIT; bundled Chromium, Node.js and other components have their own notices |
| React, React DOM | MIT |
| CodeMirror 6 packages and Lezer packages | MIT |
| Markdown-it, Markdown-it-footnote | MIT |
| DOMPurify | MPL-2.0 OR Apache-2.0; used under its Apache-2.0 option |
| KaTeX | MIT; bundled fonts and their notices are retained |
| Lucide React | ISC |
| Mermaid | MIT; its dependencies retain their own licenses |
| PDF.js / pdfjs-dist | Apache-2.0; upstream notices cover bundled resources |
| YAML | ISC |

The Electron runtime's `LICENSE` and `LICENSES.chromium.html` remain beside the
application executable. The packaging script does not remove these files.
Vite and the React Vite plugin are build tools, not separately executed by the
portable application. `electron-builder` is present as a development dependency;
the current portable directory is produced by the project's packaging script.

## Optional self-hosted service

The portable directory includes the service's source and dependency requirements,
not a Python interpreter or installed Python dependencies. Installing the service
uses upstream packages with their own distribution metadata and notices:

| Direct Python package | License |
| --- | --- |
| FastAPI | MIT |
| Uvicorn | BSD-3-Clause |
| markdown-it-py | MIT |
| Bleach | Apache-2.0 |

The service requirements use bounded compatible version ranges, so the actual
installed versions should be recorded from the deployment environment for
reproducible operations. The Docker image also includes Python and Linux base
components with their own licenses.
