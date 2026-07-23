/**
 * Elligentt AI Recommendations — Phase 8
 * Proactive automation suggestions based on usage patterns.
 * Attached to window.AIRecommendations
 */
(function(){
  'use strict';

  var RECS_KEY = 'elligentt_ai_recs_v1';
  var shownRecs = {};
  var lastCheck = 0;

  function load(){ try{var r=localStorage.getItem(RECS_KEY);if(r)shownRecs=JSON.parse(r);}catch(e){shownRecs={};} }
  function save(){ try{localStorage.setItem(RECS_KEY,JSON.stringify(shownRecs));}catch(e){} }

  function markShown(id){ shownRecs[id]=Date.now(); save(); }
  function wasShown(id){ return !!shownRecs[id]; }

  function generate(){
    var recs = [];
    var now = Date.now();

    // 1. Pattern: frequent bridge to same chain
    try{
      if(typeof ExecutionHistory !== 'undefined'){
        var hist = ExecutionHistory.getHistory('bridge', 50);
        if(hist.length >= 3){
          var chains = {};
          for(var i=0;i<hist.length;i++){
            var c = hist[i].chain || 'Unknown';
            chains[c] = (chains[c]||0) + 1;
          }
          var top = Object.keys(chains).sort(function(a,b){return chains[b]-chains[a];})[0];
          if(top && chains[top] >= 3){
            var id = 'bridge_'+top.replace(/\s/g,'_');
            if(!wasShown(id)){
              recs.push({
                id: id, type: 'suggest_recurring', priority: 'medium',
                text: 'I noticed you bridge to '+top+' frequently ('+chains[top]+' times).',
                suggestion: 'Create a recurring bridge permit for '+top+'?',
                action: 'schedule bridge to '+top+' weekly'
              });
            }
          }
        }
      }
    } catch(e){}

    // 2. Pattern: same swap pair
    try{
      if(typeof ExecutionHistory !== 'undefined'){
        var swaps = ExecutionHistory.getHistory('swap', 30);
        if(swaps.length >= 3){
          if(!wasShown('swap_pattern')){
            recs.push({
              id: 'swap_pattern', type: 'suggest_automation', priority: 'low',
              text: 'I noticed all your swaps use the same token pairs.',
              suggestion: 'Would you like me to automate your swap routine?',
              action: 'show permissions'
            });
          }
        }
      }
    } catch(e){}

    // 3. Pattern: daily operations at same time
    try{
      if(typeof ExecutionHistory !== 'undefined'){
        var all = ExecutionHistory.getHistory(null, 100);
        if(all.length >= 5){
          var hours = {};
          for(var j=0;j<all.length;j++){
            var h = new Date(all[j].timestamp).getUTCHours();
            hours[h] = (hours[h]||0) + 1;
          }
          var peakH = Object.keys(hours).sort(function(a,b){return hours[b]-hours[a];})[0];
          if(peakH && hours[peakH] >= 3 && !wasShown('time_'+peakH)){
            recs.push({
              id: 'time_'+peakH, type: 'suggest_schedule', priority: 'low',
              text: 'You execute most operations around '+peakH+':00 UTC.',
              suggestion: 'Schedule recurring operations for this time window?',
              action: 'schedule a daily payment'
            });
          }
        }
      }
    } catch(e){}

    // 4. Permit usage analysis
    try{
      if(typeof PermitEngine !== 'undefined'){
        var active = PermitEngine.getActive();
        if(active.length === 0 && !wasShown('no_permits')){
          recs.push({
            id: 'no_permits', type: 'suggest_permit', priority: 'high',
            text: 'You have no active permits. Each financial operation requires a permit.',
            suggestion: 'Would you like to set up a session permit?',
            action: 'create a session permit for 500 USDC'
          });
        }
      }
    } catch(e){}

    // 5. Scheduled permits due
    try{
      if(typeof PermitEngine !== 'undefined'){
        var due = PermitEngine.getScheduledDue();
        for(var k=0;k<due.length;k++){
          var s = due[k];
          var sid = 'due_'+s.id;
          if(!wasShown(sid)){
            recs.push({
              id: sid, type: 'remind_scheduled', priority: 'high',
              text: 'Scheduled permit "'+s.name+'" is due for execution.',
              suggestion: 'Execute now or adjust the schedule?',
              action: 'show permissions'
            });
          }
        }
      }
    } catch(e){}

    // Limit recommendations to 3 to avoid spam
    return recs.slice(0,3);
  }

  function getFresh(force){
    var now = Date.now();
    if(!force && now-lastCheck < 300000 && shownRecs) return lastRecs;
    lastRecs = generate(); lastCheck = now;
    return lastRecs;
  }

  var lastRecs = [];

  load();

  window.AIRecommendations = {
    generate: generate,
    getFresh: getFresh,
    markShown: markShown,
    wasShown: wasShown
  };
})();
