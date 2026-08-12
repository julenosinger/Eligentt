/**
 * MULTISEND DUPLICATE DETECTION — Unit tests
 * ═══════════════════════════════════════════════════════════════════════
 * Covers the chain + normalized-address duplicate detection added to the
 * Multisend module. The pure helper functions are extracted from the source
 * index.html and executed against a mutable `recipients` array.
 *
 * A duplicate does NOT make an address invalid — "valid" and "duplicate" are
 * independent flags. Detection keys on (chainId + trimmed/lowercased address).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');

function extractFunction(source, name) {
  const i = source.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('function not found: ' + name);
  const brace = source.indexOf('{', i);
  let depth = 0;
  for (let j = brace; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') { depth--; if (depth === 0) return source.slice(i, j + 1); }
  }
  throw new Error('unbalanced function: ' + name);
}
function extractArrow(source, name) {
  const m = source.match(new RegExp('const ' + name + '\\s*=\\s*(?:a|addr|s)?\\s*=>\\s*[^\\n]+'));
  if (!m) throw new Error('arrow not found: ' + name);
  return m[0];
}

const code = [
  extractFunction(src, 'normalizeRecipientAddr'),
  extractFunction(src, 'recipientDuplicateKey'),
  extractFunction(src, 'findDuplicateGroups'),
  extractFunction(src, 'getDuplicateIndices'),
  extractFunction(src, 'duplicateSummary'),
  extractArrow(src, 'isAddr'),
  extractArrow(src, 'isEns'),
  extractArrow(src, 'shortAddr'),
].join('\n');

function makeContext(rows) {
  const context = { recipients: [] };
  vm.createContext(context);
  vm.runInContext(code, context);
  rows.forEach(r => context.recipients.push(r));
  return context;
}

const A = '0xAAA0000000000000000000000000000000000000';
const B = '0xBBB0000000000000000000000000000000000000';
const C = '0xCCC0000000000000000000000000000000000000';

describe('normalizeRecipientAddr', () => {
  it('trims and lowercases', () => {
    const c = makeContext([]);
    expect(c.normalizeRecipientAddr('  0xAbC123  ')).toBe('0xabc123');
  });
});

describe('findDuplicateGroups', () => {
  it('unique addresses -> no duplicates', () => {
    const c = makeContext([{ addr: A, chainId: 'Arc_Testnet' }, { addr: B, chainId: 'Arc_Testnet' }]);
    expect(c.findDuplicateGroups()).toHaveLength(0);
  });

  it('duplicate addresses -> 1 group, 2 rows', () => {
    const c = makeContext([{ addr: A, chainId: 'Arc_Testnet' }, { addr: A, chainId: 'Arc_Testnet' }]);
    const g = c.findDuplicateGroups();
    expect(g).toHaveLength(1);
    expect(g[0].rows).toEqual([0, 1]);
  });

  it('case-insensitive (upper vs lower)', () => {
    const c = makeContext([
      { addr: '0xAbC1230000000000000000000000000000000000', chainId: 'Arc_Testnet' },
      { addr: '0xabc1230000000000000000000000000000000000', chainId: 'Arc_Testnet' },
    ]);
    expect(c.findDuplicateGroups()).toHaveLength(1);
  });

  it('whitespace is trimmed', () => {
    const c = makeContext([
      { addr: '  ' + A + '  ', chainId: 'Arc_Testnet' },
      { addr: A, chainId: 'Arc_Testnet' },
    ]);
    expect(c.findDuplicateGroups()).toHaveLength(1);
  });

  it('chain + address: same address on different chains is NOT a duplicate', () => {
    const c = makeContext([
      { addr: A, chainId: 'Arc_Testnet' },
      { addr: A, chainId: 'Base_Sepolia' },
    ]);
    expect(c.findDuplicateGroups()).toHaveLength(0);
  });

  it('chain + address: same chain lowercase is a duplicate', () => {
    const c = makeContext([
      { addr: '0xDEF0000000000000000000000000000000000000', chainId: 'Base_Sepolia' },
      { addr: '0xdef0000000000000000000000000000000000000', chainId: 'Base_Sepolia' },
    ]);
    expect(c.findDuplicateGroups()).toHaveLength(1);
  });

  it('multiple duplicates across different groups', () => {
    const c = makeContext([
      { addr: A, chainId: 'Arc_Testnet' },
      { addr: B, chainId: 'Arc_Testnet' },
      { addr: A, chainId: 'Arc_Testnet' },
      { addr: B, chainId: 'Arc_Testnet' },
      { addr: C, chainId: 'Arc_Testnet' },
    ]);
    expect(c.findDuplicateGroups()).toHaveLength(2);
  });

  it('3+ occurrences in one group', () => {
    const c = makeContext([
      { addr: A, chainId: 'Arc_Testnet' }, { addr: A, chainId: 'Arc_Testnet' }, { addr: A, chainId: 'Arc_Testnet' },
    ]);
    expect(c.findDuplicateGroups()[0].rows).toHaveLength(3);
  });

  it('invalid (non-40-hex) address repeated is still flagged duplicate', () => {
    const c = makeContext([
      { addr: '0x123', chainId: 'Arc_Testnet' },
      { addr: '0x123', chainId: 'Arc_Testnet' },
    ]);
    expect(c.findDuplicateGroups()).toHaveLength(1);
  });

  it('empty addresses are ignored (not duplicates)', () => {
    const c = makeContext([
      { addr: '', chainId: 'Arc_Testnet' },
      { addr: '', chainId: 'Arc_Testnet' },
    ]);
    expect(c.findDuplicateGroups()).toHaveLength(0);
  });

  it('manual + CSV origin are treated identically (same state)', () => {
    // Row from CSV + row added manually, same address -> duplicate
    const c = makeContext([{ addr: A, chainId: 'Arc_Testnet' }]);
    c.recipients.push({ addr: A.toLowerCase(), chainId: 'Arc_Testnet' }); // manual
    expect(c.findDuplicateGroups()).toHaveLength(1);
  });
});

describe('valid vs duplicate are independent', () => {
  it('a duplicate address is still valid', () => {
    const c = makeContext([{ addr: A, chainId: 'Arc_Testnet' }, { addr: A, chainId: 'Arc_Testnet' }]);
    expect(c.isAddr(A)).toBe(true);
    expect(c.findDuplicateGroups()).toHaveLength(1);
  });
});

describe('acceptance: 5 recipients (rows 1 & 4 duplicate)', () => {
  const c = makeContext([
    { addr: A, chainId: 'Arc_Testnet' },
    { addr: B, chainId: 'Arc_Testnet' },
    { addr: C, chainId: 'Arc_Testnet' },
    { addr: A, chainId: 'Arc_Testnet' },
    { addr: '0xDDD0000000000000000000000000000000000000', chainId: 'Arc_Testnet' },
  ]);
  it('1 duplicate group', () => expect(c.findDuplicateGroups()).toHaveLength(1));
  it('rows 1 and 4 (0-indexed 0 and 3)', () => expect(c.findDuplicateGroups()[0].rows).toEqual([0, 3]));
  it('2 duplicate indices', () => expect(c.getDuplicateIndices().size).toBe(2));
  it('summary mentions Rows 1, 4', () => expect(c.duplicateSummary()).toContain('Rows 1, 4'));
});

describe('duplicate resolution', () => {
  it('removing one occurrence resolves the duplicate', () => {
    const c = makeContext([{ addr: A, chainId: 'Arc_Testnet' }, { addr: A, chainId: 'Arc_Testnet' }]);
    expect(c.findDuplicateGroups()).toHaveLength(1);
    c.recipients.splice(1, 1);
    expect(c.findDuplicateGroups()).toHaveLength(0);
  });

  it('editing an address away resolves the duplicate', () => {
    const c = makeContext([{ addr: A, chainId: 'Arc_Testnet' }, { addr: A, chainId: 'Arc_Testnet' }]);
    c.recipients[1].addr = B;
    expect(c.findDuplicateGroups()).toHaveLength(0);
  });
});
