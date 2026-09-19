/**
 * Elligentt Multi-Application Config — Phase 1 (Core Infrastructure)
 * ═════════════════════════════════════════════════════════════════
 * Browser-side source of truth for the shared Liquidity Core. Elligentt runs in
 * APPLICATION_MODE = CORE: a single Vault + Treasury serve multiple consumer
 * applications (ELLIGENT today, EXECDAAT next). Only accounting/attribution is
 * segregated — liquidity, keys and Treasury logic are NEVER duplicated.
 *
 * Values MUST mirror functions/api/shared-config.mjs (RELAYER_CONFIG.APPLICATION).
 * Every field is OPTIONAL at runtime; the defaults keep existing flows unchanged:
 *     Application = ELLIGENT · Client = default · Version = 1
 */
const ApplicationConfig = Object.freeze({
  APPLICATION_MODE:     'CORE',
  DEFAULT_APPLICATION:  'ELLIGENT',
  DEFAULT_CLIENT:       'default',
  DEFAULT_VERSION:      '1',
  DEFAULT_ENVIRONMENT:  'production',
  MAX_FIELD_LEN:        32,

  KNOWN_APPLICATIONS: ['ELLIGENT', 'EXECDAAT', 'FUTURE_APP'],

  // Registry consumed by the dashboard "view by application" data layer.
  APPLICATIONS: {
    ELLIGENT:   { id: 'ELLIGENT',   label: 'Elligent',    core: true,  active: true  },
    EXECDAAT:   { id: 'EXECDAAT',   label: 'ExecDaat',    core: false, active: false },
    FUTURE_APP: { id: 'FUTURE_APP', label: 'Future Apps', core: false, active: false },
  },
});

const ApplicationContext = (() => {
  'use strict';

  const CFG = ApplicationConfig;

  // Memo-safe sanitizer: strip the memo delimiter, control chars, whitespace and
  // cap the length so a value can never corrupt the memo grammar or ledger keys.
  function sanitizeToken(value, fallback) {
    if (value === undefined || value === null) return fallback;
    let s = String(value).trim();
    if (!s) return fallback;
    s = s.replace(/\|/g, '').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, '_');
    if (!s) return fallback;
    if (s.length > CFG.MAX_FIELD_LEN) s = s.slice(0, CFG.MAX_FIELD_LEN);
    return s;
  }

  function firstDefined(...vals) {
    for (const v of vals) {
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return undefined;
  }

  // Normalize a partial context into the full { application, client, version,
  // environment, origin } shape with defaults applied.
  function normalizeContext(input) {
    const i = (input && typeof input === 'object') ? input : {};
    const application = sanitizeToken(
      firstDefined(i.applicationId, i.appId, i.application),
      CFG.DEFAULT_APPLICATION
    ).toUpperCase();
    const client = sanitizeToken(firstDefined(i.clientId, i.client), CFG.DEFAULT_CLIENT);
    const version = sanitizeToken(firstDefined(i.version, i.apiVersion), CFG.DEFAULT_VERSION);
    const environment = sanitizeToken(firstDefined(i.environment, i.env), CFG.DEFAULT_ENVIRONMENT);
    let origin = firstDefined(i.origin);
    if (!origin && typeof window !== 'undefined' && window.location) {
      origin = window.location.origin || null;
    }
    origin = origin ? String(origin).slice(0, 256) : null;
    return { application, client, version, environment, origin };
  }

  function resolveApplication(id) {
    const key = sanitizeToken(id, CFG.DEFAULT_APPLICATION).toUpperCase();
    return CFG.APPLICATIONS[key] || { id: key, label: key, core: false, active: false };
  }

  function isKnown(id) {
    return CFG.KNOWN_APPLICATIONS.includes(sanitizeToken(id, '').toUpperCase());
  }

  function isCore() {
    return String(CFG.APPLICATION_MODE).toUpperCase() === 'CORE';
  }

  // Identity triple for API bodies (applicationId/clientId/version).
  function toApiFields(input) {
    const c = normalizeContext(input);
    return { applicationId: c.application, clientId: c.client, version: c.version };
  }

  return {
    MODE: CFG.APPLICATION_MODE,
    sanitizeToken,
    normalizeContext,
    resolveApplication,
    isKnown,
    isCore,
    toApiFields,
    defaults: () => normalizeContext({}),
  };
})();

if (typeof window !== 'undefined') {
  window.ApplicationConfig = ApplicationConfig;
  window.ApplicationContext = ApplicationContext;
}
