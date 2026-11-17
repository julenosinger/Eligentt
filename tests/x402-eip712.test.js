/**
 * x402-eip712.test.js — EIP-3009 TransferWithAuthorization EIP-712 certification
 * ═══════════════════════════════════════════════════════════════════════════
 * Level 1 (offline) certification of the exact USDC EIP-712 domain and typed-data
 * schema on Arc Mainnet. Uses a deterministic test identity with NO mainnet funds.
 *
 * Certifies:
 *   - The EIP-712 domain separator matches the ON-CHAIN DOMAIN_SEPARATOR
 *     (0x940506929bba468048a19b567f4f0d534714bc06604b5c3017e5d16785ccdf84,
 *     from docs/x402-mainnet-certification-corrective.md).
 *   - The TransferWithAuthorization struct (field order + types).
 *   - Digest computation, signature recovery, low-s malleability rejection.
 */
import { describe, it, expect } from 'vitest';
import { Wallet, TypedDataEncoder, verifyTypedData } from 'ethers';
import {
  buildTransferWithAuthorization,
  transferWithAuthorizationDomain,
  transferWithAuthorizationDigest,
  recoverTransferWithAuthorizationSigner,
  verifyTransferWithAuthorization,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  ARC_USDC,
  ARC_CHAIN_ID,
  USDC_NAME,
  USDC_VERSION,
} from '../functions/api/x402/x402-eip712.mjs';

// Deterministic test identity (no mainnet funds).
const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// On-chain DOMAIN_SEPARATOR confirmed in X402-2.0.1 (corrective cert).
const ONCHAIN_DOMAIN_SEPARATOR = '0x940506929bba468048a19b567f4f0d534714bc06604b5c3017e5d16785ccdf84';

const from = () => new Wallet(TEST_PK).address.toLowerCase();
const TO = '0x' + 'cd'.repeat(20);

function sampleValue(over = {}) {
  return {
    from: from(),
    to: TO,
    value: '1000000',         // 1.00 USDC atomic (exact decimal string)
    validAfter: '0',
    validBefore: '9999999999',
    nonce: '0x' + '11'.repeat(32),
    ...over,
  };
}

describe('EIP-3009 TransferWithAuthorization — domain certification', () => {
  it('domain name/version/chainId/verifyingContract are exact', () => {
    const domain = transferWithAuthorizationDomain(ARC_CHAIN_ID, ARC_USDC);
    expect(domain.name).toBe(USDC_NAME);
    expect(domain.version).toBe(USDC_VERSION);
    expect(domain.chainId).toBe(5042);
    expect(domain.verifyingContract.toLowerCase()).toBe(ARC_USDC.toLowerCase());
  });

  it('EIP-712 domain separator matches the ON-CHAIN DOMAIN_SEPARATOR', () => {
    const domain = transferWithAuthorizationDomain(ARC_CHAIN_ID, ARC_USDC);
    const separator = TypedDataEncoder.hashDomain(domain);
    expect(separator).toBe(ONCHAIN_DOMAIN_SEPARATOR);
  });

  it('TransferWithAuthorization struct has the exact field order and types', () => {
    const fields = TRANSFER_WITH_AUTHORIZATION_TYPES.TransferWithAuthorization;
    expect(fields.map((f) => f.name)).toEqual(['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']);
    expect(fields.map((f) => f.type)).toEqual(['address', 'address', 'uint256', 'uint256', 'uint256', 'bytes32']);
  });
});

describe('EIP-3009 TransferWithAuthorization — digest & recovery', () => {
  it('computes a deterministic digest for the same typed data', () => {
    const td = buildTransferWithAuthorization(sampleValue());
    const d1 = transferWithAuthorizationDigest(td);
    const d2 = transferWithAuthorizationDigest(buildTransferWithAuthorization(sampleValue()));
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('changes to any signed term change the digest', () => {
    const base = sampleValue();
    const digests = [
      transferWithAuthorizationDigest(buildTransferWithAuthorization({ ...base, to: '0x' + 'ee'.repeat(20) })),
      transferWithAuthorizationDigest(buildTransferWithAuthorization({ ...base, value: '2000000' })),
      transferWithAuthorizationDigest(buildTransferWithAuthorization({ ...base, nonce: '0x' + '22'.repeat(32) })),
      transferWithAuthorizationDigest(buildTransferWithAuthorization({ ...base, validBefore: '9999999998' })),
    ];
    const original = transferWithAuthorizationDigest(buildTransferWithAuthorization(base));
    for (const d of digests) expect(d).not.toBe(original);
  });

  it('recovers the correct signer and equals the wallet address', async () => {
    const wallet = new Wallet(TEST_PK);
    const value = { ...sampleValue(), from: wallet.address.toLowerCase() };
    const td = buildTransferWithAuthorization(value);
    const signature = await wallet.signTypedData(td.domain, TRANSFER_WITH_AUTHORIZATION_TYPES, td.value);
    const recovered = recoverTransferWithAuthorizationSigner(td, signature);
    expect(recovered).toBe(wallet.address.toLowerCase());
  });

  it('verifyTransferWithAuthorization accepts the correct signer and rejects a wrong one', async () => {
    const wallet = new Wallet(TEST_PK);
    const value = { ...sampleValue(), from: wallet.address.toLowerCase() };
    const td = buildTransferWithAuthorization(value);
    const signature = await wallet.signTypedData(td.domain, TRANSFER_WITH_AUTHORIZATION_TYPES, td.value);
    expect(verifyTransferWithAuthorization(td, signature, wallet.address).ok).toBe(true);
    // Wrong expectedFrom (different wallet) → signer_mismatch.
    const other = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    expect(verifyTransferWithAuthorization(td, signature, other.address).ok).toBe(false);
  });

  it('matches ethers reference verification (independent cross-check)', async () => {
    const wallet = new Wallet(TEST_PK);
    const value = { ...sampleValue(), from: wallet.address.toLowerCase() };
    const td = buildTransferWithAuthorization(value);
    const signature = await wallet.signTypedData(td.domain, TRANSFER_WITH_AUTHORIZATION_TYPES, td.value);
    const reference = verifyTypedData(td.domain, TRANSFER_WITH_AUTHORIZATION_TYPES, td.value, signature);
    expect(reference.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('rejects malformed / wrong-length signatures', () => {
    const td = buildTransferWithAuthorization(sampleValue());
    expect(recoverTransferWithAuthorizationSigner(td, '0x00')).toBeNull();          // too short
    expect(recoverTransferWithAuthorizationSigner(td, '0x' + '00'.repeat(65))).toBeNull(); // 65 bytes, not 65 hex
    expect(recoverTransferWithAuthorizationSigner(td, 'not-a-signature')).toBeNull();
    expect(recoverTransferWithAuthorizationSigner(td, null)).toBeNull();
  });

  it('rejects high-s (malleable) signatures', async () => {
    const wallet = new Wallet(TEST_PK);
    const value = { ...sampleValue(), from: wallet.address.toLowerCase() };
    const td = buildTransferWithAuthorization(value);
    const signature = await wallet.signTypedData(td.domain, TRANSFER_WITH_AUTHORIZATION_TYPES, td.value);
    // Flip s to the high half of the curve: s' = N - s.
    const r = '0x' + signature.slice(2, 66);
    const s = BigInt('0x' + signature.slice(66, 130));
    const v = signature.slice(130);
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const sHigh = (N - s).toString(16).padStart(64, '0');
    const highS = r + sHigh + v;
    expect(recoverTransferWithAuthorizationSigner(td, highS)).toBeNull();
  });
});
