/**
 * Elligentt — Shared Source Sync Validator
 * Ensures public/shared/ is identical to shared/ for all common files.
 * Prevents security drift between source and deployment trees.
 * Exits 1 if any deployed file has diverged from source.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'shared');
const DEPLOY = path.join(ROOT, 'public', 'shared');

let errors = 0;

function hashFile(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function fail(msg) { console.error('ERROR: ' + msg); errors++; }

function walk(dir, baseDir, fileList) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp, baseDir, fileList);
    else fileList.push(fp.substring(baseDir.length + 1));
  }
}

console.log('Verifying shared/ → public/shared/ sync...');

const allFiles = [];
walk(SRC, SRC, allFiles);

for (const rel of allFiles) {
  const sf = path.join(SRC, rel);
  const df = path.join(DEPLOY, rel);

  if (!fs.existsSync(df)) {
    // Over 170 files exist only in shared/ — that's fine, they're unused in deployed subset
    continue;
  }

  try {
    const sh = hashFile(sf);
    const dh = hashFile(df);
    if (sh !== dh) {
      fail('DRIFT DETECTED: public/shared/' + rel + ' differs from shared/' + rel + ' — sync required');
    }
  } catch (e) {
    fail('Hash error for ' + rel + ': ' + e.message);
  }
}

// Check for files in deploy that are NOT in source
const deployFiles = [];
if (fs.existsSync(DEPLOY)) walk(DEPLOY, DEPLOY, deployFiles);
for (const rel of deployFiles) {
  const sf = path.join(SRC, rel);
  if (!fs.existsSync(sf)) {
    fail('ORPHAN: public/shared/' + rel + ' exists but shared/' + rel + ' is missing — remove or add to source');
  }
}

console.log('');
if (errors > 0) {
  console.error('SYNC VALIDATION FAILED: ' + errors + ' error(s)');
  console.error('Run: node scripts/sync-shared.cjs to fix drift');
  process.exit(1);
} else {
  console.log('All ' + allFiles.filter(r => fs.existsSync(path.join(DEPLOY, r))).length + ' deployed files identical to source. Zero drift.');
  process.exit(0);
}
