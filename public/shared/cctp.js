/**
 * Shared CCTP Utilities — Eliminates duplication across bridge/swap/settlement
 * ══════════════════════════════════════════════════════════════════════
 * USED BY: executeBridge(), xcExecuteSend(), FulfillerEngine, SettlementModule
 * BEHAVIOR: Must remain IDENTICAL to current implementation.
 *           Same timeouts, same polling, same error handling.
 */
const CCTPShared = (() => {
  // ── Constants (sourced from RT config) ──────────────────
  const IRIS_V2_URL  = (typeof RT !== 'undefined' && RT.CCTP_IRIS_V2_URL) ||
    'https://iris-api-sandbox.circle.com/v2/messages/';
  const IRIS_ATTEST_URL = (typeof RT !== 'undefined' && RT.CCTP_ATTEST_URL) ||
    'https://iris-api-sandbox.circle.com/attestations/';

  /**
   * Poll Circle Iris API V2 for attestation
   * @param {number} domain - Source CCTP domain
   * @param {string} txHash - depositForBurn transaction hash
   * @param {object} opts - { maxPolls (120), interval (5000), onPoll(pollCount, status) }
   * @returns {Promise<{messageBytes: string, attestationSig: string}|null>}
   */
  async function pollIrisV2(domain, txHash, opts = {}) {
    const maxPolls = opts.maxPolls || 120;
    const interval = opts.interval || 5000;
    const irisUrl  = IRIS_V2_URL + domain + '?transactionHash=' + txHash;

    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, interval));
      try {
        const res = await fetch(irisUrl);
        if (!res.ok) continue;
        const data = await res.json();
        if (data.messages && data.messages.length > 0) {
          const msg = data.messages[0];
          if (opts.onPoll) opts.onPoll(i + 1, msg.status || 'pending');
          if (msg.status === 'complete' && msg.attestation && msg.attestation !== 'PENDING') {
            return {
              messageBytes: msg.message,
              attestationSig: msg.attestation,
              messageHash: msg.messageHash,
              rawMessage: msg
            };
          }
        }
      } catch (e) { /* network retry */ }
    }
    return null;
  }

  /**
   * Poll Circle Iris V1 (legacy attestation endpoint)
   * @param {string} msgHash - CCTP message hash (keccak256 of message bytes)
   * @param {object} opts - { maxPolls (60), interval (5000) }
   * @returns {Promise<string|null>} attestation signature
   */
  async function pollIrisV1(msgHash, opts = {}) {
    const maxPolls = opts.maxPolls || 60;
    const interval = opts.interval || 5000;

    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, interval));
      try {
        const r = await fetch(IRIS_ATTEST_URL + msgHash);
        if (r.ok) {
          const d = await r.json();
          if (d.attestation && d.attestation !== 'PENDING') {
            return d.attestation;
          }
        }
      } catch (e) { /* retry */ }
    }
    return null;
  }

  /**
   * Extract CCTP message bytes from depositForBurn logs
   * @param {object} receipt - ethers TransactionReceipt
   * @returns {string|null} message bytes
   */
  function extractMessageFromLogs(receipt) {
    if (!receipt || !receipt.logs) return null;
    const mtIface = (typeof ethers !== 'undefined')
      ? new ethers.Interface(['event MessageSent(bytes message)'])
      : null;
    if (!mtIface) return null;
    for (const log of receipt.logs) {
      try {
        const parsed = mtIface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === 'MessageSent') return parsed.args.message;
      } catch (e) { /* skip */ }
    }
    return null;
  }

  /**
   * Full attestation flow: V2 → fallback V1 via message hash
   * @returns {Promise<{messageBytes: string, attestationSig: string}|null>}
   */
  async function pollForAttestation(domain, txHash, burnReceipt, opts = {}) {
    // Try V2 first
    const result = await pollIrisV2(domain, txHash, {
      maxPolls: opts.maxPolls || 120,
      interval: opts.interval || 5000,
      onPoll: opts.onPoll
    });
    if (result) return result;

    // Fallback: extract message from logs + V1 poll
    const messageBytes = extractMessageFromLogs(burnReceipt);
    if (!messageBytes) return null;

    if (typeof ethers !== 'undefined') {
      const msgHash = ethers.keccak256(messageBytes);
      const attestationSig = await pollIrisV1(msgHash, {
        maxPolls: 60,
        interval: 5000
      });
      if (attestationSig) {
        return { messageBytes, attestationSig };
      }
    }
    return null;
  }

  // ── Public API ──────────────────────────────────────────
  return {
    pollIrisV2,
    pollIrisV1,
    extractMessageFromLogs,
    pollForAttestation
  };
})();
