# Elligente — Batch Payments dApp on Arc Testnet

## Overview
Elligente is a decentralized application (dApp) for **batch USDC payments, token swaps, and cross-chain bridging** on Arc Testnet. Send to 500 recipients in one transaction, powered by Circle USDC & App Kit.

## Live URL
- **Production**: https://elligente.pages.dev

## Features
- ✅ Batch USDC payments to multiple recipients in a single transaction
- ✅ Token swap (USDC ↔ EURC) via Circle App Kit
- ✅ Cross-chain bridging via Circle CCTP v2
- ✅ Invoice generator
- ✅ Liquidity pool interface
- ✅ Multi-wallet support: MetaMask, Coinbase Wallet, Rabby, WalletConnect v2

## Technology Stack
- **Frontend**: Vanilla HTML/CSS/JavaScript (single-file dApp)
- **Blockchain**: Arc Testnet (Chain ID: 5042002)
- **APIs**: Circle USDC, Circle App Kit
- **Hosting**: Cloudflare Pages with Pages Functions for secure key injection
- **Wallet**: ethers.js v6, WalletConnect v2

## Architecture
```
public/
  index.html     ← Full dApp (static HTML)
  _headers       ← Security headers (CSP, HSTS)
  _redirects     ← SPA routing fallback
  robots.txt     ← Crawler config
functions/
  index.js       ← Cloudflare Pages Function (injects API keys at runtime)
wrangler.jsonc   ← Cloudflare config
```

## Key Injection (Security)
API keys are **never hardcoded** in the HTML. They are stored as **Cloudflare Secrets** and injected at runtime by the Pages Function:

| Secret Name   | Description              |
|---------------|--------------------------|
| `TEST_API_KEY`| Circle API Key           |
| `KIT_KEY`     | Circle App Kit Key       |

## Deployment
**Platform**: Cloudflare Pages  
**Project Name**: `elligente`  
**Status**: ✅ Active

## Local Development
```bash
npm install
npx wrangler pages dev public --port 3000
```

## Arc Testnet Config
- **RPC**: https://rpc.testnet.arc.network
- **Chain ID**: 5042002 (0x4cef52)
- **Explorer**: https://testnet.arcscan.app
- **USDC Faucet**: https://faucet.circle.com

## Environment Variables (Cloudflare Pages → Settings → Environment Variables)

### Secrets (set as encrypted secrets, never commit)
| Name | Required | Description |
|------|----------|-------------|
| `AUTH_SECRET` | **Yes** | Master secret for custodial wallet encryption (per-user salt v2). Auth endpoints **fail closed (500)** if missing. |
| `TURBO_RELAYER_PRIVATE_KEY` | Relayer | Operator EOA private key used server-side by `/api/relayer` and `/api/relayer/mint`. |
| `TEST_API_KEY` / `KIT_KEY` | Circle | Circle API / App Kit keys, injected at runtime. |

### Configuration
| Name | Default | Description |
|------|---------|-------------|
| `NODE_ENV` | _(unset)_ | `production` enables stricter checks. In production `RELAYER_ALLOWED_USERS` **must** be set or the relayer returns `500 "Relayer authorization configuration missing"`. |
| `RELAYER_ALLOWED_USERS` | _(empty)_ | Comma-separated allowlist of authorized signer addresses. Empty = no allowlist gate (dev/test only). **Required in production.** |
| `RELAYER_EIP712_ENABLED` | `false` | Backend: when `true`, EIP-712 auth is accepted as a primary path. Legacy `personal_sign` is always accepted as fallback. |
| `RELAYER_REQUIRE_SELF` | `true` | Enforce `recovered === userAddress` binding on `/api/relayer` (and `/api/relayer/mint` when `userAddress` is provided). Set `false` only for delegated flows. |
| `RELAYER_KILL_SWITCH` | `false` | `true` blocks relayer + mint execution (`503`). Does **not** affect auth/login. |
| `APP_ORIGINS` / `ALLOWED_ORIGINS` | app origin | Comma-separated CORS allowlist for `/api/auth/*`. |
| `ALLOW_LOCALHOST` | `false` | `true` allows `localhost`/`127.0.0.1` origins (dev only). |

### Frontend runtime flags (`window.__ELLIGENTT_CONFIG__`)
| Name | Default | Description |
|------|---------|-------------|
| `EIP712_ENABLED` | `false` | Frontend: enable EIP-712 signing for the relayer authorization. |
| `EIP712_ROLLOUT_PERCENT` | `0` | Gradual rollout (0–100). `0` = legacy only, `1–99` = probabilistic, `100` = full. EIP-712 is attempted **only** when `EIP712_ENABLED=true` **and** the rollout gate passes **and** the signer is silent (custodial/internal). Any failure falls back to `personal_sign`.

## Authorization Flow Matrix
- **LEGACY** (`personal_sign`): ownership + timestamp + per-user nonce replay guard; `userAddress` binding enforced by the relayer. No cryptographic binding of `intentId`/amounts.
- **EIP-712** (`signTypedData`): full binding of `user + intentId + grossAmount + feeAmount + nonce + deadline`; deadline window + replay guard.
- **MIXED MODE**: both coexist. A request is verified as EIP-712 only when it opts in (`auth.scheme='eip712'`); otherwise legacy. Allowlist + replay guard apply to both. **Legacy is not removed.**

## Observability (safe telemetry — no secrets)
Structured events emitted by the relayer/mint functions: `relayer_auth_success`, `relayer_auth_failed`, `relayer_blocked`, `mint_success`, `mint_failed` (with `endpoint`, `mode`/`mint_path`, `reason`, `timestamp`). Frontend emits `relayer_auth_method`. Signatures, tokens, keys, OTPs and intent payloads are **never** logged.

## Last Updated
June 2026
