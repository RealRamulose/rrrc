/**
 * RAMULOSE RACE CONTROL — Full-stack server
 * Shared live race control for the whole league
 */
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const dgram = require('dgram');

const PORT = process.env.PORT || 3000;
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'ramulose.db');

// Auto-init DB if missing
if (!fs.existsSync(dbPath)) {
  console.log('Database not found — initializing...');
  require('./init-db.js');
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const app = express();
// Required on Render / Railway / any reverse proxy so secure cookies work
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'ramulose-rc-change-me-in-production-2026',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Helpers ----------
function pad(n, len = 4) {
  return String(n).padStart(len, '0');
}

function nextId(counterName, prefix) {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(counterName);
  const next = (row ? row.value : 0) + 1;
  db.prepare('UPDATE counters SET value = ? WHERE name = ?').run(next, counterName);
  return `${prefix}-${pad(next)}`;
}

function audit(action, byUser) {
  db.prepare('INSERT INTO audit_log (action, by_user) VALUES (?, ?)').run(action, byUser || 'System');
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    next();
  };
}

const FLAG_ROLES = ['OWNER', 'ADMIN', 'RACE_DIRECTOR', 'DEPUTY_RACE_DIRECTOR'];
const STEWARD_ROLES = ['OWNER', 'ADMIN', 'RACE_DIRECTOR', 'DEPUTY_RACE_DIRECTOR', 'STEWARD'];
const INCIDENT_ROLES = ['OWNER', 'ADMIN', 'RACE_DIRECTOR', 'DEPUTY_RACE_DIRECTOR', 'STEWARD', 'MARSHAL'];
const ADMIN_ROLES = ['OWNER', 'ADMIN'];

const FLAG_META = {
  GREEN: { emoji: '🟢', label: 'GREEN FLAG', msg: 'Track is clear. Racing resumes.' },
  YELLOW: { emoji: '🟡', label: 'YELLOW FLAG', msg: 'Yellow flag. No overtaking.' },
  DOUBLE_YELLOW: { emoji: '🟠', label: 'DOUBLE YELLOW', msg: 'Double yellow. Extreme caution. Be prepared to stop.' },
  SAFETY_CAR: { emoji: '🚗', label: 'SAFETY CAR', msg: 'Safety Car deployed. Form up. No overtaking.' },
  RED: { emoji: '🔴', label: 'RED FLAG', msg: 'All drivers must safely return to the pits and await further instructions.' },
  CHEQUERED: { emoji: '🏁', label: 'CHEQUERED FLAG', msg: 'Race finished. Proceed to parc fermé.' }
};

