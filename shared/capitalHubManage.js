/**
 * Capital Hub — Manage Funds (Phase 0: UI foundation).
 *
 * PRESENTATION ONLY. Five Quick Actions and one operation panel (form · details · steps).
 * Nothing here signs, sends, burns, mints or calls a financial endpoint. The primary buttons are
 * intentionally disabled until native execution is connected in a later phase; the EXISTING flows
 * stay reachable through a clearly labelled secondary button (the same launchers the Overview uses).
 *
 * Reads only what the app already exposes: Gateway cache (CapitalHub.gateway), wallet balances
 * (UB state) and the Gateway-supported chain list (_UB_GW_DEP_CHAINS). Unknown values show "Not available".
 */
(function () {
  'use strict';
  var CH = window.CapitalHub, UI = window.CapitalHubUI;
  if (!CH || !UI || UI.__manage) return;
  UI.__manage = true;
  var esc = UI.esc;
  var NA = '<span class="ch-dim">Not available</span>';

  var ACTS = [
    { k: 'deposit',    t: 'Deposit',        s: 'Add funds',        ic: 'download',        d: 'Fund your unified balance with assets from your EVM wallet.', btn: 'Review deposit', ex: 'Use existing deposit window' },
    { k: 'send',       t: 'Send',           s: 'Transfer funds',   ic: 'send',            d: 'Send from your Gateway balance to another address.',          btn: 'Review transfer', ex: 'Use existing flow (Send Assets)' },
    { k: 'crosschain', t: 'Cross-chain',    s: 'Move capital',     ic: 'arrows-exchange', d: 'Move Gateway capital to another supported network.',          btn: 'Review cross-chain transfer', ex: 'Use existing flow (Send Assets)' },
    { k: 'charge',     t: 'Charge in USDC', s: 'Request payment',  ic: 'receipt-2',       d: 'Create a USDC payment request that someone can pay.',         btn: 'Create payment request', ex: 'Create in Billing (Payment Links)' },
    { k: 'withdraw',   t: 'Withdraw',       s: 'Return funds',     ic: 'upload',          d: 'Return Gateway funds to your connected wallet.',              btn: 'Review withdrawal', ex: 'Use existing flow (Send Assets)' }
  ];
  var STEPS = {
    deposit:    [['Review', 'Check amount, network and fees.'], ['Sign', 'Approve and deposit in your wallet.'], ['Processing', 'The deposit confirms on the source network.'], ['Confirm', 'The credit appears in your Gateway balance.']],
    send:       [['Review', 'Check recipient, network and fees.'], ['Sign', 'Sign the transfer in your wallet.'], ['Processing', 'Circle Gateway processes the transfer.'], ['Confirm', 'Funds are minted on the destination network.']],
    crosschain: [['Review', 'Check destination, recipient and fees.'], ['Sign', 'Sign the transfer in your wallet.'], ['Processing', 'Circle Gateway processes the transfer.'], ['Confirm', 'Funds are minted on the destination network.']],
    charge:     [['Review', 'Check amount, network and beneficiary.'], ['Sign', 'Wallet authorization, if required.'], ['Processing', 'The payment request is created.'], ['Confirm', 'A payment counts only after it is verified.']],
    withdraw:   [['Review', 'Check network, wallet and fees.'], ['Sign', 'Sign the transfer in your wallet.'], ['Processing', 'Circle Gateway processes the transfer.'], ['Confirm', 'Funds arrive in your wallet.']]
  };
  var M = {
    act: 'deposit', anim: false,
    f: { deposit: { asset: 'USDC', net: 0, amount: '' }, send: { asset: 'USDC', net: 0, to: '', amount: '' }, crosschain: { asset: 'USDC', net: 0, to: null, amount: '' },
         charge: { net: 0, to: null, desc: '', exp: '', amount: '' }, withdraw: { asset: 'USDC', net: 0, amount: '' } }
  };
  var TOK = { USDC: '#2775ca', EURC: '#3b82f6', cirBTC: '#f59e0b' };

  function actOf(k) { for (var i = 0; i < ACTS.length; i++) if (ACTS[i].k === k) return ACTS[i]; return ACTS[0]; }
  function chains(asset) {
    var m = window._UB_GW_DEP_CHAINS;
    return (m && m[asset]) ? m[asset] : [];
  }
  function activeId() { try { return Number(activeChainId); } catch (_) { return 0; } }
  function pickNet(f, asset) {
    var list = chains(asset);
    if (!list.some(function (c) { return c.id === f.net; })) {
      var a = activeId(), hit = list.filter(function (c) { return c.id === a; })[0] || list.filter(function (c) { return c.id === 5042; })[0] || list[0];
      f.net = hit ? hit.id : 0;
    }
    return f.net;
  }
  function chainName(asset, id) { var c = chains(asset).filter(function (x) { return x.id === id; })[0]; return c ? c.name : null; }
  function tok(sym) { return '<span class="ch-tok" style="background:' + (TOK[sym] || '#64748b') + '">' + esc(String(sym).charAt(0)) + '</span>'; }
  function chainLogo(id) { try { var r = window.CHAIN_REGISTRY && window.CHAIN_REGISTRY[id]; if (r && typeof _nsChainLogo === 'function') return '<span class="ch-logo">' + _nsChainLogo(r) + '</span>'; } catch (_) {} return ''; }
  function isAddr(s) { return /^0x[0-9a-fA-F]{40}$/.test(String(s || '')); }
  function shortAddr(a) { return a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : (a || ''); }

  // Balances: Gateway (unified, from the shared cache) and wallet (active network only).
  function gwAvail(g, asset) {
    if (!UI.usable(g)) return null;
    var e = g.assets[asset]; if (!e || e.error) return null;
    return CH.total(g, asset);
  }
  function walletBal(asset, net) {
    if (net !== activeId()) return null;
    var w = CH.walletBalances(); if (!w || w[asset] == null) return null;
    return Number(w[asset]);
  }
  function floorStr(n, dec) {       // truncated (never rounded up) decimal string
    var s = Number(n).toFixed(dec + 4), i = s.indexOf('.');
    var out = i === -1 ? s : s.slice(0, i + 1 + dec).replace(/\.?0+$/, '');
    return out === '' || out === '-0' ? '0' : out;
  }

  // ── Validation (display only) ─────────────────────────────────────────
  function check(k, g) {
    var f = M.f[k], asset = k === 'charge' ? 'USDC' : f.asset, dec = CH.DEC[asset] || 6;
    if (!CH.wallet()) return ['info', 'Connect your wallet to prepare this operation.'];
    if (k !== 'charge' && !chains(asset).length) return ['warn', 'No supported networks are available for ' + asset + '.'];
    if ((k === 'send' || k === 'crosschain') && f.to !== null && f.to !== '' && !isAddr(f.to)) return ['err', 'Enter a valid EVM address (0x…).'];
    if (k === 'charge' && f.to && !isAddr(f.to)) return ['err', 'Enter a valid beneficiary address (0x…).'];
    if (!f.amount) return ['', ''];
    var a = CH.toAtomic(f.amount, dec);
    if (a == null) return ['err', 'Enter a valid amount (up to ' + dec + ' decimals).'];
    if (a === 0n) return ['err', 'Amount must be greater than zero.'];
    if (k === 'deposit') { var wb = walletBal(asset, pickNet(f, asset)); if (wb != null && Number(f.amount) > wb) return ['err', 'Exceeds your wallet balance.']; }
    else if (k !== 'charge') { var av = gwAvail(g, asset); if (av != null && a > av) return ['err', 'Exceeds your available Gateway balance.']; }
    return ['', ''];
  }

  // ── Transaction details (real values only) ────────────────────────────────
  function amountText(k) { var f = M.f[k]; return f.amount ? esc(f.amount) + ' ' + (k === 'charge' ? 'USDC' : esc(f.asset)) : '<span class="ch-dim">0.00</span>'; }
  // Circle Gateway does not expose a fee-estimation endpoint; the burn intent
  // authorizes a conservative maxFee ceiling (USDC/EURC 2.01, cirBTC 0.000021).
  function feeCeil(asset) { return asset === 'cirBTC' ? '≤ 0.000021 ' + asset : '≤ 2.01 ' + asset; }
  function details(k) {
    var f = M.f[k], asset = k === 'charge' ? 'USDC' : f.asset, net = chainName(asset, pickNet(f, asset)), w = CH.wallet();
    var recip = recipientOf(k);
    var rows;
    if (k === 'deposit') rows = [['Estimated fee', NA], ['Estimated time', NA], ['You will deposit', amountText(k)], ['Gateway credit', 'After confirmation and finality']];
    else if (k === 'charge') rows = [['Amount', amountText(k)], ['Receiving network', net ? esc(net) : NA], ['Beneficiary', recip ? esc(shortAddr(recip)) : NA], ['Expiration', NA], ['Settlement', 'Paid to the beneficiary wallet, not credited to Gateway']];
    else {
      rows = [['Amount', amountText(k)], [k === 'withdraw' ? 'Destination network' : 'Destination', net ? esc(net) : NA]];
      if (k === 'crosschain') rows.unshift(['Source of funds', 'Unified Gateway balance']);
      if (k === 'withdraw') rows.push(['Wallet', w ? esc(shortAddr(w)) : NA]);
      rows.push(['Estimated fee', feeCeil(asset)], ['Estimated time', 'Typically under 30s'], ['Net amount', amountText(k)], ['Settlement', k === 'withdraw' ? 'Gateway transfer to your own wallet. Not a trustless withdrawal.' : 'Minted on the destination network']);
    }
    return rows.map(function (r) { return '<div class="ch-kv"><span>' + r[0] + '</span><span>' + r[1] + '</span></div>'; }).join('');
  }
  function hint(k, g) { var h = check(k, g); return h[1] ? '<span class="ch-h-' + h[0] + '">' + esc(h[1]) + '</span>' : ''; }

  // ── Native execution readiness (Phase 1.0.1D.2) ─────────────────────────
  // A Gateway transfer (send/cross-chain/withdraw) is ready only when the wallet is
  // connected, the amount is a valid positive value within the available Gateway
  // balance, and (for send/cross-chain) the recipient is a valid EVM address.
  function recipientOf(k) {
    var f = M.f[k], w = CH.wallet();
    if (k === 'withdraw') return w;
    return (f.to === null || String(f.to).trim() === '') ? w : String(f.to).trim();
  }
  function isReady(k, g) {
    if (k !== 'send' && k !== 'crosschain' && k !== 'withdraw') return false;
    if (!CH.wallet()) return false;
    var f = M.f[k], asset = f.asset, dec = CH.DEC[asset] || 6;
    if (!f.amount) return false;
    var a = CH.toAtomic(f.amount, dec);
    if (a == null || a === 0n) return false;
    if (k === 'send' || k === 'crosschain') { var r = recipientOf(k); if (!isAddr(r)) return false; }
    var av = gwAvail(g, asset);
    if (av != null && a > av) return false;
    return true;
  }
  function execState() {
    var d = document.getElementById('ch-exec-state');
    return d ? d : null;
  }
  function showExecState(k, cls, msg) {
    var d = document.getElementById('ch-exec-state');
    if (!d) return;
    d.className = 'ch-exec-state ch-h-' + cls;
    d.innerHTML = msg;
  }

  // Execute a native Gateway transfer (send / cross-chain / withdraw) inside the
  // Capital Hub, reusing the existing saExecGateway engine with explicit parameters.
  UI.qaExec = async function (k) {
    var f = M.f[k]; if (!f) return;
    var g = CH.gateway();
    if (!isReady(k, g)) return;
    var w = CH.wallet(), asset = f.asset;
    var recipient = recipientOf(k);
    var srcChainId = activeId(), destChainId = f.net;

    var btn = document.querySelector('[data-ch-exec="' + k + '"]');
    if (btn) { btn.disabled = true; var _c = btn.innerHTML; btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> Processing…'; }
    showExecState(k, 'info', 'Signing and submitting the transfer…');
    try {
      var res = (typeof saExecGateway === 'function')
        ? await saExecGateway({ recipient: recipient, amount: f.amount, asset: asset, chainId: srcChainId, destChainId: destChainId })
        : { status: 'error', error: 'gateway_engine_unavailable' };
      if (res && res.status === 'pending') {
        showExecState(k, 'info', 'Transfer submitted — awaiting mint on the destination network. Do not resubmit.');
      } else if (res && res.status === 'ambiguous') {
        showExecState(k, 'warn', 'Transfer result is indeterminate (' + (res.error || 'unknown') + '). Do not resubmit — it will be reconciled.');
      } else {
        showExecState(k, 'err', 'Transfer failed: ' + (res && res.error ? res.error : 'unknown error'));
      }
    } catch (e) {
      showExecState(k, 'err', 'Transfer failed: ' + (e && e.message ? e.message : 'unknown error'));
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = _c; }
      try { if (typeof ubGatewaySyncRefresh === 'function') ubGatewaySyncRefresh(); } catch (_) {}
    }
  };

  // ── Form ──────────────────────────────────────────────────────────────────
  function sel(id, opts, cur, lead) {
    return '<div class="ch-selw">' + (lead || '') + '<select class="ch-sel' + (lead ? ' ch-sel-lead' : '') + '" id="' + id + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></div>';
  }
  function fld(label, html, cls) { return '<div class="ch-fld' + (cls ? ' ' + cls : '') + '"><label class="ch-lbl">' + label + '</label>' + html + '</div>'; }
  function amountField(k, sym, max) {
    return '<div class="ch-amt"><input class="ch-in" id="ch-qf-' + k + '-amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="' + esc(M.f[k].amount) + '" aria-label="Amount">' +
      '<span class="ch-amt-sym">' + esc(sym) + '</span>' + (max ? '<button type="button" class="ch-max" data-ch-max="' + k + '">MAX</button>' : '') + '</div>';
  }
  function form(k, g) {
    var f = M.f[k], w = CH.wallet(), asset = k === 'charge' ? 'USDC' : f.asset, net = pickNet(f, asset), A = actOf(k);
    var assetSel = sel('ch-qf-' + k + '-asset', CH.ASSETS.map(function (a) { return [a, a]; }), f.asset, tok(f.asset));
    var netOpts = chains(asset).map(function (c) { return [c.id, c.name]; });
    var netSel = function (label) { return fld(label, sel('ch-qf-' + k + '-net', netOpts, net, chainLogo(net))); };
    var out = '<div class="ch-ff">';
    if (k === 'deposit') {
      var wb = walletBal(asset, net);
      out += fld('Asset', assetSel) + netSel('Source network') + fld('Amount', amountField(k, asset, true)) +
        fld('Wallet balance', '<div class="ch-balv">' + (wb != null ? '<b>' + esc(floorStr(wb, CH.DEC[asset])) + '</b> ' + esc(asset) : '<span class="ch-dim">Switch your wallet to this network to read it</span>') + '</div>');
    } else {
      var av = gwAvail(g, asset), avHtml = av != null ? '<b>' + esc(CH.fmt(av, CH.DEC[asset], CH.DEC[asset])) + '</b> ' + esc(asset) : (g.state === 'loading' ? UI.skel(90) : '<span class="ch-dim">Not available</span>');
      if (k === 'charge') {
        out += fld('Amount', amountField(k, 'USDC', false)) + netSel('Receiving network') +
          fld('Beneficiary', '<input class="ch-in ch-in-b" id="ch-qf-charge-to" autocomplete="off" spellcheck="false" placeholder="0x…" value="' + esc(f.to === null ? (w || '') : f.to) + '" aria-label="Beneficiary address">', 'full') +
          fld('Description', '<input class="ch-in ch-in-b" id="ch-qf-charge-desc" maxlength="120" autocomplete="off" placeholder="Optional reference" value="' + esc(f.desc) + '" aria-label="Description">') +
          fld('Expiration', '<select class="ch-sel" id="ch-qf-charge-exp" disabled aria-label="Expiration"><option>Not supported yet</option></select>');
      } else {
        out += fld('Asset', assetSel) + fld('Gateway available', '<div class="ch-balv">' + avHtml + '</div>') + netSel(k === 'withdraw' ? 'Destination network' : 'Destination network');
        if (k === 'withdraw') out += fld('Connected wallet', '<div class="ch-balv ch-mono" title="' + esc(w || '') + '">' + (w ? esc(shortAddr(w)) : '<span class="ch-dim">Not connected</span>') + '</div>');
        else out += fld('Recipient address', '<input class="ch-in ch-in-b" id="ch-qf-' + k + '-to" autocomplete="off" spellcheck="false" placeholder="0x…" value="' + esc(f.to === null ? (w || '') : f.to) + '" aria-label="Recipient address">');
        out += fld('Amount', amountField(k, asset, true), 'full');
      }
    }
    var native = (k === 'send' || k === 'crosschain' || k === 'withdraw');
    var ready = native && isReady(k, g);
    out += '</div><div class="ch-hint" id="ch-qf-hint" aria-live="polite">' + hint(k, g) + '</div>';
    if (native) {
      out += '<button type="button" class="ch-act ch-act-primary ch-wide" data-ch-exec="' + k + '"' + (ready ? '' : ' disabled aria-disabled="true"') + '><i class="ti ti-' + A.ic + '"></i>' + A.btn + '</button>' +
        '<div class="ch-exec-state" id="ch-exec-state" aria-live="polite"></div>';
    } else {
      out += '<button type="button" class="ch-act ch-act-primary ch-wide" disabled aria-disabled="true"><i class="ti ti-' + A.ic + '"></i>' + A.btn + '</button>' +
        '<div class="ch-pending"><i class="ti ti-info-circle"></i><span>' + (k === 'charge' ? 'Payment links are created in Billing today.' : 'The existing flow still works:') + '</span>' +
        (A.ex ? '<button type="button" class="ch-link" data-ch-qa-open="' + k + '">' + A.ex + '</button>' : '') + '</div>';
    }
    return out;
  }
  function steps(k) {
    return '<ol class="ch-steps">' + STEPS[k].map(function (s, i) { return '<li class="ch-step"><span class="ch-step-n">' + (i + 1) + '</span><div><div class="ch-step-t">' + s[0] + '</div><div class="ch-step-d">' + s[1] + '</div></div></li>'; }).join('') + '</ol>' +
      '<div class="ch-card-f">Each step reflects the real on-chain state — nothing is reported completed without verifiable confirmation.</div>';
  }

  UI.tabs.manage = function (g) {
    var k = M.act, A = actOf(k), anim = M.anim; M.anim = false;
    return UI.stateBanner(g) +
      '<div class="ch-qa-head"><i class="ti ti-bolt"></i><b>Quick Actions</b><span>Manage your capital with Circle Gateway</span></div>' +
      '<div class="ch-qa-grid" role="tablist" aria-label="Quick actions">' + ACTS.map(function (a) {
        return '<button type="button" role="tab" class="ch-qa' + (a.k === k ? ' on' : '') + '" aria-selected="' + (a.k === k) + '" data-ch-qa="' + a.k + '"><span class="ch-qa-ic"><i class="ti ti-' + a.ic + '"></i></span><span class="ch-qa-t"><b>' + a.t + '</b><small>' + a.s + '</small></span></button>';
      }).join('') + '</div>' +
      '<section class="ch-op' + (anim ? ' ch-op-in' : '') + '" role="tabpanel" aria-label="' + A.t + '">' +
        '<div class="ch-op-head"><span class="ch-op-ic"><i class="ti ti-' + A.ic + '"></i></span><div><div class="ch-panel-t">' + A.t + '</div><div class="ch-panel-s">' + A.d + '</div></div></div>' +
        '<div class="ch-op-grid"><div class="ch-op-main"><div class="ch-op-form">' + form(k, g) + '</div>' +
        '<div class="ch-op-det"><div class="ch-op-dt">Transaction details</div><div id="ch-op-det">' + details(k) + '</div></div></div>' +
        '<div class="ch-op-steps"><div class="ch-op-dt">Execution steps</div>' + steps(k) + '</div></div>' +
      '</section>' +
      '<div class="ch-secure"><i class="ti ti-shield-check"></i><span>Secure execution · Every operation is signed by your wallet · Powered by <b>Circle Gateway</b></span></div>';
  };

  // ── Interaction (state + light repaint only) ──────────────────────────────
  function sync() {
    var g = CH.gateway(), d = document.getElementById('ch-op-det'), h = document.getElementById('ch-qf-hint');
    if (d) d.innerHTML = details(M.act);
    if (h) h.innerHTML = hint(M.act, g);
    // Reactive: update the native button's disabled state as the user types or
    // changes values (send/cross-chain/withdraw only).
    var btn = document.querySelector('[data-ch-exec="' + M.act + '"]');
    if (btn) { var ready = isReady(M.act, g); if (btn.disabled === ready) btn.disabled = !ready; }
  }
  UI.qaSelect = function (k) { if (!M.f[k] || M.act === k) return; M.act = k; M.anim = true; UI.render(); };
  UI.qaInput = function (id, v) {
    var m = /^ch-qf-([a-z]+)-([a-z]+)$/.exec(id); if (!m || !M.f[m[1]]) return;
    var f = M.f[m[1]], key = m[2];
    if (key === 'amount') f.amount = String(v).trim(); else if (key === 'to') f.to = String(v).trim(); else if (key === 'desc') f.desc = String(v).slice(0, 120);
    sync();
  };
  UI.qaChange = function (id, v) {
    var m = /^ch-qf-([a-z]+)-([a-z]+)$/.exec(id); if (!m || !M.f[m[1]]) return;
    var f = M.f[m[1]];
    if (m[2] === 'asset' && CH.ASSETS.indexOf(v) !== -1) { f.asset = v; f.amount = ''; f.net = 0; }
    else if (m[2] === 'net') f.net = Number(v);
    UI.render();
  };
  UI.qaMax = function (k) {
    var g = CH.gateway(), f = M.f[k]; if (!f) return;
    var asset = f.asset, dec = CH.DEC[asset];
    if (k === 'deposit') { var wb = walletBal(asset, pickNet(f, asset)); if (wb == null) return; f.amount = floorStr(wb, dec); }
    else { var av = gwAvail(g, asset); if (av == null) return; f.amount = CH.fmt(av, dec, dec).replace(/,/g, ''); }
    var i = document.getElementById('ch-qf-' + k + '-amount'); if (i) i.value = f.amount;
    sync();
  };
  UI.qaOpen = function (k) {      // existing flows only (same launchers as the Overview)
    var f = M.f[k]; if (!f) return;
    UI.launch(k === 'deposit' ? 'deposit' : k === 'withdraw' ? 'withdraw' : k === 'charge' ? 'charge' : 'transfer', f.asset);
  };
})();
