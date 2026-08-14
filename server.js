/**
 * RAMULOSE RACE CONTROL
 * Full-stack server using Turso / @libsql/client
 *
 * IMPORTANT:
 * Database access is handled entirely by ./db.js
 * Do NOT use better-sqlite3 in this file.
 */

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const dgram = require('dgram');

const {
  get,
  all,
  run,
  exec,
  batch,
  initSchema
} = require('./db');

const PORT = process.env.PORT || 3000;

const app = express();

/* =========================================================
   EXPRESS CONFIGURATION
========================================================= */

app.set('trust proxy', 1);

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json());
app.use(cookieParser());

app.use(session({
  secret: process.env.SESSION_SECRET || 'ramulose-rc-change-me-in-production-2026',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

app.use(express.static(path.join(__dirname, 'public')));


/* =========================================================
   ASYNC ROUTE HELPER
========================================================= */

function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}


/* =========================================================
   HELPERS
========================================================= */

function pad(n, len = 4) {
  return String(n).padStart(len, '0');
}

async function nextId(counterName, prefix) {
  const row = await get(
    'SELECT value FROM counters WHERE name = ?',
    [counterName]
  );

  const next = (row ? Number(row.value) : 0) + 1;

  await run(
    'UPDATE counters SET value = ? WHERE name = ?',
    [next, counterName]
  );

  return `${prefix}-${pad(next)}`;
}

async function audit(action, byUser) {
  try {
    await run(
      'INSERT INTO audit_log (action, by_user) VALUES (?, ?)',
      [action, byUser || 'System']
    );
  } catch (err) {
    console.error('Audit log error:', err);
  }
}


/* =========================================================
   AUTHORIZATION
========================================================= */

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: 'Not logged in'
    });
  }

  next();
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.status(401).json({
        error: 'Not logged in'
      });
    }

    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({
        error: 'Permission denied'
      });
    }

    next();
  };
}


const FLAG_ROLES = [
  'OWNER',
  'ADMIN',
  'RACE_DIRECTOR',
  'DEPUTY_RACE_DIRECTOR'
];

const STEWARD_ROLES = [
  'OWNER',
  'ADMIN',
  'RACE_DIRECTOR',
  'DEPUTY_RACE_DIRECTOR',
  'STEWARD'
];

const INCIDENT_ROLES = [
  'OWNER',
  'ADMIN',
  'RACE_DIRECTOR',
  'DEPUTY_RACE_DIRECTOR',
  'STEWARD',
  'MARSHAL'
];

const ADMIN_ROLES = [
  'OWNER',
  'ADMIN'
];


/* =========================================================
   FLAGS
========================================================= */

const FLAG_META = {
  GREEN: {
    emoji: '🟢',
    label: 'GREEN FLAG',
    msg: 'Track is clear. Racing resumes.'
  },

  YELLOW: {
    emoji: '🟡',
    label: 'YELLOW FLAG',
    msg: 'Yellow flag. No overtaking.'
  },

  DOUBLE_YELLOW: {
    emoji: '🟠',
    label: 'DOUBLE YELLOW',
    msg: 'Double yellow. Extreme caution. Be prepared to stop.'
  },

  SAFETY_CAR: {
    emoji: '🚗',
    label: 'SAFETY CAR',
    msg: 'Safety Car deployed. Form up. No overtaking.'
  },

  RED: {
    emoji: '🔴',
    label: 'RED FLAG',
    msg: 'All drivers must safely return to the pits and await further instructions.'
  },

  CHEQUERED: {
    emoji: '🏁',
    label: 'CHEQUERED FLAG',
    msg: 'Race finished. Proceed to parc fermé.'
  }
};


/* =========================================================
   DISCORD
========================================================= */

async function sendDiscord(category, embed) {
  try {
    const cfg = await get(
      'SELECT * FROM discord_config WHERE id = 1'
    );

    if (!cfg || !cfg.enabled) {
      return {
        ok: false,
        reason: 'disabled'
      };
    }

    const catMap = {
      RACE_CONTROL: cfg.cat_race_control,
      INCIDENTS: cfg.cat_incidents,
      STEWARD_DECISIONS: cfg.cat_steward_decisions,
      PENALTIES: cfg.cat_penalties,
      MARSHAL_REPORTS: cfg.cat_marshal_reports,
      SYSTEM_ALERTS: cfg.cat_system_alerts
    };

    if (!catMap[category]) {
      return {
        ok: false,
        reason: 'category off'
      };
    }

    if (
      !cfg.webhook_url ||
      !cfg.webhook_url.startsWith(
        'https://discord.com/api/webhooks/'
      )
    ) {
      return {
        ok: false,
        reason: 'no webhook',
        demo: true
      };
    }

    const response = await fetch(cfg.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        username: 'Ramulose Race Control',
        embeds: [embed]
      })
    });

    if (response.ok || response.status === 204) {
      return {
        ok: true,
        real: true
      };
    }

    return {
      ok: false,
      reason: `HTTP ${response.status}`
    };

  } catch (err) {
    return {
      ok: false,
      reason: err.message
    };
  }
}


