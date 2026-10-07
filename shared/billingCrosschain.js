/**
 * BillingCrosschain — LI.FI cross-chain routing for Billing
 *
 * Reuses /api/lifi/routes, /api/lifi/step-transaction, /api/lifi/status
 * already used by the Swap module.  No new bridge system.
 *
 * Exposed as window.BillingCrosschain for consumption by index.html.
 * ZERO MOCKS. All data from real LI.FI responses.
 */
(function (window) {
  'use strict';

  // ── Chain registry (mirrors existing CHAIN_REGISTRY in the app) ───────────
  const CHAIN_IDS = {
    'Arc Mainnet':  5042,
    'Ethereum':     1,
    'Base':         8453,
    'Arbitrum':     42161,
    'Optimism':     10,
    'Polygon':      137,
  };

  const CHAIN_NAMES = Object.fromEntries(Object.entries(CHAIN_IDS).map(([k,v]) => [v, k]));

  // Token registry per chain: address + decimals.
  // Mirrors the server-side CHAIN_REGISTRY in shared-config.mjs.
  // NEVER hardcode decimals at call sites -- always use tokenInfoFor().
  const TOKEN_REGISTRY = {
    5042: {
      USDC:   { address: '0x3600000000000000000000000000000000000000', decimals: 6 },
      EURC:   { address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', decimals: 6 },
      CIRBTC: { address: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0', decimals: 8 },
    },
    1: {
      USDC: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
      EURC: { address: '0x1abaea1f7c830bd89acc67ec4af516284b1bc33c', decimals: 6 },
    },
    8453: {
      USDC: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
      EURC: { address: '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42', decimals: 6 },
    },
    42161: {
      USDC: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },
    },
    10: {
      USDC: { address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', decimals: 6 },
    },
    137: {
      USDC: { address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },
    },
  };

  // Keep USDC as a convenience alias (used by usdcFor).
  const USDC = Object.fromEntries(
    Object.entries(TOKEN_REGISTRY).map(([id, tokens]) => [id, tokens.USDC?.address || null])
  );

  function tokenInfoFor(chainId, tokenSymbol) {
    const sym = (tokenSymbol || 'USDC').toUpperCase();
    return (TOKEN_REGISTRY[chainId] || {})[sym] || null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function chainIdFor(nameOrId) {
    if (typeof nameOrId === 'number') return nameOrId;
    return CHAIN_IDS[nameOrId] || null;
  }

  function usdcFor(chainId) {
    return USDC[chainId] || null;
  }

  function fmtTime(estimatedTime) {
    if (!estimatedTime) return '—';
    const s = Number(estimatedTime);
    if (isNaN(s) || s <= 0) return '—';
    if (s < 60) return s + 's';
    return Math.round(s / 60) + 'm';
  }

  function fmtAmount(rawStr, decimals) {
    try { return (Number(rawStr) / Math.pow(10, decimals || 6)).toFixed(6); } catch (_) { return '0'; }
  }

  function fmtFee(route) {
    try {
      const gasCosts = route.steps?.reduce((acc, s) => {
        const g = s.estimate?.gasCosts?.[0];
        if (g?.amountUSD) acc += parseFloat(g.amountUSD);
        return acc;
      }, 0) || 0;
      const feeCosts = route.steps?.reduce((acc, s) => {
        const f = s.estimate?.feeCosts?.[0];
        if (f?.amountUSD) acc += parseFloat(f.amountUSD);
        return acc;
      }, 0) || 0;
      const total = gasCosts + feeCosts;
      return total > 0 ? '$' + total.toFixed(3) : '—';
    } catch (_) { return '—'; }
  }

  function toolName(route) {
    const step = route.steps?.[0];
    return step?.toolDetails?.name || step?.tool || 'Unknown';
  }

  // ── Core API calls ─────────────────────────────────────────────────────────

  /**
   * Fetch real routes from LI.FI for a billing cross-chain payment.
   * @param {object} opts
   *   fromChainId  {number}
   *   toChainId    {number}
   *   fromToken    {string} address
   *   toToken      {string} address
   *   fromAmount   {string} raw units (BigInt-safe string)
   *   fromAddress  {string} wallet address
   *   toAddress    {string} recipient address (same or different from wallet)
   * @returns {Promise<{ok:boolean, routes:Array, error?:string}>}
   */
  async function fetchRoutes(opts) {
    const body = {
      fromChainId:   opts.fromChainId,
      toChainId:     opts.toChainId,
      fromTokenAddress: opts.fromToken,
      toTokenAddress:   opts.toToken,
      fromAmount:    opts.fromAmount,
      fromAddress:   (opts.fromAddress || '').toLowerCase(),
      toAddress:     (opts.toAddress  || opts.fromAddress || '').toLowerCase(),
      options: {
        slippage: 0.005,
        integrator: 'elligentt',
        allowSwitchChain: false,
      },
    };

    try {
      const res = await fetch('/api/lifi/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.routes) {
        return { ok: false, error: json.message || json.error || 'LI.FI routes failed', routes: [] };
      }
      return { ok: true, routes: json.routes };
    } catch (e) {
      return { ok: false, error: e.message || 'Network error', routes: [] };
    }
  }

  /**
   * Fetch executable step transaction for a chosen LI.FI route step.
   */
  async function fetchStepTx(step) {
    try {
      const res = await fetch('/api/lifi/step-transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step }),
      });
      const json = await res.json();
      if (!res.ok || !json.transactionRequest) {
        return { ok: false, error: json.message || 'step-tx failed' };
      }
      return { ok: true, tx: json.transactionRequest };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Poll LI.FI status for a submitted cross-chain transaction.
   * @param {string} txHash  source chain tx hash
   * @param {number} fromChainId
   * @param {number} toChainId
   * @param {string} bridge  tool name (e.g. "across")
   * @param {function} onStatus  called with each status update
   * @returns {Promise<{ok:boolean, destinationTxHash?:string, status:string, error?:string}>}
   */
  async function pollStatus(txHash, fromChainId, toChainId, bridge, onStatus, maxPolls) {
    maxPolls = maxPolls || 120; // 10 min at 5s intervals
    const delay = (ms) => new Promise(r => setTimeout(r, ms));

    for (let i = 0; i < maxPolls; i++) {
      try {
        const url = '/api/lifi/status?txHash=' + txHash
          + '&fromChain=' + fromChainId
          + '&toChain=' + toChainId
          + (bridge ? '&bridge=' + encodeURIComponent(bridge) : '');
        const res = await fetch(url);
        const json = await res.json();
        const status = json.status || 'PENDING';
        if (onStatus) onStatus(status, json);
        if (status === 'DONE') {
          const dstTx = json.receiving?.txHash || json.destinationTxHash || null;
          return { ok: true, destinationTxHash: dstTx, status: 'DONE', raw: json };
        }
        if (status === 'FAILED') {
          return { ok: false, status: 'FAILED', error: json.substatusMessage || 'Bridge failed', raw: json };
        }
      } catch (e) {
        // transient error — keep polling
      }
      await delay(5000);
    }
    return { ok: false, status: 'TIMEOUT', error: 'Status polling timed out' };
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  /**
   * Render a list of LI.FI routes as selectable cards.
   * Returns HTML string.
   */
  function renderRouteCards(routes, selectedIdx) {
    if (!routes || !routes.length) {
      return '<div style="padding:16px;text-align:center;color:var(--muted2);font-size:10px">No cross-chain routes available</div>';
    }

    // Resolve destination token decimals from LI.FI route data.
    // route.toToken.decimals is the authoritative source per-route.
    function routeToDecimals(r) { return r.toToken?.decimals || 6; }
    function routeToSymbol(r)   { return r.toToken?.symbol   || 'USDC'; }

    const amounts = routes.map(r => parseFloat(fmtAmount(r.toAmountMin, routeToDecimals(r))));
    const times   = routes.map(r => r.steps?.reduce((acc, s) => acc + (s.estimate?.executionDuration || 0), 0) || 0);
    const bestAmt = Math.max(...amounts);
    const bestTime = Math.min(...times.filter(t => t > 0));

    return routes.map((route, idx) => {
      const toDecimals = routeToDecimals(route);
      const toSymbol   = routeToSymbol(route);
      const tool     = toolName(route);
      const received = fmtAmount(route.toAmountMin, toDecimals);
      const fee      = fmtFee(route);
      const estTime  = fmtTime(route.steps?.reduce((acc, s) => acc + (s.estimate?.executionDuration || 0), 0));
      const steps    = route.steps?.length || 1;
      const isBest   = Math.abs(parseFloat(received) - bestAmt) < 0.000001;
      const isFastest = times[idx] > 0 && times[idx] === bestTime && !isBest;
      const isSelected = idx === selectedIdx;

      const badge = isBest
        ? '<span style="position:absolute;top:-1px;right:8px;background:var(--teal);color:#0b0d12;font-size:7.5px;font-weight:800;padding:2px 6px;border-radius:0 0 4px 4px;letter-spacing:.3px">BEST RATE</span>'
        : isFastest
          ? '<span style="position:absolute;top:-1px;right:8px;background:var(--yellow);color:#0b0d12;font-size:7.5px;font-weight:800;padding:2px 6px;border-radius:0 0 4px 4px;letter-spacing:.3px">FASTEST</span>'
          : '';

      return `<div class="brs-route${isSelected ? ' brs-selected' : ''}" style="position:relative;cursor:pointer;margin-bottom:8px"
        onclick="BillingCrosschain.selectRoute(${idx})">
        ${badge}
        <div style="display:flex;align-items:center;justify-content:space-between">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:26px;height:26px;border-radius:6px;background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--teal);flex-shrink:0">${tool.slice(0,1).toUpperCase()}</div>
            <div>
              <div style="font-size:11px;font-weight:700;color:var(--text)">${tool}</div>
              <div style="font-size:8.5px;color:var(--muted2)">LI.FI aggregator</div>
            </div>
          </div>
          <div style="text-align:right">
            <div style="font-size:12px;font-weight:700;color:var(--text)">${received} <span style="font-size:9px;color:var(--muted2)">${toSymbol} received</span></div>
            ${isSelected ? '<span style="font-size:8px;color:var(--teal);border:1px solid rgba(45,212,191,.4);border-radius:4px;padding:2px 6px;margin-top:2px;display:inline-block">✓ Selected</span>' : ''}
          </div>
        </div>
        <div class="brs-meta" style="margin-top:8px">
          <div class="brs-meta-item"><div class="brs-meta-val">—</div><div class="brs-meta-lbl">Bridge fee</div></div>
          <div class="brs-meta-item"><div class="brs-meta-val">${fee}</div><div class="brs-meta-lbl">Protocol fees</div></div>
          <div class="brs-meta-item"><div class="brs-meta-val">—</div><div class="brs-meta-lbl">Est. gas</div></div>
          <div class="brs-meta-item"><div class="brs-meta-val">${estTime}</div><div class="brs-meta-lbl">Est. time</div></div>
          <div class="brs-meta-item"><div class="brs-meta-val">${steps}</div><div class="brs-meta-lbl">Steps</div></div>
        </div>
      </div>`;
    }).join('');
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let _routes      = [];
  let _selectedIdx = 0;
  let _paymentData = null;  // the invoice/paylink being paid

  function selectRoute(idx) {
    _selectedIdx = idx;
    const container = document.getElementById('bcc-route-list');
    if (container) container.innerHTML = renderRouteCards(_routes, _selectedIdx);
    const btn = document.getElementById('bcc-pay-btn');
    if (btn && _routes[idx]) {
      const tool = toolName(_routes[idx]);
      btn.textContent = 'Pay via ' + tool;
      btn.disabled = false;
    }
  }

  /**
   * Open the cross-chain payment modal for a billing item.
   * @param {object} paymentData  { type, id, publicToken, label, amount, token, recipient, chain, chainId }
   * @param {string} walletAddr   connected wallet address
   * @param {number} sourceChainId   wallet's current chain
   */
  async function openModal(paymentData, walletAddr, sourceChainId) {
    _paymentData = paymentData;
    _routes = [];
    _selectedIdx = 0;

    const destChainId = paymentData.chainId || chainIdFor(paymentData.chain) || 5042;
    // Destination token: use paymentData.token symbol; fallback USDC.
    const tokenSymbol  = (paymentData.token || 'USDC').toUpperCase();
    const destTokenAddr = (destTokenInfo || {}).address || usdcFor(destChainId);
    // Source token: same symbol on source chain; fallback to USDC if not found.
    const srcTokenInfo = tokenInfoFor(sourceChainId, tokenSymbol) || tokenInfoFor(sourceChainId, 'USDC');
    const destToken    = destTokenAddr;
    const srcToken     = srcTokenInfo ? srcTokenInfo.address : usdcFor(sourceChainId);

    if (!srcToken) {
      if (window.toast) toast('Source chain USDC address unknown', 'error');
      return;
    }
    if (!destToken) {
      if (window.toast) toast('Destination chain USDC address unknown', 'error');
      return;
    }

    // Use real token decimals for the destination token.
    const destTokenInfo = tokenInfoFor(destChainId, paymentData.token || 'USDC');
    const destDecimals  = destTokenInfo ? destTokenInfo.decimals : 6;
    const amountRaw = String(Math.round(parseFloat(paymentData.amount) * Math.pow(10, destDecimals)));
    const fromChainName = window.CHAIN_REGISTRY?.[sourceChainId]?.name || CHAIN_NAMES[sourceChainId] || ('Chain ' + sourceChainId);
    const destChainName = paymentData.chain || CHAIN_NAMES[destChainId] || ('Chain ' + destChainId);

    // Show modal in loading state
    _showModal({
      fromChain: fromChainName,
      toChain: destChainName,
      amount: paymentData.amount,
      token: tokenSymbol,
      recipient: paymentData.recipient,
      loading: true,
    });

    // Fetch routes
    const result = await fetchRoutes({
      fromChainId: sourceChainId,
      toChainId:   destChainId,
      fromToken:   srcToken,
      toToken:     destToken,
      fromAmount:  amountRaw,
      fromAddress: walletAddr,
      toAddress:   paymentData.recipient,
    });

    if (!result.ok || !result.routes.length) {
      const container = document.getElementById('bcc-route-list');
      if (container) container.innerHTML =
        '<div style="padding:20px;text-align:center;color:var(--red);font-size:10px">' +
        '<i class="ti ti-alert-triangle" style="font-size:22px;display:block;margin-bottom:6px"></i>' +
        'No routes found: ' + (result.error || 'LI.FI returned no routes') + '</div>';
      const btn = document.getElementById('bcc-pay-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'No route available'; }
      return;
    }

    _routes = result.routes;
    _selectedIdx = 0;

    const container = document.getElementById('bcc-route-list');
    if (container) container.innerHTML = renderRouteCards(_routes, _selectedIdx);

    const countEl = document.getElementById('bcc-route-count');
    if (countEl) countEl.textContent = _routes.length + ' route' + (_routes.length !== 1 ? 's' : '');

    const btn = document.getElementById('bcc-pay-btn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Pay via ' + toolName(_routes[0]);
    }
  }

  function _showModal(info) {
    let overlay = document.getElementById('bcc-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'bcc-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:10000;display:flex;align-items:center;justify-content:center';
      overlay.addEventListener('click', function(e) { if (e.target === overlay) closeModal(); });
      document.body.appendChild(overlay);
    }

    const fromChain = info.fromChain || '—';
    const toChain   = info.toChain   || '—';

    overlay.innerHTML = `
      <div style="background:var(--card);border:1px solid var(--border2);border-radius:14px;width:480px;max-width:96vw;max-height:90vh;overflow-y:auto;padding:0">
        <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-size:12px;font-weight:800;color:var(--text)">Cross-Chain Payment</div>
            <div style="font-size:9px;color:var(--muted2);margin-top:2px">${fromChain} → ${toChain}</div>
          </div>
          <button class="btn" onclick="BillingCrosschain.closeModal()" style="padding:4px 8px;font-size:10px"><i class="ti ti-x"></i></button>
        </div>
        <div style="padding:14px 20px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div style="font-size:10px;font-weight:700;color:var(--teal);text-transform:uppercase;letter-spacing:.5px">
              <i class="ti ti-route" style="font-size:10px"></i> Available Routes
            </div>
            <span id="bcc-route-count" style="font-size:9px;color:var(--muted2)"></span>
          </div>
          <div id="bcc-route-list" style="min-height:60px">
            ${info.loading
              ? '<div style="padding:28px;text-align:center;color:var(--muted2)"><i class="ti ti-loader-2" style="font-size:22px;display:block;margin-bottom:6px;animation:spin 1s linear infinite"></i>Finding routes…</div>'
              : ''}
          </div>
          <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--muted2);margin-bottom:4px">
              <span>You pay</span><span style="color:var(--text)">${info.amount || '—'} ${info.token || 'USDC'} on ${fromChain}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--muted2);margin-bottom:12px">
              <span>Recipient</span><span style="color:var(--blue);font-family:monospace;font-size:8px">${(info.recipient||'').slice(0,10)}...${(info.recipient||'').slice(-6)}</span>
            </div>
            <button id="bcc-pay-btn" class="btn primary" style="width:100%;padding:11px;font-size:11px;font-weight:700" disabled onclick="BillingCrosschain.executeSelected()">
              Select a route…
            </button>
            <div id="bcc-status" style="margin-top:8px;font-size:9px;color:var(--muted2);text-align:center;display:none"></div>
          </div>
        </div>
      </div>`;
    overlay.style.display = 'flex';
  }

  function closeModal() {
    const el = document.getElementById('bcc-overlay');
    if (el) el.style.display = 'none';
  }

  /**
   * Execute the selected route.
   * Signs the step transaction via the user's wallet (window.signer).
   * Polls LI.FI status until DONE, then calls /api/payment/ to verify.
   */
  async function executeSelected() {
    const route = _routes[_selectedIdx];
    if (!route) { if (window.toast) toast('No route selected', 'error'); return; }
    if (!window.signer) { if (window.toast) toast('No wallet signer', 'error'); return; }

    const btn       = document.getElementById('bcc-pay-btn');
    const statusEl  = document.getElementById('bcc-status');
    const setStatus = (msg) => { if (statusEl) { statusEl.style.display = ''; statusEl.textContent = msg; } };

    if (btn) { btn.disabled = true; btn.textContent = 'Preparing transaction...'; }

    // Execute ALL steps of the selected route in order.
    // Failing any step stops execution and leaves the payment in Processing/Failed.
    const steps = route.steps;
    if (!steps || !steps.length) {
      if (window.toast) toast('Route has no steps', 'error');
      if (btn) btn.disabled = false;
      return;
    }

    let sourceTxHash;    // hash of the first step tx (used for status polling)
    let lastStepTxHash;  // hash of the last executed step

    for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
      const step = steps[stepIdx];
      const stepLabel = steps.length > 1 ? ' (step ' + (stepIdx + 1) + '/' + steps.length + ')' : '';

      setStatus('Fetching transaction for step ' + (stepIdx + 1) + ' of ' + steps.length + '...');
      const txRes = await fetchStepTx(step);
      if (!txRes.ok) {
        if (window.toast) toast('Step ' + (stepIdx + 1) + ' failed: ' + txRes.error, 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
        setStatus('Step ' + (stepIdx + 1) + ' error: ' + txRes.error);
        return;
      }

      const txReq = txRes.tx;
      setStatus('Waiting for wallet signature' + stepLabel + '...');
      try {
        const txResponse = await window.signer.sendTransaction({
          to:       txReq.to,
          data:     txReq.data,
          value:    txReq.value ? BigInt(txReq.value) : 0n,
          gasLimit: txReq.gasLimit ? BigInt(txReq.gasLimit) : undefined,
          chainId:  txReq.chainId ? Number(txReq.chainId) : undefined,
        });
        lastStepTxHash = txResponse.hash;
        if (stepIdx === 0) sourceTxHash = lastStepTxHash;
        if (window.toast) toast('Step ' + (stepIdx + 1) + ' submitted: ' + lastStepTxHash.slice(0, 10) + '...', 'info');
        setStatus('Step ' + (stepIdx + 1) + ' sent - waiting for confirmation...');
        await txResponse.wait();
        if (stepIdx < steps.length - 1) {
          setStatus('Step ' + (stepIdx + 1) + ' confirmed - proceeding to step ' + (stepIdx + 2) + '...');
        } else {
          setStatus('All steps confirmed - polling bridge status...');
        }
      } catch (e) {
        if (e.code === 4001) {
          if (window.toast) toast('Rejected by wallet' + stepLabel, 'error');
          setStatus('Rejected by wallet at step ' + (stepIdx + 1));
        } else {
          if (window.toast) toast('Step ' + (stepIdx + 1) + ' error: ' + (e.shortMessage || e.message || ''), 'error');
          setStatus('Error at step ' + (stepIdx + 1) + ': ' + (e.message || ''));
        }
        if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
        return;
      }
    } // end steps loop

    // Update local state to Processing immediately
    const d = _paymentData;
    if (d) {
      if (d.type === 'paylink') {
        const l = window.payLinks?.find(x => x.id === d.id);
        if (l) { l.status = 'Processing'; l.paidTx = sourceTxHash; if (window.Store) Store.save('links', window.payLinks); if (window.renderPayLinks) renderPayLinks(); if (window.updatePlStats) updatePlStats(); }
      } else if (d.type === 'invoice') {
        const inv = window.invoiceList?.find(x => x.id === d.id);
        if (inv) { inv.status = 'Processing'; inv.txHash = sourceTxHash; if (window.Store) Store.save('invoices', window.invoiceList); if (window.renderInvoices) renderInvoices(); if (window.updateInvStats) updateInvStats(); }
      }
    }

    // Poll bridge status using the FIRST step (source chain) identifiers.
    const firstStep   = steps[0];
    const fromChainId = firstStep.action?.fromChainId || _paymentData?.sourceChainId;
    const toChainId   = firstStep.action?.toChainId   || _paymentData?.chainId;
    const bridge      = firstStep.tool || '';

    const pollResult = await pollStatus(sourceTxHash, fromChainId, toChainId, bridge, function(status) {
      setStatus('Bridge status: ' + status);
    }, 120);

    if (!pollResult.ok) {
      if (window.toast) toast('Bridge ' + pollResult.status + ': ' + (pollResult.error || ''), 'warning');
      setStatus(pollResult.status + ': ' + (pollResult.error || ''));
      return;
    }

    const destTxHash = pollResult.destinationTxHash;
    setStatus('Bridge DONE — verifying on destination chain…');

    // Backend on-chain verification (Arc RPC)
    const verifyToken = d.publicToken || d.id;
    let backendVerified = false;
    try {
      const verRes = await fetch('/api/payment/' + verifyToken, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txHash: destTxHash || sourceTxHash,
          feeTxHash: null,
          paidBy: window.walletAddress || '',
          sourceTxHash,
          bridge: bridge,
          sourceChain: fromChainId,
        }),
      });
      const verJson = await verRes.json().catch(() => ({}));
      if (verRes.ok && verJson.ok) {
        backendVerified = true;
      } else {
        setStatus('Verify: ' + (verJson.error || 'pending'));
        if (window.toast) toast('Bridge complete — on-chain verification: ' + (verJson.error || 'pending'), 'warning');
      }
    } catch (e) {
      setStatus('Verify failed: ' + e.message);
    }

    // Update local state
    if (d) {
      if (d.type === 'paylink') {
        const l = window.payLinks?.find(x => x.id === d.id);
        if (l) {
          l.paidTx = destTxHash || sourceTxHash;
          l.sourceTxHash = sourceTxHash;
          l.bridge = bridge;
          l.paidFrom = window.walletAddress || '';
          if (backendVerified) { l.status = 'Paid'; l.payments = (l.payments||0)+1; l.paidOn = new Date().toISOString(); }
          if (window.Store) Store.save('links', window.payLinks);
          if (window.renderPayLinks) renderPayLinks();
          if (window.updatePlStats) updatePlStats();
        }
      } else if (d.type === 'invoice') {
        const inv = window.invoiceList?.find(x => x.id === d.id);
        if (inv) {
          inv.txHash = destTxHash || sourceTxHash;
          inv.sourceTxHash = sourceTxHash;
          inv.bridge = bridge;
          inv.paidFrom = window.walletAddress || '';
          if (backendVerified) { inv.status = 'Paid'; inv.paidOn = new Date().toISOString(); }
          if (window.Store) Store.save('invoices', window.invoiceList);
          if (window.renderInvoices) renderInvoices();
          if (window.updateInvStats) updateInvStats();
        }
      }
    }

    if (backendVerified) {
      if (window.toast) toast('Cross-chain payment verified on-chain!', 'success');
      setStatus('✅ Payment verified on destination chain');
    } else {
      setStatus('⏳ Payment processing — will confirm soon');
    }

    setTimeout(() => closeModal(), 4000);
    if (window.refreshBalance) refreshBalance();
  }

  // ── Public surface ─────────────────────────────────────────────────────────
  window.BillingCrosschain = {
    openModal,
    closeModal,
    selectRoute,
    executeSelected,
    fetchRoutes,
    pollStatus,
    // Exposed for tests
    _toolName:     toolName,
    _fmtTime:      fmtTime,
    _fmtAmount:    fmtAmount,
    _renderRouteCards: renderRouteCards,
    _chainIdFor:   chainIdFor,
    _tokenInfoFor: tokenInfoFor,
    CHAIN_IDS,
    USDC,
    TOKEN_REGISTRY,
  };

})(window);
