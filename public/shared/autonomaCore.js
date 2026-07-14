/**
 * Autonoma Core Intelligence — AI Agent Layer
 * NLU, Goal Extraction, Reasoning, Confidence, Tool Router, World State, Memory
 * Sits ABOVE existing modules. Never duplicates business logic.
 * Attached to window.AutonomaCore
 */
(function(){
  'use strict';

  /* ════════════════════════════════════════
     WORD MAP — Semantic NLU (replaces rigid regex)
  ════════════════════════════════════════ */
  var WORD_MAP = {
    swap: { aliases: ['swap','trocar','troca','troque','convert','converter','exchange','trade','troco','converta','cambiar','buy','comprar','sell','vender','obter','get','pegue','pegar','adquirir','quero','preciso de','converta para','trocar por'], goal: 'swap', module: 'swap' },
    bridge: { aliases: ['bridge','ponte','bridging','bridged','cross','cruz','cross-chain','crosschain','enviar para','mover','mover para','transferir para','mandar para','levar para'], goal: 'bridge', module: 'bridge' },
    crosschain: { aliases: ['cross-chain payment','crosschain payment','cross chain payment','xchain','x-chain','cross-chain send','crosschain send','pagamento cross','enviar cross','cross-chain pay','pagamento entre redes','envio entre redes'], goal: 'crosschain', module: 'xchain' },
    payment: { aliases: ['send','enviar','mandar','pagar','pagamento','pay','transfer','transferir','remeter','depositar'], goal: 'payment', module: 'send' },
    balance: { aliases: ['balance','saldo','carteira','wallet','quanto tenho','quanto eu tenho','meu saldo','minha carteira','holdings','portfolio','balanço','balanco','posição','posicao','funds','fundos','what do i have','my balance','show balance','show my','ver saldo','ver carteira','mostrar saldo','mostrar carteira'], goal: 'balance', module: null },
    permission: { aliases: ['permission','permissão','permissao','permit','permits','permissões','permissoes','show permissions','ver permissões','minhas permissões','my permissions','revoke','revogar','cancelar permissão','disable','aumentar limite','increase limit','allowance'], goal: 'permission', module: null },
    schedule: { aliases: ['schedule','agendar','agendamento','recurring','recorrente','automatico','automático','todo dia','toda semana','todo mês','every day','every week','every month','daily','weekly','monthly','programar','automatizar'], goal: 'schedule', module: 'schedule' },
    treasury: { aliases: ['treasury','tesouraria','tesouro','vault','cofre','protocolo','protocol','reservas','reserves','liquidez','liquidity','fees','taxas','revenue','receita'], goal: 'treasury', module: 'treasury' },
    history: { aliases: ['history','histórico','historico','transactions','transações','transacoes','activity','atividade','recent','recentes','log','registro','record','executed','executado','what did you','o que você fez','o que voce fez','quanto bridge','how much bridge'], goal: 'history', module: null },
    help: { aliases: ['help','ajuda','what can you do','o que você faz','o que voce faz','como usar','how to','capabilities','funcionalidades','comandos','commands','what is possible','o que é possível'], goal: 'help', module: null },
    hello: { aliases: ['hello','hi','hey','ola','olá','oi','bom dia','boa tarde','boa noite','good morning','good afternoon','good evening','hey there','eai','e aí'], goal: 'greeting', module: null },
    liquidity: { aliases: ['liquidity','liquidez','pool','lp','posição','position','add liquidity','adicionar liquidez','remove liquidity','remover liquidez','withdraw liquidity','sacar liquidez'], goal: 'liquidity', module: 'pool' },
    invoice: { aliases: ['invoice','fatura','bill','cobrança','cobranca','billing','nota fiscal','receipt','recibo'], goal: 'invoice', module: 'invoices' },
    multisend: { aliases: ['multisend','batch','lote','em massa','múltiplos','multiplos','vários','varios','diversos','many','multiple','csv'], goal: 'multisend', module: 'batch' }
  };

  /* ════════════════════════════════════════
     CONVERSATION MEMORY
  ════════════════════════════════════════ */
  var MEM_KEY = 'elligentt_core_memory_v1';
  var memory = { currentGoal: null, currentParams: {}, history: [], lastInteraction: 0, userPreferences: {} };
  function loadMem(){ try { var r = localStorage.getItem(MEM_KEY); if(r) memory = JSON.parse(r); } catch(e){} }
  function saveMem(){ try { localStorage.setItem(MEM_KEY, JSON.stringify(memory)); } catch(e){} }
  function resetGoal(){ memory.currentGoal = null; memory.currentParams = {}; saveMem(); }
  function setGoal(goal, params){ memory.currentGoal = goal; memory.currentParams = params || {}; memory.lastInteraction = Date.now(); saveMem(); }
  function getGoal(){ return memory.currentGoal; }
  function goalActive(){ return memory.currentGoal && (Date.now() - memory.lastInteraction) < 300000; }
  function addToHistory(entry){ memory.history.unshift({ text: entry, ts: Date.now() }); if(memory.history.length > 50) memory.history.length = 50; saveMem(); }

  /* ════════════════════════════════════════
     WORLD STATE — Live environment snapshot
  ════════════════════════════════════════ */
  function getWorldState(){
    var state = {
      wallet: typeof walletAddress !== 'undefined' ? walletAddress : null,
      chain: typeof activeChainId !== 'undefined' ? activeChainId : 'unknown',
      chainName: typeof activeNetworkName !== 'undefined' ? activeNetworkName : 'Arc Testnet',
      balances: {},
      activePermits: typeof PermitEngine !== 'undefined' ? PermitEngine.getPermitCount() : 0,
      sessionWallet: typeof PermitEngine !== 'undefined' ? PermitEngine.getSessionWalletAddress() : null,
      vaultStatus: 'unknown',
      bridgeAvailable: true,
      gasEstimate: 'N/A'
    };
    if(typeof document !== 'undefined'){
      var balEl = document.getElementById('sb-bal');
      if(balEl) state.balances.USDC = balEl.textContent || '—';
    }
    return state;
  }

  /* ════════════════════════════════════════
     NLU — Semantic understanding (replaces regex)
  ════════════════════════════════════════ */
  function understand(msg){
    var low = msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    var tokens = low.split(/[\s,.;:!?]+/).filter(Boolean);
    var scores = [];
    var goalKeys = Object.keys(WORD_MAP);

    for(var i = 0; i < goalKeys.length; i++){
      var entry = WORD_MAP[goalKeys[i]];
      var score = 0;
      var matchedAliases = [];
      for(var j = 0; j < entry.aliases.length; j++){
        if(low.indexOf(entry.aliases[j]) !== -1){
          score += entry.aliases[j].length; // longer matches = stronger
          matchedAliases.push(entry.aliases[j]);
        }
      }
      if(score > 0){
        scores.push({ goal: entry.goal, module: entry.module, score: score, matches: matchedAliases });
      }
    }

    scores.sort(function(a,b){ return b.score - a.score; });
    return scores;
  }

  /* ════════════════════════════════════════
     PARAMETER EXTRACTION
  ════════════════════════════════════════ */
  function extractParams(msg, goal){
    var p = {};
    var low = msg.toLowerCase();

    // Amount
    var amtM = low.match(/(\d+(?:[.,]\d+)?)/);
    if(amtM) p.amount = parseFloat(amtM[1].replace(',','.'));

    // Token
    var tokenMap = {
      'usdc': 'USDC', 'usd': 'USDC', 'dollar': 'USDC', 'dollars': 'USDC', 'dólar': 'USDC', 'dolares': 'USDC', 'dólares': 'USDC',
      'eurc': 'EURC', 'eur': 'EURC', 'euro': 'EURC', 'euros': 'EURC',
      'cirbtc': 'cirBTC', 'btc': 'cirBTC', 'bitcoin': 'cirBTC',
      'eth': 'ETH', 'ether': 'ETH', 'ethereum': 'ETH'
    };
    var tokenKeys = Object.keys(tokenMap);
    for(var i = 0; i < tokenKeys.length; i++){
      if(low.indexOf(tokenKeys[i]) !== -1){ p.token = tokenMap[tokenKeys[i]]; break; }
    }

    // Recipient address
    var addrM = msg.match(/0x[a-fA-F0-9]{40}/);
    if(addrM) p.address = addrM[0];

    // Chain / Network
    var chainMap = { arc: 'Arc Testnet', base: 'Base', ethereum: 'Ethereum', sepolia: 'Sepolia', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon', robinhood: 'Robinhood' };
    var fromM = low.match(/from\s+(\w+)/), toM = low.match(/to\s+(\w+)/), paraM = low.match(/para\s+(?:a\s+)?(\w+)/);
    if(fromM && chainMap[fromM[1]]) p.fromChain = chainMap[fromM[1]];
    if(toM && chainMap[toM[1]]) p.toChain = chainMap[toM[1]];
    if(!p.toChain && paraM && chainMap[paraM[1]]) p.toChain = chainMap[paraM[1]];

    // Description
    var labelM = msg.match(/(?:called|named|label|para|for|descri[çc][aã]o|description)\s+["']?([^"']{2,40})["']?/i);
    if(labelM) p.label = labelM[1].trim();

    // Recurrence
    if(/\b(daily|di[aá]rio|todo dia|every day)\b/.test(low)) p.recurrence = 'daily';
    else if(/\b(weekly|semanal|toda semana|every week)\b/.test(low)) p.recurrence = 'weekly';
    else if(/\b(monthly|mensal|todo m[êe]s|every month)\b/.test(low)) p.recurrence = 'monthly';

    return p;
  }

  /* ════════════════════════════════════════
     MISSING PARAMETER DETECTION
  ════════════════════════════════════════ */
  function getRequiredParams(goal){
    var map = {
      swap: ['amount','token'],
      bridge: ['amount'],
      payment: ['amount','address'], crosschain: ['amount','address'],
      schedule: ['amount'],
      liquidity: ['amount'],
      invoice: [],
      multisend: []
    };
    return map[goal] || [];
  }

  function findMissing(params, goal){
    var required = getRequiredParams(goal);
    var missing = [];
    for(var i = 0; i < required.length; i++){
      if(!params[required[i]]) missing.push(required[i]);
    }
    return missing;
  }

  function missingLabel(key){
    var map = { amount: 'amount', token: 'token', address: 'recipient address' };
    return map[key] || key;
  }

  /* ════════════════════════════════════════
     CONFIDENCE ENGINE
  ════════════════════════════════════════ */
  function calculateConfidence(scores, params, goal){
    if(!scores || scores.length === 0) return 0;
    var topScore = scores[0].score;
    var hasAmount = !!params.amount;
    var hasToken = !!params.token;
    var confidence = 50;
    if(topScore > 10) confidence += 20;
    if(hasAmount) confidence += 15;
    if(hasToken) confidence += 10;
    if(params.address) confidence += 10;
    if(params.toChain) confidence += 10;
    if(topScore > 20) confidence += 5;
    return Math.min(confidence, 98);
  }

  /* ════════════════════════════════════════
     REASONING — Validates before acting
  ════════════════════════════════════════ */
  function reason(goal, params, state, confidence){
    var checks = [];
    var warnings = [];

    // Wallet
    if(state.wallet) checks.push({ check: 'Wallet connected', ok: true });
    else { checks.push({ check: 'Wallet connected', ok: false }); warnings.push('Connect your wallet first.'); }

    // Balance
    if(params.amount && params.amount > 0 && params.token){
      checks.push({ check: 'Amount specified: ' + params.amount + ' ' + params.token, ok: true });
    }

    // Permit
    if(state.activePermits > 0){
      checks.push({ check: 'Active permits: ' + state.activePermits, ok: true });
    } else if(goal !== 'balance' && goal !== 'help' && goal !== 'greeting'){
      checks.push({ check: 'No active permits', ok: false });
      warnings.push('A permit will be requested for this operation.');
    }

    // Risk
    var riskLevel = 'LOW';
    if(params.amount > 10000) riskLevel = 'HIGH';
    else if(params.amount > 1000) riskLevel = 'MEDIUM';
    if(riskLevel !== 'LOW'){
      checks.push({ check: 'Risk: ' + riskLevel, ok: riskLevel === 'LOW' });
    }

    // Confidence threshold
    if(confidence < 40){
      warnings.push('I\'m not sure I understood correctly. Could you clarify?');
    }

    return {
      allOk: warnings.length === 0,
      checks: checks,
      warnings: warnings,
      riskLevel: riskLevel,
      shouldAskClarification: confidence < 40,
      canProceed: warnings.length === 0 || (warnings.length === 1 && warnings[0].indexOf('permit') !== -1)
    };
  }

  /* ════════════════════════════════════════
     LEARNING — Track user preferences
  ════════════════════════════════════════ */
  function learn(goal, params){
    if(params.token) memory.userPreferences.favToken = params.token;
    if(params.fromChain) memory.userPreferences.favChain = params.fromChain;
    if(params.toChain) memory.userPreferences.favDestChain = params.toChain;
    memory.userPreferences.lastGoal = goal;
    saveMem();
  }

  function getPreferences(){
    return memory.userPreferences || {};
  }

  /* ════════════════════════════════════════
     GOAL TO INTENT MAPPING (for existing handlers)
  ════════════════════════════════════════ */
  function goalToIntent(goal){
    var map = {
      swap: 'SWAP_EXECUTE',       bridge: 'BRIDGE', crosschain: 'CROSS_CHAIN', payment: 'SEND_PAYMENT',
      balance: 'QUERY_BALANCE', permission: 'PERM_QUERY', schedule: 'CREATE_SCHEDULE',
      treasury: 'QUERY_TREASURY', history: 'QUERY_HISTORY', help: 'HELP',
      greeting: 'GREETING', liquidity: 'QUERY_LIQUIDITY', invoice: 'CREATE_INVOICE',
      multisend: 'MULTISEND'
    };
    return map[goal] || 'DEFAULT';
  }

  /* ════════════════════════════════════════
     MAIN PROCESSING PIPELINE
  ════════════════════════════════════════ */
  function process(msg, callbacks){
    var R = callbacks.R;
    var autonomaSendQuick = callbacks.autonomaSendQuick;
    var _executeIntent = callbacks._executeIntent;
    var _ctxActive = callbacks._ctxActive;
    var _ctxSet = callbacks._ctxSet;
    var _ctxParams = callbacks._ctxParams;

    // 1. Check conversation memory for multi-turn
    if(goalActive()){
      var existingGoal = getGoal();
      var existingParams = memory.currentParams || {};
      var newParams = extractParams(msg, existingGoal);
      var merged = {};
      var keys = Object.keys(existingParams);
      for(var i = 0; i < keys.length; i++){ merged[keys[i]] = existingParams[keys[i]]; }
      var newKeys = Object.keys(newParams);
      for(var j = 0; j < newKeys.length; j++){ if(newParams[newKeys[j]]) merged[newKeys[j]] = newParams[newKeys[j]]; }

      // Check for cancel
      if(/\b(cancel|stop|abort|para|parar|desistir|esquece|esque[cç]a)\b/.test(msg.toLowerCase())){
        resetGoal();
        return R.intro('Context cleared. How can I help you?');
      }

      var missing = findMissing(merged, existingGoal);
      if(missing.length > 0){
        setGoal(existingGoal, merged);
        return R.intro('I\'m still working on your <strong style="color:#06F7E9">' + existingGoal + '</strong>.') +
          R.card(R.head('question','Missing Information',{text: missing.length + ' needed',cls:'pending'}),
            missing.map(function(m){ return R.row(missingLabel(m), 'Please provide the ' + missingLabel(m), 'yellow'); }).join('') +
            '<div style="font-size:9px;color:var(--muted2);margin-top:6px">Or say <em>"cancel"</em> to start over.</div>');
      }

      // All params present — route to existing handler
      addToHistory(existingGoal + ': ' + JSON.stringify(merged).substring(0, 100));
      learn(existingGoal, merged);
      resetGoal();
      var intent = goalToIntent(existingGoal);
      return { type: 'intent', intent: intent, params: merged, msg: msg };
    }

    // 2. NLU
    var scores = understand(msg);

    // 3. No understanding — fallback
    if(!scores || scores.length === 0){
      addToHistory('fallback: ' + msg.substring(0, 60));
      // Check for simple greeting patterns that might have been missed
      if(/\b(hi|hello|hey|ola|oi|bom dia|boa tarde|boa noite)\b/.test(msg.toLowerCase())){
        return { type: 'intent', intent: 'GREETING', params: {}, msg: msg };
      }
      return { type: 'fallback', msg: msg };
    }

    var topScore = scores[0];
    var goal = topScore.goal;
    var params = extractParams(msg, goal);
    var confidence = calculateConfidence(scores, params, goal);
    var state = getWorldState();
    var reasoning = reason(goal, params, state, confidence);

    // 4. Low confidence — ask clarification
    if(reasoning.shouldAskClarification){
      return R.intro('I\'m not sure I understood. Did you mean <strong>' + goal + '</strong>?') +
        '<div style="display:flex;gap:6px;margin-top:8px">' +
        '<button class="aut-act confirm" onclick="' + (typeof autonomaSendQuick === 'function' ? "autonomaSendQuick('" + goal.replace(/'/g,"\\'") + "')" : '') + '">Yes, ' + goal + '</button>' +
        '<button class="aut-act" onclick="autonomaSendQuick(\'help\')">Something else</button></div>';
    }

    // 5. Missing required params — ask only what's needed
    var missing = findMissing(params, goal);
    if(missing.length > 0 && goal !== 'hello' && goal !== 'help' && goal !== 'greeting'){
      setGoal(goal, params);
      addToHistory(goal + ' (incomplete): ' + msg.substring(0, 60));
      var friendlyGoal = { swap: 'swap', bridge: 'bridge', crosschain: 'cross-chain payment', payment: 'payment', balance: 'balance', schedule: 'scheduling', liquidity: 'liquidity' }[goal] || goal;
      return R.intro('I\'d love to help with your <strong style="color:#06F7E9">' + friendlyGoal + '</strong>.') +
        R.card(R.head('question','Just a few details',{text: missing.length + ' needed',cls:'pending'}),
          missing.map(function(m){ return R.row(missingLabel(m), 'I need the ' + missingLabel(m) + ' to proceed', 'yellow'); }).join('') +
          (params.amount ? R.row('Amount','<strong>' + params.amount + '</strong> ✓','green') : '') +
          (params.token ? R.row('Token','<strong>' + params.token + '</strong> ✓','green') : ''),
          R.actions(
            { icon: 'x', label: 'Cancel', cls: 'danger', action: "autonomaSendQuick('cancel')" }
          ));
    }

    // 6. Everything ready — route to existing handler
    addToHistory(goal + ': ' + msg.substring(0, 60));
    learn(goal, params);
    resetGoal();
    var finalIntent = goalToIntent(goal);
    return { type: 'intent', intent: finalIntent, params: params, msg: msg, confidence: confidence, reasoning: reasoning };
  }

  loadMem();

  window.AutonomaCore = {
    process: process,
    understand: understand,
    extractParams: extractParams,
    getWorldState: getWorldState,
    reason: reason,
    calculateConfidence: calculateConfidence,
    goalToIntent: goalToIntent,
    findMissing: findMissing,
    resetGoal: resetGoal,
    getGoal: getGoal,
    goalActive: goalActive,
    getPreferences: getPreferences,
    WORD_MAP: WORD_MAP
  };
})();
