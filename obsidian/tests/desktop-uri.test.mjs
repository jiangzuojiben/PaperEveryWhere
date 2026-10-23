import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { VaultStore } from '../desktop/vault-store.mjs';
import { parseVaultdeskUri, matchesCurrentVault, applyVaultdeskUri } from '../desktop/uri.mjs';

test('URI parser preserves encoded note content and rejects ambiguous/unsafe inputs', () => {
  assert.deepEqual(parseVaultdeskUri('vaultdesk://open?file=Folder%2FNote.md&vault=Chosen'), { action:'open', vault:'Chosen', path:'Folder/Note.md' });
  assert.deepEqual(parseVaultdeskUri('vaultdesk://new?name=%E6%96%B0%E7%AC%94%E8%AE%B0&content=%23%20Title%0A%0ABody'), { action:'new', vault:null, path:'新笔记.md', content:'# Title\n\nBody' });
  for (const uri of ['https://open?file=x','vaultdesk://delete?file=x','vaultdesk://open?file=..%2Foutside.md','vaultdesk://new?name=.vaultdesk%2Fsettings.json','vaultdesk://new?name=plugin.js&content=code','vaultdesk://open?file=A&file=B','vaultdesk://open?file=A&unknown=1','vaultdesk://user:pass@open?file=A','vaultdesk://open/other?file=A','vaultdesk://open?file=A#fragment','vaultdesk://new?content=text']) assert.throws(() => parseVaultdeskUri(uri));
});

test('URI commands act only on the current vault and emit the UI open event', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'vaultdesk-uri-'));
  const store = await VaultStore.open(root,{watchFiles:false});
  t.after(async () => {
    store.close();
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('vaultdesk-uri-'));
    await fs.rm(root,{recursive:true,force:true});
  });
  assert.equal(matchesCurrentVault(path.basename(root),root),true);
  assert.equal(matchesCurrentVault(root,root),true);
  assert.equal(matchesCurrentVault('Different vault',root),false);
  const event = await applyVaultdeskUri(store,`vaultdesk://new?name=Folder%2FCreated&content=hello&vault=${encodeURIComponent(root)}`);
  assert.deepEqual(event,{type:'open',path:'Folder/Created.md'});
  assert.equal((await store.read(event.path)).content,'hello');
  assert.deepEqual(await applyVaultdeskUri(store,'vaultdesk://open?file=Folder%2FCreated.md'),event);
  await assert.rejects(applyVaultdeskUri(store,'vaultdesk://new?name=Nope&vault=Different'),{code:'URI_VAULT_MISMATCH'});
  assert.equal((await store.snapshot()).files.some((file) => file.path === 'Nope.md'),false);
  await assert.rejects(applyVaultdeskUri(store,'vaultdesk://new?name=Folder%2FCreated&content=overwrite'),/already exists/);
  assert.equal((await store.read(event.path)).content,'hello');
});
