/**
 * Autonoma Contact Integration V1
 * ──────────────────────────────────────
 * ADDITIVE module. Makes Autonoma understand contacts as first-class entities.
 * Patches autProcess to resolve contact names → wallet addresses,
 * supports "Pay Gabriel", "Send Marta 50 USDC", "Run Payroll", etc.
 *
 * ALL existing functionality preserved. Purely additive.
 * Attached to window.AutonomaContacts
 */
(function () {
  'use strict';

  /* ── Wait for deps ────────────────────────────────────────────────── */
  function waitForDeps(cb) {
    var tries = 0;
    function check() {
      tries++;
      if (typeof window.autProcess === 'function' && typeof window.ContactsHub !== 'undefined') return cb();
      if (tries < 80) setTimeout(check, 300);
    }
    check();
  }

  /* ── Contact Name Resolution ──────────────────────────────────────── */
  function resolveNamesInMessage(msg) {
    if (!msg || typeof ContactsHub === 'undefined') return { msg: msg, resolved: null, context: null };

    // Check active contact context first
    var active = ContactsHub.getActiveContact();
    if (active) {
      var ctxLower = msg.toLowerCase();
      var contextRefs = /^(pay|send|bridge|swap|schedule)(\s+him|\s+her|\s+them|$)/i;
      if (contextRefs.test(ctxLower)) {
        return {
          msg: msg.replace(/him|her|them/i, active.name),
          resolved: active,
          context: active.id
        };
      }
    }

    // Try exact match
    var c = ContactsHub.findExact(msg.trim());
    if (c) return { msg: msg, resolved: c, context: c.id };

    // Try name in message patterns: "Pay Gabriel" "Send Marta 50 USDC" "Bridge Samuel to Base"
    var namePatterns = [
      /^(?:pay|send|bridge|swap|schedule)\s+([a-z\u00C0-\u024FA-Z][a-z\u00C0-\u024FA-Z\s]{1,30})(?:\s|$)/i,
      /(?:to|for|para)\s+([a-z\u00C0-\u024FA-Z][a-z\u00C0-\u024FA-Z\s]{1,30})(?:\s|$)/i,
      /^(?:pagar?|enviar|mandar|agendar)\s+([a-z\u00C0-\u024FA-Z][a-z\u00C0-\u024FA-Z\s]{1,30})(?:\s|$)/i,
    ];

    for (var i = 0; i < namePatterns.length; i++) {
      var match = msg.match(namePatterns[i]);
      if (match) {
        var name = match[1].trim();
        var exact = ContactsHub.findExact(name);
        if (exact) return { msg: msg.replace(name, exact.addr), resolved: exact, context: exact.id };
        var matches = ContactsHub.findByName(name);
        if (matches.length === 1) return { msg: msg.replace(name, matches[0].addr), resolved: enrichContact(matches[0]), context: matches[0].id };
        if (matches.length > 1) return { msg: msg, resolved: null, context: null, ambiguous: matches };
      }
    }

    // Try group resolution: "Pay Employees"
    var groupPatterns = [
      /^(?:pay|send|run|schedule|bridge|pagar?|enviar|agendar)\s+(?:all\s+)?(.+?)(?:\s|$)/i,
    ];
    for (var j = 0; j < groupPatterns.length; j++) {
      var gm = msg.match(groupPatterns[j]);
      if (gm) {
        var groupName = gm[1].trim().toLowerCase();
        var groupContacts = ContactsHub.getGroupAddresses(groupName);
        if (groupContacts.length > 0) {
          return { msg: msg, resolved: null, context: null, group: groupName, groupContacts: groupContacts };
        }
        // SmartRecipient: payroll / employees lookup
        if ((/(?:payroll|folha|employees|employee|funcion[a-z]+)/i.test(groupName) || groupName === 'employees')) {
          var srPayroll = (typeof SmartRecipient !== 'undefined') ? SmartRecipient.getPayrollRecipients() : [];
          if (srPayroll.length > 0) {
            return { msg: msg, resolved: null, context: null, group: 'Payroll', groupContacts: srPayroll.map(function(r){ return r.contact; }) };
          }
          var legacyPayroll = ContactsHub.getPayrollContacts();
          if (legacyPayroll.length > 0) {
            return { msg: msg, resolved: null, context: null, group: 'Payroll', groupContacts: legacyPayroll };
          }
        }
        // SmartRecipient: suppliers lookup
        if (/(?:supplier|suppliers|fornecedor|fornecedores|vendor)/i.test(groupName)) {
          var srSuppliers = (typeof SmartRecipient !== 'undefined') ? SmartRecipient.getSupplierRecipients() : [];
          if (srSuppliers.length > 0) {
            return { msg: msg, resolved: null, context: null, group: 'Suppliers', groupContacts: srSuppliers.map(function(r){ return r.contact; }) };
          }
        }
        // SmartRecipient: tag-based lookup
        if (typeof SmartRecipient !== 'undefined') {
          var tagResults = SmartRecipient.findByTag(groupName.charAt(0).toUpperCase() + groupName.slice(1));
          if (tagResults.length > 0) {
            return { msg: msg, resolved: null, context: null, group: groupName, groupContacts: tagResults.map(function(r){ return r.contact; }) };
          }
        }
      }
    }

    return { msg: msg, resolved: null, context: null };
  }

  /* ── Patch autProcess ─────────────────────────────────────────────── */
  function patchAutoProcess() {
    var orig = window.autProcess;
    if (!orig || window.__autonomaContactsPatched) return;

    window.autProcess = function (msg) {
      var result = resolveNamesInMessage(msg);

      // If we found a contact, set context and potentially enrich the message
      if (result.resolved) {
        ContactsHub.setActiveContact(result.context);
        // Inject contact context card
        try { injectContactContextCard(result.resolved); } catch (_) {}
        // If we resolved a name to address in the message, process the modified message
        if (result.msg !== msg) {
          return orig(result.msg);
        }
      }

      // Handle group resolution
      if (result.group && result.groupContacts && result.groupContacts.length > 0) {
        injectGroupActionCard(result.group, result.groupContacts);
        return;
      }

      // Handle ambiguous matches
      if (result.ambiguous) {
        injectAmbiguousCard(result.ambiguous);
        return;
      }

      // Handle active contact context for generic commands
      if (!result.resolved && ContactsHub.getActiveContact()) {
        var activeLower = msg.toLowerCase();
        if (/^(?:pay|send|bridge|swap|schedule|pagar?|enviar|agendar)\b/i.test(activeLower) &&
            ! /\b0x[a-fA-F0-9]{40}\b/i.test(msg)) {
          var active = ContactsHub.getActiveContact();
          if (active && active.addr) {
            injectContactContextCard(active);
          }
        }
      }

      return orig(msg);
    };
    window.__autonomaContactsPatched = true;
    console.log('[AutonomaContacts] patched autProcess for contact name resolution.');
  }

  /* ── UI Injection ─────────────────────────────────────────────────── */
  function injectContactContextCard(contact) {
    try {
      var c = document.getElementById('aut-messages');
      if (!c) return;
      var w = document.getElementById('aut-welcome');
      if (w) w.style.display = 'none';
      var typing = c.querySelector('.aut-typing-msg');
      if (typing) typing.remove();
      var prefs = (typeof ContactsHub !== 'undefined' && contact.id) ? ContactsHub.getPreferences(contact.id) : {};
      c.insertAdjacentHTML('beforeend',
        '<div class="aut-msg ai" style="margin-bottom:4px"><div class="aut-msg-body" style="border-left:2px solid var(--purple);padding-left:10px">' +
          '<div style="font-size:9px;color:var(--muted2);margin-bottom:3px"><i class="ti ti-user-check"></i> Contact context</div>' +
          '<div style="font-weight:600;font-size:11px">' + contact.name + '</div>' +
          '<div style="font-size:8px;color:var(--muted2);font-family:monospace">' + (contact.addr ? contact.addr.slice(0,10) + '...' + contact.addr.slice(-6) : '') + '</div>' +
          (prefs.token ? '<div style="font-size:8px;color:var(--teal);margin-top:2px">Prefers ' + prefs.token + (prefs.chain ? ' on ' + prefs.chain : '') + '</div>' : '') +
          '<div style="font-size:7px;color:var(--muted2);margin-top:3px">Type commands like: Pay him · Schedule Friday · Bridge to Base</div>' +
        '</div></div>');
      c.scrollTop = c.scrollHeight;
    } catch (_) {}
  }

  function injectGroupActionCard(groupName, contacts) {
    try {
      var c = document.getElementById('aut-messages');
      if (!c) return;
      var addrs = contacts.slice(0, 5).map(function (x) { return x.name; }).join(', ');
      if (contacts.length > 5) addrs += ' +' + (contacts.length - 5) + ' more';
      c.insertAdjacentHTML('beforeend',
        '<div class="aut-msg ai"><div class="aut-msg-body">' +
          '<strong>' + groupName + '</strong> (' + contacts.length + ' contacts)<br>' +
          '<div style="font-size:9px;color:var(--muted2);margin:4px 0">' + addrs + '</div><br>' +
          '<button class="btn primary" style="font-size:9px;padding:4px 10px" onclick="showPage(\'batch\');ContactsHub.getGroupAddresses(\'' + groupName + '\').forEach(function(c){if(typeof addToCurrentBatch===\'function\')addToCurrentBatch(c.id)})">Add to Batch</button> ' +
          '<button class="btn" style="font-size:9px;padding:4px 10px" onclick="showPage(\'schedule\')">Schedule Payments</button>' +
        '</div></div>');
      c.scrollTop = c.scrollHeight;
    } catch (_) {}
  }

  function injectAmbiguousCard(matches) {
    try {
      var c = document.getElementById('aut-messages');
      if (!c) return;
      var html = '<div class="aut-msg ai"><div class="aut-msg-body">' +
        '<strong>Multiple contacts found:</strong><br><br>';
      matches.slice(0, 5).forEach(function (m) {
        html += '<button class="btn" style="font-size:9px;padding:4px 10px;margin:2px" onclick="ContactsHub.setActiveContact(\'' + m.id + '\');autonomaSendQuick(\'' + m.name + '\')">' + m.name + ' · ' + (m.addr ? m.addr.slice(0,6) + '...' : '') + '</button> ';
      });
      html += '</div></div>';
      c.insertAdjacentHTML('beforeend', html);
      c.scrollTop = c.scrollHeight;
    } catch (_) {}
  }

  /* ── Enrich contact helper ────────────────────────────────────────── */
  function enrichContact(c) {
    var out = c;
    try {
      if (typeof ContactsHub !== 'undefined' && ContactsHub.enrichContact) out = ContactsHub.enrichContact(c);
    } catch (_) {}
    // SmartRecipient crosschain preferences for "Bridge and pay Gabriel" scenarios
    if (typeof SmartRecipient !== 'undefined' && out && out.name) {
      var xc = SmartRecipient.getContactForBridge(out.name);
      if (xc) {
        out.preferredToken = out.preferredToken || xc.preferredToken;
        out.preferredChain = out.preferredChain || xc.preferredChain;
        out.allowCrosschain = xc.allowCrosschain;
        out.preferredRoute = out.preferredRoute || xc.preferredRoute;
      }
    }
    return out;
  }

  /* ── Init ─────────────────────────────────────────────────────────── */
  waitForDeps(function () {
    patchAutoProcess();
  });

  window.AutonomaContacts = {
    resolveNamesInMessage: resolveNamesInMessage,
    patchAutoProcess: patchAutoProcess
  };

  console.log('[AutonomaContacts] Initialized.');
})();