function buildFlagEmbed(flag, eventId, race) {
  const m = FLAG_META[flag] || {
    emoji: '🏁',
    label: flag,
    msg: ''
  };

  const colors = {
    GREEN: 0x00c853,
    YELLOW: 0xffd600,
    DOUBLE_YELLOW: 0xff9100,
    SAFETY_CAR: 0x00bcd4,
    RED: 0xff1744,
    CHEQUERED: 0xaaaaaa
  };

  return {
    title: `${m.emoji} ${m.label}`,
    description: m.msg,
    color: colors[flag] || 0xe10600,

    fields: [
      {
        name: 'League',
        value: race.league_name,
        inline: true
      },
      {
        name: 'Round',
        value: `Round ${race.round} — ${race.circuit}`,
        inline: true
      },
      {
        name: 'Lap',
        value: `${race.current_lap} / ${race.total_laps}`,
        inline: true
      },
      {
        name: 'Event ID',
        value: eventId,
        inline: true
      },
      {
        name: 'Time',
        value: new Date().toLocaleTimeString('en-GB'),
        inline: true
      }
    ],

    footer: {
      text: 'Ramulose Race Control'
    },

    timestamp: new Date().toISOString()
  };
}


/* =========================================================
   AUTH
========================================================= */

app.post(
  '/api/login',
  asyncHandler(async (req, res) => {

    const { username, pin } = req.body || {};

    if (!username || !pin) {
      return res.status(400).json({
        error: 'Username and PIN required'
      });
    }

    const user = await get(
      `SELECT *
       FROM users
       WHERE username = ?
       AND active = 1`,
      [username.trim().toLowerCase()]
    );

    if (
      !user ||
      !bcrypt.compareSync(
        String(pin),
        user.pin_hash
      )
    ) {
      return res.status(401).json({
        error: 'Invalid username or PIN'
      });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      display: user.display_name,
      role: user.role
    };

    await audit(
      'Logged in',
      user.display_name
    );

    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);

        return res.status(500).json({
          error: 'Session save failed'
        });
      }

      res.json({
        ok: true,
        user: req.session.user
      });
    });
  })
);


app.post(
  '/api/logout',
  asyncHandler(async (req, res) => {

    if (req.session.user) {
      await audit(
        'Logged out',
        req.session.user.display
      );
    }

    req.session.destroy(() => {
      res.json({
        ok: true
      });
    });
  })
);


app.get(
  '/api/me',
  (req, res) => {

    if (!req.session.user) {
      return res.status(401).json({
        error: 'Not logged in'
      });
    }

    res.json({
      user: req.session.user
    });
  }
);


/* =========================================================
   PROFILE
========================================================= */

app.post(
  '/api/me/profile',
  asyncHandler(async (req, res) => {

    if (!req.session.user) {
      return res.status(401).json({
        error: 'Not logged in'
      });
    }

    const {
      display_name,
      current_pin,
      new_pin
    } = req.body || {};

    const uid = req.session.user.id;

    const row = await get(
      'SELECT * FROM users WHERE id = ?',
      [uid]
    );

    if (!row) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    if (new_pin) {

      if (
        !current_pin ||
        !bcrypt.compareSync(
          String(current_pin),
          row.pin_hash
        )
      ) {
        return res.status(400).json({
          error: 'Current PIN is incorrect'
        });
      }

      if (String(new_pin).length < 4) {
        return res.status(400).json({
          error: 'New PIN must be at least 4 characters'
        });
      }

      const hash = bcrypt.hashSync(
        String(new_pin),
        10
      );

      await run(
        'UPDATE users SET pin_hash = ? WHERE id = ?',
        [hash, uid]
      );

      await audit(
        'Changed own PIN',
        req.session.user.display
      );
    }

    if (
      display_name &&
      display_name.trim()
    ) {

      const name = display_name.trim();

      await run(
        'UPDATE users SET display_name = ? WHERE id = ?',
        [name, uid]
      );

      req.session.user.display = name;

      await audit(
        `Changed display name to ${name}`,
        name
      );
    }

    res.json({
      ok: true,
      user: req.session.user
    });
  })
);


