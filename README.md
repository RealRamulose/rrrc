# RAMULOSE RACE CONTROL

Multi-user F1 esports league Race Control system.

Everyone who logs in sees the **same live race** (flags, incidents, decisions).

---

## Owner login

- **Username:** `ramulose`
- **PIN:** `1012`

---

## Run on your computer (first time)

### 1. Install Node.js

Download and install from: https://nodejs.org  
(Choose the **LTS** version)

### 2. Open a terminal in this folder

```bash
cd ramulose-rc
```

### 3. Install dependencies

```bash
npm install
```

### 4. Create the database

```bash
node init-db.js
```

### 5. Start the server

```bash
npm start
```

### 6. Open in browser

Go to: **http://localhost:3000**

Sign in with `ramulose` / `1012`

---

## Put it online (for the whole league)

### Easiest: Railway

1. Create a free account at https://railway.app
2. Click **New Project** → **Deploy from GitHub** (or upload this folder)
3. Railway will detect Node.js and run `npm start`
4. You get a public URL like `https://your-app.up.railway.app`
5. Share that URL with your marshals, stewards, and drivers

### Alternative: Render

1. Go to https://render.com
2. New → Web Service
3. Connect this project
4. Build command: `npm install`
5. Start command: `npm start`
6. Free tier works fine for a league

---

## How to add users (PINs)

1. Log in as **ramulose** / **1012**
2. Open the **Users** tab
3. Fill in:
   - Username (what they type to log in)
   - Display Name
   - PIN
   - Role
4. Tap **Add User**
5. Give them their username + PIN

### Roles

| Role | Flags | Incidents | Penalties | Manage users |
|------|-------|-----------|-----------|--------------|
| Owner / Admin | Yes | Yes | Yes | Yes + Settings |
| Race Director | Yes | Yes | Yes | No |
| Steward | No | Yes | Yes | No |
| Marshal | No | Report only | No | No |
| Spectator | No | View only | No | No |

---

## Discord webhooks

1. In Discord: Server Settings → Integrations → Webhooks → New Webhook
2. Copy the webhook URL
3. In Race Control → **Settings** → paste the URL → Save
4. Press **Test Webhook**

The webhook URL is stored **only on the server**. Normal users never see it.

---

## Demo accounts (created automatically)

| Username | PIN  | Role          |
|----------|------|---------------|
| ramulose | 1012 | Owner         |
| rd       | 1234 | Race Director |
| marshal  | 1111 | Marshal       |
| steward  | 2222 | Steward       |
| viewer   | 9999 | Spectator     |

Change these PINs after first login.

---

## Connect F1 25 (EA Sports) telemetry

Race Control can listen to **live data from F1 25** over your network (UDP).

When connected it can read:
- Track / circuit name
- Total laps
- Current lap (player car)
- Session type (Practice / Qualifying / Race)
- Whether telemetry packets are arriving

### Important

- The **Race Control server must run on a PC** (or always-on computer) on the **same Wi‑Fi / network** as the machine/console playing F1 25.
- Your phone only opens the website — the PC is what receives game data.

### Step-by-step (PC playing F1 25)

1. Start Ramulose Race Control on your PC (`npm start`).
2. Find your PC’s IP address:
   - Windows: open Command Prompt → type `ipconfig` → look for **IPv4 Address** (example `192.168.1.50`)
   - Mac: System Settings → Network → Wi‑Fi → details
3. Open **F1 25**.
4. Go to **Settings → Telemetry Settings**.
5. Set:

| Setting | Value |
|---------|--------|
| UDP Telemetry | **On** |
| UDP Broadcast Mode | **Off** (try **On** if it does not connect) |
| UDP IP Address | Your PC IP (example `192.168.1.50`) or `127.0.0.1` if game + server are on the same PC |
| UDP Port | **20777** |
| UDP Send Rate | **20 Hz** or **60 Hz** |
| UDP Format | **2025** (or **2024** if 2025 does not work) |

6. Save settings and start a session (Practice or Race).
7. In Race Control (Dashboard) you should see: **F1 25: LIVE · Monza · Race** (example).

### PlayStation / Xbox

1. Race Control server still runs on a **PC on the same network**.
2. In F1 25 Telemetry Settings, set **UDP IP Address** to that PC’s IP (not the console IP).
3. Port **20777**, Format **2025**, Telemetry **On**.

### Firewall

If it does not connect on Windows:

1. Allow Node.js through the firewall, **or**
2. Allow inbound UDP port **20777**.

### What Race Control does with the data

- Updates **circuit name** and **total laps** from the session packet when possible
- Updates **current lap** from lap data when possible
- Shows connection status on the Dashboard

Flags (Green / Yellow / Red / Safety Car) stay under **Race Director control** on purpose, so league control is not overridden by the game automatically.

### Change telemetry port

```bash
F1_UDP_PORT=20777 npm start
```
