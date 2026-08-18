/**
 * MS-5 — EXECUTOR SINGLETON & DOUBLE-EXECUTION PREVENTION
 * Verifies that the agent schedule executor and batch engine are idempotent
 * (no second instance / tick loop when the module is loaded twice) — the root
 * cause of the duplicate broadcast regression.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const executorSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'agentScheduleExecutor.js'), 'utf8');
const batchSrc = fs.readFileSync(path.join(root, 'public', 'shared', 'BatchExecutionEngine.js'), 'utf8');

function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function makeWindow() {
  return {
    localStorage: makeLocalStorage(),
    document: { readyState: 'complete', addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval: () => {},
    CustomEvent: class { constructor(t) { this.type = t; } },
  };
}

describe('MS-5 — executor singleton (no double instance / tick loop)', () => {
  it('agentScheduleExecutor loaded twice yields ONE instance', () => {
    const win = makeWindow();
    new Function('window', 'localStorage', 'document', executorSrc)(win, win.localStorage, win.document);
    const first = win.AgentScheduleExecutor;
    new Function('window', 'localStorage', 'document', executorSrc)(win, win.localStorage, win.document);
    const second = win.AgentScheduleExecutor;
    expect(first).toBeDefined();
    expect(second).toBe(first); // second load is a no-op
  });

  it('BatchExecutionEngine loaded twice yields ONE instance', () => {
    // BatchExecutionEngine references localStorage/document as GLOBALS (not params).
    globalThis.localStorage = makeLocalStorage();
    globalThis.document = { readyState: 'complete', addEventListener() {}, dispatchEvent() {}, removeEventListener() {} };
    globalThis.CustomEvent = class { constructor(t) { this.type = t; } };
    const win = {};
    new Function('window', batchSrc)(win);
    const first = win.BatchExecutionEngine;
    new Function('window', batchSrc)(win);
    const second = win.BatchExecutionEngine;
    expect(first).toBeDefined();
    expect(second).toBe(first);
    delete globalThis.localStorage;
    delete globalThis.document;
    delete globalThis.CustomEvent;
  });
});
