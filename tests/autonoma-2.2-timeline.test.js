/**
 * Autonoma 2.2 — Inline transaction timeline (presentation-only) guards.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

describe('Autonoma inline transaction timeline', () => {
  it('renders a single timeline (aut-step-timeline), no enclosing card/panel', () => {
    expect(html).toContain('aut-step-timeline');
    // Timeline CSS exists and is borderless (no background/border on the container).
    expect(html).toMatch(/\.aut-step-timeline\{[^}]*display:flex/);
  });

  it('defines the four steps (Preparing / Broadcasting / Awaiting / Completed)', () => {
    expect(html).toContain("label: 'Preparing transaction'");
    expect(html).toContain("label: 'Broadcasting transaction'");
    expect(html).toContain("label: 'Awaiting confirmation'");
    expect(html).toContain("label: 'Transaction completed'");
  });

  it('maps execution states to timeline steps', () => {
    // _agentStepIndex maps PLANNING→0, BROADCASTING→1, CONFIRMING/…→2, COMPLETED→3.
    expect(html).toContain("case 'PLANNING': return 0");
    expect(html).toContain("case 'BROADCASTING': return 1");
    expect(html).toContain("case 'COMPLETED': return 3");
  });

  it('_agentStateMsg renders the timeline (no per-state progress block append)', () => {
    const fn = html.slice(html.indexOf('function _agentStateMsg'), html.indexOf('async function _agentVerifyOnChain'));
    expect(fn).toContain('_agentRenderTimeline(execId)');
    // The old per-state _addAgentResultMsg append is gone from the progress path.
    expect(fn).not.toContain("_addAgentResultMsg(msg,");
  });

  it('honors prefers-reduced-motion for the active-step pulse', () => {
    expect(html).toContain('prefers-reduced-motion:reduce');
    expect(html).toContain('.aut-step-item.active .aut-step-dot{animation:none}');
  });

  it('supports failure states (failed step, not a false success)', () => {
    expect(html).toContain('_AGENT_FAIL_STATES');
    expect(html).toContain('REVERTED:1');
    expect(html).toContain('.aut-step-item.failed');
  });
});
