# Independent core verification

`adapter.mjs` executes the frozen corpus against `core/vault.mjs`. It does not
read `oracle.json`, import Obsidian, or call an original Obsidian service. Every
file group shares one in-memory vault; mutation groups run in declaration order.
Each result contains a stable synchronous core snapshot and only its group's
files. References are resolved against the whole vault.

Run from the `obsidian` project directory:

```powershell
node research/compatibility/verify.mjs
node --test tests/compatibility.test.mjs
```

The verification script writes `independent-observations.json` and
`independent-result.json`, including strict and portable comparison results,
input/implementation hashes, and rejection of all four frozen negative
controls. The tests also check input isolation, settings snapshot isolation,
key-order independence, and acceptance of observed tied candidates.

The following files are copied byte-for-byte from the adjacent
`Obsidian-REA-Research/compatibility` research project and remain frozen:

- `cases.json`
- `oracle.json`
- `conformance.mjs`
- `run-adapter.mjs`
- `negative-controls.mjs`
- `adapter.d.ts`
- `README.md`

The frozen `README.md` describes the original research project. Its historical
`runtime-evidence` commands refer to that project's recordings, which are not
bundled here. The independent verification script and tests apply the same four
negative mutations to the independent implementation's observations instead.

The oracle covers 20 cases: 34 resolution queries and 10 mutation cases observed
with Obsidian 1.13.7 on Windows. Passing this finite corpus does not establish
full Obsidian compatibility, UI fidelity, plugin compatibility, or cloud-service
parity. `stable-observed` here denotes that the synchronous independent core has
completed its operation and produced a consistent index; it is not a new REA
recording of the original application.
