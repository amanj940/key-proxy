import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import 'dotenv/config';

const DB_PATH = process.env.DB_PATH || './data/key-proxy.db';
const MK = Buffer.from(process.env.MASTER_KEY || '', 'hex');
if (MK.length !== 32) throw new Error('MASTER_KEY must be 64 hex chars (openssl rand -hex 32)');

// Initialize SQLite
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    name TEXT PRIMARY KEY,
    base_url TEXT NOT NULL,
    default_model TEXT,
    default_locked INTEGER DEFAULT 0,
    note TEXT,
    scanning INTEGER DEFAULT 0,
    scanned_at INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS keys (
    id TEXT PRIMARY KEY,
    provider_name TEXT NOT NULL,
    h TEXT NOT NULL,
    enc TEXT NOT NULL,
    tail TEXT NOT NULL,
    status TEXT DEFAULT 'unverified',
    disabled INTEGER DEFAULT 0,
    used INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    FOREIGN KEY (provider_name) REFERENCES providers(name) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS models (
    provider_name TEXT NOT NULL,
    model_id TEXT NOT NULL,
    type TEXT NOT NULL,
    ok INTEGER,
    enabled INTEGER DEFAULT 1,
    err TEXT,
    at INTEGER,
    PRIMARY KEY (provider_name, model_id),
    FOREIGN KEY (provider_name) REFERENCES providers(name) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hash TEXT UNIQUE NOT NULL,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    last_used INTEGER,
    budget REAL,
    spend REAL DEFAULT 0,
    rpm_limit INTEGER DEFAULT 0,
    tpm_limit INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS spend_logs (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    model TEXT NOT NULL,
    cost REAL NOT NULL,
    tokens INTEGER NOT NULL,
    latency INTEGER NOT NULL,
    status TEXT NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );

  CREATE INDEX IF NOT EXISTS idx_keys_provider ON keys(provider_name);
  CREATE INDEX IF NOT EXISTS idx_keys_status ON keys(status);
  CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_name);
  CREATE INDEX IF NOT EXISTS idx_clients_hash ON clients(hash);
  CREATE INDEX IF NOT EXISTS idx_spend_logs_client ON spend_logs(client_id);
  CREATE INDEX IF NOT EXISTS idx_spend_logs_timestamp ON spend_logs(timestamp);
`);

export const enc = (t) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', MK, iv);
  const e = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), e]).toString('base64');
};
export const dec = (s) => {
  const b = Buffer.from(s, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', MK, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
};
export const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

const PRESETS = {
  groq: ['https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile'],
  openrouter: ['https://openrouter.ai/api/v1', 'meta-llama/llama-3.3-70b-instruct:free'],
  gemini: ['https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-flash'],
  cerebras: ['https://api.cerebras.ai/v1', 'llama-3.3-70b'],
  mistral: ['https://api.mistral.ai/v1', 'mistral-small-latest'],
  sambanova: ['https://api.sambanova.ai/v1', 'Meta-Llama-3.3-70B-Instruct'],
  nvidia: ['https://integrate.api.nvidia.com/v1', 'meta/llama-3.3-70b-instruct'],
};

// Initialize presets
for (const [name, [baseUrl, defaultModel]] of Object.entries(PRESETS)) {
  const stmt = db.prepare('INSERT OR IGNORE INTO providers (name, base_url, default_model) VALUES (?, ?, ?)');
  stmt.run(name, baseUrl, defaultModel);
}

// Helper functions
export function getProviders() {
  const stmt = db.prepare(`
    SELECT name, base_url as baseUrl, default_model as defaultModel,
           default_locked as defaultLocked, note, scanning as scanning,
           scanned_at as scannedAt
    FROM providers
  `);
  const providers = stmt.all();

  for (const p of providers) {
    p.keys = getKeys(p.name);
    p.models = getModels(p.name);
  }

  return providers;
}

export function getKeys(providerName) {
  const stmt = db.prepare('SELECT * FROM keys WHERE provider_name = ?');
  return stmt.all(providerName);
}

export function getModels(providerName) {
  const stmt = db.prepare('SELECT model_id as id, type, ok, enabled, err, at FROM models WHERE provider_name = ?');
  const models = stmt.all(providerName);
  const result = {};
  for (const m of models) {
    result[m.id] = {
      type: m.type,
      ok: m.ok === 1,
      enabled: m.enabled === 1,
      err: m.err,
      at: m.at
    };
  }
  return result;
}

export function getClients() {
  const stmt = db.prepare('SELECT id, name, prefix, created_at as created, used, last_used as last, budget, spend, rpm_limit as rpmLimit, tpm_limit as tpmLimit FROM clients');
  return stmt.all();
}

export function saveProvider(name, data) {
  const stmt = db.prepare(`
    INSERT INTO providers (name, base_url, default_model, default_locked)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      base_url = excluded.base_url,
      default_model = excluded.default_model,
      default_locked = excluded.default_locked
  `);
  stmt.run(name, data.baseUrl, data.defaultModel, data.defaultLocked ? 1 : 0);
}

export function deleteProvider(name) {
  db.prepare('DELETE FROM providers WHERE name = ?').run(name);
}

export function addKey(providerName, keyData) {
  const stmt = db.prepare(`
    INSERT INTO keys (id, provider_name, h, enc, tail, status, disabled, used, errors)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    keyData.id,
    providerName,
    keyData.h,
    keyData.enc,
    keyData.tail,
    keyData.status || 'unverified',
    keyData.disabled ? 1 : 0,
    keyData.used || 0,
    keyData.errors || 0
  );
}

