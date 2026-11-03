'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
// TIME_SCALE > 1 speeds the game up for testing (e.g. TIME_SCALE=20 -> 30 min match = 90 s)
const SCALE = Number(process.env.TIME_SCALE || 1);

const MIN = 60 * 1000;
// Per-match settings the host can change in the lobby (all times in minutes).
const DEFAULTS = {
  headStartMin: 3,
  pingEveryMin: 3,
  shrinkEveryMin: 10,
  durationMin: 30, // hunt length, counted from the end of the head start
  roleMode: 'random', // 'random' = server picks hunters, 'manual' = players choose
  hunterCount: 0, // 0 = automatic (about 1 hunter per 4 players)
};
const LIMITS = {
  headStartMin: [0, 30],
  pingEveryMin: [0.5, 30],
  shrinkEveryMin: [1, 60],
  durationMin: [5, 180],
  hunterCount: [0, 10],
};
const CFG = {
  shrinkFactor: 0.7,
  defaultRadius: 150, // metres
  maxRadiusLimit: 400, // host may choose any value up to this
  minRadiusLimit: 50, // lowest value the host may choose
  minRadius: 40, // the shrinking zone never goes below this
  maxPlayers: 20,
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 20000 });

app.disable('x-powered-by');
// Works with either layout: files inside ./public (normal) or all files flat in the
// project root (useful when uploading through GitHub's web uploader, which flattens folders).
const fs = require('fs');
const PUB = path.join(__dirname, 'public');
if (fs.existsSync(path.join(PUB, 'index.html'))) {
  app.use(express.static(PUB, { extensions: ['html'] }));
  app.get('/play', (req, res) => res.sendFile(path.join(PUB, 'play.html')));
} else {
  const send = (file) => (req, res) => res.sendFile(path.join(__dirname, file));
  app.get('/', send('index.html'));
  app.get(['/play', '/play.html'], send('play.html'));
  app.get(['/privacy', '/privacy.html'], send('privacy.html'));
  app.get(['/terms', '/terms.html'], send('terms.html'));
  app.get('/css/style.css', send('style.css'));
  app.get('/js/play.js', send('play.js'));
}
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/config.json', (req, res) =>
  res.json({ ...CFG, scale: SCALE })
);

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const rooms = new Map();

function roomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)];
  } while (rooms.has(c));
  return c;
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function hunterCountFor(settings, total) {
  const wanted = settings.hunterCount > 0 ? settings.hunterCount : Math.max(1, Math.round(total / 4));
  return Math.max(1, Math.min(wanted, total - 1));
}

function cleanName(n) {
  return String(n || '')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .slice(0, 20);
}

function hasFix(p) {
  return typeof p.lat === 'number' && typeof p.lng === 'number';
}

function alive(room) {
  return [...room.players.values()].filter((p) => p.side === 'shadow' && !p.caught);
}

// While roles are still to be drawn at random, nobody's side is shown.
function sideShown(room, p) {
  return room.phase === 'lobby' && room.settings.roleMode === 'random' ? 'random' : p.side;
}

function publicPlayer(p, room) {
  return {
    id: p.id,
    name: p.name,
    side: sideShown(room, p),
    caught: p.caught,
    connected: p.connected,
    host: room.hostId === p.id,
    hasFix: hasFix(p),
  };
}

function outsideZone(room, p) {
  if (!room.center || !hasFix(p)) return false;
  return haversine(room.center.lat, room.center.lng, p.lat, p.lng) > room.radius;
}

