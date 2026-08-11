/**
 * Elligentt Build Pipeline v5
 * Phase 1-4: bundles + CSS + source sync + inline extraction
 * Phase 5: Terser minification
 * 
 * Usage: node scripts/build.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { minify } = require('terser');

// ═══════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SRC_HTML = path.join(PUBLIC, 'index.html');
const BACKUP_HTML = path.join(PUBLIC, 'index.original.html');
const BUNDLE_DIR = path.join(PUBLIC, 'bundles');

const SYNC_MAP = [
  { from: 'shared', to: 'public/shared' },
  { from: 'config', to: 'public/config' },
  { from: 'remediation', to: 'public/remediation' },
];

// ═══════════════════════════════════════
// UTILS
// ═══════════════════════════════════════

function log(msg, level) {
  const p = { info: '  OK', warn: '  WARN', error: '  FAIL', h1: '\n>>', h2: '   >' }[level || 'info'] || '    ';
  const c = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[32m', h1: '\x1b[36m', h2: '\x1b[35m' }[level] || '';
  console.log(c + p + ' ' + msg + '\x1b[0m');
}

function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
function readText(fp) { return fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null; }
function writeText(fp, content) { ensureDir(path.dirname(fp)); fs.writeFileSync(fp, content, 'utf8'); }
function contentHash(content) { return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8); }

function walkDir(dir, base) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) results.push(...walkDir(fp, base));
    else results.push(fp.substring(base.length + 1));
  }
  return results;
}

// ═══════════════════════════════════════
// PHASE 2: SOURCE SYNC
// ═══════════════════════════════════════

function syncSourceToPublic() {
  const stats = { synced: 0, skipped: 0, errors: 0 };
  for (const mapping of SYNC_MAP) {
    const srcDir = path.join(ROOT, mapping.from);
    const dstDir = path.join(ROOT, mapping.to);
    if (!fs.existsSync(srcDir)) { log(`Source missing: ${mapping.from}`, 'warn'); continue; }
    const files = walkDir(srcDir, srcDir);
    for (const rel of files) {
      const sf = path.join(srcDir, rel);
      const df = path.join(dstDir, rel);
      try {
        if (fs.existsSync(df) && fs.readFileSync(sf).equals(fs.readFileSync(df))) { stats.skipped++; continue; }
        ensureDir(path.dirname(df));
        fs.copyFileSync(sf, df);
        stats.synced++;
      } catch (e) { log(`Sync error: ${rel}`, 'warn'); stats.errors++; }
    }
  }
  return stats;
}

// ═══════════════════════════════════════
// PHASE 3: MODULE TIER CLASSIFICATION (from ModuleLoader)
// ═══════════════════════════════════════

function parseModuleLoaderTiers() {
  const loaderPath = path.join(PUBLIC, 'shared', 'moduleLoader.js');
  const code = readText(loaderPath);
  if (!code) return { core: [], dormant: [] };

  const extract = (varName) => {
    const regex = new RegExp(`var\\s+${varName}\\s*=\\s*(\\[[\\s\\S]*?\\]);`, 'm');
    const match = code.match(regex);
    if (!match) return [];
    try {
      // Extract string literals from the array
      const items = [];
      const strRegex = /'([^']+)'/g;
      let m;
      while ((m = strRegex.exec(match[1])) !== null) {
        items.push(m[1]);
      }
      return items;
    } catch (e) { return []; }
  };

  const critical = extract('CRITICAL');
  const essential = extract('ESSENTIAL');
  const dormant = extract('DORMANT');

  // Core = critical + essential, normalized to /paths
  const core = [...new Set([...critical, ...essential])]
    .map(p => p.startsWith('/') ? p : '/' + p);

  return {
    core: core,
    dormant: dormant.map(p => p.startsWith('/') ? p : '/' + p)
  };
}

function classifyScripts(localScripts, tiers) {
  const core = [];
  const app = [];
  const skipped = [];

  for (const script of localScripts) {
    const isCore = tiers.core.some(p => script.src === p || script.src.endsWith(p));
    const isDormant = tiers.dormant.some(p => script.src === p || script.src.endsWith(p));

    // Config and remediation scripts are always core (they load before ModuleLoader)
    const isConfig = script.src.startsWith('/config/');
    const isRemediation = script.src.startsWith('/remediation/');
    // ModuleLoader itself is always core
    const isModuleLoader = script.src === '/shared/moduleLoader.js';

    if (isDormant && !isConfig && !isRemediation) {
      skipped.push(script);
    } else if (isCore || isConfig || isRemediation || isModuleLoader) {
      core.push(script);
    } else {
      app.push(script);
    }
  }

  return { core, app, skipped };
}

// ═══════════════════════════════════════
// HTML PARSE
// ═══════════════════════════════════════

function parseScriptTags(html) {
  const scripts = [];
  const regex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const attrs = match[1];
    const srcMatch = attrs.match(/src\s*=\s*["']([^"']+)["']/i);
    scripts.push({
      src: srcMatch ? srcMatch[1] : null,
      isDefer: /defer/i.test(attrs),
      isAsync: /async/i.test(attrs),
      isInline: !srcMatch,
      isExternal: !!(srcMatch && /^https?:\/\//i.test(srcMatch[1])),
      isLocal: !!(srcMatch && !/^https?:\/\//i.test(srcMatch[1])),
      fullTag: match[0],
      body: match[2],
      index: match.index,
      endIndex: match.index + match[0].length,
    });
  }
  return scripts;
}

function parseStyleBlocks(html) {
  // Strip all <script>...</script> blocks first to avoid extracting
  // <style> tags that appear inside JS template strings (e.g. invoice HTML).
  const cleaned = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  
  const styles = [];
  const regex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    // Skip blocks containing JS template expressions (these are inside JS strings, not real CSS)
    if (match[1].includes('${')) continue;
    if (match[1].includes("'+ (")) continue;
    if (match[1].includes("' + (")) continue;
    styles.push({ content: match[1], fullTag: match[0], index: match.index });
  }
  return styles;
}

// ═══════════════════════════════════════
// BUNDLE BUILDERS
// ═══════════════════════════════════════

async function buildBundle(scripts, name) {
  const bundledPaths = [];
  const missing = [];

  let content = [
    '/**',
    ` * Elligentt ${name} Bundle — Auto-generated`,
    ` * ${new Date().toISOString()}`,
    ` * ${scripts.length} modules`,
    ' */',
    '',
    '(function() {',
    '  "use strict";',
    ''
  ].join('\n');

  for (const script of scripts) {
    const filePath = path.join(PUBLIC, script.src.replace(/^\//, ''));
    if (fs.existsSync(filePath)) {
      content += `\n// ══ ${script.src} ══\n`;
      content += readText(filePath).trimEnd() + '\n';
      bundledPaths.push(script.src);
    } else {
      missing.push(script.src);
    }
  }

  content += '\n})();\n';

  // Minify with terser (comment/whitespace only — safe mode)
  const rawSize = content.length;
  let minified = content;
  try {
    const result = await minify(content, {
      ecma: 2020,
      compress: false,
      mangle: false,
      format: { comments: false },
    });
    if (result.code) minified = result.code;
  } catch (e) {
    minified = content;
    log(`Minify skipped for ${name} bundle (syntax issue)`, 'h2');
  }
  const minSize = minified.length;

  const hash = contentHash(minified);
  const filename = `${name}.${hash}.js`;

  return { content: minified, rawContent: content, filename, hash, bundledPaths, count: bundledPaths.length, missing, rawSize, minSize };
}

function buildCSS(styleBlocks) {
  if (styleBlocks.length === 0) return null;
  let css = '/* Elligentt Styles — Auto-generated */\n';
  css += `/* ${new Date().toISOString()} — ${styleBlocks.length} blocks */\n\n`;
  for (let i = 0; i < styleBlocks.length; i++) {
    css += `/* Block ${i + 1} */\n`;
    css += styleBlocks[i].content.trimEnd() + '\n\n';
  }
  return css;
}

// ═══════════════════════════════════════
// PHASE 4: INLINE SCRIPT EXTRACTION
// ═══════════════════════════════════════

function extractInlineScripts(html, inlineScripts) {
  const extracted = [];
  const toKeep = [];

  for (let i = 0; i < inlineScripts.length; i++) {
    const script = inlineScripts[i];
    const body = script.body.trim();

    // Keep Cloudflare Pages runtime config inline (injected at deploy)
    if (body.startsWith('//') && body.includes('Cloudflare Pages runtime')) {
      toKeep.push(script);
      continue;
    }

    // Keep Cloudflare analytics beacon (type=module, external concerns)
    if (script.isModule) {
      toKeep.push(script);
      continue;
    }

    // Extract: write to file, replace with defer tag
    const hash = contentHash(body);
    const name = `inline-${extracted.length + 1}.${hash}.js`;
    const lines = body.split('\n').length;

    writeText(path.join(BUNDLE_DIR, name), body + '\n');

    extracted.push({
      script,
      filename: name,
      hash,
      lines,
      content: body,
      size: body.length,
      tag: `<script defer src="/bundles/${name}"></script>`,
    });
  }

  return { extracted, toKeep };
}

function applyInlineExtraction(html, extractionResult) {
  let out = html;

  // Replace extracted inline scripts with defer references (reverse order)
  for (let i = extractionResult.extracted.length - 1; i >= 0; i--) {
    const item = extractionResult.extracted[i];
    out = out.substring(0, item.script.index) + item.tag + out.substring(item.script.endIndex);
  }

  return out;
}

function rebuildHTML(html, coreBundle, appBundle, classResult, cssResult, extractionResult) {
  let out = html;

  // ── Build unified operation list (all index-based, from ORIGINAL html) ──
  const ops = [];

  // Local external script removals
  const scriptRegex = /<script\b([^>]*?)src\s*=\s*["'](\/[^"']+)["']([^>]*?)>[\s\S]*?<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    if (!/^https?:\/\//i.test(match[2])) {
      ops.push({
        type: 'remove',
        index: match.index,
        endIndex: match.index + match[0].length,
      });
    }
  }

  // Inline script replacements (extract → defer)
  if (extractionResult && extractionResult.extracted.length > 0) {
    for (const item of extractionResult.extracted) {
      ops.push({
        type: 'replace',
        index: item.script.index,
        endIndex: item.script.endIndex,
        replacement: item.tag,
      });
    }
  }

  // Process operations in REVERSE index order (preserves original indices)
  ops.sort((a, b) => b.index - a.index);
  for (const op of ops) {
    if (op.type === 'remove') {
      out = out.substring(0, op.index) + out.substring(op.endIndex);
    } else if (op.type === 'replace') {
      out = out.substring(0, op.index) + op.replacement + out.substring(op.endIndex);
    }
  }
  out = out.replace(/\n{3,}/g, '\n\n');

  // Remove inline <style> blocks
  const styleBlocks = cssResult.blocks;
  for (let i = styleBlocks.length - 1; i >= 0; i--) {
    const idx = out.indexOf(styleBlocks[i].fullTag);
    if (idx !== -1) out = out.substring(0, idx) + out.substring(idx + styleBlocks[i].fullTag.length);
  }
  out = out.replace(/\n{3,}/g, '\n\n');

  // Find </head> in cleaned HTML
  const bodyIdx2 = out.indexOf('<body');
  const headEnd2 = bodyIdx2 !== -1 ? out.lastIndexOf('</head>', bodyIdx2) : out.indexOf('</head>');
  if (headEnd2 === -1) { log('FATAL: Lost </head> during cleanup', 'error'); return out; }

  // Insert bundles + CSS before </head>
  let insert = '';

  if (cssResult.content) {
    insert += `\n<link rel="stylesheet" href="/app.css?h=${cssResult.hash}">`;
  }

  insert += `\n<!-- Core Bundle: ${coreBundle.count} modules (synchronous) -->`;
  insert += `\n<script src="/bundles/${coreBundle.filename}"></script>`;

  if (appBundle && appBundle.count > 0) {
    insert += `\n<!-- App Bundle: ${appBundle.count} modules (deferred) -->`;
    insert += `\n<script defer src="/bundles/${appBundle.filename}"></script>`;
  }

  if (classResult.skipped.length > 0) {
    insert += `\n<!-- Dormant modules skipped: ${classResult.skipped.length} (oracle + unused) -->`;
  }

  if (extractionResult && extractionResult.extracted.length > 0) {
    insert += `\n<!-- Inline scripts extracted: ${extractionResult.extracted.length} files -->`;
  }

  out = out.substring(0, headEnd2) + insert + '\n' + out.substring(headEnd2);
  out = out.replace(/\n{3,}/g, '\n\n');

  return out;
}