/* =========================================================
   RACE STATE
========================================================= */

app.get(
  '/api/race',
  requireAuth,
  asyncHandler(async (req, res) => {

    const race = await get(
      'SELECT * FROM race_state WHERE id = 1'
    );

    const events = await all(`
      SELECT
        e.*,
        u.display_name AS by_name
      FROM race_control_events e
      LEFT JOIN users u
        ON u.id = e.created_by
      ORDER BY e.id DESC
      LIMIT 30
    `);

    const incidents = await all(`
      SELECT *
      FROM incidents
      ORDER BY id DESC
      LIMIT 50
    `);

    res.json({
      race,
      events,
      incidents
    });
  })
);


app.get(
  '/api/public/race',
  asyncHandler(async (req, res) => {

    const race = await get(`
      SELECT
        league_name,
        season,
        round,
        circuit,
        current_lap,
        total_laps,
        status
      FROM race_state
      WHERE id = 1
    `);

    const events = await all(`
      SELECT
        event_id,
        flag,
        lap,
        created_at
      FROM race_control_events
      ORDER BY id DESC
      LIMIT 10
    `);

    const incidents = await all(`
      SELECT
        incident_id,
        lap,
        type,
        status,
        drivers
      FROM incidents
      WHERE status NOT IN (
        'CLEARED',
        'CLOSED',
        'DECIDED'
      )
      ORDER BY id DESC
      LIMIT 10
    `);

    res.json({
      race,
      events,
      incidents
    });
  })
);


/* =========================================================
   RACE SETUP
========================================================= */

app.post(
  '/api/race/setup',
  requireRoles(...ADMIN_ROLES),
  asyncHandler(async (req, res) => {

    const {
      league_name,
      season,
      round,
      circuit,
      total_laps,
      current_lap
    } = req.body || {};

    await run(`
      UPDATE race_state
      SET
        league_name = COALESCE(?, league_name),
        season = COALESCE(?, season),
        round = COALESCE(?, round),
        circuit = COALESCE(?, circuit),
        total_laps = COALESCE(?, total_laps),
        current_lap = COALESCE(?, current_lap),
        updated_at = datetime('now')
      WHERE id = 1
    `, [
      league_name,
      season,
      round,
      circuit,
      total_laps,
      current_lap
    ]);

    await audit(
      'Updated race setup',
      req.session.user.display
    );

    res.json({
      ok: true
    });
  })
);


app.post(
  '/api/race/lap',
  requireRoles(...FLAG_ROLES),
  asyncHandler(async (req, res) => {

    const { delta } = req.body || {};

    const race = await get(
      'SELECT * FROM race_state WHERE id = 1'
    );

    let lap =
      Number(race.current_lap) +
      (delta === -1 ? -1 : 1);

    if (lap < 1) lap = 1;

    if (lap > race.total_laps) {
      lap = race.total_laps;
    }

    await run(`
      UPDATE race_state
      SET
        current_lap = ?,
        updated_at = datetime('now')
      WHERE id = 1
    `, [lap]);

    res.json({
      ok: true,
      current_lap: lap
    });
  })
);


/* =========================================================
   FLAGS
========================================================= */

app.post(
  '/api/flag',
  requireRoles(...FLAG_ROLES),
  asyncHandler(async (req, res) => {

    const { flag } = req.body || {};

    if (!FLAG_META[flag]) {
      return res.status(400).json({
        error: 'Invalid flag'
      });
    }

    const race = await get(
      'SELECT * FROM race_state WHERE id = 1'
    );

    const eventId = await nextId(
      'rc',
      'RC'
    );

    const meta = FLAG_META[flag];

    await run(`
      UPDATE race_state
      SET
        status = ?,
        updated_at = datetime('now')
      WHERE id = 1
    `, [flag]);

    await run(`
      INSERT INTO race_control_events
        (
          event_id,
          flag,
          lap,
          message,
          created_by
        )
      VALUES (?, ?, ?, ?, ?)
    `, [
      eventId,
      flag,
      race.current_lap,
      meta.msg,
      req.session.user.id
    ]);

    await audit(
      `Activated ${meta.label} (${eventId})`,
      req.session.user.display
    );

    const updatedRace = await get(
      'SELECT * FROM race_state WHERE id = 1'
    );

    const discord = await sendDiscord(
      'RACE_CONTROL',
      buildFlagEmbed(
        flag,
        eventId,
        updatedRace
      )
    );

    res.json({
      ok: true,
      event_id: eventId,
      status: flag,
      discord
    });
  })
);