/** Build the state that one particular player is allowed to see. */
function viewFor(room, me) {
  const now = Date.now();
  const players = [...room.players.values()];
  const view = {
    now,
    code: room.code,
    phase: room.phase,
    cfg: {
      minRadius: CFG.minRadiusLimit,
      maxRadius: CFG.maxRadiusLimit,
      defaultRadius: CFG.defaultRadius,
      limits: LIMITS,
    },
    settings: room.settings,
    baseRadius: room.baseRadius,
    you: { id: me.id, side: sideShown(room, me), caught: me.caught, host: room.hostId === me.id },
    players: players.map((p) => publicPlayer(p, room)),
    zone: room.center ? { lat: room.center.lat, lng: room.center.lng, radius: room.radius } : null,
    times: {
      huntStartAt: room.huntStartAt,
      nextPingAt: room.nextPingAt,
      nextShrinkAt: room.nextShrinkAt,
      endAt: room.endAt,
    },
    winner: room.winner,
    endReason: room.endReason,
    mates: [],
    ping: null,
    revealed: [],
  };

  // teammates are visible live to each other (only during a match)
  if (room.phase === 'headstart' || room.phase === 'hunt') {
    for (const p of players) {
      if (p.id !== me.id && p.side === me.side && hasFix(p)) {
        view.mates.push({ id: p.id, name: p.name, lat: p.lat, lng: p.lng, caught: p.caught });
      }
    }
  }

  if (me.side === 'hunter' && room.phase === 'hunt') {
    view.ping = room.lastPing; // snapshot of shadows at last ping
    // Shadows that wander outside the zone are revealed live.
    for (const p of alive(room)) {
      if (outsideZone(room, p)) {
        view.revealed.push({ id: p.id, name: p.name, lat: p.lat, lng: p.lng });
      }
    }
  }

  // After the match everybody can see where everyone ended up.
  if (room.phase === 'ended') {
    view.final = players
      .filter(hasFix)
      .map((p) => ({ id: p.id, name: p.name, side: p.side, caught: p.caught, lat: p.lat, lng: p.lng }));
  }

  return view;
}

function broadcast(room) {
  room.updatedAt = Date.now();
  for (const p of room.players.values()) {
    if (p.connected && p.socketId) {
      io.to(p.socketId).emit('state', viewFor(room, p));
    }
  }
}

function doPing(room) {
  room.lastPing = {
    at: Date.now(),
    shadows: alive(room)
      .filter(hasFix)
      .map((p) => ({ id: p.id, name: p.name, lat: p.lat, lng: p.lng })),
  };
}

function endGame(room, winner, reason) {
  if (room.phase === 'ended') return;
  room.phase = 'ended';
  room.winner = winner;
  room.endReason = reason;
  room.endedAt = Date.now();
}

function checkWin(room) {
  if (room.phase !== 'headstart' && room.phase !== 'hunt') return;
  if (alive(room).length === 0) endGame(room, 'hunters', 'All Shadows were caught.');
}

function tickRoom(room) {
  const now = Date.now();

  if (room.phase === 'lobby') {
    // drop players who left the lobby and never came back
    for (const p of [...room.players.values()]) {
      if (!p.connected && now - p.lastSeen > 60 * 1000) room.players.delete(p.id);
    }
    if (room.players.size === 0) {
      rooms.delete(room.code);
      return;
    }
    if (!room.players.has(room.hostId)) room.hostId = room.players.keys().next().value;
  }

  if (room.phase === 'headstart' && now >= room.huntStartAt) {
    room.phase = 'hunt';
    room.nextPingAt = now;
    room.nextShrinkAt = now + room.t.shrinkEveryMs;
    room.endAt = now + room.t.durationMs;
  }

  if (room.phase === 'hunt') {
    if (now >= room.nextPingAt) {
      doPing(room);
      room.nextPingAt += room.t.pingEveryMs;
    }
    if (now >= room.nextShrinkAt) {
      room.radius = Math.max(CFG.minRadius, Math.round(room.radius * CFG.shrinkFactor));
      room.nextShrinkAt += room.t.shrinkEveryMs;
    }
    if (now >= room.endAt) endGame(room, 'shadows', 'The clock ran out. The Shadows survived.');
  }

  checkWin(room);
  broadcast(room);
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === 'ended') {
      // keep result screens around a bit, then clean up
      if (now - room.endedAt > 60 * MIN) rooms.delete(room.code);
      else broadcast(room);
      continue;
    }
    if (now - room.updatedAt > 6 * 60 * MIN) {
      rooms.delete(room.code);
      continue;
    }
    tickRoom(room);
  }
}, 1000);

