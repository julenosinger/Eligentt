/**
 * Elligentt — PWA Asset Validator
 * Validates manifest.json, favicon.ico, icon-192.png
 * Exits 1 on any corruption. Used as pre-deploy/pre-commit check.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC = process.argv[2] || path.resolve(__dirname, '..', 'public');
let errors = 0;

function fail(msg) { console.error('ERROR: ' + msg); errors++; }
function ok(msg) { console.log('  OK: ' + msg); }

// ── manifest.json ──
console.log('Validating manifest.json...');
const mfPath = path.join(PUBLIC, 'manifest.json');
if (!fs.existsSync(mfPath)) { fail('manifest.json missing'); }
else {
  let raw;
  try { raw = fs.readFileSync(mfPath, 'utf8'); } catch(e) { fail('manifest.json read error: ' + e.message); }
  if (raw) {
    if (raw.indexOf('<!DOCTYPE') >= 0 || raw.indexOf('<html') >= 0) {
      fail('manifest.json contains HTML document — CORRUPTED');
    } else {
      try { JSON.parse(raw); ok('manifest.json is valid JSON'); }
      catch(e) { fail('manifest.json is not valid JSON: ' + e.message); }
    }
  }
}

// ── favicon.ico ──
console.log('Validating favicon.ico...');
const fvPath = path.join(PUBLIC, 'favicon.ico');
if (!fs.existsSync(fvPath)) { fail('favicon.ico missing'); }
else {
  let buf;
  try { buf = fs.readFileSync(fvPath); } catch(e) { fail('favicon.ico read error: ' + e.message); }
  if (buf) {
    // ICO signature: first 4 bytes = 00 00 01 00 (little-endian: reserved=0, type=1, count=1)
    if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) {
      ok('favicon.ico is valid ICO (' + buf.length + ' bytes)');
    } else if (buf.length > 10 && buf.toString('utf8', 0, 15).indexOf('<!DOCTYPE') >= 0) {
      fail('favicon.ico contains HTML document — CORRUPTED');
    } else {
      fail('favicon.ico has invalid ICO signature');
    }
  }
}

// ── icon-192.png ──
console.log('Validating icon-192.png...');
const pngPath = path.join(PUBLIC, 'icon-192.png');
if (!fs.existsSync(pngPath)) { fail('icon-192.png missing'); }
else {
  let buf;
  try { buf = fs.readFileSync(pngPath); } catch(e) { fail('icon-192.png read error: ' + e.message); }
  if (buf) {
    const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
    const isPNG = buf.length >= 8 && PNG_SIG.every((b, i) => buf[i] === b);
    if (isPNG) {
      ok('icon-192.png is valid PNG (' + buf.length + ' bytes)');
    } else if (buf.length > 10 && buf.toString('utf8', 0, 15).indexOf('<!DOCTYPE') >= 0) {
      fail('icon-192.png contains HTML document — CORRUPTED');
    } else {
      fail('icon-192.png has invalid PNG signature');
    }
  }
}

// ── Summary ──
console.log('');
if (errors > 0) {
  console.error('VALIDATION FAILED: ' + errors + ' error(s)');
  console.error('Run: node scripts/generate-assets.cjs  to regenerate corrupted assets');
  process.exit(1);
} else {
  console.log('All PWA assets valid.');
  process.exit(0);
}
