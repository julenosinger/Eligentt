const TreasuryGuard = (() => {
  'use strict';

  const USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
  const EURC_ADDRESS = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
  const CIRBTC_ADDRESS = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF';
  const TREASURY_VAULT = '0xbfC9E8F79bd30b912081ae88F9ad0A515F08c2F1';
  const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];
  const ALERT_KEY = 'elligente_treasury_alerts';

  async function checkInvariant(provider) {
    if (!provider || typeof ethers === 'undefined') return null;

    const results = { timestamp: Date.now(), checks: [], alerts: [] };

    const tokens = [
      { symbol: 'USDC', address: USDC_ADDRESS, decimals: 6 },
      { symbol: 'EURC', address: EURC_ADDRESS, decimals: 6 },
      { symbol: 'cirBTC', address: CIRBTC_ADDRESS, decimals: 8 },
    ];

    for (const t of tokens) {
      try {
        const contract = new ethers.Contract(t.address, ERC20_ABI, provider);
        const balance = await contract.balanceOf(TREASURY_VAULT);
        const formatted = parseFloat(ethers.formatUnits(balance, t.decimals));

        const check = {
          token: t.symbol,
          address: t.address,
          treasuryBalance: formatted,
          rawBalance: balance.toString(),
          status: 'ok',
        };

        if (formatted < 0) {
          check.status = 'critical';
          results.alerts.push({ level: 'critical', message: t.symbol + ' balance negative', balance: formatted });
        }

        results.checks.push(check);
      } catch (e) {
        results.checks.push({ token: t.symbol, status: 'error', error: e.message });
      }
    }

    results.status = results.alerts.length > 0 ? 'alert' : 'ok';
    _saveAlert(results);
    return results;
  }

  async function reconcile(provider, expectedBalances) {
    if (!provider || typeof ethers === 'undefined') return null;

    const result = { timestamp: Date.now(), discrepancies: [], status: 'ok' };

    for (const expected of (expectedBalances || [])) {
      try {
        const contract = new ethers.Contract(expected.address, ERC20_ABI, provider);
        const actual = await contract.balanceOf(TREASURY_VAULT);
        const actualFormatted = parseFloat(ethers.formatUnits(actual, expected.decimals || 6));
        const diff = Math.abs(actualFormatted - (expected.balance || 0));

        if (diff > (expected.tolerance || 0.01)) {
          result.discrepancies.push({
            token: expected.symbol,
            expected: expected.balance,
            actual: actualFormatted,
            diff,
            status: 'mismatch',
          });
          result.status = 'mismatch';
        }
      } catch (e) {
        result.discrepancies.push({ token: expected.symbol, status: 'error', error: e.message });
      }
    }

    return result;
  }

  function _saveAlert(result) {
    try {
      const alerts = JSON.parse(localStorage.getItem(ALERT_KEY) || '[]');
      alerts.unshift({ ...result, savedAt: Date.now() });
      if (alerts.length > 50) alerts.length = 50;
      localStorage.setItem(ALERT_KEY, JSON.stringify(alerts));
    } catch (_) {}
  }

  function getAlertHistory() {
    try {
      return JSON.parse(localStorage.getItem(ALERT_KEY) || '[]');
    } catch (_) { return []; }
  }

  return { checkInvariant, reconcile, getAlertHistory, TREASURY_VAULT };
})();

if (typeof window !== 'undefined') window.TreasuryGuard = TreasuryGuard;
