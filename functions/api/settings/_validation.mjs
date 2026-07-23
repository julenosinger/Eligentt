const ENCRYPTION_PREFIX = 'enc:aesgcm:';
const ENCRYPTION_VERSION = 1;

const META_FIELDS = new Set(['_updatedAt', '_updatedBy', '_restoredAt', 'ts', '_encryptedFields']);

const SENSITIVE_FIELD_PATTERNS = [
  /Key$/i, /Secret$/i, /Token$/i,
  /[Ww]ebhook$/i, /[Ww]ebhook[Ss]ecret$/i,
  /[Pp]assword$/i, /[Pp]rivate[Kk]ey$/i,
  /[Ee]ntity[Ss]ecret$/i, /[Cc]lient[Ss]ecret$/i,
  /[Aa]ccess[Tt]oken$/i, /[Rr]efresh[Tt]oken$/i,
  /[Bb]earer[Tt]oken$/i, /[Rr]pc[Ss]ecret$/i,
  /[Bb]ank[Tt]oken$/i, /[Cc]ard[Tt]oken$/i,
];

const FINANCIAL_SENSITIVE_KEYS = new Set([
  'account', 'iban', 'swift', 'routingNumber', 'routing_number',
  'last4', 'token', 'number', 'accountNumber', 'account_number',
]);

const SCHEMA = {
  network:            { type: 'string',  maxLength: 64 },
  chain:              { type: 'string',  maxLength: 64 },
  rpcPrimary:         { type: 'url',     maxLength: 512 },
  rpcBackup:          { type: 'url',     maxLength: 512 },
  customRpcs:         { type: 'string',  maxLength: 4096 },
  explorer:           { type: 'url',     maxLength: 512 },
  gasStrategy:        { type: 'enum',    values: ['standard', 'fast', 'instant'] },
  gasMax:             { type: 'number',  min: 1,     max: 10000 },
  slippage:           { type: 'number',  min: 0.1,   max: 50 },
  deadline:           { type: 'number',  min: 1,     max: 120 },
  confBlocks:         { type: 'number',  min: 1,     max: 64 },
  timeout:            { type: 'number',  min: 1000,  max: 300000 },
  retryStrategy:      { type: 'enum',    values: ['none', 'once', 'exponential'] },

  walletProvider:     { type: 'enum',    values: ['internal', 'metamask', 'walletconnect', 'coinbase', 'rainbow', 'safe'] },
  sessionTimeout:     { type: 'number',  min: 5,     max: 1440 },
  wcProjectId:        { type: 'string',  maxLength: 128 },

  toggles:            { type: 'object' },

  circleApiKey:           { type: 'secret',  maxLength: 512 },
  circleEntitySecret:     { type: 'secret',  maxLength: 512 },
  circleWalletSet:        { type: 'string',  maxLength: 128 },
  circleTreasury:         { type: 'string',  maxLength: 128 },
  circleWebhookSecret:    { type: 'secret',  maxLength: 512 },
  circleBusinessAccount:  { type: 'string',  maxLength: 128 },
  circleUsdcNetwork:      { type: 'string',  maxLength: 64 },

  txLimit:            { type: 'number',  min: 0,     max: 1000000000 },
  dailyLimit:         { type: 'number',  min: 0,     max: 1000000000 },
  authTimeout:        { type: 'number',  min: 1,     max: 1440 },
  countryWhitelist:   { type: 'string',  maxLength: 2048 },
  ipWhitelist:        { type: 'string',  maxLength: 4096 },
  riskThreshold:      { type: 'number',  min: 0,     max: 100 },
  contractAddress:    { type: 'string',  maxLength: 128 },
  platformFee:        { type: 'number',  min: 0,     max: 5 },

  emailNotify:        { type: 'string',  maxLength: 256 },
  telegramToken:      { type: 'secret',  maxLength: 256 },
  telegramChat:       { type: 'string',  maxLength: 128 },
  discordWebhook:     { type: 'secret',  maxLength: 512 },
  slackWebhook:       { type: 'secret',  maxLength: 512 },
  webhookUrl:         { type: 'url',     maxLength: 512 },

  aiMaxTx:            { type: 'number',  min: 0,     max: 1000000000 },
  aiDailyLimit:       { type: 'number',  min: 0,     max: 1000000000 },
  aiProvider:         { type: 'string',  maxLength: 64 },
  aiModel:            { type: 'string',  maxLength: 128 },

  bankAccounts:       { type: 'array' },
  cards:              { type: 'array' },
};

