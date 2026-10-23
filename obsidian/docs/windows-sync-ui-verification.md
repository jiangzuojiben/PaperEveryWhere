# Windows automatic sync settings verification

Verified on 2026-10-23 in a native Electron window using the built renderer `dist/assets/index-7zxMCtUA.js`. Playwright CLI attached to this test window through a dedicated loopback CDP port. The cloud service used a separate loopback port and a new temporary SQLite database; the vault contained one synthetic note. No production vault, account, service, or app profile was used.

All account creation, remote-vault creation/selection, automatic-sync changes, sign-out, and note edits went through visible UI controls. `window.vaultdesk.syncStatus()` was used only as a read-only observation. Cloud revisions were checked through read-only SQLite queries; no access token or password is included here.

| UI action | Native controller result | Filesystem/cloud evidence | Result |
| --- | --- | --- | --- |
| Register a temporary independent account; create and select a remote vault; enable automatic sync | `enabled: true`, `paused: false`, `phase: idle`, future `nextRunAt` | Initial synthetic note uploaded as revision 1 | Pass |
| Edit the note in the Markdown editor and allow normal autosave | Automatic run completes without pressing the manual sync button | `Auto uploaded after editor save.` exists locally and in remote revision 2 | Pass |
| Clear the remote-vault dropdown while automatic sync remains checked | `enabled: false`, `paused: true`, `running: false`, `phase: paused`, `nextRunAt: null` | Manual sync becomes disabled and the status bar displays that sync is paused | Pass |
| Edit after clearing the target | Controller stays disabled/paused | `Local edit while remote target is cleared.` is saved locally; cloud remains revision 2 after more than one 60-second polling interval | Pass |
| Select the same remote vault again | `enabled: true`, `paused: false`; scheduling resumes | The pending local content becomes remote revision 3 automatically | Pass |
| Click account sign-out | `enabled: false`, `paused: true`, `running: false`, `phase: paused`, `nextRunAt: null` | Settings returns to the signed-out form | Pass |
| Edit the note after sign-out | Controller stays disabled/paused | `Local edit after sign out stays local.` is saved locally; cloud remains revision 3 after 79 seconds | Pass |

The renderer console contained zero warnings and zero errors during this sequence. Both disconnected states were observed beyond the normal 60-second polling interval. The Playwright session was detached, the owned Electron and service processes exited, and neither dedicated port remained listening. Redacted evidence is retained in `output/playwright/sync-ui-verification/evidence.jsonl`; the verification directory also contains two screenshots of the settings UI.

Automatic approval review rejected removal of the newly created temporary vault/database directory and isolated Electron profile with the reason `blocked by policy`. The directories were left intact, and no alternate deletion mechanism was attempted. They contain synthetic test data only.

The retained directories are:

- `C:\Users\[user]\Documents\文档资料\PaperDesk\obsidian\output\playwright\sync-ui-verification\run-1792745967522`
- `C:\Users\[user]\AppData\Local\Temp\VaultDesk-Test-32224`

## Reproduce

1. Build the renderer, start the self-hosted service with a new `VAULTDESK_DB`, and launch Electron with a new synthetic `VAULTDESK_VAULT`, `VAULTDESK_TEST_MODE=1`, and dedicated loopback debugging port.
2. Attach Playwright CLI using `playwright-cli -s=<isolated-session> attach --cdp http://127.0.0.1:<port>`.
3. Take a fresh snapshot before each control interaction. In **同步与发布**, enter the test service address, register a disposable account, create a remote vault, and check **自动同步**.
4. Close settings and edit the note. Confirm autosave and an incremented remote revision.
5. Reopen settings, choose the empty **远程知识库** option, close settings, and edit again. Confirm local save, disabled/paused controller, no scheduled run, and no remote revision after at least 60 seconds.
6. Reselect the remote vault and confirm the pending change uploads. Sign out, edit again, and repeat the no-upload observation.

## Small UI findings

- The tested build's introduction still described sync as an explicit action even though automatic sync is available.
- The automatic-sync and pause checkboxes had visible captions but lacked accessible names in the snapshot. Both controls worked; accessible labels would improve assistive technology and UI automation.

After this walkthrough, the renderer source was updated to correct the sync description and associate `Setting` captions with a single input/select control. Those changes were not present in the tested build and have not been verified in a new native UI session by this walkthrough.

These findings do not affect the verified controller reset when credentials or the remote target are cleared. Source-level scheduler, selective-sync, network retry, and conflict tests are separate from this native renderer walkthrough.