// ═══════════════════════════════════════
// MODULE LOADER PATCH
// ═══════════════════════════════════════

function patchModuleLoader(allBundledPaths) {
  const loaderPath = path.join(PUBLIC, 'shared', 'moduleLoader.js');
  if (!fs.existsSync(loaderPath)) { log('moduleLoader.js not found', 'warn'); return; }

  let content = readText(loaderPath).replace(/\r\n/g, '\n');

  if (content.includes('window.__ELLIGENTT_BUNDLE')) {
    log('ModuleLoader already patched', 'h2');
    return;
  }

  const search = '    if (loaded[path]) return Promise.resolve();\n' +
    '    if (pending[path]) return pending[path];\n' +
    '\n' +
    '    // Skip dormant modules';

  const replace = '    if (loaded[path]) return Promise.resolve();\n' +
    '    if (pending[path]) return pending[path];\n' +
    '\n' +
    '    if (window.__ELLIGENTT_BUNDLE && window.__ELLIGENTT_BUNDLE.files &&\n' +
    '        window.__ELLIGENTT_BUNDLE.files.indexOf(path) !== -1) {\n' +
    '      loaded[path] = true;\n' +
    '      return Promise.resolve();\n' +
    '    }\n' +
    '\n' +
    '    // Skip dormant modules';

  if (content.includes(search)) {
    content = content.replace(search, replace);
    if (readText(loaderPath).includes('\r\n')) content = content.replace(/\n/g, '\r\n');
    writeText(loaderPath, content);
    log('ModuleLoader patched', 'info');
  } else {
    log('ModuleLoader patch signature not found', 'warn');
  }
}

