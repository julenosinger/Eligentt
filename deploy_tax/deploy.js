/**
 * TaxPayment — deploy script (ethers v6, Arc Mainnet)
 *
 * Usage:
 *   PRIVATE_KEY=0x... \
 *   TAX_TREASURY=0x...  \
 *   node deploy_tax/deploy.js
 *
 * Arc Mainnet USDC precompile address is read from the ABI artifact.
 * Set TAX_TREASURY to the address that will receive all tax payments.
 */
import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

// Arc Mainnet USDC precompile // arc-studio-allow-onchain-literal
const USDC_ARC = '0x3600000000000000000000000000000000000000';
const ARC_RPC  = 'https://rpc.mainnet.arc.io'; // arc-studio-allow-onchain-literal
const CHAIN_ID = 5042;

async function main() {
  const pk       = process.env.PRIVATE_KEY;
  const treasury = process.env.TAX_TREASURY;

  if (!pk)       throw new Error('PRIVATE_KEY env var required');
  if (!treasury) throw new Error('TAX_TREASURY env var required');
  if (!/^0x[0-9a-fA-F]{40}$/.test(treasury)) throw new Error('Invalid TAX_TREASURY address');

  const provider = new ethers.JsonRpcProvider(ARC_RPC, { chainId: CHAIN_ID, name: 'arc' });
  const signer   = new ethers.Wallet(pk, provider);

  console.log('Deployer:', signer.address);
  console.log('Treasury:', treasury);

  // Load compiled artifact (forge build output)
  let abi, bytecode;
  try {
    const artifact = JSON.parse(readFileSync(join(__dir, '../contracts/out/TaxPayment.sol/TaxPayment.json'), 'utf8'));
    abi      = artifact.abi;
    bytecode = artifact.bytecode.object;
  } catch (_) {
    // Fallback: minimal ABI for verification only
    throw new Error('Run `forge build` first to generate the artifact at contracts/out/TaxPayment.sol/TaxPayment.json');
  }

  const factory  = new ethers.ContractFactory(abi, bytecode, signer);
  console.log('Deploying TaxPayment…');
  const contract = await factory.deploy(USDC_ARC, treasury);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log('\n✅ TaxPayment deployed:');
  console.log('  Address:  ', address);
  console.log('  USDC:     ', USDC_ARC);
  console.log('  Treasury: ', treasury);
  console.log('  Chain:     Arc Mainnet (5042)');
  console.log('\nAdd to CF env:');
  console.log('  TAX_PAYMENT_CONTRACT=' + address);
  console.log('  TAX_TREASURY=' + treasury);
  console.log('\nAdd to Settings → Tax in the app:');
  console.log('  ElligentBatch-style contract address field for TaxPayment');

  // Write deployment record
  const fs = await import('fs');
  fs.writeFileSync(
    join(__dir, 'deployed_tax.json'),
    JSON.stringify({ address, usdc: USDC_ARC, treasury, chainId: CHAIN_ID, deployedAt: new Date().toISOString() }, null, 2)
  );
}

main().catch(e => { console.error(e); process.exit(1); });