const PROVIDER_KEY_PATTERNS = [
  /^[a-z][a-z0-9-]*Key$/,
  /^[a-z][a-z0-9-]*Secret$/,
  /^[a-z][a-z0-9-]*Env$/,
  /^[a-z][a-z0-9-]*Priority$/,
  /^[a-z][a-z0-9-]*Url$/,
  /^[a-z][a-z0-9-]*Countries$/,
];

function isMetaField(key) {
  return META_FIELDS.has(key);
}

function isKnownField(key) {
  if (SCHEMA[key]) return true;
  for (const p of PROVIDER_KEY_PATTERNS) {
    if (p.test(key)) return true;
  }
  return false;
}

function isSensitiveFieldName(key) {
  for (const p of SENSITIVE_FIELD_PATTERNS) {
    if (p.test(key)) return true;
  }
  return false;
}

function sanitizeValue(value) {
  if (typeof value === 'string') {
    let s = value.trim();
    s = s.replace(/\x00/g, '');
    return s;
  }
  return value;
}

function sanitizeKey(key) {
  if (typeof key !== 'string') return false;
  if (key === '__proto__') return false;
  if (key === 'constructor') return false;
  if (key === 'prototype') return false;
  if (key.startsWith('__') && key.endsWith('__')) return false;
  return true;
}

function isValidUrl(str) {
  if (typeof str !== 'string' || !str) return false;
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function validateField(key, value, schema) {
  if (!schema) return { valid: false, reason: 'unknown' };

  const def = schema;

  if (def.type === 'secret') {
    if (typeof value !== 'string') return { valid: false, reason: 'expected string' };
    if (def.maxLength && value.length > def.maxLength) return { valid: false, reason: 'too long' };
    return { valid: true };
  }

  if (def.type === 'string') {
    if (typeof value !== 'string') return { valid: false, reason: 'expected string' };
    if (def.maxLength && value.length > def.maxLength) return { valid: false, reason: 'too long' };
    return { valid: true };
  }

  if (def.type === 'url') {
    if (typeof value !== 'string') return { valid: false, reason: 'expected string' };
    if (def.maxLength && value.length > def.maxLength) return { valid: false, reason: 'too long' };
    if (!isValidUrl(value)) return { valid: false, reason: 'invalid url' };
    return { valid: true };
  }

  if (def.type === 'number') {
    if (typeof value !== 'number') return { valid: false, reason: 'expected number' };
    if (!Number.isFinite(value)) return { valid: false, reason: 'not finite' };
    if (Number.isNaN(value)) return { valid: false, reason: 'NaN' };
    if (def.min !== undefined && value < def.min) return { valid: false, reason: 'below min' };
    if (def.max !== undefined && value > def.max) return { valid: false, reason: 'above max' };
    return { valid: true };
  }

  if (def.type === 'enum') {
    if (typeof value !== 'string') return { valid: false, reason: 'expected string' };
    if (!def.values.includes(value)) return { valid: false, reason: 'not in enum' };
    return { valid: true };
  }

  if (def.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return { valid: false, reason: 'expected plain object' };
    return { valid: true };
  }

  if (def.type === 'array') {
    if (!Array.isArray(value)) return { valid: false, reason: 'expected array' };
    return { valid: true };
  }

  return { valid: false, reason: 'unknown type' };
}

function sanitizeObject(obj, depth, auditFields) {
  if (depth > 20) return obj;
  if (!obj || typeof obj !== 'object') return obj;

  const out = Array.isArray(obj) ? [] : {};
  const entries = Array.isArray(obj)
    ? obj.map((v, i) => [i, v])
    : Object.entries(obj);

  for (const [k, v] of entries) {
    if (!sanitizeKey(k)) {
      if (auditFields) auditFields.blocked.push(String(k));
      continue;
    }
    const rawKey = typeof k === 'string' ? k : String(k);
    if (!Array.isArray(obj) && isMetaField(rawKey)) {
      out[k] = v;
      continue;
    }
    if (typeof v === 'string') {
      out[k] = sanitizeValue(v);
    } else if (typeof v === 'object' && v !== null) {
      out[k] = sanitizeObject(v, depth + 1, auditFields);
    } else {
      out[k] = v;
    }
  }

  return out;
}

export function validateAndSanitize(body, audit) {
  const result = {};
  const ignored = [];
  const rejected = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { result, ignored, rejected: ['invalid body type'] };
  }

  const cleaned = sanitizeObject(body, 0, null);

  for (const [key, rawValue] of Object.entries(cleaned)) {
    if (isMetaField(key)) {
      result[key] = rawValue;
      continue;
    }

    if (!isKnownField(key)) {
      ignored.push(key);
      continue;
    }

    const schema = SCHEMA[key];
    let effectiveSchema = schema;

    if (!effectiveSchema) {
      for (const p of PROVIDER_KEY_PATTERNS) {
        if (p.test(key)) {
          if (/Key$/i.test(key) || /Secret$/i.test(key)) {
            effectiveSchema = { type: 'secret', maxLength: 512 };
          } else if (/Priority$/i.test(key)) {
            effectiveSchema = { type: 'number', min: 1, max: 10 };
          } else if (/Env$/i.test(key)) {
            effectiveSchema = { type: 'string', maxLength: 32 };
          } else if (/Url$/i.test(key)) {
            effectiveSchema = { type: 'url', maxLength: 512 };
          } else if (/Countries$/i.test(key)) {
            effectiveSchema = { type: 'string', maxLength: 2048 };
          }
          break;
        }
      }
    }

    if (!effectiveSchema) {
      ignored.push(key);
      continue;
    }

    const { valid, reason } = validateField(key, rawValue, effectiveSchema);
    if (valid) {
      result[key] = rawValue;
    } else {
      rejected.push(`${key} (${reason})`);
    }
  }

  if (audit && (ignored.length || rejected.length)) {
    const entries = [];
    if (ignored.length) entries.push(`ignoredFields:${ignored.join(',')}`);
    if (rejected.length) entries.push(`rejectedFields:${rejected.join(',')}`);
    audit.push(...entries);
  }

  return { result: cleanResult(result), ignored, rejected };
}

