/**
 * Initializes the SQLite database for Ramulose Race Control
 * Run once: node init-db.js
 */
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'ramulose.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN (
      'OWNER','ADMIN','RACE_DIRECTOR','DEPUTY_RACE_DIRECTOR',
      'STEWARD','MARSHAL','DRIVER','SPECTATOR'
    )),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS race_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    league_name TEXT NOT NULL DEFAULT 'Ramulose F1 League',
    season TEXT NOT NULL DEFAULT '2026',
    round INTEGER NOT NULL DEFAULT 1,
    circuit TEXT NOT NULL DEFAULT 'Monza',
    current_lap INTEGER NOT NULL DEFAULT 1,
    total_laps INTEGER NOT NULL DEFAULT 27,
    status TEXT NOT NULL DEFAULT 'GREEN',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS race_control_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    flag TEXT NOT NULL,
    lap INTEGER NOT NULL,
    message TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS incidents (
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
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS incident_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL,
    action TEXT NOT NULL,
    by_user TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    by_user TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS discord_config (
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
  );

  CREATE TABLE IF NOT EXISTS penalties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );
`);

// Seed race state
const raceExists = db.prepare('SELECT id FROM race_state WHERE id = 1').get();
if (!raceExists) {
  db.prepare(`
    INSERT INTO race_state (id, league_name, season, round, circuit, current_lap, total_laps, status)
    VALUES (1, 'Ramulose F1 League', '2026', 1, 'Monza', 1, 27, 'GREEN')
  `).run();
}

// Seed Discord config
const discordExists = db.prepare('SELECT id FROM discord_config WHERE id = 1').get();
if (!discordExists) {
  db.prepare('INSERT INTO discord_config (id) VALUES (1)').run();
}

// Seed counters
const counters = ['rc', 'inc', 'dec'];
for (const c of counters) {
  const exists = db.prepare('SELECT name FROM counters WHERE name = ?').get(c);
  if (!exists) db.prepare('INSERT INTO counters (name, value) VALUES (?, 0)').run(c);
}

// Seed default penalties
const defaultPenalties = [
  'Warning', '3-second penalty', '5-second penalty', '10-second penalty',
  '20-second penalty', '30-second penalty', 'Grid penalty', 'Points penalty',
  'Disqualification', 'Race suspension', 'Championship suspension'
];
const insertPenalty = db.prepare('INSERT OR IGNORE INTO penalties (name, sort_order) VALUES (?, ?)');
defaultPenalties.forEach((p, i) => insertPenalty.run(p, i));

// Seed owner: ramulose / 1012
const ownerExists = db.prepare('SELECT id FROM users WHERE username = ?').get('ramulose');
if (!ownerExists) {
  const hash = bcrypt.hashSync('1012', 10);
  db.prepare(`
    INSERT INTO users (username, display_name, pin_hash, role)
    VALUES (?, ?, ?, ?)
  `).run('ramulose', 'Ramulose', hash, 'OWNER');
  console.log('✓ Created owner: ramulose / 1012');
}

// Helpful demo accounts
const demos = [
  { username: 'rd', display: 'Race Director', pin: '1234', role: 'RACE_DIRECTOR' },
  { username: 'marshal', display: 'Marshal 01', pin: '1111', role: 'MARSHAL' },
  { username: 'steward', display: 'Steward 01', pin: '2222', role: 'STEWARD' },
  { username: 'viewer', display: 'Spectator', pin: '9999', role: 'SPECTATOR' }
];
for (const d of demos) {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(d.username);
  if (!exists) {
    const hash = bcrypt.hashSync(d.pin, 10);
    db.prepare(`
      INSERT INTO users (username, display_name, pin_hash, role)
      VALUES (?, ?, ?, ?)
    `).run(d.username, d.display, hash, d.role);
    console.log(`✓ Created ${d.username} / ${d.pin} (${d.role})`);
  }
}

console.log('\nDatabase ready:', dbPath);
db.close();