/* ------------------------------------------------------------------ */
/* sockets                                                             */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {
  let ctx = { code: null, playerId: null };

  const getCtx = () => {
    const room = rooms.get(ctx.code);
    const me = room && room.players.get(ctx.playerId);
    return room && me ? { room, me } : {};
  };

  const attach = (room, me) => {
    me.socketId = socket.id;
    me.connected = true;
    me.lastSeen = Date.now();
    ctx = { code: room.code, playerId: me.id };
    socket.join(room.code);
  };

  socket.on('create', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const name = cleanName(data && data.name);
    if (!name) return ack({ ok: false, error: 'Enter a name first.' });
    const code = roomCode();
    const me = {
      id: crypto.randomUUID(),
      name,
      side: 'shadow',
      caught: false,
      connected: true,
      lastSeen: Date.now(),
    };
    const room = {
      code,
      hostId: me.id,
      players: new Map([[me.id, me]]),
      phase: 'lobby',
      settings: { ...DEFAULTS },
      t: null,
      baseRadius: CFG.defaultRadius,
      radius: CFG.defaultRadius,
      center: null,
      lastPing: null,
      winner: null,
      updatedAt: Date.now(),
    };
    rooms.set(code, room);
    attach(room, me);
    ack({ ok: true, code, playerId: me.id });
    broadcast(room);
  });

  socket.on('join', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const name = cleanName(data && data.name);
    const code = String((data && data.code) || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!name) return ack({ ok: false, error: 'Enter a name first.' });
    if (!room) return ack({ ok: false, error: 'No match with that code.' });
    if (room.phase !== 'lobby') return ack({ ok: false, error: 'That match already started.' });
    if (room.players.size >= CFG.maxPlayers) return ack({ ok: false, error: 'Match is full.' });
    const taken = [...room.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return ack({ ok: false, error: 'That name is taken in this match.' });
    const hunters = [...room.players.values()].filter((p) => p.side === 'hunter').length;
    const me = {
      id: crypto.randomUUID(),
      name,
      side: hunters < 1 ? 'hunter' : 'shadow',
      caught: false,
      connected: true,
      lastSeen: Date.now(),
    };
    room.players.set(me.id, me);
    attach(room, me);
    ack({ ok: true, code, playerId: me.id });
    broadcast(room);
  });

  socket.on('resume', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const room = rooms.get(String((data && data.code) || '').toUpperCase());
    const me = room && room.players.get(data && data.playerId);
    if (!room || !me) return ack({ ok: false });
    attach(room, me);
    ack({ ok: true, code: room.code, playerId: me.id });
    broadcast(room);
  });

  socket.on('setSide', (side) => {
    const { room, me } = getCtx();
    if (!room || room.phase !== 'lobby') return;
    if (side !== 'hunter' && side !== 'shadow') return;
    me.side = side;
    broadcast(room);
  });

  socket.on('setRadius', (r) => {
    const { room, me } = getCtx();
    if (!room || room.phase !== 'lobby' || room.hostId !== me.id) return;
    const n = Math.round(Number(r));
    if (!Number.isFinite(n)) return;
    // clamp: any value between the min and 400 m
    const v = Math.min(CFG.maxRadiusLimit, Math.max(CFG.minRadiusLimit, n));
    room.baseRadius = v;
    room.radius = v;
    broadcast(room);
  });

  socket.on('setSettings', (d) => {
    const { room, me } = getCtx();
    if (!room || room.phase !== 'lobby' || room.hostId !== me.id || !d) return;
    const s = room.settings;
    for (const k of Object.keys(LIMITS)) {
      if (d[k] === undefined) continue;
      let n = Number(d[k]);
      if (!Number.isFinite(n)) continue;
      const [lo, hi] = LIMITS[k];
      n = Math.min(hi, Math.max(lo, n));
      s[k] = k === 'hunterCount' ? Math.round(n) : Math.round(n * 2) / 2; // half-minute steps
    }
    if (d.roleMode === 'random' || d.roleMode === 'manual') s.roleMode = d.roleMode;
    broadcast(room);
  });

  socket.on('start', (_d, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const { room, me } = getCtx();
    if (!room) return ack({ ok: false, error: 'Not in a match.' });
    if (room.hostId !== me.id) return ack({ ok: false, error: 'Only the host can start.' });
    if (room.phase !== 'lobby') return ack({ ok: false, error: 'Already started.' });
    const all = [...room.players.values()];
    if (room.settings.roleMode === 'random') {
      if (all.length < 2) return ack({ ok: false, error: 'Need at least 2 players.' });
      const k = hunterCountFor(room.settings, all.length);
      shuffle([...all]).forEach((p, i) => { p.side = i < k ? 'hunter' : 'shadow'; });
    }
    const hunters = all.filter((p) => p.side === 'hunter');
    const shadows = all.filter((p) => p.side === 'shadow');
    if (!hunters.length || !shadows.length) {
      return ack({ ok: false, error: 'Need at least 1 Hunter and 1 Shadow.' });
    }
    const located = (shadows.some(hasFix) ? shadows : all).filter(hasFix);
    if (!located.length) {
      return ack({ ok: false, error: 'Waiting for GPS. Allow location access and try again.' });
    }
    room.center = {
      lat: located.reduce((s, p) => s + p.lat, 0) / located.length,
      lng: located.reduce((s, p) => s + p.lng, 0) / located.length,
    };
    room.radius = room.baseRadius;
    const now = Date.now();
    room.phase = 'headstart';
    room.startedAt = now;
    const st = room.settings;
    room.t = {
      headStartMs: (st.headStartMin * MIN) / SCALE,
      pingEveryMs: (st.pingEveryMin * MIN) / SCALE,
      shrinkEveryMs: (st.shrinkEveryMin * MIN) / SCALE,
      durationMs: (st.durationMin * MIN) / SCALE,
    };
    room.huntStartAt = now + room.t.headStartMs;
    room.nextPingAt = null;
    room.nextShrinkAt = null;
    room.endAt = null;
    room.lastPing = null;
    for (const p of all) p.caught = false;
    ack({ ok: true });
    broadcast(room);
  });

  socket.on('loc', (d) => {
    const { room, me } = getCtx();
    if (!room || !d) return;
    const lat = Number(d.lat);
    const lng = Number(d.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    me.lat = lat;
    me.lng = lng;
    me.acc = Number(d.acc) || null;
    me.locAt = Date.now();
    me.lastSeen = Date.now();
  });

  socket.on('tagged', () => {
    const { room, me } = getCtx();
    if (!room || room.phase !== 'hunt') return;
    if (me.side !== 'shadow' || me.caught) return;
    me.caught = true;
    checkWin(room);
    broadcast(room);
  });

  socket.on('leave', () => {
    const { room, me } = getCtx();
    if (!room) return;
    if (room.phase === 'lobby') {
      room.players.delete(me.id);
      if (room.hostId === me.id && room.players.size) room.hostId = room.players.keys().next().value;
    } else {
      me.connected = false;
      me.socketId = null;
    }
    socket.leave(room.code);
    ctx = { code: null, playerId: null };
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const { room, me } = getCtx();
    if (!room) return;
    if (me.socketId === socket.id) {
      me.connected = false;
      me.socketId = null;
      me.lastSeen = Date.now();
      broadcast(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`DuskHunt listening on :${PORT} (time scale x${SCALE})`);
});
