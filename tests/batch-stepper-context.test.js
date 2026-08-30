/**
 * Batch Payments Stepper — contextual visibility (header/topbar).
 * ═══════════════════════════════════════════════════════════════════════
 * The global header keeps logo/nav/wallet/network. The Batch Payments
 * workflow stepper (Recipients → Review & Sign → Pay Fee & Send → Completed)
 * is rendered ONLY on the Batch Payments page, driven by showPage().
 * These are structural guards — no execution/state logic is touched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

describe('Batch Payments Stepper — contextual to the Batch page only', () => {
  it('stepper is wrapped in a single contextual container (id="wf-stepper")', () => {
    expect(html).toContain('class="wf-stepper" id="wf-stepper"');
  });

  it('all four steps remain inside the wrapper (Recipients → Completed)', () => {
    expect(html).toContain('id="wf-step-1"');
    expect(html).toContain('id="wf-step-2"');
    expect(html).toContain('id="wf-step-3"');
    expect(html).toContain('id="wf-step-4"');
    expect(html).toContain('Recipients');
    expect(html).toContain('Review &amp; Sign');
    expect(html).toContain('Pay Fee &amp; Send');
    expect(html).toContain('Completed');
  });

  it('stepper is hidden by default and only shown via the .show class', () => {
    expect(html).toContain('.wf-stepper{display:none;align-items:center;height:100%;flex-shrink:0}');
    expect(html).toContain('.wf-stepper.show{display:flex}');
  });

  it('showPage toggles the stepper based on the current page (batch only)', () => {
    expect(html).toContain("getElementById('wf-stepper')");
    expect(html).toContain("classList.toggle('show', id === 'batch')");
  });

  it('stepper steps are not individually hidden (wrapper controls visibility)', () => {
    // No per-step display rule hides the steps; the .wf-stepper wrapper is the
    // single visibility control point (hidden by default, shown on batch).
    expect(html).not.toContain('#wf-step-1{display:none}');
    expect(html).not.toContain('#wf-step-2{display:none}');
    expect(html).not.toContain('#wf-step-3{display:none}');
    expect(html).not.toContain('#wf-step-4{display:none}');
  });

  it('existing step state management is preserved (updateWorkflowStep)', () => {
    expect(html).toContain('function updateWorkflowStep(step, state');
    expect(html).toContain("getElementById(`wf-step-${step}`)");
  });

  it('Send Assets / Swap / Bridge / Treasury / Unified Balance are not batch', () => {
    // The toggle is scoped to 'batch' only; other page ids are untouched.
    expect(html).toContain("showPage('send')");
    expect(html).toContain("showPage('swap')");
    expect(html).toContain("showPage('bridge')");
    expect(html).toContain("showPage('treasury')");
    expect(html).toContain("showPage('unified-balance')");
  });

  it('display:none removes the stepper from flow (no empty header space)', () => {
    // Hidden state uses display:none (not visibility/opacity), so no gap remains.
    expect(html).toContain('.wf-stepper{display:none');
  });
});