export function updateKey(providerName, keyId, updates) {
  const setClauses = [];
  const params = [];

  if (updates.disabled !== undefined) {
    setClauses.push('disabled = ?');
    params.push(updates.disabled ? 1 : 0);
  }
  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    params.push(updates.status);
  }
  if (updates.used !== undefined) {
    setClauses.push('used = ?');
    params.push(updates.used);
  }
  if (updates.errors !== undefined) {
    setClauses.push('errors = ?');
    params.push(updates.errors);
  }

  if (setClauses.length === 0) return;

  params.push(providerName, keyId);
  const stmt = db.prepare(`
    UPDATE keys SET ${setClauses.join(', ')}
    WHERE provider_name = ? AND id = ?
  `);
  stmt.run(...params);
}

export function deleteKey(providerName, keyId) {
  db.prepare('DELETE FROM keys WHERE provider_name = ? AND id = ?').run(providerName, keyId);
}

export function saveModels(providerName, models) {
  db.prepare('DELETE FROM models WHERE provider_name = ?').run(providerName);

  const stmt = db.prepare(`
    INSERT INTO models (provider_name, model_id, type, ok, enabled, err, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [id, m] of Object.entries(models)) {
    stmt.run(
      providerName,
      id,
      m.type,
      m.ok === true ? 1 : (m.ok === false ? 0 : null),
      m.enabled === false ? 0 : 1,
      m.err || null,
      m.at || null
    );
  }
}

export function addClient(name, key, hash, prefix) {
  const id = crypto.randomUUID();
  const stmt = db.prepare(`
    INSERT INTO clients (id, name, hash, prefix, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(id, name, hash, prefix, Date.now());
  return { id, key };
}

export function deleteClient(id) {
  // Delete spend_logs first due to foreign key constraint
  db.prepare('DELETE FROM spend_logs WHERE client_id = ?').run(id);
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
}

export function updateClientUsage(id) {
  const stmt = db.prepare(`
    UPDATE clients
    SET used = used + 1, last_used = ?
    WHERE id = ?
  `);
  stmt.run(Date.now(), id);
}

export function updateClientSpend(id, cost) {
  const stmt = db.prepare(`
    UPDATE clients
    SET spend = spend + ?
    WHERE id = ?
  `);
  stmt.run(cost, id);
}

export function logSpend(data) {
  const stmt = db.prepare(`
    INSERT INTO spend_logs (id, timestamp, client_id, provider_name, model, cost, tokens, latency, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    crypto.randomUUID(),
    Date.now(),
    data.clientId,
    data.provider,
    data.model,
    data.cost,
    data.tokens,
    data.latency,
    data.status
  );
}

export function updateProviderModels(providerName, models, note, scanning, scannedAt) {
  const stmt = db.prepare(`
    UPDATE providers
    SET note = ?, scanning = ?, scanned_at = ?
    WHERE name = ?
  `);
  stmt.run(note || null, scanning ? 1 : 0, scannedAt || 0, providerName);
  saveModels(providerName, models);
}

// Compatibility layer for existing code
export let db_legacy = {
  providers: {},
  clients: []
};

// Load data on startup
function loadToLegacy() {
  const providers = getProviders();
  db_legacy.providers = {};
  for (const p of providers) {
    db_legacy.providers[p.name] = p;
  }
  db_legacy.clients = getClients();
}

loadToLegacy();

// Save function that syncs to SQLite
export function save(now = false) {
  if (now) {
    loadToLegacy();
  }
}

// Backup function
export function backup(path) {
  fs.copyFileSync(DB_PATH, path);
}

export default db;
export { db as db_sqlite, loadToLegacy };

export function getClientByHash(hash) {
  // Query directly from SQLite to ensure up-to-date data
  const stmt = db.prepare('SELECT id, name, hash, prefix, created_at as created, used, last_used as last, budget, spend, rpm_limit as rpmLimit, tpm_limit as tpmLimit FROM clients WHERE hash = ?');
  return stmt.get(hash);
}