function cleanResult(result) {
  if (typeof result !== 'object' || result === null) return result;
  if (Array.isArray(result)) {
    return result.map(cleanResult);
  }
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (!sanitizeKey(k)) continue;
    out[k] = cleanResult(v);
  }
  return out;
}

export function maskSensitiveForBackup(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const out = Array.isArray(settings) ? [] : {};
  for (const [k, v] of Object.entries(settings)) {
    if (isSensitiveFieldName(k) && typeof v === 'string' && v.length > 0) {
      out[k] = '********';
    } else if (k === 'bankAccounts' && Array.isArray(v)) {
      out[k] = v.map(maskBankEntry);
    } else if (k === 'cards' && Array.isArray(v)) {
      out[k] = v.map(maskCardEntry);
    } else if (typeof v === 'object' && v !== null) {
      out[k] = maskSensitiveForBackup(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function maskBankEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = { ...entry };
  for (const key of FINANCIAL_SENSITIVE_KEYS) {
    if (typeof out[key] === 'string' && out[key].length > 0) {
      out[key] = '********';
    }
  }
  return out;
}

function maskCardEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = { ...entry };
  for (const key of FINANCIAL_SENSITIVE_KEYS) {
    if (typeof out[key] === 'string' && out[key].length > 0) {
      out[key] = '********';
    }
  }
  return out;
}

let _cachedKey = null;
let _cachedKeySecret = null;

async function deriveCryptoKey(env) {
  const secret = env.SETTINGS_ENCRYPTION_KEY || env.AUTH_SECRET || 'elligentt-default-key-change-me';
  if (_cachedKey && _cachedKeySecret === secret) return _cachedKey;

  const salt = new Uint8Array([0x45, 0x6c, 0x6c, 0x69, 0x67, 0x65, 0x6e, 0x74, 0x74, 0x53, 0x65, 0x74, 0x74, 0x69, 0x6e, 0x67]);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  _cachedKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  _cachedKeySecret = secret;
  return _cachedKey;
}

function bufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function encryptValue(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(value)
  );
  return ENCRYPTION_PREFIX + ENCRYPTION_VERSION + ':' + bufferToBase64(iv) + ':' + bufferToBase64(ciphertext);
}

async function decryptValue(key, value) {
  const parts = value.slice(ENCRYPTION_PREFIX.length).split(':');
  if (parts.length < 3) return value;
  const iv = new Uint8Array(base64ToBuffer(parts[1]));
  const ciphertext = base64ToBuffer(parts.slice(2).join(':'));
  const dec = new TextDecoder();
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return dec.decode(plaintext);
}

function isEncrypted(val) {
  return typeof val === 'string' && val.startsWith(ENCRYPTION_PREFIX);
}

async function encryptFinancialData(obj, key, auditFields) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    const result = [];
    for (const item of obj) {
      result.push(await encryptFinancialData(item, key, auditFields));
    }
    return result;
  }
  const out = { ...obj };
  for (const [k, v] of Object.entries(out)) {
    if (FINANCIAL_SENSITIVE_KEYS.has(k) && typeof v === 'string' && v.length > 0 && !isEncrypted(v)) {
      out[k] = await encryptValue(key, v);
      if (auditFields) auditFields.push(`encrypted:${k}`);
    } else if (k === 'bankAccounts' && Array.isArray(v)) {
      out[k] = await encryptFinancialData(v, key, auditFields);
    } else if (k === 'cards' && Array.isArray(v)) {
      out[k] = await encryptFinancialData(v, key, auditFields);
    }
  }
  return out;
}

