/**
 * Autonoma NLU — Natural Language Understanding Engine
 * Decomposes user messages into structured entities for financial operations.
 * Attached to window.AutonomaNLU. Never modifies existing modules.
 */
(function(){
  'use strict';

  /* ════════════════════════════════════════
     CONFIGURATION
  ════════════════════════════════════════ */
  var TOKENS = {
    'usdc': { symbol: 'USDC', aliases: ['usdc','usd','dollar','dollars','dólar','dolares','dólares','dolar','buck','bucks'] },
    'eurc': { symbol: 'EURC', aliases: ['eurc','eur','euro','euros'] },
    'cirbtc': { symbol: 'cirBTC', aliases: ['cirbtc','cir btc','cirbtc','btc','bitcoin'] },
    'eth': { symbol: 'ETH', aliases: ['eth','ether','ethereum'] }
  };

  var CHAINS = {
    'arc': { name: 'Arc Testnet', aliases: ['arc','testnet','arc testnet'] },
    'ethereum': { name: 'Ethereum', aliases: ['ethereum','eth','sepolia','mainnet'] },
    'base': { name: 'Base', aliases: ['base','base sepolia'] },
    'arbitrum': { name: 'Arbitrum', aliases: ['arbitrum','arb','arbitrum sepolia'] },
    'optimism': { name: 'Optimism', aliases: ['optimism','op','optimism sepolia'] },
    'polygon': { name: 'Polygon', aliases: ['polygon','poly','amoy'] }
  };

  var TIMEZONES = {
    'utc': { name: 'UTC', offset: 0, aliases: ['utc','gmt','z'] },
    'brt': { name: 'BRT', offset: -3, aliases: ['brt','brasilia','brasília','brazil','sao paulo','são paulo'] },
    'est': { name: 'EST', offset: -5, aliases: ['est','eastern','new york','ny'] },
    'pst': { name: 'PST', offset: -8, aliases: ['pst','pacific','los angeles','la'] },
    'cet': { name: 'CET', offset: 1, aliases: ['cet','central european','berlin','paris'] },
    'ist': { name: 'IST', offset: 5.5, aliases: ['ist','india'] },
    'cst': { name: 'CST', offset: 8, aliases: ['cst','china','beijing','shanghai'] },
    'jst': { name: 'JST', offset: 9, aliases: ['jst','japan','tokyo'] },
    'aest': { name: 'AEST', offset: 10, aliases: ['aest','australia','sydney'] }
  };

  var MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  var MONTHS_PT = ['janeiro','fevereiro','março','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  var DAYS_EN = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  var DAYS_PT = ['domingo','segunda','terça','terca','quarta','quinta','sexta','sabado','sábado'];

  var INTENT_MAP = {
    'payment': { intents: ['SEND_PAYMENT','CROSS_CHAIN'], aliases: ['send','pay','payment','transfer','enviar','mandar','pagar','pagamento','remeter','depositar'] },
    'swap': { intents: ['SWAP_EXECUTE'], aliases: ['swap','trade','exchange','convert','trocar','troca','converter','cambiar','comprar','vender'] },
    'bridge': { intents: ['BRIDGE','BRIDGE_TURBO'], aliases: ['bridge','ponte','cross','cross-chain','crosschain','bridging'] },
    'schedule': { intents: ['CREATE_SCHEDULE'], aliases: ['schedule','agendar','agendamento','recurring','recorrente','automate','automatizar','programar'] },
    'balance': { intents: ['QUERY_BALANCE'], aliases: ['balance','saldo','wallet','carteira','holdings','portfolio','how much','quanto tenho','meu saldo'] },
    'liquidity': { intents: ['QUERY_LIQUIDITY','ADD_LIQUIDITY','REMOVE_LIQUIDITY'], aliases: ['liquidity','liquidez','pool','lp','position','posição','add liquidity','remove liquidity'] },
    'treasury': { intents: ['QUERY_TREASURY'], aliases: ['treasury','tesouraria','tesouro','vault','cofre','protocolo','protocol','reservas','reserves'] },
    'invoice': { intents: ['CREATE_INVOICE'], aliases: ['invoice','fatura','bill','cobrança','cobranca','receipt','recibo'] },
    'multisend': { intents: ['MULTISEND','MASS_PAYMENT'], aliases: ['multisend','batch','lote','massa','múltiplos','multiplos','vários','varios','bulk','csv'] },
    'report': { intents: ['FINANCIAL_OS_REPORT'], aliases: ['report','relatório','relatorio','generate report','gerar relatório','monthly report','weekly report','daily report'] },
    'history': { intents: ['QUERY_HISTORY'], aliases: ['history','histórico','historico','transactions','transações','transacoes','activity','atividade'] },
    'execute': { intents: ['EXECUTE_SCHEDULES','EXECUTE_ALL_SCHEDULES'], aliases: ['execute','executar','run','rodar','trigger','disparar','process','processar'] },
    'pause': { intents: ['AGENT_PAUSE'], aliases: ['pause','pausar','stop','parar','disable','desabilitar'] },
    'resume': { intents: ['AGENT_RESUME'], aliases: ['resume','retomar','enable','habilitar','ativar','activate'] },
    'help': { intents: ['HELP'], aliases: ['help','ajuda','what can you do','o que você faz','how to','como usar','capabilities','comandos','commands'] },
    'greeting': { intents: ['GREETING'], aliases: ['hello','hi','hey','ola','olá','oi','bom dia','boa tarde','boa noite','good morning','good afternoon'] }
  };

  /* ════════════════════════════════════════
     NORMALIZATION
  ════════════════════════════════════════ */
  function normalize(msg){
    if (!msg || typeof msg !== 'string') return '';
    return msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function stripAccents(s){
    return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  /* ════════════════════════════════════════
     AMOUNT EXTRACTION
  ════════════════════════════════════════ */
  function extractAmount(msg){
    var low = msg.toLowerCase();
    var words = low.split(/[\s,.;:!?]+/).filter(Boolean);
    var amt = null;

    // "half" / "metade"
    if (/\b(half|metade)\b/i.test(low)) {
      amt = null; // ambiguous, needs context
      return { value: null, unit: 'half', isAmbiguous: true };
    }

    // "all" / "tudo" / "everything" / "entire balance"
    if (/\b(all|tudo|everything|entire|total)\b.*\b(balance|saldo|funds?|usdc|eurc|cirbtc)\b/i.test(low) ||
        /\b(balance|saldo|funds?|usdc|eurc|cirbtc)\b.*\b(all|tudo|everything|entire|total)\b/i.test(low)) {
      return { value: null, unit: 'all', isFullBalance: true };
    }

    // Standard numeric: 1, 1.5, 10, 1000, 0.25
    var numM = low.match(/(\d+(?:[.,]\d+)?)/);
    if (numM) {
      amt = parseFloat(numM[1].replace(',', '.'));
      return { value: amt, unit: 'raw' };
    }

    // Written numbers (one, two, three... up to twenty)
    var numWords = {
      'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,'seven':7,'eight':8,'nine':9,'ten':10,
      'eleven':11,'twelve':12,'thirteen':13,'fourteen':14,'fifteen':15,'sixteen':16,'seventeen':17,'eighteen':18,'nineteen':19,'twenty':20,
      'um':1,'uma':1,'dois':2,'duas':2,'três':3,'tres':3,'quatro':4,'cinco':5,'seis':6,'sete':7,'oito':8,'nove':9,'dez':10,
      'onze':11,'doze':12,'treze':13,'quatorze':14,'quinze':15,'dezesseis':16,'dezessete':17,'dezoito':18,'dezenove':19,'vinte':20,
      'thirty':30,'forty':40,'fifty':50,'sixty':60,'seventy':70,'eighty':80,'ninety':90,'hundred':100,
      'trinta':30,'quarenta':40,'cinquenta':50,'sessenta':60,'setenta':70,'oitenta':80,'noventa':90,'cem':100,'cento':100,
      'thousand':1000,'mil':1000,'million':1000000,'milhão':1000000,'milhao':1000000
    };
    for (var w = 0; w < words.length; w++) {
      if (numWords[words[w]] && words[w].length > 2) {
        return { value: numWords[words[w]], unit: 'written' };
      }
    }

    return { value: null };
  }

  /* ════════════════════════════════════════
     TOKEN EXTRACTION
  ════════════════════════════════════════ */
  function extractToken(msg){
    var low = msg.toLowerCase();
    var keys = Object.keys(TOKENS);
    var best = null;
    var bestLen = 0;
    for (var i = 0; i < keys.length; i++) {
      var entry = TOKENS[keys[i]];
      for (var j = 0; j < entry.aliases.length; j++) {
        var alias = entry.aliases[j];
        var re = new RegExp('\\b' + alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        if (re.test(msg) && alias.length > bestLen) {
          best = entry.symbol;
          bestLen = alias.length;
          break;
        }
      }
    }
    return best;
  }

  /* ════════════════════════════════════════
     ADDRESS EXTRACTION
  ════════════════════════════════════════ */
  function extractAddresses(msg){
    var matches = msg.match(/0x[a-fA-F0-9]{40}/g);
    if (!matches) return { primary: null, all: [] };
    return {
      primary: matches[0],
      all: matches,
      count: matches.length
    };
  }

  function isValidAddress(addr){
    return /^0x[a-fA-F0-9]{40}$/.test(addr);
  }

  /* ════════════════════════════════════════
     CHAIN EXTRACTION
  ════════════════════════════════════════ */
  function extractChain(msg){
    var low = msg.toLowerCase();
    var keys = Object.keys(CHAINS);
    var result = { from: null, to: null, single: null };

    // "from X" / "de X"
    var fromM = low.match(/(?:from|de|da|do)\s+(\w+(?:\s+\w+)?)/i);
    if (fromM) {
      var fromCand = fromM[1].toLowerCase();
      for (var i = 0; i < keys.length; i++) {
        var entry = CHAINS[keys[i]];
        for (var j = 0; j < entry.aliases.length; j++) {
          if (fromCand === entry.aliases[j] || fromCand.indexOf(entry.aliases[j]) !== -1) {
            result.from = keys[i];
            break;
          }
        }
        if (result.from) break;
      }
    }

    // "to X" / "para X" / "na X" / "na rede X"
    var toM = low.match(/(?:to|para|na|na rede|on)\s+(\w+(?:\s+\w+)?)/i);
    if (toM) {
      var toCand = toM[1].toLowerCase();
      for (var k = 0; k < keys.length; k++) {
        var toEntry = CHAINS[keys[k]];
        for (var l = 0; l < toEntry.aliases.length; l++) {
          if (toCand === toEntry.aliases[l] || toCand.indexOf(toEntry.aliases[l]) !== -1) {
            result.to = keys[k];
            break;
          }
        }
        if (result.to) break;
      }
    }

    // Single chain mention (no from/to context)
    if (!result.from && !result.to) {
      for (var m = 0; m < keys.length; m++) {
        var sEntry = CHAINS[keys[m]];
        for (var n = 0; n < sEntry.aliases.length; n++) {
          if (sEntry.aliases[n].length >= 3) {
            var sRe = new RegExp('\\b' + sEntry.aliases[n].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
            if (sRe.test(low)) {
              result.single = keys[m];
              break;
            }
          }
        }
        if (result.single) break;
      }
    }

    return result;
  }

  /* ════════════════════════════════════════
     DATE EXTRACTION
  ════════════════════════════════════════ */
  function extractDate(msg){
    var low = stripAccents(msg.toLowerCase());
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // "today" / "hoje" / "now" / "agora"
    if (/\b(today|hoje|now|agora)\b/i.test(low)) {
      return { date: today, type: 'absolute', label: 'today' };
    }

    // "tomorrow" / "amanhã" / "amanha"
    if (/\b(tomorrow|amanh[ãa])\b/i.test(low)) {
      var tomorrow = new Date(today.getTime() + 86400000);
      return { date: tomorrow, type: 'absolute', label: 'tomorrow' };
    }

    // "day after tomorrow" / "depois de amanhã"
    if (/\bday\s+after\s+tomorrow\b/i.test(low) || /\bdepois de amanh[ãa]\b/i.test(low)) {
      var dayAfter = new Date(today.getTime() + 172800000);
      return { date: dayAfter, type: 'absolute', label: 'day after tomorrow' };
    }

    // "next [day name]" / "próximo(a) [day]" / "proximo(a) [day]"
    var nextRe = /\b(next|pr[oó]xim[oa]|pr[oó]ximo)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|domingo|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado)/i;
    var nextM = low.match(nextRe);
    if (nextM) {
      var dayName = nextM[2].toLowerCase();
      var targetDay = getDayIndex(dayName);
      if (targetDay >= 0) {
        var nextDate = getNextDay(today, targetDay, true);
        return { date: nextDate, type: 'absolute', label: 'next ' + DAYS_EN[targetDay] };
      }
    }

    // "this [day name]" / "esta [day]" / "esse [day]"
    var thisRe = /\b(this|est[ea]|ess[ea]?)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|domingo|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado)/i;
    var thisM = low.match(thisRe);
    if (thisM) {
      var thisDayName = thisM[2].toLowerCase();
      var thisTargetDay = getDayIndex(thisDayName);
      if (thisTargetDay >= 0) {
        var thisDate = getNextDay(today, thisTargetDay, false);
        return { date: thisDate, type: 'absolute', label: 'this ' + DAYS_EN[thisTargetDay] };
      }
    }

    // Standalone day name: "[day]" (assumes this/next closest)
    var dayRe = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|domingo|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado)\b/i;
    var dayM = low.match(dayRe);
    if (dayM) {
      var standaloneDay = getDayIndex(dayM[1].toLowerCase());
      if (standaloneDay >= 0) {
        var closest = getNextDay(today, standaloneDay, false);
        // If the closest day is today, it means today; if past this week, next
        if (closest.getTime() === today.getTime()) {
          return { date: closest, type: 'absolute', label: DAYS_EN[standaloneDay] };
        }
        return { date: closest, type: 'absolute', label: DAYS_EN[standaloneDay] };
      }
    }

    // Date patterns: "July 30", "July 30 2026", "30 July 2026"
    var dateRe1 = /\b(january|february|march|april|may|june|july|august|september|october|november|december|janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?\b/i;
    var d1M = low.match(dateRe1);
    if (d1M) {
      var monthIdx = getMonthIndex(d1M[1].toLowerCase());
      if (monthIdx >= 0) {
        var day = parseInt(d1M[2]);
        var year = d1M[3] ? parseInt(d1M[3]) : now.getFullYear();
        if (day >= 1 && day <= 31) {
          var d = new Date(year, monthIdx, day);
          if (!isNaN(d.getTime())) {
            return { date: d, type: 'absolute', label: d1M[0] };
          }
        }
      }
    }

    // Date patterns: "30 July 2026", "30 de Julho de 2026"
    var dateRe2 = /\b(\d{1,2})\s+(?:de\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+(?:de\s+)?(\d{4}))?\b/i;
    var d2M = low.match(dateRe2);
    if (d2M) {
      var mIdx2 = getMonthIndex(d2M[2].toLowerCase());
      if (mIdx2 >= 0) {
        var day2 = parseInt(d2M[1]);
        var year2 = d2M[3] ? parseInt(d2M[3]) : now.getFullYear();
        if (day2 >= 1 && day2 <= 31) {
          var d2 = new Date(year2, mIdx2, day2);
          if (!isNaN(d2.getTime())) {
            return { date: d2, type: 'absolute', label: d2M[0] };
          }
        }
      }
    }

    // Numeric date: "31/12/2026", "12/31/2026", "31-12-2026"
    var dateRe3 = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/;
    var d3M = low.match(dateRe3);
    if (d3M) {
      var p1 = parseInt(d3M[1]), p2 = parseInt(d3M[2]), p3 = parseInt(d3M[3]);
      var yr = p3 < 100 ? (p3 + 2000) : p3;
      // Try DD/MM/YYYY first
      if (p1 <= 31 && p2 <= 12) {
        var d3 = new Date(yr, p2 - 1, p1);
        if (!isNaN(d3.getTime()) && d3.getDate() === p1) {
          return { date: d3, type: 'absolute', label: d3M[0] };
        }
      }
      // Try MM/DD/YYYY
      if (p1 <= 12 && p2 <= 31) {
        var d4 = new Date(yr, p1 - 1, p2);
        if (!isNaN(d4.getTime()) && d4.getDate() === p2) {
          return { date: d4, type: 'absolute', label: d3M[0] };
        }
      }
    }

    // "in X days" / "em X dias"
    var inDaysRe = /\bin\s+(\d+)\s*(day|dias?|dia)\b/i;
    var inDaysM = low.match(inDaysRe);
    if (inDaysM) {
      var days = parseInt(inDaysM[1]);
      var futureDate = new Date(today.getTime() + days * 86400000);
      return { date: futureDate, type: 'relative', label: 'in ' + days + ' days', offsetDays: days };
    }

    // "in X weeks" / "em X semanas"
    var inWeeksRe = /\bin\s+(\d+)\s*(week|semana)\b/i;
    var inWeeksM = low.match(inWeeksRe);
    if (inWeeksM) {
      var weeks = parseInt(inWeeksM[1]);
      var futureWeek = new Date(today.getTime() + weeks * 7 * 86400000);
      return { date: futureWeek, type: 'relative', label: 'in ' + weeks + ' weeks', offsetDays: weeks * 7 };
    }

    // "next week" / "próxima semana"
    if (/\bnext\s+week\b/i.test(low) || /\bpr[oó]xima\s+semana\b/i.test(low)) {
      var nextWeek = new Date(today.getTime() + 7 * 86400000);
      return { date: nextWeek, type: 'absolute', label: 'next week' };
    }

    // "next month" / "próximo mês"
    if (/\bnext\s+month\b/i.test(low) || /\bpr[oó]ximo\s+m[eê]s\b/i.test(low)) {
      var nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return { date: nextMonth, type: 'absolute', label: 'next month' };
    }

    return { date: null };
  }

  function getDayIndex(name){
    var day = DAYS_EN.indexOf(name);
    if (day >= 0) return day;
    day = DAYS_PT.indexOf(name);
    if (day >= 0) return day;
    // Handle "terça" vs "terca"
    if (name === 'terca' || name === 'terça') return 2;
    if (name === 'sabado' || name === 'sábado') return 6;
    return -1;
  }

  function getNextDay(fromDate, targetDay, forceNext){
    var currentDay = fromDate.getDay();
    var diff = targetDay - currentDay;
    if (diff < 0) diff += 7;
    if (diff === 0 && !forceNext) return new Date(fromDate);
    if (diff === 0 && forceNext) diff = 7;
    return new Date(fromDate.getTime() + diff * 86400000);
  }

  function getMonthIndex(name){
    var idx = MONTHS.indexOf(name);
    if (idx >= 0) return idx;
    idx = MONTHS_PT.indexOf(name);
    if (idx >= 0) return idx;
    if (name === 'marco' || name === 'março') return 2;
    if (name === 'julho') return 6;
    return -1;
  }

  /* ════════════════════════════════════════
     TIME EXTRACTION
  ════════════════════════════════════════ */
  function extractTime(msg){
    var low = stripAccents(msg.toLowerCase());

    // "at midnight" / "à meia-noite"
    if (/\bat midnight\b/i.test(low) || /\b[àa] meia[-\s]?noite\b/i.test(low)) {
      return { hours: 0, minutes: 0, type: 'absolute', label: 'midnight' };
    }

    // "at noon" / "ao meio-dia"
    if (/\bat noon\b/i.test(low) || /\bao meio[-\s]?dia\b/i.test(low) || /\bmeio dia\b/i.test(low)) {
      return { hours: 12, minutes: 0, type: 'absolute', label: 'noon' };
    }

    // "at 15:00" / "at 15:30" / "às 15:00" / "as 15h" / "at 15" / "às 15"
    var timeRe1 = /(?:at|[àa]s?)\s*(\d{1,2})(?::(\d{2}))?(?:\s*(h|hrs?|horas?))?(?:\s*(am|pm))?\b/i;
    var t1M = low.match(timeRe1);
    if (t1M) {
      var hrs = parseInt(t1M[1]);
      var mins = t1M[2] ? parseInt(t1M[2]) : 0;
      var meridian = (t1M[4] || '').toLowerCase();
      if (meridian === 'pm' && hrs < 12) hrs += 12;
      if (meridian === 'am' && hrs === 12) hrs = 0;
      if (hrs >= 0 && hrs <= 23 && mins >= 0 && mins <= 59) {
        return { hours: hrs, minutes: mins, type: 'absolute', label: hrs + ':' + (mins < 10 ? '0' : '') + mins };
      }
    }

    // Standalone time: "15:00", "3pm", "3 pm", "3:30pm"
    var timeRe2 = /\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i;
    var t2M = low.match(timeRe2);
    if (t2M) {
      var h2 = parseInt(t2M[1]);
      var m2 = parseInt(t2M[2]);
      var mer2 = (t2M[3] || '').toLowerCase();
      if (mer2 === 'pm' && h2 < 12) h2 += 12;
      if (mer2 === 'am' && h2 === 12) h2 = 0;
      if (h2 >= 0 && h2 <= 23 && m2 >= 0 && m2 <= 59) {
        return { hours: h2, minutes: m2, type: 'absolute', label: h2 + ':' + (m2 < 10 ? '0' : '') + m2 };
      }
    }

    // "at 3pm", "3pm", "3 am"
    var timeRe3 = /\b(\d{1,2})\s*(am|pm)\b/i;
    var t3M = low.match(timeRe3);
    if (t3M) {
      var h3 = parseInt(t3M[1]);
      var mer3 = t3M[2].toLowerCase();
      if (mer3 === 'pm' && h3 < 12) h3 += 12;
      if (mer3 === 'am' && h3 === 12) h3 = 0;
      if (h3 >= 0 && h3 <= 23) {
        return { hours: h3, minutes: 0, type: 'absolute', label: h3 + ':00' };
      }
    }

    // "in 10 minutes" / "em 10 minutos"
    var inMinRe = /\bin\s+(\d+)\s*(minute|minuto)s?\b/i;
    var inMinM = low.match(inMinRe);
    if (inMinM) {
      var minsOffset = parseInt(inMinM[1]);
      var futureTime = new Date(Date.now() + minsOffset * 60000);
      return { hours: futureTime.getHours(), minutes: futureTime.getMinutes(), type: 'relative', label: 'in ' + minsOffset + ' min', offsetMinutes: minsOffset };
    }

    // "in 2 hours" / "em 2 horas"
    var inHrRe = /\bin\s+(\d+)\s*(hour|hora)s?\b/i;
    var inHrM = low.match(inHrRe);
    if (inHrM) {
      var hrsOffset = parseInt(inHrM[1]);
      var futureHr = new Date(Date.now() + hrsOffset * 3600000);
      return { hours: futureHr.getHours(), minutes: futureHr.getMinutes(), type: 'relative', label: 'in ' + hrsOffset + ' hrs', offsetMinutes: hrsOffset * 60 };
    }

    return { hours: null, minutes: null };
  }

  /* ════════════════════════════════════════
     TIMEZONE EXTRACTION
  ════════════════════════════════════════ */
  function extractTimezone(msg){
    var low = stripAccents(msg.toLowerCase());
    var keys = Object.keys(TIMEZONES);

    // "UTC+2", "UTC-3", "GMT+5:30", "UTC+5:30"
    var utcOffRe = /(?:utc|gmt)\s*([+-]\s*\d{1,2}(?::(\d{2}))?)\b/i;
    var offM = low.match(utcOffRe);
    if (offM) {
      var sign = offM[1].replace(/\s/g, '').charAt(0) === '+' ? 1 : -1;
      var offHr = parseInt(offM[1].replace(/[^\d]/g, '').substring(0, 2));
      var offMin = offM[2] ? parseInt(offM[2]) : 0;
      var offset = sign * (offHr + offMin / 60);
      var label = 'UTC' + (sign > 0 ? '+' : '') + offHr + (offMin ? ':' + (offMin < 10 ? '0' : '') + offMin : '');
      return { name: label, offset: offset, label: label };
    }

    // Named timezones
    for (var i = 0; i < keys.length; i++) {
      var entry = TIMEZONES[keys[i]];
      for (var j = 0; j < entry.aliases.length; j++) {
        var re = new RegExp('\\b' + entry.aliases[j].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        if (re.test(low)) {
          return { name: entry.name, offset: entry.offset, label: entry.name };
        }
      }
    }

    return null;
  }

  /* ════════════════════════════════════════
     RECURRENCE EXTRACTION
  ════════════════════════════════════════ */
  function extractRecurrence(msg){
    var low = stripAccents(msg.toLowerCase());

    // Daily
    if (/\b(daily|di[aá]ri[oa]|diariamente|cada dia|todo dia|every day|each day|once a day|per day|a day)\b/i.test(low))
      return { type: 'daily', label: 'Daily' };

    // Weekly
    if (/\b(weekly|semanal|semanalmente|cada semana|toda semana|every week|each week|once a week|per week|a week|every 7 days)\b/i.test(low))
      return { type: 'weekly', label: 'Weekly' };

    // Bi-weekly
    if (/\b(bi[-\s]?weekly|fortnightly|every (two|2) weeks|every other week|quinzenal|cada 15|cada quinze|cada duas semanas|every 14 days|every fourteen days)\b/i.test(low))
      return { type: 'biweekly', label: 'Bi-weekly' };

    // Monthly
    if (/\b(monthly|mensal|mensalmente|cada m[eê]s|todo m[eê]s|every month|each month|once a month|per month|a month)\b/i.test(low))
      return { type: 'monthly', label: 'Monthly' };

    // Day-of-week pattern: "every sunday/friday/etc" / "toda segunda/terça/etc"
    var dayRecurRe = /\b(every|toda|todo)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|domingo|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado)\b/i;
    var dayRecurM = low.match(dayRecurRe);
    if (dayRecurM) {
      var dayIdx = getDayIndex(dayRecurM[2].toLowerCase());
      if (dayIdx >= 0) {
        return { type: 'weekly', label: 'Weekly on ' + DAYS_EN[dayIdx], dayOfWeek: dayIdx };
      }
    }

    // Generic "every"/"recurring" without specific cadence
    if (/\b(every|each|todo|toda|cada|recurring|recorrente)\b/i.test(low))
      return { type: 'ambiguous', label: 'Recurring (needs cadence)' };

    return null;
  }

  /* ════════════════════════════════════════
     ACTION / INTENT EXTRACTION
  ════════════════════════════════════════ */
  function detectAction(msg){
    var low = stripAccents(msg.toLowerCase());

    // Detect the primary action verb
    var actionPatterns = [
      { action: 'send', re: /\b(send|enviar|mandar|transfer|transferir|remeter|depositar)\b/i },
      { action: 'pay', re: /\b(pay|pagar|pagamento|payment)\b/i },
      { action: 'swap', re: /\b(swap|trade|exchange|convert|trocar|troca|converter|cambiar|comprar|vender)\b/i },
      { action: 'bridge', re: /\b(bridge|ponte|cross|cross[- ]?chain|bridging|bridged)\b/i },
      { action: 'schedule', re: /\b(schedule|agendar|agendamento|programar|automate|automatizar|recurring|recorrente)\b/i },
      { action: 'execute', re: /\b(execute|executar|run|rodar|trigger|disparar|process|processar)\b/i },
      { action: 'pause', re: /\b(pause|pausar|stop|parar|disable|desabilitar)\b/i },
      { action: 'resume', re: /\b(resume|retomar|enable|habilitar|ativar|activate)\b/i },
      { action: 'create', re: /\b(create|criar|gerar|make|fazer|fa[çc]a)\b/i },
      { action: 'show', re: /\b(show|ver|mostrar|display|exibir|see)\b/i },
      { action: 'generate', re: /\b(generate|gerar|criar)\b/i },
      { action: 'allocate', re: /\b(allocate|alocar|allocate|distribute|distribuir)\b/i },
      { action: 'split', re: /\b(split|dividir|divide|distribute)\b/i }
    ];

    var action = null;
    for (var i = 0; i < actionPatterns.length; i++) {
      if (actionPatterns[i].re.test(low)) {
        action = actionPatterns[i].action;
        break;
      }
    }
    return action;
  }

  function detectIntentType(msg, entities){
    var low = stripAccents(msg.toLowerCase());
    var keys = Object.keys(INTENT_MAP);
    var scores = [];

    for (var i = 0; i < keys.length; i++) {
      var entry = INTENT_MAP[keys[i]];
      var score = 0;
      var matched = [];
      for (var j = 0; j < entry.aliases.length; j++) {
        var alias = entry.aliases[j];
        var re = new RegExp('\\b' + alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
        if (re.test(low)) {
          score += alias.length;
          matched.push(alias);
        }
      }
      if (score > 0) {
        scores.push({ type: keys[i], intents: entry.intents, score: score, matches: matched });
      }
    }

    scores.sort(function(a, b){ return b.score - a.score; });

    // Second pass: entity-based intent refinement
    if (entities.amount && entities.token && entities.address && entities.action === 'send') {
      // Has payment essentials → likely a payment
      if (!scores.some(function(s){ return s.type === 'payment'; })) {
        scores.unshift({ type: 'payment', intents: ['SEND_PAYMENT'], score: 30, matches: ['entity-based'], inferred: true });
      }
    }

    if (entities.amount && entities.token && !entities.address && (entities.action === 'send' || entities.action === 'pay')) {
      // Payment intent but missing address
      if (!scores.some(function(s){ return s.type === 'payment'; })) {
        scores.unshift({ type: 'payment', intents: ['SEND_PAYMENT'], score: 25, matches: ['entity-based'], inferred: true });
      }
    }

    if (entities.amount && entities.token && entities.action === 'swap') {
      if (!scores.some(function(s){ return s.type === 'swap'; })) {
        scores.unshift({ type: 'swap', intents: ['SWAP_EXECUTE'], score: 30, matches: ['entity-based'], inferred: true });
      }
    }

    if (entities.recurrence && entities.action === 'schedule') {
      if (!scores.some(function(s){ return s.type === 'schedule'; })) {
        scores.unshift({ type: 'schedule', intents: ['CREATE_SCHEDULE'], score: 30, matches: ['entity-based'], inferred: true });
      }
    }

    return scores;
  }

  function detectFinancialOperation(msg){
    var low = stripAccents(msg.toLowerCase());
    var ops = [];

    if (/\b(payroll|salary|sal[áa]rio|folha|equipe|team|staff|employee|funcion[áa]rio)\b/i.test(low))
      ops.push({ type: 'payroll', label: 'Payroll' });
    if (/\b(swap|troca|exchange|convert)\b/i.test(low))
      ops.push({ type: 'swap', label: 'Token Swap' });
    if (/\b(bridge|ponte|cross[-\s]?chain|cctp)\b/i.test(low))
      ops.push({ type: 'bridge', label: 'Bridge' });
    if (/\b(treasury|tesouraria|vault|allocate|alocar)\b/i.test(low))
      ops.push({ type: 'treasury', label: 'Treasury Management' });
    if (/\b(report|relat[oó]rio|relatorio)\b/i.test(low))
      ops.push({ type: 'report', label: 'Report Generation' });
    if (/\b(recurring|recorrente|schedule|agendar|every|todo dia|toda semana|todo m[eê]s)\b/i.test(low))
      ops.push({ type: 'schedule', label: 'Scheduled Operation' });
    if (/\b(workflow|fluxo|automa[cç][aã]o|automate|automation)\b/i.test(low))
      ops.push({ type: 'workflow', label: 'Workflow' });
    if (/\b(split|dividir|distribute|entre)\b/i.test(low))
      ops.push({ type: 'split', label: 'Split Payment' });
    if (/\b(batch|mass|m[uú]ltipl|v[áa]rios|lote|bulk|csv)\b/i.test(low))
      ops.push({ type: 'batch', label: 'Batch Operation' });
    if (/\b(all|everything|tudo|entire)\b/i.test(low) && /\b(schedules?|agendamentos?|automation)\b/i.test(low))
      ops.push({ type: 'execute_all', label: 'Execute All' });

    return ops;
  }

  /* ════════════════════════════════════════
     ENTITY DECOMPOSITION — Main Pipeline
  ════════════════════════════════════════ */
  function decompose(msg){
    if (!msg || typeof msg !== 'string') return { intent_type: null, entities: {} };

    var normalized = normalize(msg);

    // Extract all entities
    var amountResult = extractAmount(msg);
    var token = extractToken(msg);
    var addresses = extractAddresses(msg);
    var chainInfo = extractChain(msg);
    var dateInfo = extractDate(msg);
    var timeInfo = extractTime(msg);
    var timezone = extractTimezone(msg);
    var recurrence = extractRecurrence(msg);
    var action = detectAction(msg);

    var entities = {
      amount: amountResult.value,
      amountMeta: { isFullBalance: amountResult.isFullBalance || false, isAmbiguous: amountResult.isAmbiguous || false, unit: amountResult.unit || 'raw' },
      token: token,
      address: addresses.primary,
      addresses: addresses.all,
      addressCount: addresses.count || 0,
      chain: chainInfo.single,
      fromChain: chainInfo.from,
      toChain: chainInfo.to,
      date: dateInfo.date,
      dateLabel: dateInfo.label || null,
      dateType: dateInfo.type || null,
      time: timeInfo.hours !== null ? timeInfo : null,
      timezone: timezone,
      recurrence: recurrence,
      action: action,
      executionType: 'single'
    };

    // Determine execution type
    if (entities.recurrence) {
      entities.executionType = 'recurring';
    } else if (entities.addressCount > 1 || (amountResult.value && /\b(batch|mass|m[uú]ltipl|lote|bulk|v[áa]rios)\b/i.test(normalized))) {
      entities.executionType = 'batch';
    } else if (/\b(workflow|fluxo|automa[cç][aã]o)\b/i.test(normalized)) {
      entities.executionType = 'workflow';
    }

    // Detect intent
    var intentScores = detectIntentType(msg, entities);
    var financialOps = detectFinancialOperation(msg);

    // Build full result
    var result = {
      original: msg,
      normalized: normalized,
      intent_type: intentScores.length > 0 ? intentScores[0].type : null,
      intent_scores: intentScores,
      action: action,
      entities: entities,
      financial_operations: financialOps,
      confidence: intentScores.length > 0 ? Math.min(intentScores[0].score * 3, 95) : 0
    };

    // Detect missing required information
    result.missing = getMissing(result);
    result.clarifications = getClarification(result.missing, result.entities, result.intent_type);

    return result;
  }

  /* ════════════════════════════════════════
     MISSING ENTITY DETECTION
  ════════════════════════════════════════ */
  function getMissing(result){
    var entities = result.entities;
    var intent = result.intent_type;
    var missing = [];

    // Always track these base entities
    if (!entities.amount && !entities.amountMeta.isFullBalance) {
      if (intent === 'payment' || intent === 'swap' || intent === 'bridge' || intent === 'schedule' || intent === 'multisend') {
        missing.push({ field: 'amount', label: 'amount', question: 'What amount? (e.g. "100 USDC")', priority: 'high' });
      }
    }

    if (!entities.token && (intent === 'payment' || intent === 'swap' || intent === 'bridge')) {
      missing.push({ field: 'token', label: 'token', question: 'Which token? (USDC, EURC, cirBTC)', priority: 'high' });
    }

    if (!entities.address && intent === 'payment' && entities.addresses.length === 0) {
      missing.push({ field: 'address', label: 'recipient address', question: 'Who would you like to send it to? (0x...)', priority: 'high' });
    }

    if (!entities.date && intent === 'schedule') {
      missing.push({ field: 'date', label: 'date', question: 'When should this be scheduled? (e.g. "tomorrow", "next Friday", "July 30")', priority: 'high' });
    }

    if (intent === 'multisend' && entities.addresses.length === 0) {
      missing.push({ field: 'address', label: 'recipient addresses', question: 'Which addresses should receive the payment?', priority: 'high' });
    }

    if (intent === 'bridge' && !entities.toChain && !entities.fromChain) {
      missing.push({ field: 'chain', label: 'destination chain', question: 'Which chain should I bridge to? (e.g. "to Arbitrum", "to Base")', priority: 'medium' });
    }

    if (intent === 'swap' && !entities.token) {
      missing.push({ field: 'from_token', label: 'source token', question: 'Which token do you want to swap from?', priority: 'high' });
    }

    if (entities.recurrence && entities.recurrence.type === 'ambiguous') {
      missing.push({ field: 'recurrence', label: 'recurrence pattern', question: 'How often? Daily, weekly, monthly?', priority: 'medium' });
    }

    // If no intent detected at all
    if (!intent) {
      missing.push({ field: 'intent', label: 'intent', question: 'What would you like to do? (send, swap, bridge, schedule...)', priority: 'high' });
    }

    return missing;
  }

  /* ════════════════════════════════════════
     INTELLIGENT CLARIFICATION
  ════════════════════════════════════════ */
  function getClarification(missing, entities, intentType){
    if (!missing || missing.length === 0) return null;

    var highPriority = missing.filter(function(m){ return m.priority === 'high'; });
    var mediumPriority = missing.filter(function(m){ return m.priority === 'medium'; });

    // For payments: ask the most important missing field
    if (intentType === 'payment') {
      if (!entities.address) {
        return {
          intro: 'I understand you want to send ' + (entities.amount ? entities.amount + ' ' : '') + (entities.token || 'tokens') + '.',
          question: 'Who would you like to send it to?',
          missing: ['address'],
          example: 'You can provide a wallet address like 0x...'
        };
      }
      if (!entities.amount && !entities.amountMeta.isFullBalance) {
        return {
          intro: 'I understand you want to send ' + (entities.token || 'tokens') + '.',
          question: 'How much would you like to send?',
          missing: ['amount'],
          example: 'e.g. "100 USDC" or "0.5 EURC"'
        };
      }
      if (!entities.token) {
        return {
          intro: 'I understand you want to send ' + (entities.amount || '') + '.',
          question: 'Which token?',
          missing: ['token'],
          example: 'USDC, EURC, or cirBTC'
        };
      }
    }

    // For scheduling: ask date/time if missing
    if (intentType === 'schedule') {
      if (!entities.date) {
        return {
          intro: 'I understand you want to schedule' + (entities.amount ? ' a payment of ' + entities.amount + ' ' + (entities.token || 'USDC') : ' something') + '.',
          question: 'When should this be scheduled?',
          missing: ['date'],
          example: 'e.g. "tomorrow at 15 UTC", "next Friday", "every Monday at 10am"'
        };
      }
      if (!entities.recurrence && !/\b(every|recurring|recorrente)\b/i.test(entities.dateLabel || '')) {
        return {
          intro: 'I understand you want to schedule for ' + (entities.dateLabel || entities.date) + '.',
          question: 'Is this a one-time payment or recurring?',
          missing: ['recurrence'],
          example: 'e.g. "one time", "daily", "weekly", "monthly"'
        };
      }
    }

    // For swaps
    if (intentType === 'swap') {
      if (!entities.amount) {
        return {
          intro: 'I understand you want to swap ' + (entities.token || 'tokens') + '.',
          question: 'How much would you like to swap?',
          missing: ['amount'],
          example: 'e.g. "100 USDC" or "0.5 EURC"'
        };
      }
    }

    // For bridge
    if (intentType === 'bridge') {
      if (!entities.toChain) {
        return {
          intro: 'I understand you want to bridge ' + (entities.amount ? entities.amount + ' ' + (entities.token || '') : 'assets') + '.',
          question: 'Which chain should I bridge to?',
          missing: ['toChain'],
          example: 'Supported: Arbitrum, Base, Ethereum, Optimism, Polygon'
        };
      }
    }

    // Generic fallback
    var questions = [];
    if (highPriority.length > 0) {
      questions = highPriority;
    } else if (mediumPriority.length > 0) {
      questions = mediumPriority;
    }

    if (questions.length > 0) {
      return {
        intro: 'I need a few more details to help you:',
        question: questions[0].question,
        missing: questions.map(function(q){ return q.field; }),
        allMissing: questions,
        example: 'You can provide multiple details at once, e.g. "send 100 USDC to 0x... tomorrow at 15 UTC"'
      };
    }

    return null;
  }

  /* ════════════════════════════════════════
     VALIDATION
  ════════════════════════════════════════ */
  function validate(entities){
    var errors = [];
    var warnings = [];

    if (entities.address && !isValidAddress(entities.address)) {
      errors.push({ field: 'address', message: 'Invalid address format. Must be 0x followed by 40 hex characters.' });
    }

    if (entities.addresses) {
      for (var i = 0; i < entities.addresses.length; i++) {
        if (!isValidAddress(entities.addresses[i])) {
          errors.push({ field: 'addresses[' + i + ']', message: 'Invalid address at position ' + (i + 1) + ': ' + entities.addresses[i] });
        }
      }
    }

    if (entities.amount !== null && entities.amount !== undefined && entities.amount <= 0 && !entities.amountMeta.isFullBalance) {
      errors.push({ field: 'amount', message: 'Amount must be greater than zero.' });
    }

    if (entities.date && entities.date instanceof Date && entities.date < new Date(new Date().setHours(0, 0, 0, 0))) {
      warnings.push({ field: 'date', message: 'The specified date is in the past. Are you sure?' });
    }

    if (entities.amount !== null && entities.amount > 100000) {
      warnings.push({ field: 'amount', message: 'Large amount detected (' + entities.amount + '). Please verify carefully.' });
    }

    return { valid: errors.length === 0, errors: errors, warnings: warnings };
  }

  /* ════════════════════════════════════════
     SMART PARAMETER ENRICHMENT
     Called by autProcess to enhance the message before
     existing pipeline processes it.
  ════════════════════════════════════════ */
  function enrich(msg){
    var decomposed = decompose(msg);

    // If we detected entities that can improve existing pipeline understanding,
    // return enriched context
    if (decomposed.clarifications) {
      return {
        type: 'clarify',
        decomposed: decomposed,
        clarification: decomposed.clarifications
      };
    }

    return {
      type: 'enriched',
      decomposed: decomposed,
      enhanced: {
        amount: decomposed.entities.amount,
        token: decomposed.entities.token,
        address: decomposed.entities.address,
        chain: decomposed.entities.chain,
        toChain: decomposed.entities.toChain,
        fromChain: decomposed.entities.fromChain,
        recurrence: decomposed.entities.recurrence ? decomposed.entities.recurrence.type : null,
        date: decomposed.entities.date,
        time: decomposed.entities.time,
        timezone: decomposed.entities.timezone,
        action: decomposed.entities.action,
        executionType: decomposed.entities.executionType,
        intentType: decomposed.intent_type,
        intentScores: decomposed.intent_scores
      }
    };
  }

  /* ════════════════════════════════════════
     BUILD CANONICAL COMMAND
     Reconstruct a clean, unambiguous command from
     extracted entities for the existing pipeline.
  ════════════════════════════════════════ */
  function buildCanonical(entities, intentType){
    var parts = [];

    if (intentType === 'payment') {
      parts.push('send');
      if (entities.amount) parts.push(entities.amount.toString());
      if (entities.token) parts.push(entities.token);
      if (entities.address) parts.push('to ' + entities.address);
      if (entities.toChain) parts.push('on ' + entities.toChain);
      return parts.join(' ');
    }

    if (intentType === 'swap') {
      parts.push('swap');
      if (entities.amount) parts.push(entities.amount.toString());
      if (entities.token) parts.push(entities.token);
      return parts.join(' ');
    }

    if (intentType === 'bridge') {
      parts.push('bridge');
      if (entities.amount) parts.push(entities.amount.toString());
      if (entities.token) parts.push(entities.token);
      if (entities.toChain) parts.push('to ' + entities.toChain);
      return parts.join(' ');
    }

    if (intentType === 'schedule') {
      parts.push('schedule');
      if (entities.amount) parts.push(entities.amount.toString());
      if (entities.token) parts.push(entities.token);
      if (entities.recurrence) parts.push(entities.recurrence.type);
      if (entities.dateLabel) parts.push(entities.dateLabel);
      return parts.join(' ');
    }

    return null;
  }

  /* ════════════════════════════════════════
     EXPORT
  ════════════════════════════════════════ */
  window.AutonomaNLU = {
    version: '1.0.0',
    decompose: decompose,
    enrich: enrich,
    validate: validate,
    getMissing: getMissing,
    getClarification: getClarification,
    buildCanonical: buildCanonical,
    // Individual extractors
    extractAmount: extractAmount,
    extractToken: extractToken,
    extractAddresses: extractAddresses,
    extractChain: extractChain,
    extractDate: extractDate,
    extractTime: extractTime,
    extractTimezone: extractTimezone,
    extractRecurrence: extractRecurrence,
    detectAction: detectAction,
    detectIntentType: detectIntentType,
    detectFinancialOperation: detectFinancialOperation,
    isValidAddress: isValidAddress
  };
})();