// ---------- Discord (server-side only) ----------
async function sendDiscord(category, embed) {
  const cfg = db.prepare('SELECT * FROM discord_config WHERE id = 1').get();
  if (!cfg || !cfg.enabled) return { ok: false, reason: 'disabled' };

  const catMap = {
    RACE_CONTROL: cfg.cat_race_control,
    INCIDENTS: cfg.cat_incidents,
    STEWARD_DECISIONS: cfg.cat_steward_decisions,
    PENALTIES: cfg.cat_penalties,
    MARSHAL_REPORTS: cfg.cat_marshal_reports,
    SYSTEM_ALERTS: cfg.cat_system_alerts
  };
  if (!catMap[category]) return { ok: false, reason: 'category off' };

  if (!cfg.webhook_url || !cfg.webhook_url.startsWith('https://discord.com/api/webhooks/')) {
    return { ok: false, reason: 'no webhook', demo: true };
  }

  try {
    const res = await fetch(cfg.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Ramulose Race Control', embeds: [embed] })
    });
    if (res.ok || res.status === 204) return { ok: true, real: true };
    return { ok: false, reason: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function buildFlagEmbed(flag, eventId, race) {
  const m = FLAG_META[flag] || { emoji: '🏁', label: flag, msg: '' };
  const colors = {
    GREEN: 0x00c853, YELLOW: 0xffd600, DOUBLE_YELLOW: 0xff9100,
    SAFETY_CAR: 0x00bcd4, RED: 0xff1744, CHEQUERED: 0xaaaaaa
  };
  return {
    title: `${m.emoji} ${m.label}`,
    description: m.msg,
    color: colors[flag] || 0xe10600,
    fields: [
      { name: 'League', value: race.league_name, inline: true },
      { name: 'Round', value: `Round ${race.round} — ${race.circuit}`, inline: true },
      { name: 'Lap', value: `${race.current_lap} / ${race.total_laps}`, inline: true },
      { name: 'Event ID', value: eventId, inline: true },
      { name: 'Time', value: new Date().toLocaleTimeString('en-GB'), inline: true }
    ],
    footer: { text: 'Ramulose Race Control' },
    timestamp: new Date().toISOString()
  };
}

// ---------- Auth ----------
app.post('/api/login', (req, res) => {
  const { username, pin } = req.body || {};
  if (!username || !pin) return res.status(400).json({ error: 'Username and PIN required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(String(pin), user.pin_hash)) {
    return res.status(401).json({ error: 'Invalid username or PIN' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    display: user.display_name,
    role: user.role
  };
  audit(`Logged in`, user.display_name);
  req.session.save((err) => {
    if (err) return res.status(500).json({ error: 'Session save failed' });
    res.json({ ok: true, user: req.session.user });
  });
});

app.post('/api/logout', (req, res) => {
  if (req.session.user) audit('Logged out', req.session.user.display);
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: req.session.user });
});

// Update own display name and/or PIN
app.post('/api/me/profile', requireAuth, (req, res) => {
  const { display_name, current_pin, new_pin } = req.body || {};
  const uid = req.session.user.id;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  if (!row) return res.status(404).json({ error: 'User not found' });

  // Changing PIN requires current PIN
  if (new_pin) {
    if (!current_pin || !bcrypt.compareSync(String(current_pin), row.pin_hash)) {
      return res.status(400).json({ error: 'Current PIN is incorrect' });
    }
    if (String(new_pin).length < 4) {
      return res.status(400).json({ error: 'New PIN must be at least 4 characters' });
    }
    const hash = bcrypt.hashSync(String(new_pin), 10);
    db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hash, uid);
    audit('Changed own PIN', req.session.user.display);
  }

  if (display_name && display_name.trim()) {
    const name = display_name.trim();
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, uid);
    req.session.user.display = name;
    audit(`Changed display name to ${name}`, name);
  }

  res.json({ ok: true, user: req.session.user });
});

// ---------- Race state ----------
app.get('/api/race', requireAuth, (req, res) => {
  const race = db.prepare('SELECT * FROM race_state WHERE id = 1').get();
  const events = db.prepare(`
    SELECT e.*, u.display_name as by_name
    FROM race_control_events e
    LEFT JOIN users u ON u.id = e.created_by
    ORDER BY e.id DESC LIMIT 30
  `).all();
  const incidents = db.prepare(`
    SELECT * FROM incidents ORDER BY id DESC LIMIT 50
  `).all();
  res.json({ race, events, incidents });
});

// Public (no auth) race snapshot for spectators who aren't logged in — optional
app.get('/api/public/race', (req, res) => {
  const race = db.prepare('SELECT league_name, season, round, circuit, current_lap, total_laps, status FROM race_state WHERE id = 1').get();
  const events = db.prepare(`
    SELECT event_id, flag, lap, created_at FROM race_control_events
    ORDER BY id DESC LIMIT 10
  `).all();
  const incidents = db.prepare(`
    SELECT incident_id, lap, type, status, drivers FROM incidents
    WHERE status NOT IN ('CLEARED','CLOSED','DECIDED')
    ORDER BY id DESC LIMIT 10
  `).all();
  res.json({ race, events, incidents });
});

app.post('/api/race/setup', requireRoles(...ADMIN_ROLES), (req, res) => {
  const { league_name, season, round, circuit, total_laps, current_lap } = req.body || {};
  db.prepare(`
    UPDATE race_state SET
      league_name = COALESCE(?, league_name),
      season = COALESCE(?, season),
      round = COALESCE(?, round),
      circuit = COALESCE(?, circuit),
      total_laps = COALESCE(?, total_laps),
      current_lap = COALESCE(?, current_lap),
      updated_at = datetime('now')
    WHERE id = 1
  `).run(league_name, season, round, circuit, total_laps, current_lap);
  audit('Updated race setup', req.session.user.display);
  res.json({ ok: true });
});

app.post('/api/race/lap', requireRoles(...FLAG_ROLES), (req, res) => {
  const { delta } = req.body || {};
  const race = db.prepare('SELECT * FROM race_state WHERE id = 1').get();
  let lap = race.current_lap + (delta === -1 ? -1 : 1);
  if (lap < 1) lap = 1;
  if (lap > race.total_laps) lap = race.total_laps;
  db.prepare('UPDATE race_state SET current_lap = ?, updated_at = datetime(\'now\') WHERE id = 1').run(lap);
  res.json({ ok: true, current_lap: lap });
});

// ---------- Flags ----------
app.post('/api/flag', requireRoles(...FLAG_ROLES), async (req, res) => {
  const { flag } = req.body || {};
  if (!FLAG_META[flag]) return res.status(400).json({ error: 'Invalid flag' });

  const race = db.prepare('SELECT * FROM race_state WHERE id = 1').get();
  const eventId = nextId('rc', 'RC');
  const meta = FLAG_META[flag];

  db.prepare(`
    UPDATE race_state SET status = ?, updated_at = datetime('now') WHERE id = 1
  `).run(flag);

  db.prepare(`
    INSERT INTO race_control_events (event_id, flag, lap, message, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(eventId, flag, race.current_lap, meta.msg, req.session.user.id);

  audit(`Activated ${meta.label} (${eventId})`, req.session.user.display);

  const updatedRace = db.prepare('SELECT * FROM race_state WHERE id = 1').get();
  const discord = await sendDiscord('RACE_CONTROL', buildFlagEmbed(flag, eventId, updatedRace));

  res.json({
    ok: true,
    event_id: eventId,
    status: flag,
    discord
  });
});

// ---------- Incidents ----------
app.get('/api/incidents', requireAuth, (req, res) => {
  const list = db.prepare('SELECT * FROM incidents ORDER BY id DESC LIMIT 100').all();
  res.json({ incidents: list });
});

app.get('/api/incidents/:id', requireAuth, (req, res) => {
  const inc = db.prepare('SELECT * FROM incidents WHERE incident_id = ?').get(req.params.id);
  if (!inc) return res.status(404).json({ error: 'Not found' });
  const history = db.prepare('SELECT * FROM incident_history WHERE incident_id = ? ORDER BY id').all(req.params.id);
  res.json({ incident: inc, history });
});

app.post('/api/incidents', requireRoles(...INCIDENT_ROLES), async (req, res) => {
  const b = req.body || {};
  const incidentId = nextId('inc', 'INC');
  const race = db.prepare('SELECT current_lap FROM race_state WHERE id = 1').get();

  db.prepare(`
    INSERT INTO incidents (
      incident_id, lap, sector, corner, drivers, type, description,
      marshal_name, status, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
  `).run(
    incidentId,
    b.lap || race.current_lap,
    b.sector || '',
    b.corner || '',
    b.drivers || '',
    b.type || 'Other',
    b.description || '',
    b.marshal_name || req.session.user.display,
    req.session.user.id
  );

  db.prepare(`
    INSERT INTO incident_history (incident_id, action, by_user) VALUES (?, ?, ?)
  `).run(incidentId, 'Created', req.session.user.display);

  audit(`Created ${incidentId}`, req.session.user.display);

  const embed = {
    title: `🚨 ${incidentId}`,
    description: b.description || b.type || 'Incident reported',
    color: 0xff1744,
    fields: [
      { name: 'Lap', value: String(b.lap || race.current_lap), inline: true },
      { name: 'Sector', value: String(b.sector || '—'), inline: true },
      { name: 'Corner', value: b.corner || '—', inline: true },
      { name: 'Drivers', value: b.drivers || '—', inline: true },
      { name: 'Type', value: b.type || 'Other', inline: true },
      { name: 'Status', value: 'OPEN', inline: true },
      { name: 'Reported by', value: b.marshal_name || req.session.user.display, inline: false }
    ],
    footer: { text: 'Ramulose Race Control' },
    timestamp: new Date().toISOString()
  };
  await sendDiscord('INCIDENTS', embed);

  res.json({ ok: true, incident_id: incidentId });
});

app.patch('/api/incidents/:id', requireRoles(...STEWARD_ROLES), async (req, res) => {
  const inc = db.prepare('SELECT * FROM incidents WHERE incident_id = ?').get(req.params.id);
  if (!inc) return res.status(404).json({ error: 'Not found' });

  const b = req.body || {};
  const updates = [];
  const params = [];

  if (b.status) { updates.push('status = ?'); params.push(b.status); }
  if (b.steward_notes !== undefined) { updates.push('steward_notes = ?'); params.push(b.steward_notes); }
  if (b.finding !== undefined) { updates.push('finding = ?'); params.push(b.finding); }
  if (b.penalty !== undefined) { updates.push('penalty = ?'); params.push(b.penalty); }

  let decisionId = inc.decision_id;
  if (b.publish_decision) {
    decisionId = nextId('dec', 'DEC');
    updates.push('decision_id = ?');
    params.push(decisionId);
    if (!b.status) { updates.push('status = ?'); params.push('DECIDED'); }
  }

  updates.push("updated_at = datetime('now')");
  updates.push('updated_by = ?');
  params.push(req.session.user.id);
  params.push(req.params.id);

  db.prepare(`UPDATE incidents SET ${updates.join(', ')} WHERE incident_id = ?`).run(...params);

  const actionParts = [];
  if (b.status) actionParts.push(`Status → ${b.status}`);
  if (b.publish_decision) actionParts.push(`Decision ${decisionId} published`);
  if (b.finding) actionParts.push('Finding added');
  if (b.penalty) actionParts.push(`Penalty: ${b.penalty}`);

  db.prepare(`
    INSERT INTO incident_history (incident_id, action, by_user) VALUES (?, ?, ?)
  `).run(req.params.id, actionParts.join('; ') || 'Updated', req.session.user.display);

  audit(`Updated ${req.params.id}`, req.session.user.display);

  if (b.publish_decision) {
    const updated = db.prepare('SELECT * FROM incidents WHERE incident_id = ?').get(req.params.id);
    const embed = {
      title: '⚖️ STEWARD DECISION',
      description: updated.finding || '',
      color: 0xaa00ff,
      fields: [
        { name: 'Incident', value: updated.incident_id, inline: true },
        { name: 'Lap', value: String(updated.lap || '—'), inline: true },
        { name: 'Drivers', value: updated.drivers || '—', inline: true },
        { name: 'Penalty', value: updated.penalty || 'None', inline: false },
        { name: 'Decision ID', value: decisionId, inline: true }
      ],
      footer: { text: 'Ramulose Race Control' },
      timestamp: new Date().toISOString()
    };
    await sendDiscord('STEWARD_DECISIONS', embed);
  }

  res.json({ ok: true, decision_id: decisionId });
});

// ---------- Users (Admin) ----------
app.get('/api/users', requireRoles(...ADMIN_ROLES), (req, res) => {
  const users = db.prepare(`
    SELECT id, username, display_name, role, active, created_at
    FROM users ORDER BY role, username
  `).all();
  res.json({ users });
});

app.post('/api/users', requireRoles(...ADMIN_ROLES), (req, res) => {
  const { username, display_name, pin, role } = req.body || {};
  if (!username || !pin || !role) return res.status(400).json({ error: 'username, pin, role required' });

  const validRoles = ['OWNER','ADMIN','RACE_DIRECTOR','DEPUTY_RACE_DIRECTOR','STEWARD','MARSHAL','DRIVER','SPECTATOR'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (exists) return res.status(400).json({ error: 'Username already exists' });

  const hash = bcrypt.hashSync(String(pin), 10);
  db.prepare(`
    INSERT INTO users (username, display_name, pin_hash, role)
    VALUES (?, ?, ?, ?)
  `).run(username.trim().toLowerCase(), display_name || username, hash, role);

  audit(`Added user ${username} as ${role}`, req.session.user.display);
  res.json({ ok: true });
});

app.delete('/api/users/:username', requireRoles(...ADMIN_ROLES), (req, res) => {
  const uname = req.params.username.toLowerCase();
  if (uname === 'ramulose') return res.status(400).json({ error: 'Cannot delete the owner account' });
  if (req.session.user.username === uname) return res.status(400).json({ error: 'Cannot delete yourself' });

  db.prepare('DELETE FROM users WHERE username = ?').run(uname);
  audit(`Deleted user ${uname}`, req.session.user.display);
  res.json({ ok: true });
});

// ---------- Discord config ----------
app.get('/api/discord', requireRoles(...ADMIN_ROLES), (req, res) => {
  const cfg = db.prepare('SELECT * FROM discord_config WHERE id = 1').get();
  // Never send full webhook URL to client — only whether set
  res.json({
    has_webhook: !!(cfg.webhook_url && cfg.webhook_url.length > 10),
    channel_name: cfg.channel_name,
    enabled: !!cfg.enabled,
    categories: {
      RACE_CONTROL: !!cfg.cat_race_control,
      INCIDENTS: !!cfg.cat_incidents,
      STEWARD_DECISIONS: !!cfg.cat_steward_decisions,
      PENALTIES: !!cfg.cat_penalties,
      MARSHAL_REPORTS: !!cfg.cat_marshal_reports,
      SYSTEM_ALERTS: !!cfg.cat_system_alerts
    }
  });
});

app.post('/api/discord', requireRoles(...ADMIN_ROLES), (req, res) => {
  const b = req.body || {};
  const sets = [];
  const params = [];

  if (b.webhook_url !== undefined) {
    sets.push('webhook_url = ?');
    params.push(b.webhook_url.trim());
  }
  if (b.channel_name !== undefined) {
    sets.push('channel_name = ?');
    params.push(b.channel_name);
  }
  if (b.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(b.enabled ? 1 : 0);
  }
  if (b.categories) {
    const map = {
      RACE_CONTROL: 'cat_race_control',
      INCIDENTS: 'cat_incidents',
      STEWARD_DECISIONS: 'cat_steward_decisions',
      PENALTIES: 'cat_penalties',
      MARSHAL_REPORTS: 'cat_marshal_reports',
      SYSTEM_ALERTS: 'cat_system_alerts'
    };
    for (const [k, col] of Object.entries(map)) {
      if (b.categories[k] !== undefined) {
        sets.push(`${col} = ?`);
        params.push(b.categories[k] ? 1 : 0);
      }
    }
  }

  if (sets.length) {
    db.prepare(`UPDATE discord_config SET ${sets.join(', ')} WHERE id = 1`).run(...params);
    audit('Updated Discord config', req.session.user.display);
  }
  res.json({ ok: true });
});

app.post('/api/discord/test', requireRoles(...ADMIN_ROLES), async (req, res) => {
  const race = db.prepare('SELECT * FROM race_state WHERE id = 1').get();
  const embed = {
    title: '✅ Webhook Test',
    description: 'Ramulose Race Control test message.\nIf you see this, the webhook is working!',
    color: 0x00c853,
    fields: [
      { name: 'League', value: race.league_name, inline: true },
      { name: 'Time', value: new Date().toLocaleTimeString('en-GB'), inline: true }
    ],
    footer: { text: 'Ramulose Race Control — Test' },
    timestamp: new Date().toISOString()
  };
  const result = await sendDiscord('SYSTEM_ALERTS', embed);
  res.json(result);
});

// ---------- Penalties & Audit ----------
app.get('/api/penalties', requireAuth, (req, res) => {
  const list = db.prepare('SELECT name FROM penalties ORDER BY sort_order, id').all();
  res.json({ penalties: list.map(p => p.name) });
});

app.get('/api/audit', requireRoles(...STEWARD_ROLES, 'ADMIN', 'OWNER'), (req, res) => {
  const logs = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all();
  res.json({ logs });
});

// ---------- Health ----------
app.get('/api/health', (req, res) => res.json({ ok: true, name: 'Ramulose Race Control' }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// ---------- F1 25 UDP Telemetry ----------
const TELEMETRY_PORT = parseInt(process.env.F1_UDP_PORT || '20777', 10);
let telemetry = {
  connected: false,
  lastPacketAt: null,
  trackId: null,
  trackName: null,
  totalLaps: null,
  currentLap: null,
  sessionType: null,
  safetyCar: null, // 0 none, 1 full, 2 VSC, 3 formation
  networkGame: null
};

// Common F1 track IDs (subset used in modern titles)
const TRACK_NAMES = {
  0: 'Melbourne', 1: 'Paul Ricard', 2: 'Shanghai', 3: 'Sakhir', 4: 'Catalunya',
  5: 'Monaco', 6: 'Montreal', 7: 'Silverstone', 8: 'Hockenheim', 9: 'Hungaroring',
  10: 'Spa', 11: 'Monza', 12: 'Singapore', 13: 'Suzuka', 14: 'Abu Dhabi',
  15: 'Texas', 16: 'Brazil', 17: 'Austria', 18: 'Sochi', 19: 'Mexico',
  20: 'Baku', 21: 'Bahrain Short', 22: 'Silverstone Short', 23: 'Texas Short',
  24: 'Suzuka Short', 25: 'Hanoi', 26: 'Zandvoort', 27: 'Imola', 28: 'Portimao',
  29: 'Jeddah', 30: 'Miami', 31: 'Las Vegas', 32: 'Losail', 39: 'Silverstone'
};

const SESSION_TYPES = {
  0: 'Unknown', 1: 'Practice 1', 2: 'Practice 2', 3: 'Practice 3',
  4: 'Short Practice', 5: 'Qualifying 1', 6: 'Qualifying 2', 7: 'Qualifying 3',
  8: 'Short Qualifying', 9: 'One-Shot Qualifying', 10: 'Race', 11: 'Race 2',
  12: 'Race 3', 13: 'Time Trial', 15: 'Race'
};

function readU16(buf, offset) { return buf.readUInt16LE(offset); }
function readU8(buf, offset) { return buf.readUInt8(offset); }
function readU32(buf, offset) { return buf.readUInt32LE(offset); }

function parseF1Packet(msg) {
  if (!msg || msg.length < 24) return;
  // Header: format(2) year(1) major(1) minor(1) pktVer(1) packetId(1) sessionUID(8) sessionTime(4) frame(4) overallFrame(4) playerCar(1) secondary(1) = ~29 bytes varies by year
  // F1 24/25 header is typically 29 bytes
  const packetFormat = readU16(msg, 0);
  if (packetFormat < 2023 || packetFormat > 2026) return;

  // packetId position: after format(2)+year+maj+min+pktVer = offset 6
  const packetId = readU8(msg, 6);
  telemetry.connected = true;
  telemetry.lastPacketAt = Date.now();

  // Session packet = 1
  if (packetId === 1 && msg.length > 40) {
    // Offsets approximate for 2024/2025 session packet after 29-byte header
    const headerSize = 29;
    try {
      const weather = readU8(msg, headerSize);
      const trackTemp = msg.readInt8(headerSize + 1);
      const airTemp = msg.readInt8(headerSize + 2);
      const totalLaps = readU8(msg, headerSize + 3);
      const trackLength = readU16(msg, headerSize + 4);
      const sessionType = readU8(msg, headerSize + 6);
      const trackId = msg.readInt8(headerSize + 7);
      // safety car status appears later in packet — search common offset ~header+15 to +25
      let safetyCar = 0;
      // In F1 23/24 session: m_safetyCarStatus is around offset header+19 area depending on version
      if (msg.length > headerSize + 20) {
        safetyCar = readU8(msg, headerSize + 19);
        if (safetyCar > 4) safetyCar = readU8(msg, headerSize + 17);
        if (safetyCar > 4) safetyCar = 0;
      }
      telemetry.totalLaps = totalLaps || telemetry.totalLaps;
      telemetry.sessionType = SESSION_TYPES[sessionType] || String(sessionType);
      telemetry.trackId = trackId;
      telemetry.trackName = TRACK_NAMES[trackId] || `Track ${trackId}`;
      telemetry.safetyCar = safetyCar;

      // Optionally sync race state from game (lap total + circuit name)
      if (totalLaps > 0 && totalLaps < 200) {
        db.prepare(`UPDATE race_state SET total_laps = ?, circuit = COALESCE(?, circuit), updated_at = datetime('now') WHERE id = 1`)
          .run(totalLaps, telemetry.trackName);
      }
    } catch (e) { /* ignore parse errors */ }
  }

  // Lap Data packet = 2 — player car current lap
  if (packetId === 2 && msg.length > 40) {
    const headerSize = 29;
    // Each LapData is ~53 bytes in recent formats; player car index is in header at offset 27 (approx)
    try {
      const playerCarIndex = readU8(msg, 27);
      const lapDataSize = 53;
      const base = headerSize + (playerCarIndex * lapDataSize);
      if (base + 30 < msg.length) {
        // m_currentLapNum is near the end of LapData structure
        // In F1 24: currentLapNum is often at offset ~50 within LapData
        const currentLapNum = readU8(msg, base + 50);
        if (currentLapNum >= 1 && currentLapNum <= 200) {
          telemetry.currentLap = currentLapNum;
          db.prepare(`UPDATE race_state SET current_lap = ?, updated_at = datetime('now') WHERE id = 1`)
            .run(currentLapNum);
        }
      }
    } catch (e) { /* ignore */ }
  }
}

try {
  const udpServer = dgram.createSocket('udp4');
  udpServer.on('message', (msg) => {
    try { parseF1Packet(msg); } catch (e) {}
  });
  udpServer.on('error', (err) => {
    console.warn('F1 UDP telemetry error:', err.message);
  });
  udpServer.bind(TELEMETRY_PORT, () => {
    console.log(`    F1 25 telemetry listening on UDP port ${TELEMETRY_PORT}`);
  });
} catch (e) {
  console.warn('Could not start F1 UDP listener:', e.message);
}

app.get('/api/telemetry', requireAuth, (req, res) => {
  const age = telemetry.lastPacketAt ? Date.now() - telemetry.lastPacketAt : null;
  res.json({
    connected: !!(telemetry.connected && age !== null && age < 5000),
    lastPacketAgeMs: age,
    trackName: telemetry.trackName,
    totalLaps: telemetry.totalLaps,
    currentLap: telemetry.currentLap,
    sessionType: telemetry.sessionType,
    safetyCar: telemetry.safetyCar
  });
});


app.listen(PORT, () => {
  console.log(`\n🏎️  RAMULOSE RACE CONTROL running`);
  console.log(`    Local:   http://localhost:${PORT}`);
  console.log(`    Login:   ramulose / 1012\n`);
});