/* =========================================================
   INCIDENTS
========================================================= */

app.get(
  '/api/incidents',
  requireAuth,
  asyncHandler(async (req, res) => {

    const list = await all(`
      SELECT *
      FROM incidents
      ORDER BY id DESC
      LIMIT 100
    `);

    res.json({
      incidents: list
    });
  })
);


app.get(
  '/api/incidents/:id',
  requireAuth,
  asyncHandler(async (req, res) => {

    const inc = await get(
      'SELECT * FROM incidents WHERE incident_id = ?',
      [req.params.id]
    );

    if (!inc) {
      return res.status(404).json({
        error: 'Not found'
      });
    }

    const history = await all(`
      SELECT *
      FROM incident_history
      WHERE incident_id = ?
      ORDER BY id
    `, [req.params.id]);

    res.json({
      incident: inc,
      history
    });
  })
);


app.post(
  '/api/incidents',
  requireRoles(...INCIDENT_ROLES),
  asyncHandler(async (req, res) => {

    const b = req.body || {};

    const incidentId = await nextId(
      'inc',
      'INC'
    );

    const race = await get(
      'SELECT current_lap FROM race_state WHERE id = 1'
    );

    await run(`
      INSERT INTO incidents
        (
          incident_id,
          lap,
          sector,
          corner,
          drivers,
          type,
          description,
          marshal_name,
          status,
          created_by
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
    `, [
      incidentId,
      b.lap || race.current_lap,
      b.sector || '',
      b.corner || '',
      b.drivers || '',
      b.type || 'Other',
      b.description || '',
      b.marshal_name ||
        req.session.user.display,
      req.session.user.id
    ]);

    await run(`
      INSERT INTO incident_history
        (
          incident_id,
          action,
          by_user
        )
      VALUES (?, ?, ?)
    `, [
      incidentId,
      'Created',
      req.session.user.display
    ]);

    await audit(
      `Created ${incidentId}`,
      req.session.user.display
    );

    const embed = {
      title: `🚨 ${incidentId}`,

      description:
        b.description ||
        b.type ||
        'Incident reported',

      color: 0xff1744,

      fields: [
        {
          name: 'Lap',
          value: String(
            b.lap || race.current_lap
          ),
          inline: true
        },
        {
          name: 'Sector',
          value: String(
            b.sector || '—'
          ),
          inline: true
        },
        {
          name: 'Corner',
          value: b.corner || '—',
          inline: true
        },
        {
          name: 'Drivers',
          value: b.drivers || '—',
          inline: true
        },
        {
          name: 'Type',
          value: b.type || 'Other',
          inline: true
        },
        {
          name: 'Status',
          value: 'OPEN',
          inline: true
        },
        {
          name: 'Reported by',
          value:
            b.marshal_name ||
            req.session.user.display,
          inline: false
        }
      ],

      footer: {
        text: 'Ramulose Race Control'
      },

      timestamp: new Date().toISOString()
    };

    await sendDiscord(
      'INCIDENTS',
      embed
    );

    res.json({
      ok: true,
      incident_id: incidentId
    });
  })
);


