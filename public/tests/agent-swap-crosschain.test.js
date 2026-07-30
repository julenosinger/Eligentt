/**
 * SWAP & CROSSCHAIN PAYMENT — Agent executor safety tests
 * ═══════════════════════════════════════════════════════════
 * Covers: swap plan building with real pool routing, bridge recipient passthrough,
 * crosschain payment chat routing, and schedule crosschain recipient field.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const schedExecSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentScheduleExecutor.js'), 'utf8');

describe('_agentExecuteBridge — crosschain recipient passthrough', () => {
  const fn = html.slice(
    html.indexOf('async function _agentExecuteBridge('),
    html.indexOf('async function _agentExecuteTurboBridge')
  );

  it('accepts a 6th argument recipientAddr and validates it', () => {
    expect(fn).toContain('recipientAddr');
    expect(fn).toContain("var payoutRecipient");
    expect(fn).toContain("var mintRecipient = ethers.zeroPadValue(payoutRecipient || agentAddr, 32)");
  });

  it('shows the recipient in the PLANNING state message', () => {
    expect(fn).toContain('? \' → recipient \'+payoutRecipient.substring(0,8)');
  });

  it('uses the agent address as fallback when recipient is not provided (bridge-to-self)', () => {
    expect(fn).toContain('payoutRecipient || agentAddr');
  });

  it('displays the recipient in the completion success card', () => {
    expect(fn).toContain("payoutRecipient ? 'Recipient: ");
  });

  it('records the recipient in the AgentAudit execution log', () => {
    expect(fn).toContain("recipient: payoutRecipient || agentAddr");
  });
});

describe('_agentExecuteOp — crosschain branch forwards recipient', () => {
  const fn = html.slice(
    html.indexOf("else if(operation==='crosschain'){"),
    html.indexOf("else if(operation==='add_liquidity')")
  );

  it('extracts recipient from paramsJson (recipient or address key)', () => {
    expect(fn).toContain("xParams.recipient || xParams.address");
    expect(fn).toContain("var xRecipient");
  });

  it('passes recipient as 6th argument to _agentExecuteBridge', () => {
    expect(fn).toContain('_agentExecuteBridge(amount, xDomain, xDestChain, xCid, xSrcChainId, xRecipient)');
  });

  it('shows the recipient in the PLANNING state', () => {
    expect(fn).toContain("(xRecipient ? ' for '+String(xRecipient).substring(0,8)");
  });
});

describe('autPayment — crosschain routing detection', () => {
  const fn = html.slice(
    html.indexOf('function autPayment(msg)'),
    html.indexOf('function autProcessCSV')
  );

  it('forwards crosschain messages (recipient + destination network) to _handleCrossChain', () => {
    expect(fn).toContain("return _handleCrossChain(msg");
    expect(fn).toContain("toChain:");
    expect(fn).toContain("cMap[xNet[1]]");
  });

  it('detects networks: base, arbitrum, optimism, polygon, ethereum, sepolia', () => {
    const netRx = fn.match(/\\b\((?:on|to|at|na|no|em|para a|pra)\)\\s\+\\\(([^)]+)\)/);
    if (netRx) {
      const nets = netRx[1];
      expect(nets).toContain('base');
      expect(nets).toContain('arbitrum');
      expect(nets).toContain('ethereum');
    }
  });

  it('only forwards when both a network AND a wallet address are present', () => {
    expect(fn).toContain('xNet');
    expect(fn).toContain('/0x[a-fA-F0-9]{40}/');
  });
});

describe('_handleCrossChain — agent execution passes recipient', () => {
  const fn = html.slice(
    html.indexOf('function _handleCrossChain('),
    html.indexOf('function _handleDefault')
  );

   it('maps destination chain to CCTP domain', () => {
    expect(fn).toContain("'Base':6");
    expect(fn).toContain("'Polygon':7");
    expect(fn).toContain("'Ethereum':0");
    expect(fn).toContain("'Arbitrum':3");
    expect(fn).toContain("'Optimism':2");
  });

  it('detects target chain via "on/at/in <network>" pattern from the message', () => {
    expect(fn).toContain("(?:on|at|na|no|in|em|para a|pra)");
    expect(fn).toContain("chM && chainMap[chM[1]]");
  });

  it('builds bridge calldata with padded mintRecipient from destAddr', () => {
    expect(fn).toContain("ethers.zeroPadValue(destAddr, 32)");
  });

  it('passes destAddr to _agentExecuteBridge in the Execute-via-Agent action', () => {
    expect(fn).toContain('_agentExecuteBridge(');
    expect(fn).toContain('destAddr');
    var actionStr = fn.slice(fn.indexOf('Execute via Agent'), fn.indexOf('Execute via Agent') + 300);
    expect(actionStr).toContain('destAddr');
    expect(actionStr).toContain('_agentExecuteBridge(');
  });
});

describe('AgentScheduleExecutor — crosschain schedule recipient pass-through', () => {
  it('passes recipient address from schedule data to _agentExecuteBridge', () => {
    const fnBody = schedExecSrc.slice(schedExecSrc.indexOf('_delegateExecution'));
    expect(fnBody).toContain("crossRecipient");
    expect(fnBody).toContain("sched.recipients && sched.recipients.length && sched.recipients[0].addr");
  });

  it('passes recipient as 6th argument for crosschain, null for bridge', () => {
    const fnBody = schedExecSrc.slice(schedExecSrc.indexOf('_delegateExecution'));
    expect(fnBody).toContain("args = [v.total, domain, destNet.replace");
    expect(fnBody).toContain("crossRecipient]");
    expect(fnBody).toContain("sched.type === 'crosschain'");
  });
});
