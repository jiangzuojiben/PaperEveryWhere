# Desktop host

The Electron host loads `dist/index.html` after `npm run build`. `npm start` uses
the launcher which removes `ELECTRON_RUN_AS_NODE` from the child environment.
The renderer is sandboxed and isolated from Node. Only the methods in
`preload.cjs` are exposed as `window.vaultdesk`.

The first normal launch creates a welcome vault under the independent
`%APPDATA%/VaultDesk` user-data directory. Previously chosen vaults may be
reopened; no unrelated directories are searched. Every native window has its own
vault binding, renderer session, attachment token and workspace file. The session
records all open windows and their bounds in `desktop.json`. Unavailable vault
records are retained; if every saved vault is unavailable, a welcome window lets
the user choose a different vault. `VAULTDESK_VAULT` explicitly selects a directory
without updating the remembered production session. `VAULTDESK_DEV_URL`
may point to a loopback Vite server; it is never required for the packaged UI.

## Isolated UI validation

Set `VAULTDESK_TEST_MODE=1` and `VAULTDESK_VAULT` to a synthetic, existing vault.
The host refuses to launch test mode without that explicit vault and uses a new
temporary user-data directory (`VaultDesk-Test-<pid>`). A `vaultdesk-ready` JSON
line reports the selected paths after the renderer loads.
`VAULTDESK_TEST_SESSION` optionally names a reusable isolated test session;
`VAULTDESK_TEST_RESTORE=1` restores its windows. These flags never select production
user data.

For a local CDP test, pass Electron's `--remote-debugging-port=<port>` and
`--remote-debugging-address=127.0.0.1` flags to the launcher. Debugging is never
enabled by the production defaults. The test runner should terminate its own
Electron process and remove its synthetic vault/user-data after use.
`node scripts/desktop-window-smoke.mjs` creates synthetic vaults under `output`,
uses ephemeral loopback CDP/inspector ports, closes only its own Electron process,
and retains a JSON report and logs. It checks native multiwindow storage and
events, concurrent-save errors across the preload bridge, native File import,
per-window asset URLs, editor-draft flushing before sync, and restart restoration.
`node scripts/desktop-session-smoke.mjs` verifies unavailable vault paths and
reconnection across four isolated native launches. Its inspector hook acknowledges
only the synthetic process's restoration warnings; no production UI hook is added.

```powershell
$env:VAULTDESK_TEST_MODE = '1'
$env:VAULTDESK_VAULT = 'C:\path\to\synthetic-vault'
node scripts/start-desktop.mjs --remote-debugging-port=9332 --remote-debugging-address=127.0.0.1
```

## Storage contract

- All vault paths are relative. Traversal, absolute/Windows-special paths,
  metadata paths, symlinks and junctions are rejected.
- Files are saved with a flushed temporary file and atomic rename. Existing
  editor snapshots supply `expectedMtime` and a SHA-256 `expectedVersion` to detect
  external changes even when a different editor preserves the file timestamp.
  `write(path,content,expectedMtime,expectedVersion)` rejects stale saves with
  `MTIME_CONFLICT` or `VERSION_CONFLICT`.
- `read` returns `{content,mtime,version}`. Snapshot text entries include `content` and
  the compatibility alias `text`; binary attachments include metadata only.
  Snapshot traversal shares a 16-operation I/O limit across the directory tree;
  parallel reads retain stable depth-first sorting and per-file version hashes.
- `.obsidian/app.json` is read as optional preferences, then overridden by
  `.vaultdesk/settings.json`. The host never modifies `.obsidian`.
- History stores up to 100 unique previous revisions per path.
  `getHistory(path)` returns `{id,path,mtime,timestamp,size,hash}[]`.
  `readHistory(path,id)` adds `encoding:'utf8'` and `content` for text, or
  `encoding:'base64'` with metadata only for binary files. Reads and restores
  verify the stored content hash before returning or writing a historical version.
  `restoreHistory(path,id)` preserves the current bytes before restoring.
- `trash` moves files/folders into `.vaultdesk/trash`.
  `listTrash()` and `restoreTrash(id,destination?)` provide recovery.
- Workspace and settings are saved inside `.vaultdesk`. These files, history
  and trash are local and are excluded from sync.
- Renames call the shared `planRename` engine, then write the resulting Markdown
  changes. Concurrent external edits are left in place and returned as warnings.
- `writeBinary(path,base64)` creates an attachment without replacing an existing
  file. `exportText(content,filename)` uses the native save dialog.
  `exportAttachment(path)` saves any validated attachment through a native save
  dialog; no external program is executed.
  `writeClipboard(text)` writes text; `clipboardImage(destination)` explicitly
  imports the current native clipboard image as a uniquely named PNG, or returns
  `null` when the clipboard has no image. Clipboard text is never read by the bridge.
  `importDroppedFiles(File[],destination)` accepts native File objects through
  preload `webUtils`; it rejects fabricated Files and imports folders recursively
  without following junctions or copying protected application metadata. Naming
  collisions get numeric suffixes. A partial failure includes `error.imported`.
