# Arc Inbound Relayer Deployment

## 1. Create KV Namespace
wrangler kv:namespace create ARC_INBOUND_KV --preview

## 2. Add Relayer Wallet (VERY IMPORTANT)
wrangler secret put ARC_RELAYER_PRIVATE_KEY
# Paste a private key of a wallet that has a little ETH on Arc Testnet

## 3. Deploy the relayer
cd relayer
npm install ethers
wrangler deploy

## 4. Update your Pages project
Add the following environment variables to your Pages project:
- ARC_RELAYER_WORKER_URL = https://your-relayer.workers.dev

Then in the frontend (only for inbound-to-Arc paths), call the /register-inbound endpoint after successful burn.
