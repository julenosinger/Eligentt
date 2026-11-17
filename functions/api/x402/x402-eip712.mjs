/**
 * x402 — EIP-3009 TransferWithAuthorization typed-data construction & verification
 * ═══════════════════════════════════════════════════════════════════════════════
 * Pure, side-effect-free EIP-712 helpers for the USDC EIP-3009 authorization on
 * Arc Mainnet. No Circle credentials, no network I/O, no signing here.
 *
 * Domain (certified — see docs/x402-mainnet-certification-corrective.md):
 *   name:               "USDC"
 *   version:            "2"
 *   chainId:            5042
 *   verifyingContract:  0x3600000000000000000000000000000000000000
 *
 * TransferWithAuthorization struct (EIP-3009):
 *   from (address), to (address), value (uint256), validAfter (uint256),
 *   validBefore (uint256), nonce (bytes32)
 *
 * Financial precision: `value` is the exact BigInt atomic-unit amount, passed as
 * a canonical decimal string — never converted through Number.
 *
 * Uses ethers v6 (TypedDataEncoder / verifyTypedData), the same library the rest
 * of the repository already uses for EIP-712 (relayer-auth.mjs).
 */
import { TypedDataEncoder, verifyTypedData } from 'ethers';

export const USDC_NAME = 'USDC';
export const USDC_VERSION = '2';
export const ARC_CHAIN_ID = 5042;
export const ARC_USDC = '0x3600000000000000000000000000000000000000';

export const TRANSFER_WITH_AUTHORIZATION_TYPES = Object.freeze({
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
});

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * Build the EIP-712 domain for USDC EIP-3009 on a given chain/contract.
 */
export function transferWithAuthorizationDomain(chainId, verifyingContract) {
  return {
    name: USDC_NAME,
    version: USDC_VERSION,
    chainId,
    verifyingContract,
  };
}

/**
 * Build the typed-data message for an EIP-3009 TransferWithAuthorization.
 * All inputs are canonical strings (exact; no Number conversion).
 *   from/amount are lowercased addresses; value/validAfter/validBefore are
 *   canonical decimal strings; nonce is `0x` + 64 lowercase hex.
 */
export function buildTransferWithAuthorization({ from, to, value, validAfter, validBefore, nonce }) {
  return {
    domain: transferWithAuthorizationDomain(ARC_CHAIN_ID, ARC_USDC),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    value: {
      from: String(from).toLowerCase(),
      to: String(to).toLowerCase(),
      value: String(value),
      validAfter: String(validAfter),
      validBefore: String(validBefore),
      nonce: String(nonce).toLowerCase(),
    },
  };
}

/**
 * Compute the local EIP-712 digest (32-byte hex) for a TransferWithAuthorization.
 */
export function transferWithAuthorizationDigest({ domain, value }) {
  return TypedDataEncoder.hash(domain, TRANSFER_WITH_AUTHORIZATION_TYPES, value);
}

/**
 * Recover the signer address from an EIP-712 signature, or null on any failure
 * (bad length, bad values, high-s malleability). Returns a lowercase hex address.
 */
export function recoverTransferWithAuthorizationSigner({ domain, value }, signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
  // Reject high-s (malleable) signatures defensively.
  const s = BigInt('0x' + signature.slice(2 + 64, 2 + 128));
  if (s > SECP256K1_HALF_N) return null;
  try {
    const recovered = verifyTypedData(domain, TRANSFER_WITH_AUTHORIZATION_TYPES, value, signature);
    return recovered.toLowerCase();
  } catch (_) {
    return null;
  }
}

/**
 * Verify a signature against the exact expected terms. Returns
 * `{ ok, recovered?, reason? }`. The recovered signer MUST equal `expectedFrom`.
 */
export function verifyTransferWithAuthorization({ domain, value }, signature, expectedFrom) {
  const recovered = recoverTransferWithAuthorizationSigner({ domain, value }, signature);
  if (!recovered) return { ok: false, reason: 'invalid_signature' };
  if (recovered !== String(expectedFrom).toLowerCase()) {
    return { ok: false, reason: 'signer_mismatch', recovered };
  }
  return { ok: true, recovered };
}
