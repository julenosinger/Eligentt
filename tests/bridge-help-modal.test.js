import { describe, it, expect } from 'vitest';
import fs from 'fs';
import vm from 'vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const jsStart = html.indexOf('// ── Bridge Help & Recovery (informational modal; no transactions)');
const jsEnd = html.indexOf('// ── Bridge History Panel (slide-in, mirrors Swap History)');
const HELP_JS = html.slice(jsStart, jsEnd);

const cssStart = html.indexOf('/* ═══ Bridge Help & Recovery modal');
const cssEnd = html.indexOf('.brg-hist-overlay {', cssStart);
const HELP_CSS = html.slice(cssStart, cssEnd);

describe('Bridge Help: header button', () => {
  const m = html.match(/<button class="brg-hist-btn brg-help-btn"[^>]*>[\s\S]*?<\/button>/);
  it('exists in the Bridge page header, directly before History', () => {
    expect(m).toBeTruthy();
    const pageStart = html.indexOf('<div class="page" id="page-bridge">');
    const helpAt = html.indexOf('id="brg-help-btn"');
    const histAt = html.indexOf('id="brg-hist-btn"');
    expect(helpAt).toBeGreaterThan(pageStart);
    expect(histAt).toBeGreaterThan(helpAt);
    expect(histAt - helpAt).toBeLessThan(500);
  });
  it('is a real button with a question icon, accessible name and dialog hint', () => {
    expect(m[0]).toContain('type="button"');
    expect(m[0]).toContain('onclick="brgOpenHelp()"');
    expect(m[0]).toContain('ti-help-circle');
    expect(m[0]).toContain('aria-label="Help"');
    expect(m[0]).toContain('aria-haspopup="dialog"');
    expect(m[0]).toContain('>Help<');
  });
  it('History button is untouched', () => {
    expect(html).toContain('<button class="brg-hist-btn" id="brg-hist-btn" onclick="brgOpenHistory()" title="View bridge history">');
  });
});

describe('Bridge Help: content', () => {
  it('has the required copy', () => {
    for (const t of [
      'Bridge Help &amp; Recovery',
      'Having trouble completing your CCTP transfer?',
      'Mint not completed?',
      'If your source transaction was confirmed but your funds have not arrived, your transfer may still be awaiting attestation or minting.',
      'How to recover your transfer',
      'Open your Bridge transaction history.',
      'Locate the original CCTP transfer.',
      'Copy the source transaction hash.',
      'Open the external CCTP recovery tool.',
      'Follow the available recovery instructions and verify the destination network, recipient and transaction status.',
      'Open CCTP Recovery',
      'Never share your private key or recovery phrase.',
      'Do not initiate another transfer before verifying the original transaction.',
      'Recovery availability depends on the transaction status and protocol.',
      'This recovery guidance applies to Circle CCTP transfers.',
    ]) expect(HELP_JS).toContain(t);
  });
  it('external link is exact and safe', () => {
    expect(HELP_JS).toContain('href="https://www.cctp.io/bridge" target="_blank" rel="noopener noreferrer"');
  });
  it('marks the link as external, unverified, and promises no recovery', () => {
    expect(HELP_JS).toContain('external, third-party website');
    expect(HELP_JS).toContain('has not verified it as an official Circle tool');
    expect(HELP_JS).toContain('Recovery is not guaranteed');
    expect(HELP_JS).not.toMatch(/is the official/i);
  });
  it('separates LI.FI / other providers from CCTP guidance', () => {
    expect(HELP_JS).toMatch(/LI\.FI or other providers are not covered by this CCTP guidance/);
    expect(HELP_JS).toMatch(/status page of the provider/);
  });
});