// ═══════════════════════════════════════
// BROTLI SIZE ESTIMATE (Cloudflare auto-compresses)
// ═══════════════════════════════════════

function estimateBrotli(content) {
  // Rough estimate: brotli typically achieves 70-80% of gzip
  // For JS/CSS, brotli is ~20-25% of original size
  const kb = (content.length / 1024).toFixed(0);
  return {
    raw: parseInt(kb),
    estimated: Math.round(content.length * 0.22 / 1024)
  };
}

// ═══════════════════════════════════════
// MAIN
// ═══════════════════════════════════════

async function main() {
  console.log('\n  Elligentt Build v5 — Phase 1-5');
  console.log('  ' + '='.repeat(45) + '\n');

  const start = Date.now();

  // ── Phase 2: Sync ──
  log('Syncing source → public/', 'h1');
  const syncStats = syncSourceToPublic();
  log(`Synced: ${syncStats.synced} | Skipped: ${syncStats.skipped} | Errors: ${syncStats.errors}`, 'h2');

  // ── Verify ──
  if (!fs.existsSync(SRC_HTML)) { log('index.html not found', 'error'); process.exit(1); }
  const originalHTML = readText(SRC_HTML);
  log(`Source HTML: ${(originalHTML.length / 1024).toFixed(0)} KB`, 'h2');

  if (!fs.existsSync(BACKUP_HTML)) {
    writeText(BACKUP_HTML, originalHTML);
    log('Backup saved', 'info');
  }

  // ── Phase 3: Module classification ──
  log('Classifying modules (from ModuleLoader tiers)...', 'h1');
  const tiers = parseModuleLoaderTiers();
  log(`Core tier: ${tiers.core.length} paths from CRITICAL+ESSENTIAL`, 'h2');
  log(`Dormant tier: ${tiers.dormant.length} paths to skip`, 'h2');

  // ── Parse ──
  const allScripts = parseScriptTags(originalHTML);
  const localScripts = allScripts.filter(s => s.isLocal);
  const extCount = allScripts.filter(s => s.isExternal).length;
  const inlineCount = allScripts.filter(s => s.isInline).length;
  log(`Parsed ${allScripts.length} scripts (${localScripts.length} local, ${extCount} CDN, ${inlineCount} inline)`, 'h2');

  // ── Classify local scripts ──
  const classResult = classifyScripts(localScripts, tiers);
  log(`Classification: ${classResult.core.length} core + ${classResult.app.length} app + ${classResult.skipped.length} skipped`, 'h2');

  // ── Build bundles ──
  log('Building + minifying bundles...', 'h1');
  ensureDir(BUNDLE_DIR);

  // Clean old bundles
  const oldBundles = fs.existsSync(BUNDLE_DIR) ? fs.readdirSync(BUNDLE_DIR).filter(f => f.endsWith('.js')) : [];
  for (const f of oldBundles) fs.unlinkSync(path.join(BUNDLE_DIR, f));

  // Core bundle
  const coreBundle = await buildBundle(classResult.core, 'core');
  writeText(path.join(BUNDLE_DIR, coreBundle.filename), coreBundle.content);
  const coreBrotli = Math.round(coreBundle.content.length * 0.22 / 1024);
  log(`Core: ${coreBundle.filename} (${Math.round(coreBundle.minSize/1024)} KB min, ~${coreBrotli} KB brotli)`, 'h2');

  // App bundle
  let appBundle = null;
  if (classResult.app.length > 0) {
    appBundle = await buildBundle(classResult.app, 'app');
    writeText(path.join(BUNDLE_DIR, appBundle.filename), appBundle.content);
    const appBrotli = Math.round(appBundle.content.length * 0.22 / 1024);
    log(`App: ${appBundle.filename} (${Math.round(appBundle.minSize/1024)} KB min, ~${appBrotli} KB brotli)`, 'h2');
  }

  // Skipped modules
  if (classResult.skipped.length > 0) {
    const skippedKB = classResult.skipped.reduce((sum, s) => {
      const fp = path.join(PUBLIC, s.src.replace(/^\//, ''));
      return sum + (fs.existsSync(fp) ? fs.statSync(fp).size : 0);
    }, 0);
    log(`Skipped: ${classResult.skipped.length} dormant modules (~${Math.round(skippedKB / 1024)} KB saved)`, 'h2');
    classResult.skipped.forEach(s => log(`  skipped: ${s.src}`, 'info'));
  }

  // All bundled paths for ModuleLoader patch
  const allBundledPaths = [
    ...coreBundle.bundledPaths,
    ...(appBundle ? appBundle.bundledPaths : [])
  ];

  // ── CSS ──
  log('Extracting CSS...', 'h1');
  const styleBlocks = parseStyleBlocks(originalHTML);
  const cssContent = buildCSS(styleBlocks);
  const cssHash = cssContent ? contentHash(cssContent) : '';
  if (cssContent) {
    writeText(path.join(PUBLIC, 'app.css'), cssContent);
    const cssBrotli = Math.round(cssContent.length * 0.22 / 1024);
    log(`CSS: app.css (${Math.round(cssContent.length/1024)} KB, ~${cssBrotli} KB brotli)`, 'h2');
  }

  // ── Phase 4: Extract inline scripts ──
  log('Extracting inline scripts...', 'h1');
  const inlineScripts = allScripts.filter(s => s.isInline);
  const extractionResult = extractInlineScripts(originalHTML, inlineScripts);

  if (extractionResult.extracted.length > 0) {
    const totalLines = extractionResult.extracted.reduce((s, e) => s + e.lines, 0);
    const totalSize = extractionResult.extracted.reduce((s, e) => s + e.size, 0);
    log(`Extracted: ${extractionResult.extracted.length} inline blocks → ${Math.round(totalSize / 1024)} KB (${totalLines} lines)`, 'h2');
    extractionResult.extracted.forEach(e => {
      log(`  ${e.filename}: ${Math.round(e.size / 1024)} KB (${e.lines} lines)`, 'info');
    });
  }
  if (extractionResult.toKeep.length > 0) {
    log(`Kept inline: ${extractionResult.toKeep.length} (Cloudflare config + analytics)`, 'h2');
  }

  // ── Rebuild HTML ──
  log('Rebuilding HTML...', 'h1');
  const cssResult = { content: cssContent, hash: cssHash, blocks: styleBlocks };
  const newHTML = rebuildHTML(originalHTML, coreBundle, appBundle, classResult, cssResult, extractionResult);
  writeText(SRC_HTML, newHTML);

  const pct = ((1 - newHTML.length / originalHTML.length) * 100).toFixed(1);
  log(`HTML: ${(newHTML.length / 1024).toFixed(0)} KB (was ${(originalHTML.length / 1024).toFixed(0)} KB, ${pct}% reduction)`, 'h2');

  // ── Patch ModuleLoader ──
  patchModuleLoader(allBundledPaths);

  // ── Summary ──
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const totalMin = coreBundle.content.length + (appBundle ? appBundle.content.length : 0) +
    (cssContent ? cssContent.length : 0) +
    extractionResult.extracted.reduce((s, e) => s + e.content.length, 0);
  const totalBrotli = Math.round(totalMin * 0.22 / 1024);

  console.log('\n  ' + '='.repeat(45));
  console.log(`  Build v5 complete in ${elapsed}s`);
  console.log('  ─────────────────────────────────────');
  console.log(`  Core:  ${coreBundle.count} mod, ${Math.round(coreBundle.minSize/1024)} KB (minified)`);
  if (appBundle) console.log(`  App:   ${appBundle.count} mod, ${Math.round(appBundle.minSize/1024)} KB (minified)`);
  if (classResult.skipped.length) console.log(`  Skip:  ${classResult.skipped.length} dormant excluded`);
  if (extractionResult.extracted.length) console.log(`  Inline:${extractionResult.extracted.length} scripts extracted`);
  console.log(`  CSS:   ${styleBlocks.length} blocks, ${Math.round((cssContent||'').length/1024)} KB`);
  console.log(`  Total: ${Math.round(totalMin/1024)} KB min, ~${totalBrotli} KB brotli`);
  console.log('  ' + '='.repeat(45) + '\n');
}

main();
