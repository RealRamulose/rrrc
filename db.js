/**
 * Database layer — works with:
 * - Turso cloud (set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN)
 * - Local file for development (default: data/ramulose.db)
 */
const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const url = process.env.TURSO_DATABASE_URL || `file:${path.join(dataDir, 'ramulose.db')}`;
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

const client = createClient({
  url,
  authToken
});

async function get(sql, args = []) {
  const r = await client.execute({ sql, args });
  return r.rows[0] || null;
}

async function all(sql, args = []) {
  const r = await client.execute({ sql, args });
  return r.rows;
}

async function run(sql, args = []) {
  return client.execute({ sql, args });
}

async function exec(sql) {
  return client.execute(sql);
}

async function batch(statements) {
  return client.batch(statements, 'write');
}

async function initSchema() {
  await batch([
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS race_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      league_name TEXT NOT NULL DEFAULT 'Ramulose F1 League',
      season TEXT NOT NULL DEFAULT '2026',
      round INTEGER NOT NULL DEFAULT 1,
      circuit TEXT NOT NULL DEFAULT 'Monza',
      current_lap INTEGER NOT NULL DEFAULT 1,
      total_laps INTEGER NOT NULL DEFAULT 27,
      status TEXT NOT NULL DEFAULT 'GREEN',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS race_control_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      flag TEXT NOT NULL,
      lap INTEGER NOT NULL,
      message TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id TEXT NOT NULL UNIQUE,
      lap INTEGER,
      sector TEXT,
      corner TEXT,
      drivers TEXT,
      type TEXT,
      description TEXT,
      marshal_name TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN',
      steward_notes TEXT,
      finding TEXT,
      penalty TEXT,
      decision_id TEXT,
      created_by INTEGER,
      updated_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS incident_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id TEXT NOT NULL,
      action TEXT NOT NULL,
      by_user TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      by_user TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS discord_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      webhook_url TEXT DEFAULT '',
      channel_name TEXT DEFAULT 'race-control',
      enabled INTEGER NOT NULL DEFAULT 1,
      cat_race_control INTEGER NOT NULL DEFAULT 1,
      cat_incidents INTEGER NOT NULL DEFAULT 1,
      cat_steward_decisions INTEGER NOT NULL DEFAULT 1,
      cat_penalties INTEGER NOT NULL DEFAULT 1,
      cat_marshal_reports INTEGER NOT NULL DEFAULT 0,
      cat_system_alerts INTEGER NOT NULL DEFAULT 1
    )`,
    `CREATE TABLE IF NOT EXISTS penalties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    )`
  ]);

  // Seed race state
  const race = await get('SELECT id FROM race_state WHERE id = 1');
  if (!race) {
    await run(`INSERT INTO race_state (id, league_name, season, round, circuit, current_lap, total_laps, status)
      VALUES (1, 'Ramulose F1 League', '2026', 1, 'Monza', 1, 27, 'GREEN')`);
  }

  const discord = await get('SELECT id FROM discord_config WHERE id = 1');
  if (!discord) {
    await run('INSERT INTO discord_config (id) VALUES (1)');
  }

  for (const c of ['rc', 'inc', 'dec']) {
    const row = await get('SELECT name FROM counters WHERE name = ?', [c]);
    if (!row) await run('INSERT INTO counters (name, value) VALUES (?, 0)', [c]);
  }

  const defaultPenalties = [
    'Warning', '3-second penalty', '5-second penalty', '10-second penalty',
    '20-second penalty', '30-second penalty', 'Grid penalty', 'Points penalty',
    'Disqualification', 'Race suspension', 'Championship suspension'
  ];
  for (let i = 0; i < defaultPenalties.length; i++) {
    try {
      await run('INSERT OR IGNORE INTO penalties (name, sort_order) VALUES (?, ?)', [defaultPenalties[i], i]);
    } catch (_) {}
  }

  // Seed owner + demos only if no users
  const anyUser = await get('SELECT id FROM users LIMIT 1');
  if (!anyUser) {
    const bcrypt = require('bcryptjs');
    const seeds = [
      { username: 'ramulose', display: 'Ramulose', pin: '1012', role: 'OWNER' },
      { username: 'rd', display: 'Race Director', pin: '1234', role: 'RACE_DIRECTOR' },
      { username: 'marshal', display: 'Marshal 01', pin: '1111', role: 'MARSHAL' },
      { username: 'steward', display: 'Steward 01', pin: '2222', role: 'STEWARD' },
      { username: 'viewer', display: 'Spectator', pin: '9999', role: 'SPECTATOR' }
    ];
    for (const s of seeds) {
      const hash = bcrypt.hashSync(s.pin, 10);
      await run(
        'INSERT INTO users (username, display_name, pin_hash, role) VALUES (?, ?, ?, ?)',
        [s.username, s.display, hash, s.role]
      );
      console.log(`✓ Seeded user: ${s.username}`);
    }
  }

  const mode = process.env.TURSO_DATABASE_URL ? 'Turso cloud' : 'local file';
  console.log(`Database ready (${mode})`);
}

module.exports = { client, get, all, run, exec, batch, initSchema };
