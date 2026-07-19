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
    multisend: { aliases: ['multisend','batch','lote','em massa','múltiplos','multiplos','vários','varios','diversos','many','multiple','csv'], goal: 'multisend', module: 'batch' },
    // Agent identity & authorization
    agent_identity: { aliases: ['who are you','quem é você','quem e voce','what are you','o que você é','o que voce e','tell me about yourself','me fale sobre você','me fale sobre voce','show your identity','sua identidade','seu registro','seja apresentado','se apresente','se apresentar'], goal: 'agent_identity', module: null },
    agent_wallet: { aliases: ['show your wallet','mostre sua carteira','mostrar sua carteira','your wallet address','seu endereço','seu endereco','agent wallet','carteira do agente','qual sua carteira'], goal: 'agent_wallet', module: null },
    agent_auth: { aliases: ['what permissions','quais permissões','quais permissoes','suas permissões','suas permissoes','what can you execute','o que você pode executar','can you execute','pode executar','your permissions','agent permissions','show permissions agent','autorizações','autorizacoes','your limits'], goal: 'agent_auth', module: null },
    agent_pause: { aliases: ['pause agent','pausar agente','pause autonomous','pausar autônomo','pausar autonomo','stop agent','parar agente','disable autonomous','desabilitar autônomo','desabilitar autonomo','pause execution','pausar execução'], goal: 'agent_pause', module: null },
    agent_resume: { aliases: ['resume agent','retomar agente','resume autonomous','retomar autônomo','retomar autonomo','enable autonomous','habilitar autônomo','habilitar autonomo','resume execution','retomar execução','ativar agente','activate agent'], goal: 'agent_resume', module: null },
    agent_revoke: { aliases: ['revoke authorization','revogar autorização','revogar autorizacao','revoke agent','revogar agente','cancel authorization','cancelar autorização','cancelar autorizacao','remove permissions','remover permissões','remover permissoes'], goal: 'agent_revoke', module: null },
    agent_reputation: { aliases: ['show reputation','mostrar reputação','mostrar reputacao','your reputation','sua reputação','sua reputacao','reputation score','pontuação de reputação','agent stats','estatísticas do agente','agent history'], goal: 'agent_reputation', module: null },
    agent_allow: { aliases: ['allow agent','permitir agente','authorize agent','autorizar agente','allow swaps','permitir swaps','allow bridge','permitir bridge','allow payments','permitir pagamentos','grant permission','conceder permissão','conceder permissao','enable agent','ativar agente','allow treasury','permitir tesouraria'], goal: 'agent_allow', module: null },
    agent_limit: { aliases: ['increase daily limit','aumentar limite diário','aumentar limite diario','increase limit','aumentar limite','set max spending','definir gasto máximo','definir gasto maximo','change limit','mudar limite','update limit','atualizar limite'], goal: 'agent_limit', module: null },
    agent_disable_op: { aliases: ['disable bridge','desabilitar bridge','disable swap','desabilitar swap','disable swaps','disable treasury','disable payments','desabilitar pagamentos','desabilitar tesouraria','allow only','permitir apenas','restrict to','restringir para'], goal: 'agent_disable_op', module: null },
    agent_extend: { aliases: ['extend authorization','extender autorização','extender autorizacao','prolongar autorização','renew authorization','renovar autorização'], goal: 'agent_extend', module: null },
    agent_mission: { aliases: ['create mission','criar missão','criar missao','set up mission','configurar missão','new mission','nova missão','add mission','adicionar missão','keep treasury','manter tesouraria','pay suppliers','pagar fornecedores','bridge idle','bridge liquidity','reimburse failed','reembolsar falhas','swap rewards','trocar recompensas','liquidity ratio','taxa de liquidez','deposit excess','depositar excesso','my missions','minhas missões','show missions','mostrar missões','pause mission','pausar missão','resume mission','retomar missão','cancel mission','cancelar missão'], goal: 'agent_mission', module: null },
    agent_treasury: { aliases: ['allocate','alocar','treasury allocation','alocação de tesouraria','allocate usdc','alocar usdc','allocate funds','alocar fundos','agent treasury','tesouraria do agente','show treasury','mostrar tesouraria','treasury balance','saldo da tesouraria','treasury budget','orçamento da tesouraria','treasury limit','limite da tesouraria','pause treasury','pausar tesouraria','resume treasury','retomar tesouraria','withdraw treasury','sacar tesouraria','withdraw unused','sacar não usado','sacar nao usado','create budget','criar orçamento','criar orcamento','treasury report','relatório de tesouraria','treasury performance'], goal: 'agent_treasury', module: null },
    // Financial OS read-only queries
    portfolio_view: { aliases: ['show portfolio','ver portfolio','mostrar portfolio','portfolio intelligence','portfolio overview','how is my portfolio','como está meu portfolio','minha carteira completa','full portfolio','portfolio total','my holdings','meus ativos','my assets','show all balances','mostrar todos os saldos','total value','valor total'], goal: 'portfolio_view', module: null },
    vault_view: { aliases: ['show vault','ver vault','mostrar vault','vault allocations','alocações do vault','vault status','status do vault','locked balance','saldo bloqueado','automation balance','saldo automação','treasury allocation','alocação tesouraria','how much is locked','quanto está bloqueado','operational balance','saldo operacional'], goal: 'vault_view', module: null },
    gas_view: { aliases: ['show gas','ver gas','gas status','status do gas','gas balance','saldo de gas','gas reserve','reserva de gas','gas health','gas manager','how much gas do i have','quanto gas eu tenho','gas fee','taxa de gas','gas left','gas restante'], goal: 'gas_view', module: null },
    schedule_view: { aliases: ['show schedules','ver agendamentos','mostrar agendamentos','my schedules','meus agendamentos','scheduled payments','pagamentos agendados','what is scheduled','o que está agendado','upcoming payments','próximos pagamentos','pending schedules','agendamentos pendentes','show automations','mostrar automações','automation status','status automação'], goal: 'schedule_view', module: null },
    report_view: { aliases: ['generate report','gerar relatório','gerar relatorio','show report','ver relatório','daily report','relatório diário','weekly report','relatório semanal','monthly report','relatório mensal','portfolio report','relatório do portfolio','gas report','relatório de gas','security report','relatório de segurança','financial report','relatório financeiro','export report','exportar relatório'], goal: 'report_view', module: null },
    recommendation_view: { aliases: ['show recommendations','ver recomendações','mostrar recomendações','recommendations','recomendações','what do you recommend','o que você recomenda','what should i do','o que devo fazer','any suggestions','alguma sugestão','insights','análises','analises','what can improve','o que posso melhorar','health score','pontuação','score de saúde'], goal: 'recommendation_view', module: null },
    workflow_view: { aliases: ['show workflows','ver workflows','mostrar workflows','workflow status','status dos workflows','active workflows','workflows ativos','automation workflows','workflows de automação','my workflows','meus workflows'], goal: 'workflow_view', module: null },
    transaction_view: { aliases: ['show transactions','ver transações','mostrar transações','transaction history','histórico de transações','recent transactions','transações recentes','on chain history','histórico on chain','where did my money go','pra onde foi meu dinheiro','what did i spend','o que eu gastei'], goal: 'transaction_view', module: null },
    security_view: { aliases: ['show security','ver segurança','mostrar segurança','security status','status de segurança','permission overview','visão geral de permissões','my permissions','minhas permissões','grants overview','what permissions do i have','quais permissões eu tenho','is my wallet safe','minha carteira está segura','emergency stop','parada de emergência'], goal: 'security_view', module: null },
    spending_capacity: { aliases: ['how much can i spend','quanto posso gastar','spending capacity','capacidade de gasto','spending limit','limite de gasto','daily limit','limite diário','monthly limit','limite mensal','how much can my wallet spend','quanto minha carteira pode gastar','what can i afford','o que posso pagar'], goal: 'spending_capacity', module: null },
    // Execute All Schedules (batch schedule execution via Agent Wallet)
    execute_all_schedules: { aliases: ['execute all schedules','executar todos agendamentos','executar todos os agendamentos','execute all my schedules','execute every schedule','execute pending schedules','executar agendamentos pendentes','run all schedules','rodar todos agendamentos','run all scheduled tasks','execute today schedules','execute today\'s schedules','executar agendamentos de hoje','execute approved schedules','executar agendamentos aprovados','execute failed schedules','executar agendamentos falhos','process all schedules','processar todos agendamentos'], goal: 'execute_all_schedules', module: null },
    // Bridge Turbo (fast CCTP bridge with vault pre-funding)
    bridge_turbo: { aliases: ['bridge turbo','turbo bridge','ponte turbo','fast bridge','ponte rápida','ponte rapida','quick bridge','bridge fast','turbo bridging','cctp fast','cross chain turbo','crosschain turbo'], goal: 'bridge_turbo', module: 'bridge' },
    // Advanced Financial Operations (batch swap + mass payments)
    batch_swap: { aliases: ['batch swap','swap multiple','multiple swaps','batch de swap','swap batch','swap repeatedly','repeat swap','swaps in batch','trocas em lote','multi swap','executar swaps','execute swaps','executar varias trocas','varios swaps','várias trocas','swaps','trocar varias vezes'], goal: 'batch_swap', module: 'swap' },
    mass_payment: { aliases: ['mass payment','batch payment','mass send','payroll batch','batch of payments','lote de pagamentos','pagamento em massa','enviar em lote','pagamento em lote','send multiple payments','multiple payments','varios pagamentos','vários pagamentos','batch de pagamentos','mass pay','muitos pagamentos'], goal: 'mass_payment', module: null },
    crosschain_payroll: { aliases: ['cross chain payroll','crosschain payroll','batch cross chain','cross chain batch','payroll cross chain','folha cross chain','pagamentos cross chain','cross chain mass','mass cross chain','bridge batch','batch bridge','enviar em massa cross','crosschain em massa'], goal: 'crosschain_payroll', module: null }
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
    // Enrich with Financial OS context when available
    try {
      if (typeof FinancialContext !== 'undefined') {
        var finCtx = FinancialContext.getSnapshot();
        state.financialOS = {
          available: !!finCtx,
          portfolio: finCtx.portfolio || null,
          schedules: finCtx.schedules || null,
          security: finCtx.security || null
        };
        if (finCtx.balance) {
          state.balances.agent = finCtx.balance.agentBalances || {};
          state.balances.personal = finCtx.balance.personalBalances || {};
          state.balances.totalUsd = finCtx.balance.totalUsd || 0;
        }
        if (finCtx.security) {
          state.emergencyStop = finCtx.security.emergencyStop || false;
        }
      }
    } catch(e) {}
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
    var chainMap = { arc: 'Arc Testnet', base: 'Base', ethereum: 'Ethereum', sepolia: 'Sepolia', arbitrum: 'Arbitrum', optimism: 'Optimism', polygon: 'Polygon' };
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

    // Count — for batch operations (e.g. "execute 20 swaps", "send 50 payments")
    var countM = low.match(/\b(\d+)\s*(?:swaps|trocas|times|vezes|payments|pagamentos|ops|executions|operações|operações|operações)\b/);
    if(countM) p.count = parseInt(countM[1]);
    // Also detect "N x" or "xN" pattern ("20x", "20 x")
    if(!p.count){
      var xM = low.match(/\b(\d+)\s*x\b/);
      if(xM) p.count = parseInt(xM[1]);
    }

    // For batch operations, distinguish count from amount:
    // "swap 25 USDC to EURC 20 times" → count=20, amount=25
    // "20 swaps of 25 USDC" → count=20, amount=25
    if(p.count && p.amount && p.count > p.amount && (goal === 'batch_swap' || goal === 'mass_payment' || goal === 'crosschain_payroll')){
      // The smaller number is likely the per-item amount, count stays
    }

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
      multisend: 'MULTISEND',
      agent_identity: 'AGENT_IDENTITY', agent_wallet: 'AGENT_WALLET',
      agent_auth: 'AGENT_AUTH', agent_pause: 'AGENT_PAUSE',
      agent_resume: 'AGENT_RESUME', agent_revoke: 'AGENT_REVOKE',
      agent_reputation: 'AGENT_REPUTATION',
      agent_allow: 'AGENT_ALLOW', agent_limit: 'AGENT_LIMIT',
      agent_disable_op: 'AGENT_DISABLE_OP', agent_extend: 'AGENT_EXTEND',
      agent_mission: 'AGENT_MISSION', agent_treasury: 'AGENT_TREASURY',
      // Financial OS read-only queries
      portfolio_view: 'FINANCIAL_OS_PORTFOLIO',
      vault_view: 'FINANCIAL_OS_VAULT',
      gas_view: 'FINANCIAL_OS_GAS',
      schedule_view: 'FINANCIAL_OS_SCHEDULE',
      report_view: 'FINANCIAL_OS_REPORT',
      recommendation_view: 'FINANCIAL_OS_RECOMMENDATION',
      workflow_view: 'FINANCIAL_OS_WORKFLOW',
      transaction_view: 'FINANCIAL_OS_TRANSACTION',
      security_view: 'FINANCIAL_OS_SECURITY',
      spending_capacity: 'FINANCIAL_OS_SPENDING',
      // Execute All Schedules + Bridge Turbo
      execute_all_schedules: 'EXECUTE_ALL_SCHEDULES',
      bridge_turbo: 'BRIDGE_TURBO',
      // Advanced Financial Operations
      batch_swap: 'BATCH_SWAP',
      mass_payment: 'MASS_PAYMENT',
      crosschain_payroll: 'CROSSCHAIN_PAYROLL'
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