app.patch(
  '/api/incidents/:id',
  requireRoles(...STEWARD_ROLES),
  asyncHandler(async (req, res) => {

    const inc = await get(
      'SELECT * FROM incidents WHERE incident_id = ?',
      [req.params.id]
    );

    if (!inc) {
      return res.status(404).json({
        error: 'Not found'
      });
    }

    const b = req.body || {};

    const updates = [];
    const params = [];

    if (b.status) {
      updates.push('status = ?');
      params.push(b.status);
    }

    if (b.steward_notes !== undefined) {
      updates.push('steward_notes = ?');
      params.push(b.steward_notes);
    }

    if (b.finding !== undefined) {
      updates.push('finding = ?');
      params.push(b.finding);
    }

    if (b.penalty !== undefined) {
      updates.push('penalty = ?');
      params.push(b.penalty);
    }

    let decisionId = inc.decision_id;

    if (b.publish_decision) {

      decisionId = await nextId(
        'dec',
        'DEC'
      );

      updates.push(
        'decision_id = ?'
      );

      params.push(decisionId);

      if (!b.status) {
        updates.push(
          'status = ?'
        );

        params.push('DECIDED');
      }
    }

    updates.push(
      "updated_at = datetime('now')"
    );

    updates.push(
      'updated_by = ?'
    );

    params.push(
      req.session.user.id
    );

    params.push(
      req.params.id
    );

    await run(
      `UPDATE incidents
       SET ${updates.join(', ')}
       WHERE incident_id = ?`,
      params
    );

    const actionParts = [];

    if (b.status) {
      actionParts.push(
        `Status → ${b.status}`
      );
    }

    if (b.publish_decision) {
      actionParts.push(
        `Decision ${decisionId} published`
      );
    }

    if (b.finding) {
      actionParts.push(
        'Finding added'
      );
    }

    if (b.penalty) {
      actionParts.push(
        `Penalty: ${b.penalty}`
      );
    }

    await run(`
      INSERT INTO incident_history
        (
          incident_id,
          action,
          by_user
        )
      VALUES (?, ?, ?)
    `, [
      req.params.id,
      actionParts.join('; ') ||
        'Updated',
      req.session.user.display
    ]);

    await audit(
      `Updated ${req.params.id}`,
      req.session.user.display
    );

    if (b.publish_decision) {

      const updated = await get(
        'SELECT * FROM incidents WHERE incident_id = ?',
        [req.params.id]
      );

      const embed = {
        title: '⚖️ STEWARD DECISION',

        description:
          updated.finding || '',

        color: 0xaa00ff,

        fields: [
          {
            name: 'Incident',
            value: updated.incident_id,
            inline: true
          },
          {
            name: 'Lap',
            value: String(
              updated.lap || '—'
            ),
            inline: true
          },
          {
            name: 'Drivers',
            value: updated.drivers || '—',
            inline: true
          },
          {
            name: 'Penalty',
            value:
              updated.penalty || 'None',
            inline: false
          },
          {
            name: 'Decision ID',
            value: decisionId,
            inline: true
          }
        ],

        footer: {
          text: 'Ramulose Race Control'
        },

        timestamp:
          new Date().toISOString()
      };

      await sendDiscord(
        'STEWARD_DECISIONS',
        embed
      );
    }

    res.json({
      ok: true,
      decision_id: decisionId
    });
  })
);


/* =========================================================
   USERS
========================================================= */

app.get(
  '/api/users',
  requireRoles(...ADMIN_ROLES),
  asyncHandler(async (req, res) => {

    const users = await all(`
      SELECT
        id,
        username,
        display_name,
        role,
        active,
        created_at
      FROM users
      ORDER BY role, username
    `);

    res.json({
      users
    });
  })
);


app.post(
  '/api/users',
  requireRoles(...ADMIN_ROLES),
  asyncHandler(async (req, res) => {

    const {
      username,
      display_name,
      pin,
      role
    } = req.body || {};

    if (
      !username ||
      !pin ||
      !role
    ) {
      return res.status(400).json({
        error:
          'username, pin, role required'
      });
    }

    const validRoles = [
      'OWNER',
      'ADMIN',
      'RACE_DIRECTOR',
      'DEPUTY_RACE_DIRECTOR',
      'STEWARD',
      'MARSHAL',
      'DRIVER',
      'SPECTATOR'
    ];

    if (!validRoles.includes(role)) {
      return res.status(400).json({
        error: 'Invalid role'
      });
    }

    const normalizedUsername =
      username
        .trim()
        .toLowerCase();

    const exists = await get(
      'SELECT id FROM users WHERE username = ?',
      [normalizedUsername]
    );

    if (exists) {
      return res.status(400).json({
        error: 'Username already exists'
      });
    }

    const hash = bcrypt.hashSync(
      String(pin),
      10
    );

    await run(`
      INSERT INTO users
        (
          username,
          display_name,
          pin_hash,
          role
        )
      VALUES (?, ?, ?, ?)
    `, [
      normalizedUsername,
      display_name || username,
      hash,
      role
    ]);

    await audit(
      `Added user ${normalizedUsername} as ${role}`,
      req.session.user.display
    );

    res.json({
      ok: true
    });
  })
);


app.delete(
  '/api/users/:username',
  requireRoles(...ADMIN_ROLES),
  asyncHandler(async (req, res) => {

    const uname =
      req.params.username
        .toLowerCase();

    if (uname === 'ramulose') {
      return res.status(400).json({
        error:
          'Cannot delete the owner account'
      });
    }

    if (
      req.session.user.username === uname
    ) {
      return res.status(400).json({
        error:
          'Cannot delete yourself'
      });
    }

    const result = await run(
      'DELETE FROM users WHERE username = ?',
      [uname]
    );

    if (Number(result.rowsAffected || 0) === 0) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    await audit(
      `Deleted user ${uname}`,
      req.session.user.display
    );

    res.json({
      ok: true
    });
  })
);


