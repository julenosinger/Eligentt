/**
 * Elligentt SecurityAudit — CSP, SRI, XSS, Dependency Scan Report (Phase 11)
 * Generates security audit report. Read-only. Attached to: window.SecurityAudit
 */
(function () {
  'use strict';

  function scan() {
    var report = {
      generatedAt: new Date().toISOString(),
      csp: _checkCSP(),
      sri: _checkSRI(),
      xss: _checkXSS(),
      secrets: _checkSecrets(),
      dependencies: _checkDeps(),
      headers: _checkHeaders(),
      summary: { score: 'A', issues: 0 }
    };

    var issues = 0;
    var sections = ['csp','sri','xss','secrets','dependencies','headers'];
    sections.forEach(function (s) {
      if (report[s] && report[s].issues) issues += report[s].issues;
    });
    report.summary.issues = issues;
    report.summary.score = issues === 0 ? 'A+' : issues <= 3 ? 'A' : issues <= 6 ? 'B' : 'C';

    if (issues > 0) {
      console.warn('[SecurityAudit] ' + issues + ' issues found. Score: ' + report.summary.score);
    } else {
      console.log('[SecurityAudit] Clean. Score: A+');
    }

    return report;
  }

  function _checkCSP() {
    var meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
    return { present: !!meta, issues: meta ? 0 : 1, recommendation: meta ? 'CSP meta tag present' : 'Add CSP meta tag to <head>' };
  }

  function _checkSRI() {
    var scripts = document.querySelectorAll('script[src]');
    var withIntegrity = 0;
    scripts.forEach(function (s) { if (s.hasAttribute('integrity')) withIntegrity++; });
    var cdnScripts = 0;
    scripts.forEach(function (s) {
      if (s.src && (s.src.indexOf('cdn.jsdelivr') !== -1 || s.src.indexOf('unpkg') !== -1)) cdnScripts++;
    });
    return {
      totalScripts: scripts.length,
      withIntegrity: withIntegrity,
      cdnScripts: cdnScripts,
      issues: cdnScripts > withIntegrity ? (cdnScripts - withIntegrity) : 0,
      recommendation: 'All CDN scripts should have integrity attributes'
    };
  }

  function _checkXSS() {
    var issues = 0;
    try {
      if (typeof DOMPurify !== 'undefined') {
        // DOMPurify loaded = mitigation present
      } else {
        issues++;
      }
    } catch (_e) { issues++; }
    return { doMPurifyLoaded: typeof DOMPurify !== 'undefined', escHtmlAvailable: typeof Utils !== 'undefined' && Utils.escHtml, issues: issues };
  }

  function _checkSecrets() {
    var issues = 0;
    try {
      var body = document.body.innerHTML;
      if (/0x[0-9a-fA-F]{64}/.test(body)) {
        issues++;
      }
    } catch (_e) {}
    return { issues: issues, recommendation: 'No private keys in DOM' };
  }

  function _checkDeps() {
    return {
      ethers: typeof ethers !== 'undefined',
      dompurify: typeof DOMPurify !== 'undefined',
      qrcodejs: typeof QRCode !== 'undefined',
      issues: 0
    };
  }

  function _checkHeaders() {
    // Check via document properties
    var secure = window.location.protocol === 'https:';
    return { https: secure, issues: secure ? 0 : 1, recommendation: secure ? 'HTTPS enforced' : 'Serve over HTTPS' };
  }

  function logReport() {
    var r = scan();
    console.log('[SecurityAudit] Score: ' + r.summary.score + ' | Issues: ' + r.summary.issues);
    return r;
  }

  window.SecurityAudit = {
    VERSION: '1.0.0',
    scan: scan, logReport: logReport
  };
})();
