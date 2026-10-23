# Implementation contract

Windows desktop first; local Markdown vault is authoritative. Independent implementation based on REA observations of Obsidian 1.13.7. Existing PaperDesk is unchanged. No original application code or assets are shipped.

## Core (pure ESM, browser and Node)

`core/vault.mjs` exports `parseMarkdown(text)`, `resolveLink(linkpath, sourcePath, paths) -> string|null`, `getReferences(text, sourcePath, paths)`, `planRename(files, oldPath, newPath, settings) -> {files, changes}`, `searchFiles(files,query) -> array`. `files` is Record<path,text>. Metadata contains headings [{heading,level,line}], tags [string], frontmatter object, references. References contain kind/link/subpath/original/path and optional source offsets. Core agent may add exports, but keep these usable contracts.

## Host

Preload exposes `window.vaultdesk`: `openVault()`, `snapshot()`, `read(path)`, `write(path,content,expectedMtime?)`, `create(path,content?)`, `mkdir(path)`, `rename(oldPath,newPath,settings?)`, `trash(path)`, `importFiles()`, `assetUrl(path)`, `saveWorkspace(state)`, `loadWorkspace()`, `getHistory(path)`, `restoreHistory(path,id)`, `onChange(callback)->unsubscribe`, `openExternal(url)`. All methods async except onChange. `snapshot` and `openVault` return `{vaultPath,files:[{path,size,mtime,content?}],settings?}`; content is included for .md/.canvas/.base/.json, dirs represented by `{path,isDirectory:true}`. `read` returns `{content,mtime}`. `write/create/rename/trash/importFiles` may return own results; UI reloads snapshot after operations. `assetUrl` resolves validated vault file to safe local URL. User config uses `.vaultdesk`; existing `.obsidian` may be read for preferences but never overwritten. `VAULTDESK_VAULT` supports isolated test/demo launch. Host owns syncing; `cloudRequest(config,path,options)` calls explicit self-host base URL, `sync(config)` synchronizes binary and text files using cloud API. If not implemented, client can use fetch for browser demo; desktop avoids CORS via host.

## Renderer

React/Vite vanilla JS. `app/Editor.jsx` default component props `{path,value,onChange,mode,onNavigate,resolveAsset,files,onReady}`. `mode` = source/live/reading. `onNavigate(link)` requests wiki/md target; `resolveAsset(path)->Promise<string>`. `files` = Record<path,text>. onReady may receive `{focus,insert,scrollToHeading}`. Root controls save, file selection and error reporting. Editor owns only Editor.jsx/editor.css and helper markdown files.

`app/Views.jsx` exports `GraphView({files,onOpen,activePath,local})`, `CanvasView({value,onChange,onOpen,files})`, `BasesView({value,onChange,files,onOpen})`, `PropertiesPanel({text,onChange})`. Views own Views.jsx/views.css and helper files. File map values are text strings. Canvas JSON Canvas 1.0. Bases YAML.

## Self hosted API

Separate FastAPI service, port 8766. `/health`, `/auth/register`, `/auth/login` -> `{token,user}` using `{email,password}`. Bearer auth. `/vaults` GET and POST `{name}`. `/vaults/{id}/changes?cursor=0` -> `{changes:[{path,revision,deleted,content?,encoding?}],cursor}`. `/vaults/{id}/files` PUT `{path,content,encoding:'utf8'|'base64',base_revision:int}` -> revision; DELETE same via JSON or method supported by server. Revision conflicts 409. `/vaults/{id}/history?path=...`; `/vaults/{id}/restore` POST `{path,revision,base_revision}`. `/sites` GET/POST `{vault_id,slug,title,paths:[...]}`; `/sites/{id}` DELETE. `/p/{slug}/{path}` public reading. Server agent owns cloud/* + cloud tests + compose file. Add docs with exact shapes when implementing. Never call original Obsidian cloud.