- Microphone access is limited to audio requests from the app window, with a
  native confirmation. Camera and other permissions are rejected.

## Native windows

`newWindow({path?,cloneWorkspace?})` opens the current vault in another native
window. `openVaultInNewWindow()` uses a directory chooser for another vault.
`listWindows()` and `focusWindow(id)` expose only windows sharing the caller's
vault; `windowInfo()` returns its current identity and path. `openVault()` switches
only the calling window. Stale in-flight responses return `VAULT_CHANGED`.

Each `saveWorkspace`/`loadWorkspace` pair uses
`.vaultdesk/workspace-<windowId>.json`, falling back to legacy `workspace.json` on
first use. The renderer should save pending layout changes before cloning or
closing. State writes are ordered per file, and application quit waits for already
received workspace saves. Windows sharing a vault share one serialized VaultStore, file watcher
and sync controller. Closing one window keeps these resources alive until the
last owner closes. Background timer throttling is disabled for native windows.
Attachment URLs contain a window-specific capability and cannot be fetched by
another window, including another window of the same vault.

Bridge failures are plain `{name,message,code,...}` rejection payloads because
Electron drops custom fields from Error objects crossing `contextBridge`.

## Self-hosted sync

`cloudRequest({baseUrl,token,vaultId},path,options)` makes explicit requests only
to the configured HTTP(S) service origin; redirects are rejected. Sync starts
explicitly or after the user enables its automatic schedule. No request to the
original application's cloud is made.

`sync(config)` consumes paginated remote events, tracks per-file revisions and
SHA-256 baselines, transfers binary data as base64, and propagates deletions.
Conflicting bytes are retained in uniquely named `(... conflict ...)` files
and uploaded as ordinary files. Revision races cause another pull and bounded
retry. The local files remain the source of truth; failures leave changes for
the next sync. Configuration supports excluded folders and attachment extensions.

`configureSync(config)`, `pauseSync()`, `resumeSync()` and `syncStatus()` control
the vault's shared sync controller. Status/progress arrive through `onChange` as
`sync-status` and `sync-progress`. Before every run, `sync-before` is sent to all
windows in that vault with a `requestId`; each renderer must save pending drafts
and call `syncReady(requestId,{ok:true})`, or report `{ok:false,error}`. A failed
save, timeout, window switch or close prevents synchronization with `SYNC_BLOCKED`.

Transport TLS depends on deploying the service behind HTTPS. This implementation
does not provide end-to-end encryption, device key exchange, live collaborative
editing or original cloud protocol compatibility. Local history, trash and
sync state are unencrypted files.

Run host/storage/sync tests with:

```text
node --test tests/desktop-*.test.mjs
```

For the real FastAPI integration test, set `VAULTDESK_CLOUD_INTEGRATION=1` and
run `node --test tests/desktop-cloud.test.mjs`. `VAULTDESK_CLOUD_PYTHON` can select
a Python interpreter with `cloud/requirements.txt` installed; on Windows the
default is the existing parent project's `.venv/Scripts/python.exe`. The test
uses synthetic vaults, a temporary SQLite database and a loopback ephemeral port.

## Independent CLI and URI

The CLI requires an explicit absolute `--vault` directory and never uses the
desktop's remembered vault or an environment fallback. Output defaults to JSON;
failures produce JSON on stderr and exit code 1. `--help` describes the commands.

```text
node desktop/cli.mjs --vault C:\SyntheticVault list
node desktop/cli.mjs --vault C:\SyntheticVault read Notes/Note.md
node desktop/cli.mjs --vault C:\SyntheticVault create Notes/New.md --content "Hello"
node desktop/cli.mjs --vault C:\SyntheticVault append Notes/New.md --stdin
node desktop/cli.mjs --vault C:\SyntheticVault rename Notes/New.md Renamed.md
node desktop/cli.mjs --vault C:\SyntheticVault search "tag:project"
```

`rename` maintains references by default; `--no-update-links` performs only the
filesystem move. Binary `read` returns base64. Append is limited to text files
and checks the mtime from its read before saving.

Supported links are `vaultdesk://open?file=Folder%2FNote.md` and
`vaultdesk://new?name=Note&content=Hello`. Optional `vault` must match the current
vault's name or absolute path. A mismatching vault is rejected with a native
message instructing the user to open that vault first. Links never silently
switch vaults, and `new` creates only Markdown notes without overwriting a file. Successful operations send
`{type:'open',path}` through `onChange`. The main process accepts startup args,
`open-url`, and `second-instance` events. `registerProtocol()` asks for explicit
native confirmation before registering only `vaultdesk://` with Windows. It never
changes `obsidian://`, and merely starting the application registers no protocol.

When the renderer vetoes window closing because of unsaved work, a native dialog
defaults to keeping the window open. Only an explicit discard choice overrides
that veto. The renderer should flush pending saves before allowing normal close.
