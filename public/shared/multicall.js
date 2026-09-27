const Multicall = (() => {
  'use strict';

  const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
  const MC_ABI = [
    'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])',
  ];
  const ERC20_IFACE_ABI = ['function balanceOf(address) view returns (uint256)'];

  async function batchBalances(provider, walletAddress, tokens) {
    if (!provider || !walletAddress || typeof ethers === 'undefined') return [];
    if (!tokens || tokens.length === 0) return [];

    try {
      const erc20Iface = new ethers.Interface(ERC20_IFACE_ABI);
      const calls = tokens.map(t => ({
        target: t.address,
        allowFailure: true,
        callData: erc20Iface.encodeFunctionData('balanceOf', [walletAddress]),
      }));

      const mc = new ethers.Contract(MULTICALL3, MC_ABI, provider);
      const results = await mc.aggregate3(calls);

      return tokens.map((t, i) => {
        const r = results[i];
        if (!r.success) return { ...t, balance: 0n, formatted: 0, error: true };
        const decoded = erc20Iface.decodeFunctionResult('balanceOf', r.returnData);
        const raw = decoded[0];
        return {
          ...t,
          balance: raw,
          formatted: parseFloat(ethers.formatUnits(raw, t.decimals || 6)),
          error: false,
        };
      });
    } catch (e) {
      const results = [];
      for (const t of tokens) {
        try {
          const contract = new ethers.Contract(t.address, ERC20_IFACE_ABI, provider);
          const bal = await contract.balanceOf(walletAddress);
          results.push({ ...t, balance: bal, formatted: parseFloat(ethers.formatUnits(bal, t.decimals || 6)), error: false });
        } catch (_) {
          results.push({ ...t, balance: 0n, formatted: 0, error: true });
        }
      }
      return results;
    }
  }

  async function batchCall(provider, calls) {
    if (!provider || typeof ethers === 'undefined' || !calls || calls.length === 0) return [];

    try {
      const mc = new ethers.Contract(MULTICALL3, MC_ABI, provider);
      return await mc.aggregate3(calls);
    } catch (e) {
      return calls.map(() => ({ success: false, returnData: '0x' }));
    }
  }

  return { batchBalances, batchCall, MULTICALL3 };
})();

if (typeof window !== 'undefined') window.Multicall = Multicall;
