/**
 * Shared Validation Utilities — Non-blocking validators
 * ═══════════════════════════════════════════════════════════
 * All validators return warnings, never block existing functionality.
 * Backward compatible — isAddr() regex still works for basic checks.
 */

const Validators = (() => {

  /**
   * Validate EIP-55 checksum for Ethereum addresses.
   * Returns { valid: boolean, warning: string|null }
   * Does NOT block — just adds a warning for non-checksummed addresses.
   */
  function validateEIP55(address) {
    if (!address || typeof address !== 'string') return { valid: false, warning: 'Invalid address format' };
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { valid: false, warning: 'Not a valid hex address' };

    // If all lowercase or all uppercase, EIP-55 is not applicable (but accepted)
    const stripped = address.slice(2);
    if (stripped === stripped.toLowerCase() || stripped === stripped.toUpperCase()) {
      return { valid: true, warning: null };
    }

    // Verify EIP-55 checksum using ethers.js if available
    if (typeof ethers !== 'undefined') {
      try {
        const checksummed = ethers.getAddress(address);
        if (checksummed !== address) {
          return { valid: true, warning: 'Address does not match EIP-55 checksum. Did you mean ' + checksummed + '?' };
        }
        return { valid: true, warning: null };
      } catch (e) {
        return { valid: false, warning: 'Invalid Ethereum address checksum' };
      }
    }

    return { valid: true, warning: null };
  }

  /**
   * Robust CSV parsing — handles quoted fields, commas in values, newlines.
   * @param {string} text - Raw CSV content
   * @returns {{ headers: string[], rows: string[][] }}
   */
  function parseCSV(text) {
    if (!text || typeof text !== 'string') return { headers: [], rows: [] };

    const rows = [];
    let currentRow = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') {
          currentField += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          currentField += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          currentRow.push(currentField.trim());
          currentField = '';
        } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
          currentRow.push(currentField.trim());
          if (currentRow.some(f => f !== '')) {
            rows.push(currentRow);
          }
          currentRow = [];
          currentField = '';
          if (ch === '\r') i++;
        } else if (ch === '\r') {
          currentRow.push(currentField.trim());
          if (currentRow.some(f => f !== '')) {
            rows.push(currentRow);
          }
          currentRow = [];
          currentField = '';
        } else {
          currentField += ch;
        }
      }
    }

    // Handle last field/row
    currentRow.push(currentField.trim());
    if (currentRow.some(f => f !== '')) {
      rows.push(currentRow);
    }

    if (rows.length === 0) return { headers: [], rows: [] };

    const headers = rows[0];
    const dataRows = rows.slice(1);

    return { headers, rows: dataRows };
  }

  /**
   * Validate a chain ID against the known CHAIN_REGISTRY.
   * Returns { valid: boolean, chain: object|null, warning: string|null }
   */
  function validateChainId(chainId) {
    if (typeof CHAIN_REGISTRY === 'undefined') return { valid: true, warning: null };

    const numericId = typeof chainId === 'string' ? parseInt(chainId, 10) : chainId;
    if (isNaN(numericId)) return { valid: false, warning: 'Invalid chain ID: ' + chainId };

    const chain = (typeof getChainById === 'function') ? getChainById(numericId) : CHAIN_REGISTRY[numericId];
    if (!chain) return { valid: true, warning: 'Unknown chain ID ' + numericId + ' — transaction may fail' };

    return { valid: true, chain, warning: null };
  }

  /**
   * Validate an amount string/number for batch payments.
   * Returns { valid: boolean, value: number, warning: string|null }
   */
  function validateAmount(amount) {
    const n = parseFloat(amount);
    if (isNaN(n)) return { valid: false, value: 0, warning: 'Invalid amount: must be a number' };
    if (n <= 0) return { valid: false, value: n, warning: 'Amount must be greater than 0' };
    if (n > 1e9) return { valid: true, value: n, warning: 'Very large amount — verify before sending' };
    if (!/^\d+(\.\d{1,6})?$/.test(String(amount).trim())) {
      return { valid: true, value: n, warning: 'Amount has more than 6 decimal places — will be truncated to USDC precision' };
    }
    return { valid: true, value: n, warning: null };
  }

  /**
   * Validate a contract address against known verified addresses.
   * Returns { verified: boolean, known: boolean, warning: string|null }
   */
  function validateContractAddress(address, chainId) {
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return { verified: false, known: false, warning: 'Invalid contract address format' };
    }

    // Check against deployed addresses in RT config
    if (typeof RT !== 'undefined') {
      const knownAddresses = [
        RT.TREASURY_VAULT_ADDRESS,
        RT.POOL_CONTRACT_ADDRESS,
        RT.CCTP_TOKEN_MESSENGER,
        RT.CCTP_MESSAGE_TRANSMITTER,
        RT.MULTICALL3_ADDRESS,
      ].filter(Boolean);

      if (knownAddresses.some(a => a.toLowerCase() === address.toLowerCase())) {
        return { verified: true, known: true, warning: null };
      }
    }

    return { verified: false, known: false, warning: null };
  }

  // ── Public API ──────────────────────────────────────────
  return {
    validateEIP55,
    parseCSV,
    validateChainId,
    validateAmount,
    validateContractAddress,
  };
})();