/* =========================================================
   DISCORD CONFIG
========================================================= */

app.get(
  '/api/discord',
  requireRoles(...ADMIN_ROLES),
  asyncHandler(async (req, res) => {

    const cfg = await get(
      'SELECT * FROM discord_config WHERE id = 1'
    );

    res.json({
      has_webhook:
        !!(
          cfg.webhook_url &&
          cfg.webhook_url.length > 10
        ),

      channel_name:
        cfg.channel_name,

      enabled:
        !!cfg.enabled,

      categories: {
        RACE_CONTROL:
          !!cfg.cat_race_control,

        INCIDENTS:
          !!cfg.cat_incidents,

        STEWARD_DECISIONS:
          !!cfg.cat_steward_decisions,

        PENALTIES:
          !!cfg.cat_penalties,

        MARSHAL_REPORTS:
          !!cfg.cat_marshal_reports,

        SYSTEM_ALERTS:
          !!cfg.cat_system_alerts
      }
    });
  })
);


app.post(
  '/api/discord',
  requireRoles(...ADMIN_ROLES),
  asyncHandler(async (req, res) => {

    const b = req.body || {};

    const sets = [];
    const params = [];

    if (b.webhook_url !== undefined) {
      sets.push(
        'webhook_url = ?'
      );

      params.push(
        b.webhook_url.trim()
      );
    }

    if (b.channel_name !== undefined) {
      sets.push(
        'channel_name = ?'
      );

      params.push(
        b.channel_name
      );
    }

    if (b.enabled !== undefined) {
      sets.push(
        'enabled = ?'
      );

      params.push(
        b.enabled ? 1 : 0
      );
    }

    if (b.categories) {

      const map = {
        RACE_CONTROL:
          'cat_race_control',

        INCIDENTS:
          'cat_incidents',

        STEWARD_DECISIONS:
          'cat_steward_decisions',

        PENALTIES:
          'cat_penalties',

        MARSHAL_REPORTS:
          'cat_marshal_reports',

        SYSTEM_ALERTS:
          'cat_system_alerts'
      };

      for (
        const [key, column]
        of Object.entries(map)
      ) {

        if (
          b.categories[key] !== undefined
        ) {

          sets.push(
            `${column} = ?`
          );

          params.push(
            b.categories[key] ? 1 : 0
          );
        }
      }
    }

    if (sets.length) {

      await run(
        `UPDATE discord_config
         SET ${sets.join(', ')}
         WHERE id = 1`,
        params
      );

      await audit(
        'Updated Discord config',
        req.session.user.display
      );
    }

    res.json({
      ok: true
    });
  })
);


app.post(
  '/api/discord/test',
  requireRoles(...ADMIN_ROLES),
  asyncHandler(async (req, res) => {

    const race = await get(
      'SELECT * FROM race_state WHERE id = 1'
    );

    const embed = {
      title: '✅ Webhook Test',

      description:
        'Ramulose Race Control test message.\n' +
        'If you see this, the webhook is working!',

      color: 0x00c853,

      fields: [
        {
          name: 'League',
          value: race.league_name,
          inline: true
        },
        {
          name: 'Time',
          value:
            new Date().toLocaleTimeString(
              'en-GB'
            ),
          inline: true
        }
      ],

      footer: {
        text:
          'Ramulose Race Control — Test'
      },

      timestamp:
        new Date().toISOString()
    };

    const result =
      await sendDiscord(
        'SYSTEM_ALERTS',
        embed
      );

    res.json(result);
  })
);


/* =========================================================
   PENALTIES
========================================================= */

app.get(
  '/api/penalties',
  requireAuth,
  asyncHandler(async (req, res) => {

    const list = await all(`
      SELECT name
      FROM penalties
      ORDER BY sort_order, id
    `);

    res.json({
      penalties:
        list.map(p => p.name)
    });
  })
);


/* =========================================================
   AUDIT
========================================================= */

app.get(
  '/api/audit',
  requireRoles(
    ...STEWARD_ROLES,
    'ADMIN',
    'OWNER'
  ),
  asyncHandler(async (req, res) => {

    const logs = await all(`
      SELECT *
      FROM audit_log
      ORDER BY id DESC
      LIMIT 100
    `);

    res.json({
      logs
    });
  })
);


