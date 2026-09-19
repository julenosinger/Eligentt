/**
 * Elligentt Execution Queue & History — Phases 7+9
 * Task queue with status tracking + conversational execution memory.
 * Attached to window.ExecutionQueue & window.ExecutionHistory
 */
(function(){
  'use strict';

  /* ════════════════════════════════════════
     EXECUTION QUEUE (Phase 7)
  ════════════════════════════════════════ */
  var QKEY = 'elligentt_exec_queue_v1';
  var queue = [];

  function loadQ(){ try{var r=localStorage.getItem(QKEY);if(r)queue=JSON.parse(r);}catch(e){queue=[];} }
  function saveQ(){ try{localStorage.setItem(QKEY,JSON.stringify(queue));}catch(e){} }

  function enqueue(opts){
    var id = 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2,4);
    var task = {
      id: id, type: opts.type || 'unknown', operation: opts.operation || '',
      amount: opts.amount || 0, asset: opts.asset || 'USDC',
      chain: opts.chain || 'Arc Testnet', destination: opts.destination || '',
      status: 'pending', // pending|running|waiting_permit|waiting_confirm|completed|failed|cancelled
      created: Date.now(), started: null, elapsed: null,
      progress: 0, progressLabel: '', error: null, retryCount: 0,
      permitId: null, result: null, txHash: null
    };
    queue.unshift(task); saveQ();
    return task;
  }

  function updateStatus(id, status, extra){
    var t = queue.find(function(x){return x.id===id;});
    if(!t) return null;
    t.status = status;
    if(status === 'running' && !t.started) t.started = Date.now();
    if(extra){
      if(extra.progress !== undefined){ t.progress = extra.progress; t.progressLabel = extra.progressLabel||''; }
      if(extra.error) t.error = extra.error;
      if(extra.result) t.result = extra.result;
      if(extra.txHash) t.txHash = extra.txHash;
      if(extra.permitId) t.permitId = extra.permitId;
    }
    if(status === 'completed' || status === 'failed' || status === 'cancelled'){
      t.elapsed = t.started ? Date.now() - t.started : 0;
    }
    saveQ();
    return t;
  }

  function retry(id){
    var t = queue.find(function(x){return x.id===id;});
    if(!t || t.status === 'running') return null;
    t.retryCount = (t.retryCount||0) + 1;
    t.status = 'pending'; t.error = null;
    saveQ(); return t;
  }

  function cancel(id){
    var t = queue.find(function(x){return x.id===id;});
    if(!t || t.status === 'running' || t.status === 'completed') return null;
    t.status = 'cancelled'; t.elapsed = t.started ? Date.now() - t.started : 0;
    saveQ(); return t;
  }

  function getQueue(filter){
    var all = queue.slice();
    if(filter === 'active') return all.filter(function(t){return ['pending','running','waiting_permit','waiting_confirm'].indexOf(t.status)!==-1;});
    if(filter === 'completed') return all.filter(function(t){return t.status==='completed';});
    if(filter === 'failed') return all.filter(function(t){return t.status==='failed'||t.status==='cancelled';});
    if(filter) return all.filter(function(t){return t.status===filter;});
    return all;
  }

  function getTask(id){ return queue.find(function(x){return x.id===id;}); }

  function hasPending(){ return queue.some(function(t){return ['pending','running','waiting_permit','waiting_confirm'].indexOf(t.status)!==-1;}); }

  function fmtStatus(status){
    var map = {pending:'Pending',running:'Running',waiting_permit:'Waiting Permit',waiting_confirm:'Waiting Confirm',completed:'Completed',failed:'Failed',cancelled:'Cancelled'};
    return map[status]||status;
  }

  function statusColor(status){
    var map = {pending:'#6b7280',running:'#06F7E9',waiting_permit:'#f59e0b',waiting_confirm:'#f59e0b',completed:'#22c55e',failed:'#ef4444',cancelled:'#6b7280'};
    return map[status]||'#6b7280';
  }

  function fmtElapsed(ms){
    if(!ms) return '—';
    if(ms<1000) return ms+'ms';
    if(ms<60000) return (ms/1000).toFixed(1)+'s';
    if(ms<3600000) return Math.floor(ms/60000)+'m '+Math.floor((ms%60000)/1000)+'s';
    return Math.floor(ms/3600000)+'h '+Math.floor((ms%3600000)/60000)+'m';
  }

  /* ════════════════════════════════════════
     EXECUTION HISTORY / MEMORY (Phase 9)
  ════════════════════════════════════════ */
  var HKEY = 'elligentt_exec_history_v1';
  var history = [];

  function loadH(){ try{var r=localStorage.getItem(HKEY);if(r)history=JSON.parse(r);}catch(e){history=[];} }
  function saveH(){ try{localStorage.setItem(HKEY,JSON.stringify(history).substring(0,50000));}catch(e){} }

  function recordExecution(opts){
    var entry = {
      id: 'exec_' + Date.now() + '_' + Math.random().toString(36).substr(2,4),
      permitId: opts.permitId || '', wallet: (typeof walletAddress!=='undefined'?walletAddress:'unknown'),
      operation: opts.operation || '', amount: opts.amount || 0, asset: opts.asset || 'USDC',
      chain: opts.chain || 'Arc Testnet', contract: opts.contract || '',
      gas: opts.gas || '', duration: opts.duration || 0, result: opts.result || 'success',
      txHash: opts.txHash || '', timestamp: Date.now(), status: opts.status || 'completed',
      displayText: opts.displayText || (opts.operation+' '+opts.amount+' '+opts.asset)
    };
    history.unshift(entry);
    if(history.length > 500) history.length = 500;
    saveH();
    return entry;
  }

  function getHistory(filter, limit){
    var all = history.slice(0, limit||100);
    if(!filter) return all;
    var now = Date.now();
    if(filter === 'today'){
      var today = new Date(); today.setUTCHours(0,0,0,0);
      return all.filter(function(e){return e.timestamp>=today.getTime();});
    }
    if(filter === 'week'){
      return all.filter(function(e){return e.timestamp>=now-604800000;});
    }
    if(filter === 'month'){
      return all.filter(function(e){return e.timestamp>=now-2592000000;});
    }
    if(filter === 'failed'){
      return all.filter(function(e){return e.result==='failed';});
    }
    return all.filter(function(e){return e.operation===filter;}
    );
  }

  function getStats(){
    var all = history;
    var now = Date.now();
    var today = all.filter(function(e){return e.timestamp>=now-86400000;});
    var week = all.filter(function(e){return e.timestamp>=now-604800000;});
    var month = all.filter(function(e){return e.timestamp>=now-2592000000;});
    var byOp = {};
    var byChain = {};
    var totalAmount = 0;
    var failedCount = 0;
    for(var i=0;i<all.length;i++){
      var e = all[i];
      byOp[e.operation] = (byOp[e.operation]||0) + 1;
      byChain[e.chain] = (byChain[e.chain]||0) + 1;
      totalAmount += e.amount||0;
      if(e.result==='failed') failedCount++;
    }
    return {
      total: all.length, today: today.length, week: week.length, month: month.length,
      totalAmount: totalAmount, failedCount: failedCount,
      topOp: Object.entries(byOp).sort(function(a,b){return b[1]-a[1];}).slice(0,3),
      topChain: Object.entries(byChain).sort(function(a,b){return b[1]-a[1];}).slice(0,3)
    };
  }

  function queryHistory(question){
    var low = question.toLowerCase();
    var stats = getStats();
    if(/\b(yesterday|ontem)\b/.test(low)){ var yesterday = history.filter(function(e){return e.timestamp>=Date.now()-172800000&&e.timestamp<Date.now()-86400000;}); return {type:'query',answer:'Yesterday you executed '+yesterday.length+' operations.',data:yesterday};}
    if(/\b(this month|monthly|esse m[eê]s|mensal)\b/.test(low)){ return {type:'query',answer:'This month: '+stats.month+' operations totaling '+stats.totalAmount.toFixed(2)+' in volume.',stats:stats};}
    if(/\b(this week|weekly|essa semana|semanal)\b/.test(low)){ return {type:'query',answer:'This week: '+stats.week+' operations.',stats:stats};}
    if(/\b(failed|falha|falhou|falha de)\b/.test(low)){ return {type:'query',answer:stats.failedCount+' operations failed. Out of '+stats.total+' total.',stats:stats};}
    if(/\b(how much|quanto)\b.*\b(bridge|bridge)\b/.test(low)){ var bridged = history.filter(function(e){return e.operation==='bridge';}).reduce(function(s,e){return s+(e.amount||0);},0); return {type:'query',answer:'Total bridged: '+bridged.toFixed(2)+' this month.'};}
    return {type:'query',answer:'Total executions: '+stats.total+' | This month: '+stats.month+' | Failed: '+stats.failedCount,stats:stats};
  }

  function fmtDate(ts){ return new Date(ts).toLocaleString(); }

  loadQ(); loadH();

  window.ExecutionQueue = {
    enqueue:enqueue, updateStatus:updateStatus, retry:retry, cancel:cancel,
    getQueue:getQueue, getTask:getTask, hasPending:hasPending,
    fmtStatus:fmtStatus, statusColor:statusColor, fmtElapsed:fmtElapsed
  };

  window.ExecutionHistory = {
    recordExecution:recordExecution, getHistory:getHistory,
    getStats:getStats, queryHistory:queryHistory, fmtDate:fmtDate
  };
})();
