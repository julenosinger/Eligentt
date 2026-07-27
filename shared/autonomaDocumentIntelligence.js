/**
 * Autonoma Financial Document Intelligence Layer
 * Parses uploaded financial files (CSV/XLSX/TXT/JSON) and orchestrates
 * existing Elligentt modules — never duplicates business logic.
 * Attached to window.AutonomaDocIntel
 */
(function(){
  'use strict';

  var MAX_PAYMENTS = 50;
  var MAX_SCHEDULED = 50;
  var MAX_CROSSCHAIN = 50;
  var MAX_SWAPS = 20;

  var VALID_TOKENS = ['USDC','EURC','CIRBTC','ETH'];
  var VALID_CHAINS = ['ARC','ARBITRUM','BASE','ETHEREUM','OPTIMISM','POLYGON','ARC_TESTNET','ARB','BASE_SEPOLIA','ETH','OPTIMISM_SEPOLIA','POLYGON_AMOY'];

  function normToken(s) {
    var t = String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    if (t === 'USD' || t === 'USDT') return 'USDC';
    if (t === 'EUR') return 'EURC';
    if (t === 'CIRBTC' || t === 'CBTC' || t === 'BTC') return 'cirBTC';
    if (t === 'ETH' || t === 'ETHER') return 'ETH';
    var found = VALID_TOKENS.find(function(v){ return v.toUpperCase() === t; });
    return found || null;
  }

  function normChain(s) {
    var t = String(s||'').toUpperCase().replace(/[_ ]/g,'');
    if (t.indexOf('ARC') === 0) return 'Arc_Testnet';
    if (t.indexOf('BASE') === 0) return 'Base_Sepolia';
    if (t.indexOf('ARBITRUM') === 0 || t.indexOf('ARB') === 0) return 'Arbitrum_Sepolia';
    if (t.indexOf('ETHEREUM') === 0 || t.indexOf('ETH') === 0) return 'Ethereum_Sepolia';
    if (t.indexOf('OPTIMISM') === 0) return 'Optimism_Sepolia';
    if (t.indexOf('POLYGON') === 0 || t.indexOf('MATIC') === 0) return 'Polygon_Amoy';
    return null;
  }

  function isAddr(a) {
    return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) &&
      a.toLowerCase() !== '0x0000000000000000000000000000000000000000';
  }

  /* ════════════════════════════════════════
     CSV PARSER
  ════════════════════════════════════════ */
  function parseCSV(text) {
    var lines = text.split(/\r?\n/).filter(function(l){ return l.trim(); });
    if (!lines.length) return { rows: [], errors: ['Empty file'], headers: [] };

    var firstParts = lines[0].split(',').map(function(p){ return p.trim(); });
    var hasHeader = true;
    if (isAddr(firstParts[0]) || /^\d+(\.\d+)?$/.test(firstParts[1] || '')) {
      hasHeader = false;
    }

    var headers, dataStart;
    if (hasHeader) {
      headers = firstParts.map(function(h){ return h.trim().toLowerCase().replace(/[^a-z0-9]/gi,'_'); });
      dataStart = 1;
    } else {
      headers = ['address', 'amount', 'token', 'chain', 'note'];
      dataStart = 0;
    }

    var colMap = detectColumns(headers);
    var rows = [];
    var errors = [];
    var seenAddrs = {};

    for (var i = dataStart; i < lines.length; i++) {
      var parts = _splitCSVLine(lines[i]);
      var row = {};
      for (var c = 0; c < colMap.length && c < parts.length; c++) {
        if (colMap[c] && parts[c]) row[colMap[c]] = parts[c];
      }
      var errs = validateRow(row, i + 1);
      if (errs.length) {
        errors = errors.concat(errs);
        continue;
      }
      row._amount = parseFloat(row.amount) || 0;
      row._token = normToken(row.token) || 'USDC';
      row._chain = normChain(row.chain) || 'Arc_Testnet';
      row._rawAmount = _toRawInt(row._amount, row._token);
      var addrLower = (row.address||'').toLowerCase();
      if (seenAddrs[addrLower]) errors.push('Line ' + (i+1) + ': Duplicate address ' + row.address);
      else seenAddrs[addrLower] = true;
      rows.push(row);
    }

    return { rows: rows, errors: errors, headers: headers, colMap: colMap, totalPayments: rows.length };
  }

  function _splitCSVLine(line) {
    var parts = [];
    var current = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; }
      else if (ch === ',' && !inQuotes) { parts.push(current.trim()); current = ''; }
      else current += ch;
    }
    parts.push(current.trim());
    return parts;
  }

  /* ════════════════════════════════════════
     XLSX PARSER — lightweight binary parser
  ════════════════════════════════════════ */
  function parseXLSX(buffer) {
    try {
      var arr = new Uint8Array(buffer);
      var text = _xlsxToCSV(arr);
      if (!text) return { rows: [], errors: ['Could not parse XLSX file'], headers: [] };
      return parseCSV(text);
    } catch(e) {
      return { rows: [], errors: ['XLSX parse error: ' + (e.message || 'unknown')], headers: [] };
    }
  }

  function _xlsxToCSV(uint8) {
    try {
      var xml = '';
      for (var i = 0; i < uint8.length; i++) xml += String.fromCharCode(uint8[i]);
      if (xml.indexOf('<?xml') === -1 && xml.indexOf('<x:') === -1) {
        var text = new TextDecoder('utf-8').decode(uint8);
        if (text.indexOf('<?xml') > -1 || text.indexOf('<x:') > -1) xml = text;
      }

      var sheetIdx = xml.indexOf('<sheetData');
      if (sheetIdx === -1) return null;
      var sheetEnd = xml.indexOf('</sheetData>', sheetIdx);
      if (sheetEnd === -1) sheetEnd = xml.length;
      var sheetData = xml.substring(sheetIdx, sheetEnd);

      var rows = [];
      var rowRe = /<row[^>]*>/g;
      var rowMatch;
      var lastRowIdx = 0;
      while ((rowMatch = rowRe.exec(sheetData)) !== null) {
        var rowStart = rowMatch.index;
        var rowEnd = sheetData.indexOf('</row>', rowStart);
        if (rowEnd === -1) break;
        var rowXml = sheetData.substring(rowStart, rowEnd + 6);

        var cells = [];
        var cellRe = /<c[^>]*>[^<]*(?:(?!<\/c>)<[^>]*>[^<]*)*<\/c>/g;
        var cellMatch;
        while ((cellMatch = cellRe.exec(rowXml)) !== null) {
          var cellXml = cellMatch[0];
          var colLetter = '';
          var refMatch = cellXml.match(/r="([A-Z]+)\d+"/);
          if (refMatch) colLetter = refMatch[1];
          else {
            var colIdx = (cellMatch[0].match(/<c[^>]*>/g)||[])[0];
            if (colIdx) {
              var refM2 = colIdx.match(/r="([A-Z]+)\d+"/i);
              if (refM2) colLetter = refM2[1];
            }
          }
          var valMatch = cellXml.match(/<v[^>]*>([^<]*)<\/v>/);
          var inlineMatch = cellXml.match(/<t[^>]*>([^<]*)<\/t>/);
          var val = '';
          if (valMatch && valMatch[1]) val = _unXlsxNum(valMatch[1], colLetter);
          else if (inlineMatch) val = inlineMatch[1];
          cells.push({ col: colLetter, val: val });
        }
        cells.sort(function(a,b){
          function colNum(l) { var n=0; for(var x=0;x<l.length;x++) n=n*26+(l.charCodeAt(x)-64); return n; }
          return colNum(a.col) - colNum(b.col);
        });

        var rowVals = cells.map(function(c){ return _csvEscape(c.val); });
        while (rows.length < lastRowIdx + 1) rows.push([]);
        rows[lastRowIdx] = rowVals.concat(rows[lastRowIdx] || []);
        lastRowIdx++;
      }

      var csvLines = rows.map(function(r){ return r.join(','); }).filter(function(l){ return l.trim(); });
      if (csvLines.length === 0) return null;
      return csvLines.join('\n');
    } catch(e) { return null; }
  }

  function _unXlsxNum(val, col) {
    if (!/^\d+(\.\d+)?$/.test(val)) return val;
    return String(parseFloat(val));
  }

  function _csvEscape(s) {
    s = String(s||'').trim();
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /* ════════════════════════════════════════
     TXT PARSER — simple line-based format
     Format: address amount [token] [chain]
  ════════════════════════════════════════ */
  function parseTXT(text) {
    var lines = text.split(/\r?\n/).filter(function(l){ return l.trim(); });
    var rows = [];
    var errors = [];
    var seenAddrs = {};

    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].trim().split(/\s+/);
      if (parts.length < 2) { errors.push('Line ' + (i+1) + ': Not enough data'); continue; }
      var addrIdx = -1, amtIdx = -1;
      for (var p = 0; p < parts.length; p++) {
        if (isAddr(parts[p]) && addrIdx === -1) addrIdx = p;
        else if (/^\d+(\.\d+)?$/.test(parts[p]) && amtIdx === -1) amtIdx = p;
      }
      if (addrIdx === -1) { errors.push('Line ' + (i+1) + ': No valid address'); continue; }
      if (amtIdx === -1) { errors.push('Line ' + (i+1) + ': No valid amount'); continue; }
      var token = 'USDC', chain = 'Arc_Testnet';
      for (var q = 0; q < parts.length; q++) {
        if (q === addrIdx || q === amtIdx) continue;
        var nt = normToken(parts[q]);
        if (nt) token = nt;
        else { var nc = normChain(parts[q]); if (nc) chain = nc; }
      }
      var amount = parseFloat(parts[amtIdx]);
      var addr = parts[addrIdx];
      var addrLower = addr.toLowerCase();
      if (seenAddrs[addrLower]) errors.push('Line ' + (i+1) + ': Duplicate address ' + addr);
      else { seenAddrs[addrLower] = true; rows.push({ address: addr, amount: amount, token: token, chain: chain, _amount: amount, _token: token, _chain: chain, _rawAmount: _toRawInt(amount, token) }); }
    }
    return { rows: rows, errors: errors, headers: ['address','amount','token','chain'], totalPayments: rows.length };
  }

  /* ════════════════════════════════════════
     JSON PARSER
  ════════════════════════════════════════ */
  function parseJSON(text) {
    try {
      var data = JSON.parse(text);
      var arr = Array.isArray(data) ? data : [data];
      var rows = [];
      var errors = [];
      var seenAddrs = {};

      for (var i = 0; i < arr.length; i++) {
        var obj = arr[i];
        if (typeof obj !== 'object' || !obj) { errors.push('Entry ' + (i+1) + ': Invalid object'); continue; }
        var addr = obj.address || obj.addr || obj.wallet || obj.to || '';
        var amount = parseFloat(obj.amount || obj.value || obj.amt || 0);
        var token = obj.token || obj.symbol || obj.asset || 'USDC';
        var chain = obj.chain || obj.network || obj.chainId || 'Arc_Testnet';
        var note = obj.note || obj.name || obj.label || '';
        var errs = validateRow({ address: addr, amount: String(amount), token: token, chain: chain, note: note }, i + 1);
        if (errs.length) { errors = errors.concat(errs); continue; }
        var nToken = normToken(token) || 'USDC';
        var nChain = normChain(chain) || 'Arc_Testnet';
        var addrLower = addr.toLowerCase();
        if (seenAddrs[addrLower]) errors.push('Entry ' + (i+1) + ': Duplicate address ' + addr);
        else {
          seenAddrs[addrLower] = true;
          rows.push({ address: addr, amount: amount, token: nToken, chain: nChain, note: note, _amount: amount, _token: nToken, _chain: nChain, _rawAmount: _toRawInt(amount, nToken) });
        }
      }
      return { rows: rows, errors: errors, headers: ['address','amount','token','chain','note'], totalPayments: rows.length };
    } catch(e) {
      return { rows: [], errors: ['JSON parse error: ' + (e.message || 'unknown')], headers: [] };
    }
  }

  /* ════════════════════════════════════════
     COLUMN DETECTION
  ════════════════════════════════════════ */
  function detectColumns(headers) {
    var map = [];
    for (var i = 0; i < headers.length; i++) {
      var h = headers[i].toLowerCase().replace(/[^a-z0-9]/g,'');
      if (h.indexOf('address') !== -1 || h.indexOf('addr') !== -1 || h === 'wallet' || h === 'to' || h === 'recipient') map[i] = 'address';
      else if (h.indexOf('amount') !== -1 || h === 'value' || h === 'amt' || h === 'sum' || h === 'total') map[i] = 'amount';
      else if (h.indexOf('token') !== -1 || h === 'asset' || h === 'symbol' || h === 'currency') map[i] = 'token';
      else if (h.indexOf('chain') !== -1 || h === 'network' || h === 'chainid') map[i] = 'chain';
      else if (h.indexOf('note') !== -1 || h === 'name' || h === 'label' || h === 'description' || h === 'desc' || h === 'memo') map[i] = 'note';
      else if (h.indexOf('date') !== -1 || h === 'time' || h === 'schedule' || h === 'when') map[i] = 'date';
      else if (h.indexOf('freq') !== -1 || h === 'frequency' || h === 'recurrence' || h === 'repeat') map[i] = 'frequency';
    }
    return map;
  }

  /* ════════════════════════════════════════
     ROW VALIDATION
  ════════════════════════════════════════ */
  function validateRow(row, lineNum) {
    var errs = [];
    if (!row.address || !isAddr(row.address)) errs.push('Line ' + lineNum + ': Invalid address "' + (row.address||'') + '"');
    var amt = parseFloat(row.amount);
    if (isNaN(amt) || amt <= 0) errs.push('Line ' + lineNum + ': Invalid amount "' + (row.amount||'') + '"');
    return errs;
  }

  /* ════════════════════════════════════════
     STANDARD VALUE CONVERSION (mirrors toUsdc/saToRaw pipeline)
  ════════════════════════════════════════ */
  function _toRawInt(amount, token) {
    var dec = normToken(token) === 'CIRBTC' ? 8 : 6;
    return BigInt(Math.round(parseFloat(amount) * Math.pow(10, dec)));
  }

  /* ════════════════════════════════════════
     INTELLIGENT OPERATION CLASSIFICATION
  ════════════════════════════════════════ */
  function classifyOperation(rows, userMsg) {
    var tokens = {}; rows.forEach(function(r){ tokens[r._token] = (tokens[r._token]||0) + 1; });
    var tokenList = Object.keys(tokens);
    var chains = {}; rows.forEach(function(r){ chains[r._chain] = (chains[r._chain]||0) + 1; });
    var chainList = Object.keys(chains);
    var totalSum = rows.reduce(function(s,r){ return s + r._amount; }, 0);
    var isCrosschain = chainList.some(function(c){ return c !== 'Arc_Testnet'; });
    var multiToken = tokenList.length > 1;
    var isBatch = rows.length > 1;
    var msg = (userMsg||'').toLowerCase();

    var mode = 'instant_payment';
    if (/(schedule|agendar|agenda|every|todo dia|toda semana|todo mes|tomorrow|amanha|next|proximo|weekly|semanal|monthly|mensal|friday|sexta|monday|segunda|tuesday|terca|wednesday|quarta|thursday|quinta|saturday|sabado|sunday|domingo)/i.test(msg)) {
      mode = /(every|todo dia|toda semana|todo mes|weekly|semanal|monthly|mensal|recurring|recorrente)/i.test(msg) ? 'recurring' : 'scheduled';
    }
    if (/cross.?chain|bridge|ponte|enviar para (arbitrum|base|ethereum|polygon|optimism)/i.test(msg) || (isCrosschain && !/(schedule|agendar)/i.test(msg))) {
      mode = mode === 'scheduled' ? 'scheduled_crosschain' : (mode === 'recurring' ? 'recurring_crosschain' : 'crosschain');
    }
    if (/(swap|trocar|convert)/i.test(msg) && multiToken) mode = 'swap_and_pay';
    if (/(payroll|workflow|split|dividir|repartir)/i.test(msg)) mode = 'workflow_payroll';

    var scheduleDate = null;
    var dateMatch = msg.match(/(\d{1,2}[:h]\d{2})/);
    if (dateMatch) scheduleDate = dateMatch[0];

    return {
      mode: mode,
      totalPayments: rows.length,
      totalAmount: totalSum,
      tokenList: tokenList,
      chainList: chainList,
      isCrosschain: isCrosschain,
      isBatch: isBatch,
      isMultiToken: multiToken,
      scheduleDate: scheduleDate,
      suggestedFreq: /(daily|diario|daily)/i.test(msg) ? 'daily' : /(weekly|semanal)/i.test(msg) ? 'weekly' : /(monthly|mensal)/i.test(msg) ? 'monthly' : 'once'
    };
  }

  /* ════════════════════════════════════════
     SUMMARY BUILDER
  ════════════════════════════════════════ */
  function buildSummary(parsed, classification) {
    var totalByToken = {};
    parsed.rows.forEach(function(r){
      totalByToken[r._token] = (totalByToken[r._token]||0) + r._amount;
    });
    var tokenSummary = Object.keys(totalByToken).map(function(t){
      return { token: t, amount: totalByToken[t], count: parsed.rows.filter(function(r){ return r._token === t; }).length };
    });
    var chainSummary = {};
    parsed.rows.forEach(function(r){
      chainSummary[r._chain] = (chainSummary[r._chain]||0) + 1;
    });

    return {
      totalPayments: parsed.totalPayments,
      totalAmount: classification.totalAmount,
      tokenSummary: tokenSummary,
      chainSummary: chainSummary,
      errors: parsed.errors,
      classification: classification,
      rows: parsed.rows
    };
  }

  /* ════════════════════════════════════════
     FILE TYPE DETECTOR
  ════════════════════════════════════════ */
  function detectFileType(name, data, isBinary) {
    var n = (name||'').toLowerCase();
    if (n.endsWith('.csv') || (typeof data === 'string' && data.indexOf(',') !== -1 && data.split('\n').length > 1)) return 'csv';
    if (n.endsWith('.xlsx') || n.endsWith('.xls') || isBinary) return 'xlsx';
    if (n.endsWith('.txt') || (typeof data === 'string' && data.indexOf('0x') !== -1)) return 'txt';
    if (n.endsWith('.json') || (typeof data === 'string' && data.trim().startsWith('['))) return 'json';
    return 'csv';
  }

  /* ════════════════════════════════════════
     ORCHESTRATION BUILDER — never duplicates logic
  ════════════════════════════════════════ */
  function buildOrchestrationPlan(classification, rows) {
    var plan = { steps: [], mode: classification.mode, rows: rows };

    if (classification.mode === 'swap_and_pay') {
      plan.steps.push({ module: 'swap', action: 'execute_swap', desc: 'Swap source token to target token before paying' });
    }
    if (classification.mode === 'crosschain' || classification.mode === 'scheduled_crosschain' || classification.mode === 'recurring_crosschain') {
      plan.steps.push({ module: 'crosschain', action: 'bridge_payments', desc: 'Bridge payments to destination chain via CrossChain engine' });
    }
    if (classification.mode === 'scheduled' || classification.mode === 'recurring' || classification.mode === 'scheduled_crosschain' || classification.mode === 'recurring_crosschain') {
      plan.steps.push({ module: 'schedule_engine', action: 'create_schedules', desc: 'Create ScheduleEngine entries for each payment' });
    } else if (classification.mode === 'workflow_payroll') {
      plan.steps.push({ module: 'workflow_engine', action: 'create_workflow', desc: 'Create payroll workflow with batch execution' });
    } else {
      plan.steps.push({ module: 'ai_smart_wallet', action: 'execute_payments', desc: 'Execute payments via AI Smart Wallet' });
    }
    plan.steps.push({ module: 'audit', action: 'verify', desc: 'Verify execution and record in history' });
    return plan;
  }

  /* ════════════════════════════════════════
     EXECUTION — orchestrates existing modules
  ════════════════════════════════════════ */
  function executePlan(plan) {
    var results = { success: 0, failed: 0, errors: [] };

    if (plan.mode === 'scheduled' || plan.mode === 'recurring' || plan.mode === 'scheduled_crosschain' || plan.mode === 'recurring_crosschain') {
      if (typeof ScheduleEngine === 'undefined') return { success: 0, failed: plan.rows.length, errors: ['ScheduleEngine unavailable'] };
      var isXc = plan.mode === 'scheduled_crosschain' || plan.mode === 'recurring_crosschain';
      plan.rows.forEach(function(r){
        try {
          var recips = [{ addr: r.address, amount: r._amount, note: r.note || '', chainId: r._chain, token: r._token }];
          ScheduleEngine.create({
            type: isXc ? 'crosschain' : 'payment', name: (r.note || 'Scheduled Payment'), token: r._token,
            amount: r._amount, total: r._amount,
            network: r._chain, fromNetwork: 'Arc_Testnet', toNetwork: r._chain,
            recipients: recips, address: r.address,
            freq: plan.freq || 'once', maxEx: plan.mode === 'recurring' || plan.mode === 'recurring_crosschain' ? 0 : 1, gas: 0.10,
            nextRun: plan.scheduleDate || new Date(Date.now() + 60000).toISOString(),
            execCount: 0, executionHistory: [],
            status: 'Active', created: new Date().toISOString(), createdBy: 'autonoma',
            agentExecution: true, walletAddress: (typeof walletAddress !== 'undefined' ? walletAddress : '')
          });
          results.success++;
        } catch(e) { results.failed++; results.errors.push('Schedule for ' + r.address + ': ' + (e.message || 'error')); }
      });
      try { schedules = ScheduleEngine.getAll(); if (typeof renderSchedules === 'function') renderSchedules(); } catch(e){}
      try { if (typeof AgentScheduleExecutor !== 'undefined') AgentScheduleExecutor.start(); } catch(e){}
      return results;
    }

    if (plan.mode === 'crosschain') {
      if (typeof window !== 'undefined' && typeof window._agentExecuteBridge === 'function') {
        (async function(){
          for(var i = 0; i < plan.rows.length; i++){
            var r = plan.rows[i];
            try {
              var domain = {Base_Sepolia:6, Arbitrum_Sepolia:3, Ethereum_Sepolia:0, Optimism_Sepolia:2, Polygon_Amoy:7}[r._chain] || 6;
              await window._agentExecuteBridge(r._amount, domain, r._chain.replace('_',' '), 'doc_crosschain_' + Date.now() + '_' + i, 5042002, r.address);
              results.success++;
            } catch(e) { results.failed++; results.errors.push('Crosschain for ' + r.address + ': ' + (e.message || 'error')); }
          }
        })();
      } else {
        return { success: 0, failed: plan.rows.length, errors: ['Crosschain engine unavailable'] };
      }
      return results;
    }

    if (plan.mode === 'instant_payment' || plan.mode === 'swap_and_pay') {
      if (typeof AIWallet !== 'undefined' && AIWallet.submitIntent) {
        plan.rows.forEach(function(r){
          try {
            AIWallet.submitIntent({
              op: 'payment', name: r.note || 'Doc Payment',
              amount: r._amount, token: r._token, to: r.address,
              network: r._chain, freq: 'once', source: 'autonoma_doc'
            });
            results.success++;
          } catch(e) { results.failed++; results.errors.push('Payment for ' + r.address + ': ' + (e.message || 'error')); }
        });
        try { if (AIWallet.renderExecutions) AIWallet.renderExecutions(); } catch(e){}
      } else {
        return { success: 0, failed: plan.rows.length, errors: ['AI Smart Wallet unavailable'] };
      }
      return results;
    }

    return results;
  }

  /* ════════════════════════════════════════
     MAIN PARSE FUNCTION
  ════════════════════════════════════════ */
  function parseFile(name, data, isBinary, userMsg) {
    var type = detectFileType(name, data, isBinary);
    var parsed;
    switch (type) {
      case 'csv': parsed = parseCSV(typeof data === 'string' ? data : new TextDecoder().decode(data)); break;
      case 'xlsx': parsed = parseXLSX(data); break;
      case 'txt': parsed = parseTXT(typeof data === 'string' ? data : new TextDecoder().decode(data)); break;
      case 'json': parsed = parseJSON(typeof data === 'string' ? data : new TextDecoder().decode(data)); break;
      default: return { error: 'Unsupported file type: ' + type };
    }

    if (!parsed.rows.length) return { error: 'No valid payment entries found.', errors: parsed.errors };

    if (parsed.rows.length > MAX_PAYMENTS) {
      return { error: 'Too many payments (' + parsed.rows.length + '). Maximum is ' + MAX_PAYMENTS + '.', errors: parsed.errors };
    }

    var classification = classifyOperation(parsed.rows, userMsg || '');
    var summary = buildSummary(parsed, classification);
    var plan = buildOrchestrationPlan(classification, parsed.rows);

    return {
      success: true,
      type: type,
      parsed: parsed,
      summary: summary,
      classification: classification,
      plan: plan,
      rows: parsed.rows
    };
  }

  /* ════════════════════════════════════════
     NLU COMMAND DETECTION — detect document-related commands
  ════════════════════════════════════════ */
  function detectDocumentCommand(msg) {
    var low = (msg||'').toLowerCase();
    var hasDoc = /(payroll|folha|batch|csv|xlsx|json|upload|arquivo|file|document|pay everyone|pagar todos|send all|enviar todos|salary|salario|employee|funcionario|supplier|fornecedor)/i.test(low);
    if (!hasDoc) return null;

    var command = {
      action: 'execute',
      freq: null,
      chain: null,
      swap: false,
      bridge: false,
      split: false
    };

    if (/(schedule|agendar|agenda)/i.test(low)) command.action = 'schedule';
    if (/(recurring|recorrente|every|todo|toda)/i.test(low)) { command.action = 'recurring'; command.freq = /(weekly|semanal)/i.test(low) ? 'weekly' : /(monthly|mensal)/i.test(low) ? 'monthly' : 'daily'; }
    if (/(now|immediately|imediatamente|execute|right now|agora)/i.test(low)) command.action = 'execute';
    if (/(swap|trocar|convert)/i.test(low)) command.swap = true;
    if (/(bridge|ponte|enviar para)/i.test(low)) command.bridge = true;
    if (/(to |para |on |na |network|chain)/i.test(low)) {
      var chainMatch = low.match(/(?:to|para|on|na)\s+(arc|arbitrum|base|ethereum|polygon|optimism)/i);
      if (chainMatch) command.chain = normChain(chainMatch[1]);
    }
    if (/(split|dividir|distribute|repartir|equal|igualmente)/i.test(low)) command.split = true;
    if (/(workflow|payroll|folha de pagamento)/i.test(low)) command.action = 'workflow';

    return command;
  }

  /* ════════════════════════════════════════
     EXPORTS
  ════════════════════════════════════════ */
  var API = {
    parseFile: parseFile,
    parseCSV: parseCSV,
    parseXLSX: parseXLSX,
    parseTXT: parseTXT,
    parseJSON: parseJSON,
    detectFileType: detectFileType,
    classifyOperation: classifyOperation,
    buildSummary: buildSummary,
    buildOrchestrationPlan: buildOrchestrationPlan,
    executePlan: executePlan,
    detectDocumentCommand: detectDocumentCommand,
    detectColumns: detectColumns,
    validateRow: validateRow,
    normToken: normToken,
    normChain: normChain,
    isAddr: isAddr,
    MAX_PAYMENTS: MAX_PAYMENTS
  };

  if (typeof window !== 'undefined') window.AutonomaDocIntel = API;
  else if (typeof globalThis !== 'undefined') globalThis.AutonomaDocIntel = API;
})();