/**
 * Elligentt Multisend Dedup — Phase 5+
 * Prevents duplicate recipient addresses in multisend batches.
 * Patches AgentScheduleExecutor._validateIntent surgically.
 * No changes to agent or schedule engine behavior.
 * Attached to window.MultisendDedup
 */
(function(){
  'use strict';

  var _installed = false;

  /**
   * Check for duplicate addresses in a list of recipients.
   * Returns { duplicates: [...], hasDuplicates: bool }
   */
  function _findDuplicates(recipients, addrKey, amtKey) {
    var seen = {};
    var duplicates = [];
    var aKey = addrKey || 'addr';
    for (var i = 0; i < recipients.length; i++) {
      var a = (recipients[i][aKey] || '').toLowerCase();
      if (!a || a === '0x0000000000000000000000000000000000000000') continue;
      if (seen[a] !== undefined) {
        duplicates.push({ address: recipients[i][aKey], firstIndex: seen[a] + 1, secondIndex: i + 1 });
      } else {
        seen[a] = i;
      }
    }
    return { duplicates: duplicates, hasDuplicates: duplicates.length > 0 };
  }

  function _formatDupMessage(duplicates) {
    return duplicates.map(function(d) {
      return d.address.slice(0, 8) + '... (#' + d.firstIndex + ' & #' + d.secondIndex + ')';
    }).join(', ');
  }

  function install() {
    if (_installed) return;

    var maxAttempts = 80;
    var attempts = 0;

    function tryInstall() {
      attempts++;

      /* ── Path A: AgentScheduleExecutor (scheduled multisend) ── */
      if (typeof window.AgentScheduleExecutor !== 'undefined' && !window.AgentScheduleExecutor.__dedupWrapped) {
        var _orig = window.AgentScheduleExecutor._validateIntent;
        window.AgentScheduleExecutor._validateIntent = async function(sched, provider, agentAddr) {
          var result = await _orig.call(window.AgentScheduleExecutor, sched, provider, agentAddr);
          if (!result || !result.ok) return result;
          if (sched.type !== 'multisend' && sched.type !== 'payment') return result;

          // Check transfers
          if (result.transfers && result.transfers.length > 1) {
            var d1 = _findDuplicates(result.transfers, 'to');
            if (d1.hasDuplicates) {
              return { ok: false, reason: 'Duplicate recipient(s): ' + _formatDupMessage(d1.duplicates) + '. Remove duplicates before sending.' };
            }
          }
          // Check schedule recipients
          if (sched.recipients && sched.recipients.length > 1) {
            var d2 = _findDuplicates(sched.recipients, 'addr');
            if (d2.hasDuplicates) {
              return { ok: false, reason: 'Duplicate recipient(s) in batch: ' + _formatDupMessage(d2.duplicates) + '. Remove duplicates before sending.' };
            }
          }
          return result;
        };
        window.AgentScheduleExecutor.__dedupWrapped = true;
      }

      /* ── Path B: executeMultiSendV4 (direct execution from Schedule page) ── */
      if (typeof window.executeMultiSendV4 === 'function' && !window.__multiSendDedupV4) {
        var _origV4 = window.executeMultiSendV4;
        window.executeMultiSendV4 = function(chainGroups) {
          // Collect ALL recipients across ALL chain groups
          var allRecipients = [];
          var chainKeys = Object.keys(chainGroups || {});
          for (var c = 0; c < chainKeys.length; c++) {
            var rcpts = chainGroups[chainKeys[c]];
            if (Array.isArray(rcpts)) {
              for (var r = 0; r < rcpts.length; r++) {
                allRecipients.push({
                  addr: rcpts[r].addr || rcpts[r]._resolved || '',
                  chain: chainKeys[c]
                });
              }
            }
          }

          if (allRecipients.length > 1) {
            var dupes = _findDuplicates(allRecipients, 'addr');
            if (dupes.hasDuplicates) {
              var msg = 'Duplicate recipient(s) detected: ' + _formatDupMessage(dupes.duplicates) + '. Remove duplicates before sending.';
              if (typeof toast === 'function') toast(msg, 'error');
              console.error('[MultisendDedup]', msg);
              return;
            }
          }

          return _origV4(chainGroups);
        };
        window.__multiSendDedupV4 = true;
      }

      if ((typeof window.AgentScheduleExecutor !== 'undefined' && window.AgentScheduleExecutor.__dedupWrapped) ||
          (typeof window.executeMultiSendV4 === 'function' && window.__multiSendDedupV4)) {
        _installed = true;
        console.log('[MultisendDedup] Installed. Duplicate detection on both agent + direct multisend paths.');
        return;
      }

      if (attempts < maxAttempts) {
        setTimeout(tryInstall, 300);
      } else {
        console.error('[MultisendDedup] CRITICAL: Failed to install dedup patch after ' + maxAttempts + ' attempts. AgentScheduleExecutor and/or executeMultiSendV4 not found. Duplicate recipients will NOT be blocked for scheduled batches.');
      }
    }

    tryInstall();
  }

  // Auto-install after core modules load
  setTimeout(install, 4000);

  window.MultisendDedup = {
    install: install,
    isInstalled: function() { return _installed; }
  };
})();
