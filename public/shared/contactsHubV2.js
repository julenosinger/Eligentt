/**
 * Elligentt Contacts Hub V2
 * ──────────────────────────────────────────
 * ADDITIVE module. Transforms the Recipients page into an intelligent
 * financial identity layer. Extends contact data model, adds Autonoma
 * name-to-address resolution, contact groups, payment preferences,
 * payroll profiles, contact history, smart CSV import, and analytics.
 *
 * ALL existing functionality preserved. Purely additive.
 * NEVER auto-executes transactions.
 *
 * Attached to window.ContactsHub
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'arcpay_contacts_v2';
  var v2Data = {};
  var activeContactId = null;

  function loadV2() { try { var r = localStorage.getItem(STORAGE_KEY); if (r) v2Data = JSON.parse(r); } catch (_) { v2Data = {}; } }
  function saveV2() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v2Data)); } catch (_) {} }

  /* ── RELATIONSHIP TYPES ──────────────────────────────────────────── */
  var REL_TYPES = ['Employee', 'Supplier', 'Client', 'Investor', 'Partner', 'VIP', 'Payroll', 'Freelancer', 'DAO Member', 'Other'];
  var RISK_LEVELS = ['Low', 'Medium', 'High'];

  /* ── TAG DEFINITIONS ─────────────────────────────────────────────── */
  var ALL_TAGS = [
    'Employee', 'Client', 'Supplier', 'Family', 'Payroll', 'DAO Member',
    'Treasury', 'VIP', 'OTC', 'Crosschain', 'Business Partner', 'Investor',
    'Marketing', 'Operations', 'Finance', 'Developer', 'Freelancer', 'Partner'
  ];

  var GROUP_PRESETS = ['Employees', 'Suppliers', 'Marketing', 'Payroll Team', 'Partners', 'Clients', 'Treasury', 'Monthly Payments', 'Investors', 'VIP'];

  /* ── CONTACT DATA EXTENSION ──────────────────────────────────────── */
  function getV2(cid) {
    if (!v2Data[cid]) {
      v2Data[cid] = { tags: [], groups: [], preferences: {}, payroll: null, notes: [], status: 'active', history: { sent: 0, received: 0, count: 0, lastTx: null, nextScheduled: null } };
      saveV2();
    }
    return v2Data[cid];
  }

  function enrichContact(c) {
    var v2 = getV2(c.id);
    return Object.assign({}, c, {
      tags: v2.tags || [],
      groups: v2.groups || [],
      preferences: v2.preferences || {},
      payroll: v2.payroll || null,
      notesList: v2.notes || [],
      status: v2.status || 'active',
      crm: v2.crm || {},
      crosschain: v2.crosschain || {},
      permissions: v2.permissions || {},
      history: v2.history || { sent: 0, received: 0, count: 0, lastTx: null, nextScheduled: null }
    });
  }

  /* ── CRM FIELDS ──────────────────────────────────────────────────── */
  function setCRM(cid, fields) {
    var v2 = getV2(cid);
    v2.crm = Object.assign({ relationship: '', riskLevel: 'Low', financialScore: 0 }, v2.crm || {}, fields);
    saveV2();
  }

  function getCRM(cid) {
    var v2 = getV2(cid);
    return v2.crm || { relationship: '', riskLevel: 'Low', financialScore: 0 };
  }

  /* ── CROSSCHAIN PROFILE ───────────────────────────────────────────── */
  function setCrosschain(cid, fields) {
    var v2 = getV2(cid);
    v2.crosschain = Object.assign({ preferredDestChain: '', preferredRoute: 'CCTP V2', bridgeVolume: 0, lastBridge: null, bridgeCount: 0, supportedChains: [] }, v2.crosschain || {}, fields);
    saveV2();
  }

  function getCrosschain(cid) {
    var v2 = getV2(cid);
    return v2.crosschain || { preferredDestChain: '', preferredRoute: 'CCTP V2', bridgeVolume: 0, lastBridge: null, bridgeCount: 0, supportedChains: [] };
  }

  /* ── ACTIVE CONTACT CONTEXT ───────────────────────────────────────── */
  function setActiveContact(cid) { activeContactId = cid; try { localStorage.setItem('elligentt_active_contact', cid); } catch (_) {} }
  function getActiveContact() {
    if (!activeContactId) { try { activeContactId = localStorage.getItem('elligentt_active_contact') || null; } catch (_) {} }
    if (!activeContactId) return null;
    var c = contacts.find(function (x) { return x.id === activeContactId; });
    return c ? enrichContact(c) : null;
  }
  function clearActiveContact() { activeContactId = null; try { localStorage.removeItem('elligentt_active_contact'); } catch (_) {} }

  /* ── REAL TRANSACTION HISTORY PER CONTACT ─────────────────────────── */
  function getContactHistory(cid) {
    var c = contacts.find(function (x) { return x.id === cid; });
    if (!c || !c.addr) return { sent: 0, received: 0, count: 0, txs: [], lastTx: null };
    var addr = c.addr.toLowerCase();
    var txs = [];

    // From txHistory (batch sends, bridge, swap records)
    try {
      if (typeof txHistory !== 'undefined' && Array.isArray(txHistory)) {
        txHistory.forEach(function (tx) {
          if ((tx.addr || tx.recipient || '').toLowerCase().indexOf(addr) !== -1 || (tx.label || '').toLowerCase().indexOf(c.name.toLowerCase()) !== -1) {
            txs.push({ type: 'payment', label: tx.label, amount: tx.amount || tx.amt, ts: tx.ts || tx.time, txHash: tx.txHash });
          }
        });
      }
    } catch (_) {}

    // From batch recipients (sent payments)
    try {
      if (typeof recipients !== 'undefined' && Array.isArray(recipients)) {
        recipients.forEach(function (r) {
          if ((r.addr || '').toLowerCase() === addr && parseFloat(r.amount) > 0) {
            txs.push({ type: 'batch', label: 'Batch Payment: ' + (r.note || r.name || shortAddr(r.addr)), amount: parseFloat(r.amount), ts: Date.now(), txHash: '' });
          }
        });
      }
    } catch (_) {}

    // From cross-chain stats
    try {
      if (typeof xcStats !== 'undefined' && xcStats.volume) {
        txs.push({ type: 'crosschain', label: 'Cross-chain payments', amount: xcStats.volume, ts: Date.now(), txHash: '' });
      }
    } catch (_) {}

    // From XC history
    try {
      var xcHist = JSON.parse(localStorage.getItem('elligentt_xc_history') || '[]');
      xcHist.forEach(function (e) {
        if ((e.recipient || '').toLowerCase().indexOf(addr) !== -1) {
          txs.push({ type: 'crosschain', label: 'XC: ' + (e.fromName || '') + ' → ' + (e.toName || ''), amount: e.amt, ts: e.ts, txHash: e.txHash });
        }
      });
    } catch (_) {}

    txs.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    var totalSent = txs.reduce(function (sum, tx) { return sum + (parseFloat(tx.amount) || 0); }, 0);
    return { sent: totalSent, received: 0, count: txs.length, txs: txs.slice(0, 20), lastTx: txs[0] || null };
  }

  /* ── SCHEDULE PROFILE PER CONTACT ─────────────────────────────────── */
  function getContactSchedules(cid) {
    var c = contacts.find(function (x) { return x.id === cid; });
    if (!c || !c.addr) return { active: [], paused: [], completed: [], nextExecution: null };
    var addr = c.addr.toLowerCase();
    var all = [];
    try {
      if (typeof ScheduleEngine !== 'undefined') {
        all = ScheduleEngine.getAll ? ScheduleEngine.getAll() : [];
      }
    } catch (_) {}
    var result = { active: [], paused: [], completed: [], nextExecution: null };
    all.forEach(function (s) {
      var recipients = s.recipients || s._recipients || (s.params && s.params.recipients) || [];
      var found = false;
      if (typeof recipients === 'string') {
        found = recipients.toLowerCase().indexOf(addr) !== -1 || recipients.toLowerCase().indexOf(c.name.toLowerCase()) !== -1;
      } else if (Array.isArray(recipients)) {
        found = recipients.some(function (r) {
          return (typeof r === 'string' && r.toLowerCase().indexOf(addr) !== -1) ||
                 (r.addr && r.addr.toLowerCase() === addr) ||
                 (r.name && r.name.toLowerCase() === c.name.toLowerCase());
        });
      }
      if (!found) {
        found = (s.recipient || '').toLowerCase() === addr || (s.name || '').toLowerCase().indexOf(c.name.toLowerCase()) !== -1;
      }
      if (found) {
        var entry = { id: s.id, name: s.name, type: s.type, nextExecution: s.nextExecution, status: s.status || 'active', amount: s.amount };
        if (s.status === 'completed') result.completed.push(entry);
        else if (s.status === 'paused') result.paused.push(entry);
        else result.active.push(entry);
        if (!result.nextExecution && s.nextExecution) result.nextExecution = s.nextExecution;
      }
    });
    return result;
  }

  /* ── AGENT WALLET PERMISSIONS PER CONTACT ─────────────────────────── */
  function getContactPermissions(cid) {
    var v2 = getV2(cid);
    var defaults = { payments: true, schedule: true, payroll: false, bridge: true, swap: true, crosschain: false, treasury: false, vault: false, otc: false };
    return Object.assign(defaults, v2.permissions || {});
  }

  function setContactPermissions(cid, perms) {
    var v2 = getV2(cid);
    v2.permissions = Object.assign(v2.permissions || {}, perms);
    saveV2();
  }

  /* ── ENHANCED DETAIL MODAL ────────────────────────────────────────── */
  function openContactCard(cid) {
    var c = contacts.find(function (x) { return x.id === cid; });
    if (!c) return;
    var enriched = enrichContact(c);
    var prefs = getPreferences(cid);
    var crm = getCRM(cid);
    var xchain = getCrosschain(cid);
    var perms = getContactPermissions(cid);
    var hist = getContactHistory(cid);
    var scheds = getContactSchedules(cid);
    var chain = CHAINS.find(function (ch) { return ch.id === (c.chainId || 'Arc_Testnet'); }) || { name: 'Unknown', color: '#888' };
    var isActive = activeContactId === cid;

    var html = '<div style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)this.remove()">' +
      '<div style="background:var(--card);border:1px solid var(--border2);border-radius:14px;padding:0;width:500px;max-width:95vw;max-height:88vh;overflow:hidden" onclick="event.stopPropagation()">' +

      // Header
      '<div style="background:linear-gradient(135deg,rgba(167,139,250,.18),rgba(79,142,247,.08));padding:18px 20px;display:flex;align-items:center;gap:12px">' +
        '<div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#4f8ef7,#a78bfa);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#fff;flex-shrink:0">' + c.name[0].toUpperCase() + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:700;font-size:13px">' + c.name + '</div>' +
          '<div style="font-size:8px;color:var(--muted2);font-family:monospace;overflow:hidden;text-overflow:ellipsis">' + (c.addr || 'No address') + '</div>' +
          (enriched.tags.length ? '<div style="display:flex;gap:3px;margin-top:4px;flex-wrap:wrap">' + enriched.tags.slice(0,4).map(function (t) { return '<span style="font-size:7px;padding:1px 5px;border-radius:3px;border:1px solid var(--purple);color:var(--purple);opacity:.8">' + t + '</span>'; }).join('') + '</div>' : '') +
        '</div>' +
      '</div>' +

      // Tabs
      '<div style="display:flex;border-bottom:1px solid var(--border);overflow-x:auto">' +
        '<button class="ch-tab active" onclick="ContactsHub._switchTab(event,\'ch-tab-profile\')" style="flex:1;min-width:60px;padding:8px 4px;font-size:8.5px">Profile</button>' +
        '<button class="ch-tab" onclick="ContactsHub._switchTab(event,\'ch-tab-schedule\')" style="flex:1;min-width:60px;padding:8px 4px;font-size:8.5px">Schedule</button>' +
        '<button class="ch-tab" onclick="ContactsHub._switchTab(event,\'ch-tab-history\')" style="flex:1;min-width:60px;padding:8px 4px;font-size:8.5px">History</button>' +
        '<button class="ch-tab" onclick="ContactsHub._switchTab(event,\'ch-tab-perms\')" style="flex:1;min-width:60px;padding:8px 4px;font-size:8.5px">Permissions</button>' +
      '</div>' +

      // Body
      '<div style="max-height:55vh;overflow-y:auto;padding:14px 18px">' +

        // Profile tab
        '<div class="ch-tab-panel" id="ch-tab-profile">' +
          '<div style="font-size:9px;line-height:1.6">' +
            '<div style="margin-bottom:8px"><strong style="color:var(--muted2)">Chain:</strong> <span style="color:' + chain.color + '">' + chain.name + '</span></div>' +
            (prefs.token ? '<div style="margin-bottom:8px"><strong style="color:var(--muted2)">Preferred Token:</strong> <span style="color:var(--teal)">' + prefs.token + '</span></div>' : '') +
            (prefs.chain ? '<div style="margin-bottom:8px"><strong style="color:var(--muted2)">Preferred Chain:</strong> ' + prefs.chain + '</div>' : '') +
            (enriched.groups.length ? '<div style="margin-bottom:8px"><strong style="color:var(--muted2)">Groups:</strong> ' + enriched.groups.join(', ') + '</div>' : '') +
            (crm.relationship ? '<div style="margin-bottom:8px"><strong style="color:var(--muted2)">Relationship:</strong> ' + crm.relationship + '</div>' : '') +
            (crm.riskLevel ? '<div style="margin-bottom:8px"><strong style="color:var(--muted2)">Risk Level:</strong> <span style="color:' + (crm.riskLevel === 'High' ? 'var(--red)' : crm.riskLevel === 'Medium' ? 'var(--yellow)' : 'var(--green)') + '">' + crm.riskLevel + '</span></div>' : '') +
            (enriched.payroll ? '<div style="margin-bottom:8px"><strong style="color:var(--muted2)">Payroll:</strong> ' + (enriched.payroll.amount || '—') + ' ' + (enriched.payroll.token || 'USDC') + ' · ' + (enriched.payroll.frequency || '') + ' · Day ' + (enriched.payroll.day || '—') + '</div>' : '') +
            (xchain.preferredDestChain ? '<div style="margin-bottom:8px"><strong style="color:var(--muted2)">Bridge Destination:</strong> ' + xchain.preferredDestChain + ' · Route: ' + xchain.preferredRoute + '</div>' : '') +
            (c.note ? '<div style="margin-bottom:8px"><strong style="color:var(--muted2)">Note:</strong> ' + c.note + '</div>' : '') +
          '</div>' +
        '</div>' +

        // Schedule tab
        '<div class="ch-tab-panel" id="ch-tab-schedule" style="display:none">' +
          (scheds.active.length ? '<div style="font-size:9px;margin-bottom:10px"><strong style="color:var(--green)">Active:</strong> ' + scheds.active.length + '</div>' + scheds.active.map(function (s) { return '<div style="font-size:8.5px;padding:4px 0;border-bottom:1px solid var(--border)">' + s.name + (s.nextExecution ? ' · Next: ' + new Date(s.nextExecution).toLocaleDateString() : '') + '</div>'; }).join('') : '') +
          (scheds.paused.length ? '<div style="font-size:9px;margin-bottom:10px;margin-top:10px"><strong style="color:var(--yellow)">Paused:</strong> ' + scheds.paused.length + '</div>' + scheds.paused.map(function (s) { return '<div style="font-size:8.5px;padding:4px 0;border-bottom:1px solid var(--border)">' + s.name + '</div>'; }).join('') : '') +
          (!scheds.active.length && !scheds.paused.length ? '<div style="font-size:9px;color:var(--muted2);padding:20px;text-align:center">No schedules found</div>' : '') +
        '</div>' +

        // History tab
        '<div class="ch-tab-panel" id="ch-tab-history" style="display:none">' +
          '<div style="margin-bottom:10px;display:flex;gap:16px;font-size:10px">' +
            '<div><strong style="color:var(--muted2)">Sent:</strong> <strong>$' + (hist.sent || 0).toFixed(2) + '</strong></div>' +
            '<div><strong style="color:var(--muted2)">Txs:</strong> ' + (hist.count || 0) + '</div>' +
          '</div>' +
          (hist.txs && hist.txs.length ? hist.txs.slice(0, 10).map(function (tx) { return '<div style="font-size:8.5px;padding:3px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between"><span>' + (tx.label || tx.type) + '</span><span style="color:var(--muted2)">$' + (parseFloat(tx.amount) || 0).toFixed(2) + '</span></div>'; }).join('') : '<div style="font-size:9px;color:var(--muted2);padding:20px;text-align:center">No transactions found</div>') +
        '</div>' +

        // Permissions tab
        '<div class="ch-tab-panel" id="ch-tab-perms" style="display:none">' +
          '<div style="font-size:9px;line-height:2">' +
            permRow('Payments', perms.payments) +
            permRow('Schedule', perms.schedule) +
            permRow('Payroll', perms.payroll) +
            permRow('Bridge', perms.bridge) +
            permRow('Swap', perms.swap) +
            permRow('Crosschain', perms.crosschain) +
            permRow('Treasury', perms.treasury) +
            permRow('Vault', perms.vault) +
            permRow('OTC', perms.otc) +
          '</div>' +
          '<div style="font-size:7px;color:var(--muted2);margin-top:10px">These permissions are enforced by Agent Wallet authorization. Edit in Settings → Permissions.</div>' +
        '</div>' +
      '</div>' +

      // Footer actions
      '<div style="padding:10px 18px;border-top:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap">' +
        (isActive ? '<button class="btn" style="font-size:8.5px;padding:4px 9px;color:var(--purple)" onclick="ContactsHub.clearActiveContact()"><i class="ti ti-x"></i>Deselect</button>' : '<button class="btn primary" style="font-size:8.5px;padding:4px 9px" onclick="ContactsHub.setActiveContact(\'' + cid + '\')"><i class="ti ti-user-check"></i>Select Contact</button>') +
        '<button class="btn" style="font-size:8.5px;padding:4px 9px" onclick="ContactsHub.quickSend(\'' + cid + '\')"><i class="ti ti-send"></i>Send</button>' +
        '<button class="btn" style="font-size:8.5px;padding:4px 9px" onclick="addToCurrentBatch(\'' + cid + '\')"><i class="ti ti-plus"></i>Batch</button>' +
        '<button class="btn" style="font-size:8.5px;padding:4px 9px;color:var(--red)" onclick="var el=this.closest(\'[style*=fixed]\');if(el)el.remove();deleteContact(\'' + cid + '\')"><i class="ti ti-trash"></i></button>' +
      '</div>' +

      '</div></div>';
    document.body.insertAdjacentHTML('beforeend', html);
  }

  function permRow(label, allowed) {
    return '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<span>' + label + '</span>' +
      '<span style="color:' + (allowed ? 'var(--green)' : 'var(--red)') + ';font-weight:600">' + (allowed ? '✓ Allowed' : '✗ Forbidden') + '</span></div>';
  }

  function _switchTab(e, tabId) {
    e.preventDefault();
    var container = e.target.closest('[style*="overflow:hidden"]') || e.target.parentElement.parentElement;
    if (container) {
      container.querySelectorAll('.ch-tab').forEach(function (t) { t.classList.remove('active'); });
      container.querySelectorAll('.ch-tab-panel').forEach(function (p) { p.style.display = 'none'; });
    }
    e.target.classList.add('active');
    var panel = document.getElementById(tabId);
    if (panel) panel.style.display = '';
  }

  /* ── AUTONOMA NAME RESOLUTION ────────────────────────────────────── */
  function findByName(query) {
    if (!query) return null;
    var lower = query.toLowerCase();
    var matches = contacts.filter(function (c) {
      var v2 = v2Data[c.id] || {};
      return c.name.toLowerCase().indexOf(lower) !== -1 ||
             (c.note && c.note.toLowerCase().indexOf(lower) !== -1) ||
             (v2.tags || []).some(function (t) { return t.toLowerCase().indexOf(lower) !== -1; }) ||
             (v2.groups || []).some(function (g) { return g.toLowerCase().indexOf(lower) !== -1; });
    });
    return matches;
  }

  function findExact(name) {
    if (!name) return null;
    var lower = name.trim().toLowerCase();
    var c = contacts.find(function (c) { return c.name.toLowerCase() === lower; });
    return c ? enrichContact(c) : null;
  }

  function resolveAddress(name) {
    var c = findExact(name);
    return c ? c.addr : null;
  }

  function getGroupAddresses(groupName) {
    var lower = groupName.trim().toLowerCase();
    return contacts.filter(function (c) {
      var v2 = v2Data[c.id] || {};
      return (v2.groups || []).some(function (g) { return g.toLowerCase() === lower; });
    });
  }

  /* ── PATCH: extend core functions ─────────────────────────────────── */
  function patchContacts() {
    // Patch saveContact to preserve V2 data
    var origSave = window.saveContact;
    if (origSave && !window.__contactsHubV2Patched) {
      window.saveContact = function () {
        var prevLen = contacts.length;
        origSave();
        if (contacts.length > prevLen) {
          var newContact = contacts[0];
          if (newContact && newContact.id) getV2(newContact.id);
        }
      };
      window.__contactsHubV2Patched = true;
    }
  }

  /* ── GROUP MANAGEMENT ────────────────────────────────────────────── */
  function addToGroup(cid, group) {
    if (!group) return;
    var v2 = getV2(cid);
    if (v2.groups.indexOf(group) === -1) v2.groups.push(group);
    saveV2();
  }

  function removeFromGroup(cid, group) {
    var v2 = getV2(cid);
    v2.groups = v2.groups.filter(function (g) { return g !== group; });
    saveV2();
  }

  function getGroupNames() {
    var all = [];
    Object.keys(v2Data).forEach(function (cid) {
      var v2 = v2Data[cid];
      if (v2.groups) v2.groups.forEach(function (g) { if (all.indexOf(g) === -1) all.push(g); });
    });
    GROUP_PRESETS.forEach(function (g) { if (all.indexOf(g) === -1) all.push(g); });
    return all.sort();
  }

  /* ── PREFERENCES ──────────────────────────────────────────────────── */
  function setPreferences(cid, prefs) {
    var v2 = getV2(cid);
    v2.preferences = Object.assign(v2.preferences || {}, prefs);
    saveV2();
  }

  function getPreferences(cid) {
    var v2 = getV2(cid);
    return v2.preferences || {};
  }

  /* ── PAYROLL PROFILE ──────────────────────────────────────────────── */
  function setPayroll(cid, payrollData) {
    var v2 = getV2(cid);
    v2.payroll = payrollData;
    v2.tags = v2.tags || [];
    if (v2.tags.indexOf('Payroll') === -1) v2.tags.push('Payroll');
    saveV2();
  }

  function getPayrollContacts() {
    return contacts.filter(function (c) {
      var v2 = v2Data[c.id] || {};
      return (v2.tags || []).indexOf('Payroll') !== -1 || v2.payroll;
    }).map(enrichContact);
  }

  /* ── CONTACT NOTES ────────────────────────────────────────────────── */
  function addNote(cid, note) {
    var v2 = getV2(cid);
    v2.notes = v2.notes || [];
    v2.notes.push({ text: note, ts: Date.now() });
    if (v2.notes.length > 20) v2.notes = v2.notes.slice(-20);
    saveV2();
  }

  /* ── STATUS BADGES ────────────────────────────────────────────────── */
  function getStatusBadges(c) {
    var v2 = v2Data[c.id] || {};
    var badges = [];
    if (c.favorite) badges.push({ label: 'Favorite', color: 'var(--yellow)' });
    if ((v2.tags || []).indexOf('Payroll') !== -1 || v2.payroll) badges.push({ label: 'Payroll', color: '#f59e0b' });
    if ((v2.tags || []).indexOf('VIP') !== -1) badges.push({ label: 'VIP', color: '#a78bfa' });
    if ((v2.groups || []).length > 0) badges.push({ label: v2.groups[0], color: 'var(--teal)' });
    if (v2.status === 'inactive') badges.push({ label: 'Inactive', color: 'var(--muted2)' });
    if ((v2.tags || []).indexOf('Crosschain') !== -1) badges.push({ label: 'Crosschain', color: 'var(--blue)' });
    return badges;
  }

  /* ── ANALYTICS ────────────────────────────────────────────────────── */
  function getAnalytics() {
    var all = contacts.map(enrichContact);
    var groups = {};
    all.forEach(function (c) {
      (c.groups || []).forEach(function (g) {
        groups[g] = (groups[g] || 0) + 1;
      });
    });
    var payrollCount = 0, scheduledCount = 0, crosschainCount = 0, totalSent = 0, totalCount = 0;
    all.forEach(function (c) {
      if ((c.tags || []).indexOf('Payroll') !== -1 || c.payroll) payrollCount++;
      if ((c.tags || []).indexOf('Crosschain') !== -1) crosschainCount++;
      if (c.history) { totalSent += c.history.sent || 0; totalCount += c.history.count || 0; }
      if (c.history && c.history.nextScheduled) scheduledCount++;
    });
    return {
      total: contacts.length,
      groups: Object.keys(groups).length,
      payrollRecipients: payrollCount,
      scheduledRecipients: scheduledCount,
      crosschainRecipients: crosschainCount,
      activeContacts: all.filter(function (c) { return c.status === 'active'; }).length,
      totalPaid: totalSent,
      totalTransactions: totalCount,
      groupBreakdown: groups
    };
  }

  function getAnalyticsHTML() {
    var a = getAnalytics();
    return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px;margin-bottom:10px">' +
      metricBox('Contacts', a.total, 'var(--purple)') +
      metricBox('Groups', a.groups, 'var(--teal)') +
      metricBox('Payroll', a.payrollRecipients, '#f59e0b') +
      metricBox('Scheduled', a.scheduledRecipients, 'var(--blue)') +
      metricBox('Crosschain', a.crosschainRecipients, 'var(--green)') +
      metricBox('Active', a.activeContacts, 'var(--text)') +
      '</div>';
  }

  function metricBox(label, value, color) {
    return '<div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:6px;padding:6px 8px;text-align:center">' +
      '<div style="font-size:14px;font-weight:700;color:' + color + '">' + (value || 0) + '</div>' +
      '<div style="font-size:7px;color:var(--muted2);margin-top:2px">' + label + '</div></div>';
  }

  /* ── SMART CSV IMPORT ─────────────────────────────────────────────── */
  function smartCSVImport(text) {
    var lines = text.split('\n').filter(function (l) { return l.trim(); });
    var added = 0;
    var header = lines[0].toLowerCase();
    var hasHeader = /name|address|addr/.test(header);
    var start = hasHeader ? 1 : 0;
    var cols = hasHeader ? lines[0].split(',').map(function (s) { return s.trim().toLowerCase(); }) : ['name', 'addr', 'chain', 'group', 'token', 'type', 'notes'];

    var colMap = { name: -1, addr: -1, address: -1, chain: -1, group: -1, token: -1, type: -1, notes: -1, tag: -1, tags: -1 };
    cols.forEach(function (c, i) { if (colMap.hasOwnProperty(c)) colMap[c] = i; });
    var nameIdx = colMap.name;
    var addrIdx = Math.max(colMap.addr, colMap.address);
    var chainIdx = colMap.chain;
    var groupIdx = colMap.group;
    var tokenIdx = colMap.token;
    var typeIdx = Math.max(colMap.type, colMap.tag, colMap.tags);
    var notesIdx = colMap.notes;

    for (var i = start; i < lines.length; i++) {
      var parts = lines[i].split(',').map(function (s) { return s.trim(); });
      var name = nameIdx !== -1 ? parts[nameIdx] : '';
      var addr = addrIdx !== -1 ? parts[addrIdx] : '';
      var chain = chainIdx !== -1 ? parts[chainIdx] : 'Arc_Testnet';
      var group = groupIdx !== -1 ? parts[groupIdx] : '';
      var token = tokenIdx !== -1 ? parts[tokenIdx] : '';
      var type = typeIdx !== -1 ? parts[typeIdx] : '';
      var notes = notesIdx !== -1 ? parts[notesIdx] : '';

      if (!addr || !name) continue;
      if (!isAddr(addr)) continue;

      if (typeof CHAIN_MAP !== 'undefined' && chain) {
        chain = CHAIN_MAP[chain.toLowerCase()] || chain;
      }

      var existing = contacts.find(function (c) { return c.addr && c.addr.toLowerCase() === addr.toLowerCase(); });
      if (existing) {
        if (group) addToGroup(existing.id, group);
        if (type) { var v2 = getV2(existing.id); v2.tags = v2.tags || []; type.split(';').forEach(function (t) { t = t.trim(); if (t && v2.tags.indexOf(t) === -1) v2.tags.push(t); }); saveV2(); }
        if (notes) addNote(existing.id, notes);
        continue;
      }

      var c = { id: 'C' + Date.now() + added, name: name, addr: addr, note: notes, chainId: chain, favorite: false, lastUsed: new Date().toISOString() };
      contacts.unshift(c);
      var v2 = getV2(c.id);
      if (type) { v2.tags = v2.tags || []; type.split(';').forEach(function (t) { t = t.trim(); if (t && v2.tags.indexOf(t) === -1) v2.tags.push(t); }); }
      if (group) addToGroup(c.id, group);
      if (token) setPreferences(c.id, { token: token });
      if (notes) addNote(c.id, notes);
      added++;
    }

    if (added > 0) {
      try { Store.save('contacts', contacts); } catch (_) {}
      saveV2();
    }
    return added;
  }

  /* ── UI INJECTION ────────────────────────────────────────────────── */
  function injectV2UI() {
    var retries = 0;
    function tryInject() {
      retries++;
      var page = document.getElementById('page-recipients');
      if (!page) { if (retries < 60) setTimeout(tryInject, 500); return; }
      var bar = page.querySelector('[style*="flex-wrap:wrap"]');
      if (!bar) { if (retries < 60) setTimeout(tryInject, 500); return; }

      // Remove old v2 elements if they exist
      var oldGroup = document.getElementById('rcp-group-filter');
      if (oldGroup) oldGroup.remove();
      var oldAnalytics = document.getElementById('rcp-analytics');
      if (oldAnalytics) oldAnalytics.remove();
      var oldBadge = document.getElementById('rcp-v2-toggle');
      if (oldBadge) oldBadge.remove();

      // Add group filter
      var groups = getGroupNames();
      if (groups.length) {
        var groupSel = document.createElement('select');
        groupSel.id = 'rcp-group-filter';
        groupSel.className = 'btn';
        groupSel.setAttribute('style', 'cursor:pointer;font-family:inherit;font-size:9.5px');
        groupSel.innerHTML = '<option value="all">All Groups</option>' +
          groups.map(function (g) { return '<option value="' + g + '">' + g + '</option>'; }).join('');
        groupSel.addEventListener('change', function () { window.renderContactsV2(); });
        bar.appendChild(groupSel);
      }

      // Add analytics toggle
      var analyticsDiv = document.createElement('div');
      analyticsDiv.id = 'rcp-analytics';
      analyticsDiv.style.cssText = 'display:none;margin-top:8px';
      analyticsDiv.innerHTML = getAnalyticsHTML();
      var grid = document.getElementById('contacts-grid');
      if (grid) grid.parentNode.insertBefore(analyticsDiv, grid);

      var toggleBtn = document.createElement('button');
      toggleBtn.id = 'rcp-v2-toggle';
      toggleBtn.className = 'btn';
      toggleBtn.setAttribute('style', 'padding:4px 10px;font-size:9.5px;margin-left:4px');
      toggleBtn.textContent = 'Analytics';
      toggleBtn.addEventListener('click', function () {
        var el = document.getElementById('rcp-analytics');
        if (!el) return;
        var isVisible = el.style.display !== 'none';
        el.style.display = isVisible ? 'none' : '';
        el.innerHTML = isVisible ? '' : getAnalyticsHTML();
        toggleBtn.textContent = isVisible ? 'Analytics' : 'Hide';
      });
      bar.appendChild(toggleBtn);
    }
    tryInject();
  }

  /* ── ENHANCED CONTACT CARD RENDERING ──────────────────────────────── */
  function getBadgeHTML(c) {
    var badges = getStatusBadges(c);
    if (!badges.length) return '';
    return '<div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:3px">' +
      badges.map(function (b) {
        return '<span style="font-size:7px;padding:1px 4px;border-radius:3px;border:1px solid ' + b.color + ';color:' + b.color + ';opacity:.8">' + b.label + '</span>';
      }).join('') + '</div>';
  }

  function getPrefsHTML(c) {
    var prefs = getPreferences(c.id);
    if (!prefs.token && !prefs.chain) return '';
    var parts = [];
    if (prefs.token) parts.push('<span style="color:var(--teal)">' + prefs.token + '</span>');
    if (prefs.chain) parts.push('<span style="color:var(--muted2)">on ' + prefs.chain + '</span>');
    return '<div style="font-size:7.5px;color:var(--muted2);margin-top:2px">Prefers ' + parts.join(' ') + '</div>';
  }

  function getPayrollHTML(c) {
    var payroll = c.payroll;
    if (!payroll) return '';
    return '<div style="font-size:7.5px;color:var(--muted2);margin-top:2px">' +
      'Salary: ' + (payroll.amount || '—') + ' ' + (payroll.token || 'USDC') +
      (payroll.frequency ? ' · ' + payroll.frequency : '') + '</div>';
  }

  /* ── PATCH renderContacts ─────────────────────────────────────────── */
  function patchRenderContacts() {
    var orig = window.renderContacts;
    if (!orig || window.__contactsHubV2PatchedRender) return;

    window.renderContactsV2 = function () {
      var groupFilt = document.getElementById('rcp-group-filter');
      var groupVal = groupFilt ? groupFilt.value : 'all';
      var list = getFilteredContacts();
      if (groupVal !== 'all') {
        list = list.filter(function (c) {
          var v2 = v2Data[c.id] || {};
          return (v2.groups || []).indexOf(groupVal) !== -1;
        });
      }
      renderEnhancedContacts(list);
    };

    // Replace renderContacts permanently — preserves original behavior via V2 wrapper
    window.renderContacts = function () {
      // Ensure V2 UI is injected
      var gf = document.getElementById('rcp-group-filter');
      if (!gf) injectV2UI();
      return renderContactsV2();
    };
    window.__contactsHubV2PatchedRender = true;
    console.log('[ContactsHubV2] renderContacts patched for enhanced UI.');
  }

  function renderEnhancedContacts(list) {
    var grid = document.getElementById('contacts-grid');
    var empty = document.getElementById('rcp-empty');
    if (!grid) return;
    if (!list.length) { grid.innerHTML = ''; if (empty) empty.style.display = ''; updateSelectedCount(); return; }
    if (empty) empty.style.display = 'none';
    var GRAD = ['linear-gradient(135deg,#4f8ef7,#a78bfa)', 'linear-gradient(135deg,#f59e0b,#ef4444)', 'linear-gradient(135deg,#22c55e,#4f8ef7)', 'linear-gradient(135deg,#a78bfa,#ef4444)'];
    grid.innerHTML = list.map(function (c, i) {
      var chain = CHAINS.find(function (ch) { return ch.id === (c.chainId || 'Arc_Testnet'); }) || null;
      var addrShort = c.addr ? shortAddr(c.addr) : '<span style="color:var(--muted2);font-style:italic">No address</span>';
      var isSel = selectedContacts.has(c.id) ? 'checked' : '';
      var enriched = enrichContact(c);
      return '<div class="card" style="padding:13px;display:flex;align-items:flex-start;gap:10px;transition:border .15s" onmouseenter="this.style.borderColor=\'var(--blue)\'" onmouseleave="this.style.borderColor=\'\'">' +
        '<div style="width:36px;height:36px;border-radius:50%;background:' + GRAD[i % GRAD.length] + ';display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;flex-shrink:0">' + (c.name || '?')[0].toUpperCase() + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:11px;font-weight:600;display:flex;align-items:center;gap:5px;flex-wrap:wrap">' +
            c.name +
            '<i class="ti ' + (c.favorite ? 'ti-star-filled' : 'ti-star') + '" style="font-size:11px;color:' + (c.favorite ? 'var(--yellow)' : 'var(--muted2)') + ';cursor:pointer;margin-left:auto" onclick="toggleFav(\'' + c.id + '\',this)" title="Favorite"></i>' +
          '</div>' +
          '<div style="font-family:\'JetBrains Mono\',monospace;font-size:9px;color:var(--muted2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + addrShort + '</div>' +
          '<div style="display:flex;align-items:center;gap:4px;margin-top:3px;flex-wrap:wrap">' +
            '<div style="width:7px;height:7px;border-radius:50%;background:' + (chain ? chain.color : '#888') + '"></div>' +
            '<span style="font-size:8px;color:var(--muted2)">' + (chain ? chain.name : 'Unknown') + '</span>' +
          '</div>' +
          getBadgeHTML(c) +
          getPrefsHTML(enriched) +
          getPayrollHTML(enriched) +
          (c.note ? '<div style="font-size:8.5px;color:var(--muted2);margin-top:3px">' + c.note + '</div>' : '') +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;align-items:flex-end">' +
          '<input type="checkbox" class="contact-select" data-id="' + c.id + '" ' + isSel + ' onchange="toggleContactSelect(this)" style="margin-bottom:2px;accent-color:var(--blue)" title="Select for batch">' +
          (c.addr ? '<button class="btn" style="padding:2px 7px;font-size:8.5px" onclick="addToCurrentBatch(\'' + c.id + '\')"><i class="ti ti-plus"></i>Add</button>' : '') +
          '<button class="btn" style="padding:2px 7px;font-size:8.5px" onclick="ContactsHub.openContactCard(\'' + c.id + '\')" title="Details"><i class="ti ti-info-circle"></i></button>' +
          '<button class="btn" style="padding:2px 7px;font-size:8.5px;color:var(--red)" onclick="deleteContact(\'' + c.id + '\')"><i class="ti ti-trash"></i></button>' +
        '</div>' +
      '</div>';
    }).join('');
    updateSelectedCount();
  }

  /* ── INJECT ANALYTICS INTO RENDER ─────────────────────────────────── */
  function refreshAnalytics() {
    var el = document.getElementById('rcp-analytics');
    if (el && el.style.display !== 'none') {
      el.innerHTML = getAnalyticsHTML();
    }
  }

  /* ── INIT ─────────────────────────────────────────────────────────── */
  setTimeout(function () {
    loadV2();
    patchContacts();
    patchRenderContacts();
    // Force re-render and UI injection once DOM is ready
    setTimeout(function () {
      injectV2UI();
      try { window.renderContactsV2(); } catch (_) {}
      // Update page subtitle to show Hub is active
      try {
        var sub = document.querySelector('#page-recipients .page-sub');
        if (sub) sub.textContent = 'Financial Identity Layer · Contacts Hub V3';
      } catch (_) {}
      console.log('[ContactsHubV2] Initialized — ' + contacts.length + ' contacts, ' + Object.keys(v2Data).length + ' enriched.');
    }, 800);
  }, 200);

  /* ── EXPORTS ──────────────────────────────────────────────────────── */
  window.ContactsHub = {
    enrichContact: enrichContact,
    findByName: findByName,
    findExact: findExact,
    resolveAddress: resolveAddress,
    getGroupAddresses: getGroupAddresses,
    addToGroup: addToGroup,
    removeFromGroup: removeFromGroup,
    getGroupNames: getGroupNames,
    setPreferences: setPreferences,
    getPreferences: getPreferences,
    setPayroll: setPayroll,
    getPayrollContacts: getPayrollContacts,
    addNote: addNote,
    getStatusBadges: getStatusBadges,
    getAnalytics: getAnalytics,
    smartCSVImport: smartCSVImport,
    openContactCard: openContactCard,
    quickSend: quickSend,
    refreshAnalytics: refreshAnalytics,
    injectV2UI: injectV2UI,
    setActiveContact: setActiveContact,
    getActiveContact: getActiveContact,
    clearActiveContact: clearActiveContact,
    getContactHistory: getContactHistory,
    getContactSchedules: getContactSchedules,
    getContactPermissions: getContactPermissions,
    setContactPermissions: setContactPermissions,
    setCRM: setCRM,
    getCRM: getCRM,
    setCrosschain: setCrosschain,
    getCrosschain: getCrosschain,
    _switchTab: _switchTab,
    v2Data: v2Data,
    ALL_TAGS: ALL_TAGS,
    GROUP_PRESETS: GROUP_PRESETS,
    REL_TYPES: REL_TYPES,
    RISK_LEVELS: RISK_LEVELS
  };

})();
