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

## Last Updated
May 2026
