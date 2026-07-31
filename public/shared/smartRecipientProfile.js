/**
 * SmartRecipientProfile v2.0 — ELLIGENTT SMART RECIPIENTS
 * Surgical extension: adds optional metadata to existing contacts.
 * ZERO breaking changes. All fields optional. Backward compatible.
 * Attached to window.SmartRecipient
 */
(function () {
  'use strict';

  var STORE_KEY = 'arcpay_contacts_smart';
  var smartData = {};

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      smartData = raw ? JSON.parse(raw) : {};
    } catch (_e) { smartData = {}; }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(smartData)); } catch (_e) {}
  }

  var RECIPIENT_TYPES = [
    'Individual', 'Employee', 'Freelancer', 'Supplier', 'Merchant',
    'DAO', 'Treasury', 'Agent Wallet', 'Smart Contract', 'Vault',
    'Customer', 'Investor', 'Other'
  ];

  var SUPPORTED_NETWORKS = [
    'Arc Testnet', 'Ethereum Sepolia', 'Base Sepolia',
    'Arbitrum Sepolia', 'Solana Devnet'
  ];

  var SUPPORTED_TOKENS = ['USDC', 'EURC', 'cirBTC', 'ETH', 'Custom'];

  function _defaults(cid) {
    return {
      recipientType: '',
      description: '',
      networks: [],
      preferredSettlement: '',
      supportedTokens: [],
      paymentPrefs: { preferredToken: '', defaultAmount: 0, defaultFrequency: '', preferredExecutor: '', paymentNotes: '', paymentCategory: '' },
      crosschainPrefs: { allowCrosschain: false, autoBridge: false, cheapestRoute: false, preferredDestChain: '', requireConfirmation: false, settlementPrefs: '' },
      payrollSettings: { payrollEnabled: false, payrollRecipient: false, monthlySalary: 0, weeklySalary: 0, freelancerPayments: false },
      autonomaProfile: { trustedRecipient: false, autonomousExec: false, aiWalletCompatible: false, agentWalletCompatible: false, scheduleCompatible: true, payrollCompatible: false, crosschainCompatible: false, invoiceCompatible: false },
      agentWalletProfile: { agentWalletAddress: '', trustScore: 0, allowedOps: [], autonomousCapabilities: [], preferredExecutor: '' },
      financialStats: { totalReceived: 0, totalSent: 0, totalSchedules: 0, totalCrosschain: 0, totalPayroll: 0, totalInvoices: 0, totalLinks: 0, totalMultisend: 0, totalBatch: 0, successRate: 100 },
      tags: []
    };
  }

  function getProfile(cid) {
    if (!cid) return _defaults('');
    var base = _defaults(cid);
    var stored = smartData[cid];
    if (!stored) return base;
    return deepMerge(base, stored);
  }

  function deepMerge(base, override) {
    var out = {};
    for (var k in base) {
      if (override[k] === undefined) { out[k] = base[k]; continue; }
      if (typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) {
        out[k] = deepMerge(base[k], override[k] || {});
      } else {
        out[k] = override[k];
      }
    }
    return out;
  }

  function saveProfile(cid, updates) {
    if (!cid) return false;
    smartData[cid] = getProfile(cid);
    if (updates) {
      for (var k in updates) {
        if (typeof updates[k] === 'object' && updates[k] !== null && !Array.isArray(updates[k])) {
          smartData[cid][k] = deepMerge(smartData[cid][k] || {}, updates[k]);
        } else {
          smartData[cid][k] = updates[k];
        }
      }
    }
    save();
    return true;
  }

  function deleteProfile(cid) {
    delete smartData[cid];
    save();
  }

  function getAllProfiles() {
    var profiles = {};
    try {
      var contacts = (typeof window.contacts !== 'undefined') ? window.contacts : [];
      for (var i = 0; i < contacts.length; i++) {
        var cid = contacts[i].id;
        profiles[cid] = getProfile(cid);
      }
    } catch (_e) {}
    return profiles;
  }

  /* ── Autonoma lookup helpers ── */

  function findByType(type) {
    var results = [];
    try {
      var contacts = (typeof window.contacts !== 'undefined') ? window.contacts : [];
      for (var i = 0; i < contacts.length; i++) {
        var p = getProfile(contacts[i].id);
        if (p.recipientType === type) results.push({ contact: contacts[i], profile: p });
      }
    } catch (_e) {}
    return results;
  }

  function findByTag(tag) {
    var results = [];
    try {
      var contacts = (typeof window.contacts !== 'undefined') ? window.contacts : [];
      for (var i = 0; i < contacts.length; i++) {
        var p = getProfile(contacts[i].id);
        if (p.tags && p.tags.indexOf(tag) !== -1) results.push({ contact: contacts[i], profile: p });
      }
    } catch (_e) {}
    return results;
  }

  function getPayrollRecipients() {
    var results = [];
    try {
      var contacts = (typeof window.contacts !== 'undefined') ? window.contacts : [];
      for (var i = 0; i < contacts.length; i++) {
        var p = getProfile(contacts[i].id);
        if (p.payrollSettings && p.payrollSettings.payrollEnabled &&
            (p.recipientType === 'Employee' || p.recipientType === 'Freelancer' ||
             p.tags.indexOf('Payroll') !== -1 || p.tags.indexOf('Employee') !== -1)) {
          results.push({ contact: contacts[i], profile: p });
        }
      }
    } catch (_e) {}
    return results;
  }

  function getSupplierRecipients() {
    return findByType('Supplier');
  }

  function getTrustedRecipients() {
    var results = [];
    try {
      var contacts = (typeof window.contacts !== 'undefined') ? window.contacts : [];
      for (var i = 0; i < contacts.length; i++) {
        var p = getProfile(contacts[i].id);
        if (p.autonomaProfile && p.autonomaProfile.trustedRecipient) results.push({ contact: contacts[i], profile: p });
      }
    } catch (_e) {}
    return results;
  }

  function findCrosschainCompatible() {
    var results = [];
    try {
      var contacts = (typeof window.contacts !== 'undefined') ? window.contacts : [];
      for (var i = 0; i < contacts.length; i++) {
        var p = getProfile(contacts[i].id);
        if (p.crosschainPrefs && p.crosschainPrefs.allowCrosschain) results.push({ contact: contacts[i], profile: p });
      }
    } catch (_e) {}
    return results;
  }

  function getContactForBridge(name) {
    try {
      var contacts = (typeof window.contacts !== 'undefined') ? window.contacts : [];
      var match = null;
      for (var i = 0; i < contacts.length; i++) {
        if (contacts[i].name.toLowerCase() === name.toLowerCase()) { match = contacts[i]; break; }
      }
      if (!match) return null;
      var p = getProfile(match.id);
      return {
        contact: match,
        preferredToken: p.paymentPrefs.preferredToken || 'USDC',
        preferredChain: p.crosschainPrefs.preferredDestChain || match.chainId || 'Arc_Testnet',
        allowCrosschain: p.crosschainPrefs.allowCrosschain !== false,
        preferredRoute: p.crosschainPrefs.cheapestRoute ? 'cheapest' : 'default'
      };
    } catch (_e) { return null; }
  }

  /* ── Stats tracking ── */

  function recordPayment(cid, amount, type) {
    if (!cid) return;
    var p = getProfile(cid);
    p.financialStats.totalSent = (p.financialStats.totalSent || 0) + (Number(amount) || 0);
    p.financialStats.totalBatch = (p.financialStats.totalBatch || 0) + 1;
    if (type === 'payroll') p.financialStats.totalPayroll = (p.financialStats.totalPayroll || 0) + 1;
    if (type === 'crosschain') p.financialStats.totalCrosschain = (p.financialStats.totalCrosschain || 0) + 1;
    if (type === 'multisend') p.financialStats.totalMultisend = (p.financialStats.totalMultisend || 0) + 1;
    if (type === 'schedule') p.financialStats.totalSchedules = (p.financialStats.totalSchedules || 0) + 1;
    if (type === 'invoice') p.financialStats.totalInvoices = (p.financialStats.totalInvoices || 0) + 1;
    var total = p.financialStats.totalSent + p.financialStats.totalReceived;
    p.financialStats.successRate = total > 0 ? Math.round(((total - 1) / total) * 100) : 100;
    saveProfile(cid, { financialStats: p.financialStats });
  }

  function recordReceived(cid, amount) {
    if (!cid) return;
    var p = getProfile(cid);
    p.financialStats.totalReceived = (p.financialStats.totalReceived || 0) + (Number(amount) || 0);
    var total = p.financialStats.totalSent + p.financialStats.totalReceived;
    p.financialStats.successRate = total > 0 ? Math.round(((total) / total) * 100) : 100;
    saveProfile(cid, { financialStats: p.financialStats });
  }

  /* ── CSV export/import compatibility ── */

  function exportSmartCSV() {
    try {
      var contacts = (typeof window.contacts !== 'undefined') ? window.contacts : [];
      var rows = [['name', 'address', 'note', 'chain', 'type', 'tags', 'preferredToken', 'preferredChain', 'monthlySalary', 'payrollEnabled', 'trusted']];
      for (var i = 0; i < contacts.length; i++) {
        var c = contacts[i];
        var p = getProfile(c.id);
        rows.push([
          c.name, c.addr, c.note || '', c.chainId || '',
          p.recipientType || '',
          (p.tags || []).join(';'),
          p.paymentPrefs.preferredToken || '',
          p.crosschainPrefs.preferredDestChain || '',
          p.payrollSettings.monthlySalary || 0,
          p.payrollSettings.payrollEnabled ? 'Yes' : '',
          p.autonomaProfile.trustedRecipient ? 'Yes' : ''
        ]);
      }
      var csv = rows.map(function (r) { return r.join(','); }).join('\n');
      var a = document.createElement('a');
      a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
      a.download = 'elligente-smart-contacts.csv';
      a.click();
    } catch (_e) {}
  }

  /* ── Batch operations ── */

  function addToBatchByTag(tag) {
    var found = findByTag(tag);
    var added = 0;
    try {
      if (typeof window.recipients === 'undefined') return 0;
      for (var i = 0; i < found.length; i++) {
        window.recipients.push({
          name: found[i].contact.name,
          addr: found[i].contact.addr,
          amount: String(found[i].profile.paymentPrefs.defaultAmount || '0.00'),
          note: found[i].profile.paymentPrefs.paymentNotes || found[i].contact.note || '',
          chainId: found[i].contact.chainId || 'Arc_Testnet',
          token: found[i].profile.paymentPrefs.preferredToken || 'USDC'
        });
        added++;
      }
    } catch (_e) {}
    return added;
  }

  load();

  window.SmartRecipient = {
    getProfile: getProfile,
    saveProfile: saveProfile,
    deleteProfile: deleteProfile,
    getAllProfiles: getAllProfiles,
    findByType: findByType,
    findByTag: findByTag,
    getPayrollRecipients: getPayrollRecipients,
    getSupplierRecipients: getSupplierRecipients,
    getTrustedRecipients: getTrustedRecipients,
    findCrosschainCompatible: findCrosschainCompatible,
    getContactForBridge: getContactForBridge,
    recordPayment: recordPayment,
    recordReceived: recordReceived,
    exportSmartCSV: exportSmartCSV,
    addToBatchByTag: addToBatchByTag,
    RECIPIENT_TYPES: RECIPIENT_TYPES.slice(),
    SUPPORTED_NETWORKS: SUPPORTED_NETWORKS.slice(),
    SUPPORTED_TOKENS: SUPPORTED_TOKENS.slice()
  };
})();