describe('Bridge Help: informational only', () => {
  it('never touches the engine, wallet, network or timers', () => {
    for (const bad of ['fetch(', 'XMLHttpRequest', 'setInterval', 'setTimeout', 'window.open', 'signer', 'ethers', 'sendTransaction', 'approve', 'saveBridgeHistory', 'updateBridgeHistory', 'executeBridge', 'brSelectRoute', '_selectedBridgeRoute', 'walletAddress', 'localStorage'])
      expect(HELP_JS).not.toContain(bad);
  });
  it('listens for keydown only while open and removes it on close', () => {
    expect((HELP_JS.match(/addEventListener\('keydown'/g) || []).length).toBe(1);
    expect((HELP_JS.match(/removeEventListener\('keydown'/g) || []).length).toBe(1);
  });
});

describe('Bridge Help: real open/close handlers on a minimal DOM', () => {
  function build() {
    const docListeners = new Set();
    const body = [];
    const mk = () => {
      const el = { className: '', innerHTML: '', attrs: {}, listeners: {}, removed: false,
        setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
        addEventListener(t, f) { this.listeners[t] = f; }, remove() { this.removed = true; const i = body.indexOf(this); if (i >= 0) body.splice(i, 1); },
        querySelectorAll() { return []; } };
      return el;
    };
    const opener = { focused: 0, focus() { this.focused++; } };
    const cta = { focused: 0, focus() { this.focused++; } };
    const doc = {
      activeElement: opener,
      createElement: mk,
      body: { appendChild(el) { el.id = el.id; body.push(el); } },
      getElementById(id) { if (id === 'brg-help-cta') return body.length ? cta : null; return body.find(e => e.id === id) || null; },
      addEventListener(t, f) { if (t === 'keydown') docListeners.add(f); },
      removeEventListener(t, f) { docListeners.delete(f); },
    };
    const ctx = { document: doc, console };
    vm.createContext(ctx);
    vm.runInContext(HELP_JS, ctx);
    return { ctx, body, docListeners, opener, cta };
  }

  it('opens once, focuses the CTA, closes on Escape and restores focus', () => {
    const t = build();
    t.ctx.brgOpenHelp();
    expect(t.body.length).toBe(1);
    expect(t.body[0].id).toBe('brg-help-modal');
    expect(t.body[0].attrs.role).toBe('dialog');
    expect(t.body[0].attrs['aria-modal']).toBe('true');
    expect(t.cta.focused).toBe(1);
    t.ctx.brgOpenHelp();
    expect(t.body.length).toBe(1);
    expect(t.docListeners.size).toBe(1);
    const key = [...t.docListeners][0];
    key({ key: 'Escape' });
    expect(t.body.length).toBe(0);
    expect(t.docListeners.size).toBe(0);
    expect(t.opener.focused).toBe(1);
  });

  it('closes on backdrop click only (not on clicks inside the box)', () => {
    const t = build();
    t.ctx.brgOpenHelp();
    const modal = t.body[0];
    modal.listeners.click({ target: {} });
    expect(t.body.length).toBe(1);
    modal.listeners.click({ target: modal });
    expect(t.body.length).toBe(0);
  });

  it('repeated open/close cycles leave no listeners behind', () => {
    const t = build();
    for (let i = 0; i < 5; i++) { t.ctx.brgOpenHelp(); t.ctx.brgCloseHelp(); }
    expect(t.docListeners.size).toBe(0);
    expect(t.body.length).toBe(0);
    t.ctx.brgCloseHelp();
  });
});

describe('Bridge Help: isolated styles', () => {
  const rules = HELP_CSS.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.split('{')[0].trim()).filter(Boolean);
  it('every selector is brg-help-* (optionally light-scoped or inside a media query)', () => {
    expect(rules.length).toBeGreaterThan(15);
    for (const sel of rules) {
      const parts = sel.replace(/^@media[^{]*$/, '').split(',').map(x => x.trim()).filter(Boolean);
      for (const part of parts) expect(part).toMatch(/\.brg-help-/);
    }
  });
  it('no !important and nothing global', () => {
    expect(HELP_CSS).not.toContain('!important');
    expect(HELP_CSS).not.toMatch(/(^|\n)\s*(body|html|\*|div|button|input)\b/);
  });
  it('reuses the existing modal shell instead of a new one', () => {
    expect(HELP_JS).toContain("modal.className = 'ns-overlay brg-help-overlay'");
    expect(HELP_JS).toContain('class="ns-box brg-help-box"');
    expect(HELP_JS).toContain('class="ns-close"');
  });
});

describe('Bridge engine and history left alone', () => {
  it('existing handlers remain', () => {
    for (const fn of ['function brgOpenHistory()', 'function brgCloseHistory()', 'function brSelectRoute(', 'function _brsRenderRoutes(', 'function brgOpenNetPicker', 'function brgCloseNetPicker()'])
      expect(html).toContain(fn);
  });
});
