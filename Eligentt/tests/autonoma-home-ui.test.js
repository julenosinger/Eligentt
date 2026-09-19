/**
 * AUTONOMA HOME — landing screen shortcut cards removal (presentation cleanup).
 * ═══════════════════════════════════════════════════════════════════════════
 * The Autonoma home/landing used to render a grid of shortcut cards
 * (Payment Link, Wallet Summary, Swap Tokens, Bridge Assets, What can you do?,
 * History, How to Use, Financial Docs, Permissions). Those shortcuts were
 * removed so the chat is the single discovery/execution surface.
 *
 * These are STRUCTURAL guards only — they assert the cards are gone from the
 * landing markup while the chat input, voice input, welcome header and every
 * capability/tool/route remain fully available.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function between(start, end) {
  const i = html.indexOf(start);
  if (i < 0) return '';
  const j = html.indexOf(end, i);
  return html.slice(i, j < 0 ? html.length : j);
}

describe('Autonoma home — shortcut cards removed', () => {
  it('renders no shortcut-card container or card markup', () => {
    expect(html).not.toContain('class="aut-cards"');
    expect(html).not.toContain('id="aut-cards"');
    expect(html).not.toContain('class="aut-card"');
  });

  it('renders no card title/description elements', () => {
    expect(html).not.toContain('aut-card-title');
    expect(html).not.toContain('aut-card-desc');
  });

  it('dynamic welcome renderer (mkWelcome) no longer emits cards', () => {
    const fn = between('function mkWelcome()', 'return d;');
    expect(fn).not.toContain('aut-card');
    expect(fn).not.toContain('aut-cards');
    expect(fn).not.toContain('autonomaSendQuick');
  });

  it('dead card CSS was removed (no aut-card rules remain)', () => {
    expect(html).not.toContain('.aut-cards{');
    expect(html).not.toContain('.aut-card{');
    expect(html).not.toContain('.aut-card:hover{');
    expect(html).not.toContain('.aut-card-title{');
    expect(html).not.toContain('.aut-card-desc{');
  });
});

describe('Autonoma home — conversation surface preserved', () => {
  it('welcome header still greets the user', () => {
    expect(html).toContain('id="aut-welcome"');
    expect(html).toContain("Hello! I'm Autonoma");
    expect(html).toContain('Your AI agent for all operations on Elligentt.');
    expect(html).toContain('How can I help you today?');
  });

  it('chat input, voice input and send button remain intact', () => {
    expect(html).toContain('id="aut-input"');
    expect(html).toContain('placeholder="Type or speak your request..."');
    expect(html).toContain('id="aut-mic-btn"');
    expect(html).toContain('id="aut-send-btn"');
    expect(html).toContain('onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();autonomaSend()}"');
  });

  it('welcome renderer still exists and is wired to the empty-chat state', () => {
    expect(html).toContain('function mkWelcome()');
    expect(html).toContain('c.appendChild(mkWelcome())');
  });
});

describe('Autonoma home — no capability was removed', () => {
  it('chat execution entry points remain', () => {
    expect(html).toContain('window.autonomaSendQuick');
    expect(html).toContain('window.autonomaSend');
    expect(html).toContain('autonomaHandleFile');
  });

  it('financial capability surfaces still exist', () => {
    expect(html).toContain('showPage(\'links\')');   // Payment Links
    expect(html).toContain('showPage(\'bridge\')');  // Bridge
    expect(html).toContain('id="page-swap"');        // Swap
    expect(html).toContain('id="page-bridge"');      // Bridge page
  });

  it('autonoma intent/tool routing tables still present', () => {
    expect(html).toContain('payment_link');
    expect(html).toContain('SWAP_EXECUTE');
    expect(html).toContain('BRIDGE');
  });
});
