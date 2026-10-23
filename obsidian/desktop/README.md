# Desktop host

The Electron host loads `dist/index.html` after `npm run build`. `npm start` uses
the launcher which removes `ELECTRON_RUN_AS_NODE` from the child environment.
The renderer is sandboxed and isolated from Node. Only the methods in
`preload.cjs` are exposed as `window.vaultdesk`.

The first normal launch creates a welcome vault under the independent
`%APPDATA%/VaultDesk` user-data directory. Previously chosen vaults may be
reopened; no unrelated directories are searched. `VAULTDESK_VAULT` explicitly
selects a directory without updating the remembered vault. `VAULTDESK_DEV_URL`
may point to a loopback Vite server; it is never required for the packaged UI.

## Isolated UI validation

Set `VAULTDESK_TEST_MODE=1` and `VAULTDESK_VAULT` to a synthetic, existing vault.
The host refuses to launch test mode without that explicit vault and uses a new
temporary user-data directory (`VaultDesk-Test-<pid>`). A `vaultdesk-ready` JSON
line reports the selected paths after the renderer loads.

For a local CDP test, pass Electron's `--remote-debugging-port=<port>` and
`--remote-debugging-address=127.0.0.1` flags to the launcher. Debugging is never
enabled by the production defaults. The test runner should terminate its own
Electron process and remove its synthetic vault/user-data after use.

```powershell
$env:VAULTDESK_TEST_MODE = '1'
$env:VAULTDESK_VAULT = 'C:\path\to\synthetic-vault'
node scripts/start-desktop.mjs --remote-debugging-port=9332 --remote-debugging-address=127.0.0.1
```

## Storage contract

- All vault paths are relative. Traversal, absolute/Windows-special paths,
  metadata paths, symlinks and junctions are rejected.
- Files are saved with a flushed temporary file and atomic rename. Existing
  editor snapshots supply `expectedMtime` to detect external changes.
- `read` returns `{content,mtime}`. Snapshot text entries include `content` and
  the compatibility alias `text`; binary attachments include metadata only.
- `.obsidian/app.json` is read as optional preferences, then overridden by
  `.vaultdesk/settings.json`. The host never modifies `.obsidian`.
- History stores up to 100 unique previous revisions per path.
  `getHistory(path)` returns `{id,path,mtime,timestamp,size,hash}[]`.
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
  `writeClipboard(text)` writes text without exposing clipboard reads.
- Microphone access is limited to audio requests from the app window, with a
  native confirmation. Camera and other permissions are rejected.

## Self-hosted sync

`cloudRequest({baseUrl,token,vaultId},path,options)` makes explicit requests only
to the configured HTTP(S) service origin; redirects are rejected. Sync is user
initiated. No request to the original application's cloud is made.

`sync(config)` consumes paginated remote events, tracks per-file revisions and
SHA-256 baselines, transfers binary data as base64, and propagates deletions.
Conflicting bytes are retained in uniquely named `(... conflict ...)` files
and uploaded as ordinary files. Revision races cause another pull and bounded
retry. The local files remain the source of truth; failures leave changes for
the next explicit sync.

Transport TLS depends on deploying the service behind HTTPS. This implementation
does not provide end-to-end encryption, device key exchange, live collaborative
editing or original cloud protocol compatibility. Local history, trash and
sync state are unencrypted files.

Run host/storage/sync tests with:

```text
node --test tests/desktop-vault.test.mjs tests/desktop-sync.test.mjs
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
`open-url`, and `second-instance` events. This code does not register an OS URL
handler; a future installer may register the scheme separately.

When the renderer vetoes window closing because of unsaved work, a native dialog
defaults to keeping the window open. Only an explicit discard choice overrides
that veto. The renderer should flush pending saves before allowing normal close.
