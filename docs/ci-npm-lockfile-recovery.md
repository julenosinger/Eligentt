# CI Recovery — npm `ci` lockfile out-of-sync (`utf-8-validate@5.0.10`)

> Workstream A of Phase X402-2.1C. Restores the global CI `test` job, which was
> failing at `npm ci` before any test ran.

## 1. Failure

- Run: https://github.com/julenosinger/Eligentt/actions/runs/44133781568
- Job: `test` (Job ID `134217658665`), commit `0ea8e1f05d5d290a9db8756a8b6a0137c038d317`
- Runner: Ubuntu 26.04, Node 20.20.2, npm 10.8.2

```text
npm error code EUSAGE
npm ci can only install packages when package.json and package-lock.json are in sync.
Missing: utf-8-validate@5.0.10 from lock file
```

## 2. Root cause

`utf-8-validate` is an **optional native peer dependency of `ws`**. The lockfile
(`lockfileVersion` 3) contained a single hoisted entry `node_modules/utf-8-validate@6.0.6`,
which satisfies the `ws@8.x` consumers (ethers, viem/isows, rpc-websockets), but NOT
the nested `ws@7.5.13` under `jayson@4.3.0`:

```
@circle-fin/adapter-viem-v2@1.18.0
  → @solana/web3.js@1.99.0
    → jayson@4.3.0
      → ws@7.5.13   (peerDependencies.utf-8-validate: "^5.0.2")
```

`^5.0.2` requires a 5.x release (`5.0.10`), but the lockfile deduped it to `6.0.6`
(which does **not** satisfy `^5.0.2`). `npm ls` confirms the invalid dedup:

```text
jayson@4.3.0 → ws@7.5.13 → utf-8-validate@6.0.6 deduped invalid: "^5.0.2"
```

On npm 10.8.2 (CI), `npm ci` recomputes the ideal tree, resolves the optional
peer to `utf-8-validate@5.0.10`, finds it absent from the lockfile, and fails
closed with `EUSAGE` — correctly, because the lockfile was internally
inconsistent.

## 3. Repair (smallest correct diff)

Added exactly one nested lockfile entry so `jayson`'s `ws@7.5.13` gets its own
`utf-8-validate@5.0.10`, while the hoisted `6.0.6` continues to serve the `ws@8.x`
consumers:

```diff
+    "node_modules/jayson/node_modules/utf-8-validate": {
+      "version": "5.0.10",
+      "resolved": "https://registry.npmjs.org/utf-8-validate/-/utf-8-validate-5.0.10.tgz",
+      "integrity": "sha512-Z6czzLq4u8fPOyx7TU6X3dvUZVvoJmxSQ+IcrlmagKhilxlhZgxPK6C5Jqbkw1IDUmFTM+cz9QDnnLTwDz/2gQ==",
+      "hasInstallScript": true,
+      "license": "MIT",
+      "optional": true,
+      "dependencies": { "node-gyp-build": "^4.3.0" },
+      "engines": { "node": ">=6.14.2" }
+    },
```

Total lockfile diff: **14 insertions, 0 deletions**. No dependency versions were
upgraded; no `--force` / `--legacy-peer-deps` / `--omit=optional`; strict `npm ci`
semantics are preserved.

## 4. Verification

| Step | Result |
|---|---|
| `npx npm@10.8.2 ci` (baseline lockfile) | 283 packages |
| `npx npm@10.8.2 ci` (fixed lockfile) | 284 packages (the one nested entry) |
| `npm ls utf-8-validate` | clean — `jayson → ws@7.5.13 → utf-8-validate@5.0.10`; no `invalid` |
| CI `test` job commands (10 vitest files) | 213 passed / 0 failed |
| `npm run build` | success (4527 KB min) |

## 5. Reproducibility note

The exact `EUSAGE` text is platform-specific: the invalid dedup manifests on the
Linux CI runner (where npm 10.8.2 recomputes the optional-native-peer tree), but
`npm ci` on Windows/npm 11.9.0 does not surface the same `EUSAGE` message. The
underlying inconsistency is platform-independent and was confirmed locally via
`npm ls` (`ELSPROBLEMS`: `utf-8-validate@6.0.6 deduped invalid: "^5.0.2"`). The
fix removes that inconsistency, so both toolchains now resolve the same correct
tree. A completed remote GitHub Actions run was not triggered from this
environment; the equivalent `npm ci` + test + build sequence was verified
locally with the intended npm 10.8.2 toolchain.