async function decryptFinancialData(obj, key, auditFields) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    const result = [];
    for (const item of obj) {
      result.push(await decryptFinancialData(item, key, auditFields));
    }
    return result;
  }
  const out = { ...obj };
  let migrated = false;
  for (const [k, v] of Object.entries(out)) {
    if (FINANCIAL_SENSITIVE_KEYS.has(k) && typeof v === 'string' && v.length > 0) {
      if (isEncrypted(v)) {
        out[k] = await decryptValue(key, v);
        if (out[k] !== v && auditFields) auditFields.push(`decrypted:${k}`);
      } else {
        migrated = true;
        if (auditFields) auditFields.push(`migration:${k}`);
      }
    } else if (k === 'bankAccounts' && Array.isArray(v)) {
      const decrypted = await decryptFinancialData(v, key, auditFields);
      if (decrypted !== v) { out[k] = decrypted; migrated = true; }
    } else if (k === 'cards' && Array.isArray(v)) {
      const decrypted = await decryptFinancialData(v, key, auditFields);
      if (decrypted !== v) { out[k] = decrypted; migrated = true; }
    }
  }
  if (migrated) {
    if (auditFields) auditFields.push('migrationPerformed');
    out._encryptedFields = true;
  }
  return out;
}

async function ensureEncrypted(settings, env, auditFields) {
  let needsSave = false;
  let key = null;

  const getKey = async () => {
    if (!key) key = await deriveCryptoKey(env);
    return key;
  };

  if (settings.bankAccounts && Array.isArray(settings.bankAccounts) && settings.bankAccounts.length > 0) {
    const hasUnencrypted = settings.bankAccounts.some(b =>
      b && typeof b === 'object' && Object.entries(b).some(([k, v]) =>
        FINANCIAL_SENSITIVE_KEYS.has(k) && typeof v === 'string' && v.length > 0 && !isEncrypted(v)
      )
    );
    if (hasUnencrypted) {
      settings.bankAccounts = await encryptFinancialData(settings.bankAccounts, await getKey(), auditFields);
      needsSave = true;
    }
  }

  if (settings.cards && Array.isArray(settings.cards) && settings.cards.length > 0) {
    const hasUnencrypted = settings.cards.some(c =>
      c && typeof c === 'object' && Object.entries(c).some(([k, v]) =>
        FINANCIAL_SENSITIVE_KEYS.has(k) && typeof v === 'string' && v.length > 0 && !isEncrypted(v)
      )
    );
    if (hasUnencrypted) {
      settings.cards = await encryptFinancialData(settings.cards, await getKey(), auditFields);
      needsSave = true;
    }
  }

  return { settings, needsSave };
}

export async function decryptSettingsForRead(settings, env, auditFields) {
  let result = settings;
  const hasBanks = result.bankAccounts && Array.isArray(result.bankAccounts) && result.bankAccounts.length > 0;
  const hasCards = result.cards && Array.isArray(result.cards) && result.cards.length > 0;

  if (!hasBanks && !hasCards) return result;

  const key = await deriveCryptoKey(env);

  if (hasBanks) {
    result = { ...result, bankAccounts: await decryptFinancialData(result.bankAccounts, key, auditFields) };
  }
  if (hasCards) {
    result = { ...result, cards: await decryptFinancialData(result.cards, key, auditFields) };
  }

  return result;
}

export async function encryptSettingsForWrite(settings, env, auditFields) {
  const key = await deriveCryptoKey(env);
  const result = { ...settings };
  let applied = false;

  if (result.bankAccounts && Array.isArray(result.bankAccounts) && result.bankAccounts.length > 0) {
    result.bankAccounts = await encryptFinancialData(result.bankAccounts, key, auditFields);
    applied = true;
  }
  if (result.cards && Array.isArray(result.cards) && result.cards.length > 0) {
    result.cards = await encryptFinancialData(result.cards, key, auditFields);
    applied = true;
  }

  if (applied && auditFields) auditFields.push('encryptionApplied');

  return result;
}

export async function autoMigrateIfNeeded(existingSettings, env, auditFields) {
  return ensureEncrypted(existingSettings, env, auditFields);
}

export { SCHEMA, isKnownField, isMetaField, isSensitiveFieldName };