/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/api/health',
  asyncHandler(async (req, res) => {

    try {

      const result = await get(
        'SELECT 1 AS ok'
      );

      res.json({
        ok: true,
        database: result ? 'connected' : 'unknown',
        name: 'Ramulose Race Control'
      });

    } catch (err) {

      console.error(
        'Health database error:',
        err
      );

      res.status(500).json({
        ok: false,
        database: 'error',
        name: 'Ramulose Race Control'
      });
    }
  })
);


/* =========================================================
   F1 25 UDP TELEMETRY
========================================================= */

const TELEMETRY_PORT =
  parseInt(
    process.env.F1_UDP_PORT || '20777',
    10
  );

let telemetry = {
  connected: false,
  lastPacketAt: null,
  trackId: null,
  trackName: null,
  totalLaps: null,
  currentLap: null,
  sessionType: null,
  safetyCar: null,
  networkGame: null
};


const TRACK_NAMES = {
  0: 'Melbourne',
  1: 'Paul Ricard',
  2: 'Shanghai',
  3: 'Sakhir',
  4: 'Catalunya',
  5: 'Monaco',
  6: 'Montreal',
  7: 'Silverstone',
  8: 'Hockenheim',
  9: 'Hungaroring',
  10: 'Spa',
  11: 'Monza',
  12: 'Singapore',
  13: 'Suzuka',
  14: 'Abu Dhabi',
  15: 'Texas',
  16: 'Brazil',
  17: 'Austria',
  18: 'Sochi',
  19: 'Mexico',
  20: 'Baku',
  21: 'Bahrain Short',
  22: 'Silverstone Short',
  23: 'Texas Short',
  24: 'Suzuka Short',
  25: 'Hanoi',
  26: 'Zandvoort',
  27: 'Imola',
  28: 'Portimao',
  29: 'Jeddah',
  30: 'Miami',
  31: 'Las Vegas',
  32: 'Losail',
  39: 'Silverstone'
};


const SESSION_TYPES = {
  0: 'Unknown',
  1: 'Practice 1',
  2: 'Practice 2',
  3: 'Practice 3',
  4: 'Short Practice',
  5: 'Qualifying 1',
  6: 'Qualifying 2',
  7: 'Qualifying 3',
  8: 'Short Qualifying',
  9: 'One-Shot Qualifying',
  10: 'Race',
  11: 'Race 2',
  12: 'Race 3',
  13: 'Time Trial',
  15: 'Race'
};


function readU16(buf, offset) {
  return buf.readUInt16LE(offset);
}

function readU8(buf, offset) {
  return buf.readUInt8(offset);
}


/**
 * Parse F1 telemetry packets.
 *
 * Database writes are intentionally asynchronous.
 * Telemetry continues even if a database update fails.
 */
async function parseF1Packet(msg) {

  if (!msg || msg.length < 24) {
    return;
  }

  const packetFormat =
    readU16(msg, 0);

  if (
    packetFormat < 2023 ||
    packetFormat > 2026
  ) {
    return;
  }

  const packetId =
    readU8(msg, 6);

  telemetry.connected = true;
  telemetry.lastPacketAt = Date.now();


  /* ---------------------------------------------------------
     SESSION PACKET
  --------------------------------------------------------- */

  if (
    packetId === 1 &&
    msg.length > 40
  ) {

    const headerSize = 29;

    try {

      const totalLaps =
        readU8(
          msg,
          headerSize + 3
        );

      const sessionType =
        readU8(
          msg,
          headerSize + 6
        );

      const trackId =
        msg.readInt8(
          headerSize + 7
        );

      let safetyCar = 0;

      if (
        msg.length >
        headerSize + 20
      ) {

        safetyCar =
          readU8(
            msg,
            headerSize + 19
          );

        if (safetyCar > 4) {
          safetyCar =
            readU8(
              msg,
              headerSize + 17
            );
        }

        if (safetyCar > 4) {
          safetyCar = 0;
        }
      }

      telemetry.totalLaps =
        totalLaps ||
        telemetry.totalLaps;

      telemetry.sessionType =
        SESSION_TYPES[sessionType] ||
        String(sessionType);

      telemetry.trackId =
        trackId;

      telemetry.trackName =
        TRACK_NAMES[trackId] ||
        `Track ${trackId}`;

      telemetry.safetyCar =
        safetyCar;


      if (
        totalLaps > 0 &&
        totalLaps < 200
      ) {

        await run(`
          UPDATE race_state
          SET
            total_laps = ?,
            circuit = ?,
            updated_at = datetime('now')
          WHERE id = 1
        `, [
          totalLaps,
          telemetry.trackName
        ]);
      }

    } catch (err) {
      // Ignore malformed telemetry packet
    }
  }


  /* ---------------------------------------------------------
     LAP DATA PACKET
  --------------------------------------------------------- */

  if (
    packetId === 2 &&
    msg.length > 40
  ) {

    const headerSize = 29;

    try {

      const playerCarIndex =
        readU8(msg, 27);

      const lapDataSize = 53;

      const base =
        headerSize +
        (
          playerCarIndex *
          lapDataSize
        );

      if (
        base + 30 <
        msg.length
      ) {

        const currentLapNum =
          readU8(
            msg,
            base + 50
          );

        if (
          currentLapNum >= 1 &&
          currentLapNum <= 200
        ) {

          telemetry.currentLap =
            currentLapNum;

          await run(`
            UPDATE race_state
            SET
              current_lap = ?,
              updated_at = datetime('now')
            WHERE id = 1
          `, [
            currentLapNum
          ]);
        }
      }

    } catch (err) {
      // Ignore malformed telemetry packet
    }
  }
}


