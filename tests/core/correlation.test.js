import { describe, it, expect } from 'vitest';
import { newRequestId, newCorrelationId, resolveCorrelationId, buildMeta } from '../../functions/api/core/correlation.mjs';

describe('Core API — correlation & request ids', () => {
  it('generates unique request ids with prefix', () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).not.toBe(b);
    expect(a.startsWith('req_')).toBe(true);
  });

  it('generates correlation ids with prefix', () => {
    expect(newCorrelationId().startsWith('cid_')).toBe(true);
  });

  it('reuses the incoming X-Correlation-ID header (sanitized)', () => {
    const req = new Request('https://x/y', { headers: { 'X-Correlation-ID': 'trace-abc.123:z' } });
    expect(resolveCorrelationId(req)).toBe('trace-abc.123:z');
  });

  it('strips unsafe characters from an incoming correlation id', () => {
    const req = new Request('https://x/y', { headers: { 'X-Correlation-ID': 'a b<script>' } });
    const cid = resolveCorrelationId(req);
    expect(cid.includes(' ')).toBe(false);
    expect(cid.includes('<')).toBe(false);
  });

  it('mints a correlation id when the header is absent', () => {
    const req = new Request('https://x/y');
    expect(resolveCorrelationId(req).startsWith('cid_')).toBe(true);
  });

  it('buildMeta returns requestId, correlationId and version', () => {
    const req = new Request('https://x/y', { headers: { 'X-Correlation-ID': 'keepme' } });
    const meta = buildMeta(req, 'v1');
    expect(meta.correlationId).toBe('keepme');
    expect(meta.requestId.startsWith('req_')).toBe(true);
    expect(meta.version).toBe('v1');
  });
});