/* ---------------------------------------------------------
   UDP SERVER
--------------------------------------------------------- */

try {

  const udpServer =
    dgram.createSocket('udp4');

  udpServer.on(
    'message',
    (msg) => {

      parseF1Packet(msg)
        .catch(() => {});
    }
  );

  udpServer.on(
    'error',
    (err) => {

      console.warn(
        'F1 UDP telemetry error:',
        err.message
      );
    }
  );

  udpServer.bind(
    TELEMETRY_PORT,
    () => {

      console.log(
        `F1 25 telemetry listening on UDP port ${TELEMETRY_PORT}`
      );
    }
  );

} catch (err) {

  console.warn(
    'Could not start F1 UDP listener:',
    err.message
  );
}


/* =========================================================
   TELEMETRY API
========================================================= */

app.get(
  '/api/telemetry',
  requireAuth,
  (req, res) => {

    const age =
      telemetry.lastPacketAt
        ? Date.now() -
          telemetry.lastPacketAt
        : null;

    res.json({
      connected:
        !!(
          telemetry.connected &&
          age !== null &&
          age < 5000
        ),

      lastPacketAgeMs:
        age,

      trackName:
        telemetry.trackName,

      totalLaps:
        telemetry.totalLaps,

      currentLap:
        telemetry.currentLap,

      sessionType:
        telemetry.sessionType,

      safetyCar:
        telemetry.safetyCar
    });
  }
);


/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (err, req, res, next) => {

    console.error(
      'SERVER ERROR:',
      err
    );

    if (res.headersSent) {
      return next(err);
    }

    res.status(500).json({
      error: 'Internal server error'
    });
  }
);


/* =========================================================
   SPA FALLBACK
========================================================= */

app.get(
  '*',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );
  }
);


/* =========================================================
   START SERVER AFTER DATABASE INITIALIZATION
========================================================= */

async function startServer() {

  try {

    console.log(
      'Initializing database...'
    );

    await initSchema();

    console.log(
      '✓ Database schema ready'
    );

    const databaseMode =
      process.env.TURSO_DATABASE_URL
        ? 'TURSO CLOUD'
        : 'LOCAL FILE';

    console.log(
      `✓ Database mode: ${databaseMode}`
    );

    if (
      !process.env.TURSO_DATABASE_URL
    ) {

      console.warn(
        '⚠ TURSO_DATABASE_URL is not set.'
      );

      console.warn(
        '⚠ The application is using the local development database.'
      );
    }

    if (
      process.env.TURSO_DATABASE_URL &&
      !process.env.TURSO_AUTH_TOKEN
    ) {

      console.warn(
        '⚠ TURSO_AUTH_TOKEN is not set.'
      );
    }


    app.listen(
      PORT,
      () => {

        console.log('');
        console.log(
          '🏎️  RAMULOSE RACE CONTROL running'
        );

        console.log(
          `    Port: ${PORT}`
        );

        console.log(
          `    Database: ${databaseMode}`
        );

        console.log(
          '    Login: ramulose / 1012'
        );

        console.log('');
      }
    );

  } catch (err) {

    console.error(
      '❌ DATABASE INITIALIZATION FAILED'
    );

    console.error(err);

    process.exit(1);
  }
}


startServer();
