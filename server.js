const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ── Game state ──
const TICK_RATE = 60;
const GRAVITY = 0.55;
const MOVE_SPEED = 0.55;
const FRICTION = 0.85;
const MAX_FALL = 12;
const RECOIL_FORCE = 11;
const BULLET_SPEED = 14;
const SHOOT_COOLDOWN = 8;
const BULLET_DAMAGE = 5;
const MAX_HP = 20;
const RESPAWN_TIME = 3000;
const SPAWN_DELAY = 3.0;  // seconds a player stays locked at spawn before they can move/shoot
const MAX_PLAYERS = 4;

// Spawn x positions for slots 0..3
const SPAWN_X = [200, 700, 480, 200];
const SPAWN_X_GREEN = 700;

const platforms = [
  { x: 0, y: 580, w: 960, h: 60 },
  { x: 100, y: 470, w: 160, h: 16 },
  { x: 350, y: 400, w: 140, h: 16 },
  { x: 600, y: 350, w: 180, h: 16 },
  { x: 200, y: 280, w: 120, h: 16 },
  { x: 700, y: 480, w: 140, h: 16 },
  { x: 50, y: 180, w: 100, h: 16 },
  { x: 450, y: 220, w: 160, h: 16 },
  { x: 780, y: 200, w: 130, h: 16 },
  { x: 300, y: 130, w: 140, h: 16 },
  { x: 600, y: 100, w: 100, h: 16 },
];

// ── Players & lobby ──
const players = {};        // id -> player (in-game)
const lobby = [];          // array of player entries { id, slot (assigned at promotion), ws, name }
const wsToPlayer = new Map(); // ws -> { id, inLobby: bool, lobbyIdx: number }
const bullets = [];
let nextBulletId = 0;
let nextPlayerId = 0;

function getActivePlayerCount() {
  return Object.keys(players).length;
}

function findFreeSlot() {
  // Returns the lowest slot number 0..MAX_PLAYERS-1 that has no active player
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const id = 'p' + i;
    if (!players[id]) return i;
  }
  return -1;
}

function createPlayer(id, slot) {
  const spawnX = SPAWN_X[slot] !== undefined ? SPAWN_X[slot] : 400;
  return {
    id,
    slot,
    x: spawnX,
    y: 400,
    w: 48, h: 52,
    vx: 0, vy: 0,
    onGround: false,
    gunAngle: 0,
    hp: MAX_HP,
    alive: true,
    kills: 0,
    deaths: 0,
    shootCooldown: 0,
    recoilTimer: 0,
    keys: { left: false, right: false },
    mouseX: 480, mouseY: 320,
    shooting: false,
    respawnTimer: 0,
    invulnTimer: 1.5,  // invuln for the entire spawn countdown + 1.5s after
    spawnDelayTimer: SPAWN_DELAY,    // seconds until the player can actually play
  };
}

function respawnPlayer(p) {
  const spawnX = SPAWN_X[p.slot] !== undefined ? SPAWN_X[p.slot] : 400;
  p.x = spawnX;
  p.y = 400;
  p.vx = 0;
  p.vy = 0;
  p.hp = MAX_HP;
  p.alive = true;
  p.shootCooldown = 0;
  p.recoilTimer = 0;
  p.invulnTimer = 1.5;  // invuln for the entire spawn countdown + 1.5s after
  p.spawnDelayTimer = SPAWN_DELAY;    // 3s lock before player can move
}

function promoteFromLobby() {
  // If game has open slot and lobby has people, promote first lobby player
  // (used on disconnect to fill a free slot)
  if (lobby.length === 0) return null;
  const slot = findFreeSlot();
  if (slot === -1) return null;

  const entry = lobby.shift();
  const id = 'p' + slot;
  const player = createPlayer(id, slot);
  player._ws = entry.ws;
  players[id] = player;
  entry.ws.playerId = id;
  entry.ws.inLobby = false;
  wsToPlayer.set(entry.ws, { id, inLobby: false, lobbyIdx: 0 });

  // Update lobby indices for the rest
  for (let i = 0; i < lobby.length; i++) lobby[i].lobbyIdx = i;

  // Tell them they joined
  entry.ws.send(JSON.stringify({
    type: 'promoted',
    id,
    slot,
  }));

  broadcastLobby();

  return { entry, id, slot };
}

// Swap a dead player with the first lobby player.
// Dead player -> back of lobby (new id).
// First lobby player -> takes the dead player's slot.
function swapDeadWithLobby(playerId) {
  const p = players[playerId];
  if (!p) return null;
  if (lobby.length === 0) return null;

  const slot = p.slot;
  const deadInfo = wsToPlayer.get(p._ws);
  if (!deadInfo) return null;
  const deadWs = p._ws;

  // Remove dead player from game
  delete players[playerId];
  wsToPlayer.delete(deadWs);
  deadWs.playerId = null;

  // Pop first lobby player
  const promotedEntry = lobby.shift();
  // Create the new in-game player for the promoted lobby player
  const newPlayer = createPlayer('p' + slot, slot);
  newPlayer._ws = promotedEntry.ws;
  players['p' + slot] = newPlayer;
  wsToPlayer.set(promotedEntry.ws, { id: 'p' + slot, inLobby: false, lobbyIdx: 0 });
  promotedEntry.ws.playerId = 'p' + slot;
  promotedEntry.ws.inLobby = false;

  // Notify the promoted player — use 'init' so the client goes through the
  // same setup path as a fresh join (which is known to work correctly).
  promotedEntry.ws.send(JSON.stringify({
    type: 'init',
    id: 'p' + slot,
    slot,
    platforms,
  }));

  // Add the dead player to back of lobby with a new id
  const newDeadId = 'p' + (nextPlayerId++);
  const deadLobbyEntry = {
    ws: deadWs,
    id: newDeadId,
    lobbyIdx: lobby.length,
  };
  lobby.push(deadLobbyEntry);
  wsToPlayer.set(deadWs, { id: newDeadId, inLobby: true, lobbyIdx: lobby.length - 1 });
  deadWs.playerId = newDeadId;
  deadWs.inLobby = true;

  // Update lobby indices for remaining lobby entries
  for (let i = 0; i < lobby.length; i++) lobby[i].lobbyIdx = i;

  // Notify dead player they're in lobby
  deadWs.send(JSON.stringify({
    type: 'lobby',
    id: newDeadId,
    position: deadLobbyEntry.lobbyIdx + 1,
    inGame: getActivePlayerCount(),
    maxGame: MAX_PLAYERS,
    lobbyCount: lobby.length,
  }));

  // Broadcast updated lobby positions
  broadcastLobby();

  return { promotedId: 'p' + slot, deadId: newDeadId };
}

function broadcastLobby() {
  // Send lobby update to all clients
  for (const [ws, info] of wsToPlayer.entries()) {
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(JSON.stringify({
      type: 'lobby_update',
      inGame: getActivePlayerCount(),
      maxGame: MAX_PLAYERS,
      lobbyCount: lobby.length,
      youInLobby: info.inLobby,
      yourLobbyPos: info.inLobby ? (lobby.findIndex(e => e.ws === ws) + 1) : 0,
    }));
  }
}

// ── Connections ──
wss.on('connection', (ws) => {
  // Assign a new id
  const id = 'p' + (nextPlayerId++);
  ws.playerId = id;
  ws.inLobby = false;

  const active = getActivePlayerCount();

  if (active < MAX_PLAYERS) {
    // Join game
    const slot = findFreeSlot();
    const player = createPlayer('p' + slot, slot);
    player._ws = ws;  // track the owning websocket for lobby swap
    players['p' + slot] = player;
    ws.playerId = 'p' + slot;
    wsToPlayer.set(ws, { id: 'p' + slot, inLobby: false, lobbyIdx: 0 });

    ws.send(JSON.stringify({
      type: 'init',
      id: 'p' + slot,
      slot,
      platforms,
    }));
    console.log(`Player p${slot} connected (slot ${slot})`);
  } else {
    // Join lobby
    const entry = {
      ws,
      id,
      lobbyIdx: lobby.length,
    };
    lobby.push(entry);
    wsToPlayer.set(ws, { id, inLobby: true, lobbyIdx: lobby.length - 1 });

    ws.send(JSON.stringify({
      type: 'lobby',
      id,
      position: lobby.length,
      inGame: active,
      maxGame: MAX_PLAYERS,
      lobbyCount: lobby.length,
    }));
    console.log(`Player queued to lobby (#${lobby.length})`);
  }

  broadcastLobby();

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const info = wsToPlayer.get(ws);
      if (!info || info.inLobby) return; // Lobby players can't affect the game
      const p = players[info.id];
      if (!p) return;

      if (msg.type === 'input') {
        p.keys.left = !!msg.left;
        p.keys.right = !!msg.right;
        p.mouseX = msg.mx ?? p.mouseX;
        p.mouseY = msg.my ?? p.mouseY;
        p.shooting = !!msg.shoot;
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    const info = wsToPlayer.get(ws);
    if (!info) return;

    if (info.inLobby) {
      // Remove from lobby and update queue positions
      const idx = lobby.findIndex(e => e.ws === ws);
      if (idx !== -1) {
        lobby.splice(idx, 1);
        for (let i = idx; i < lobby.length; i++) lobby[i].lobbyIdx = i;
      }
    } else {
      // Player disconnected from game: clean removal, no lobby promotion.
      // (Lobby promotion only happens on death now.)
      const p = players[info.id];
      if (p) delete players[info.id];
    }
    wsToPlayer.delete(ws);
    broadcastLobby();
    console.log(`Player ${info.id} disconnected`);
  });
});

// ── Server game loop ──
const events = []; // per-tick events to broadcast

function tick() {
  events.length = 0;

  for (const id in players) {
    const p = players[id];

    if (!p.alive) {
      p.respawnTimer -= 1000 / TICK_RATE;
      if (p.respawnTimer <= 0) {
        // Death -> swap with first lobby player (if any).
        // Dead player goes to back of lobby, first lobby player takes their slot.
        if (lobby.length > 0) {
          events.push({ type: 'death', id, killer: null, fell: false, replaced: true });
          swapDeadWithLobby(id);
        } else {
          respawnPlayer(p);
          events.push({ type: 'respawn', id });
        }
      }
      continue;
    }

    // Gun angle
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2 - 8;
    p.gunAngle = Math.atan2(p.mouseY - cy, p.mouseX - cx);

    // Spawn delay: player is locked at spawn, can't move or shoot
    if (p.spawnDelayTimer > 0) {
      p.spawnDelayTimer = Math.max(0, p.spawnDelayTimer - (1000 / TICK_RATE) / 1000);
      // Keep them pinned at spawn during the delay
      p.vx = 0;
      p.vy = 0;
      const spawnX = SPAWN_X[p.slot] !== undefined ? SPAWN_X[p.slot] : 400;
      p.x = spawnX;
      p.y = 400;
      // When delay finishes, fire the spawned event
      if (p.spawnDelayTimer === 0) {
        events.push({ type: 'spawned', id });
      }
      continue;
    }

    // Movement
    if (p.keys.left) p.vx -= MOVE_SPEED;
    if (p.keys.right) p.vx += MOVE_SPEED;

    // Shooting
    if (p.shootCooldown > 0) p.shootCooldown--;
    if (p.recoilTimer > 0) p.recoilTimer--;
    if (p.invulnTimer > 0) p.invulnTimer = Math.max(0, p.invulnTimer - (1000 / TICK_RATE) / 1000);

    if (p.shooting && p.shootCooldown <= 0) {
      p.shootCooldown = SHOOT_COOLDOWN;
      const angle = p.gunAngle;

      p.vx += -Math.cos(angle) * RECOIL_FORCE;
      p.vy += -Math.sin(angle) * RECOIL_FORCE;
      if (p.vy < -14) p.vy = -14;
      p.onGround = false;
      p.recoilTimer = 6;

      const tipX = cx + Math.cos(angle) * 30;
      const tipY = cy + Math.sin(angle) * 30;

      const bid = nextBulletId++;
      bullets.push({
        id: bid,
        owner: id,
        x: tipX, y: tipY,
        vx: Math.cos(angle) * BULLET_SPEED,
        vy: Math.sin(angle) * BULLET_SPEED,
        life: 90,
      });

      events.push({
        type: 'shoot',
        id,
        bid,
        x: tipX, y: tipY,
        angle,
      });
    }

    // Physics
    p.vy += GRAVITY;
    if (p.vy > MAX_FALL) p.vy = MAX_FALL;
    p.vx *= FRICTION;

    p.x += p.vx;
    p.y += p.vy;

    // Platform collision
    p.onGround = false;
    for (const plat of platforms) {
      if (p.x + p.w > plat.x && p.x < plat.x + plat.w) {
        if (p.vy >= 0 && p.y + p.h > plat.y && p.y + p.h < plat.y + plat.h + p.vy + 2) {
          p.y = plat.y - p.h;
          p.vy = 0;
          p.onGround = true;
        }
      }
    }

    // Walls
    if (p.x < 0) { p.x = 0; p.vx = 0; }
    if (p.x + p.w > 960) { p.x = 960 - p.w; p.vx = 0; }
    if (p.y < 0) { p.y = 0; p.vy = 0; }
    if (p.y > 740) {
      // Fell off — die
      p.hp = 0;
      p.alive = false;
      p.respawnTimer = RESPAWN_TIME;
      p.deaths++;
      events.push({ type: 'death', id, killer: null, fell: true });
    }
  }

  // Bullets
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    b.vy += 0.08;
    b.life--;

    let remove = false;

    if (b.life <= 0 || b.x < -20 || b.x > 980 || b.y > 700) {
      remove = true;
    }

    // Hit platforms
    if (!remove) {
      for (const plat of platforms) {
        if (b.x > plat.x && b.x < plat.x + plat.w && b.y > plat.y && b.y < plat.y + plat.h) {
          remove = true;
          events.push({ type: 'impact', x: b.x, y: b.y, hit: 'wall' });
          break;
        }
      }
    }

    // Hit other players
    if (!remove) {
      for (const id in players) {
        if (id === b.owner) continue;
        const p = players[id];
        if (!p.alive) continue;
        if (p.invulnTimer > 0) continue;  // immune to damage while invuln
        if (b.x > p.x && b.x < p.x + p.w && b.y > p.y && b.y < p.y + p.h) {
          remove = true;
          p.hp -= BULLET_DAMAGE;
          p.invulnTimer = 0.3;  // 0.3s of hit invincibility
          events.push({ type: 'hit', target: id, x: b.x, y: b.y, hp: p.hp });

          if (p.hp <= 0) {
            p.hp = 0;
            p.alive = false;
            p.respawnTimer = RESPAWN_TIME;
            p.deaths++;
            const killer = players[b.owner];
            if (killer) killer.kills++;
            events.push({ type: 'death', id, killer: b.owner, fell: false });
          }
          break;
        }
      }
    }

    if (remove) bullets.splice(i, 1);
  }

  // Handle players whose respawnTimer just hit 0 (in this tick) — actually we did it above
  // Now check for death-triggered lobby promotion (when player.hp hit 0 this tick)
  // The above "death" event was emitted, but we need to also check if any player JUST died
  // Actually, players don't respawn from hp=0 — they go to "dying" state and on next respawnTimer expiry
  // we check lobby. So lobby promotion happens after the respawn timer.

  // Broadcast state
  const state = {
    type: 'state',
    players: {},
    bullets: bullets.map(b => ({ id: b.id, x: b.x, y: b.y })),
    events,
  };

  for (const id in players) {
    const p = players[id];
    state.players[id] = {
      x: p.x, y: p.y,
      vx: p.vx, vy: p.vy,
      gunAngle: p.gunAngle,
      hp: p.hp,
      alive: p.alive,
      kills: p.kills,
      deaths: p.deaths,
      onGround: p.onGround,
      recoilTimer: p.recoilTimer,
      invulnTimer: p.invulnTimer,
      spawnDelayTimer: p.spawnDelayTimer,
      slot: p.slot,
    };
  }

  const msg = JSON.stringify(state);
  wss.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  });
}

setInterval(tick, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🦆 Duck Fight server running! (max ${MAX_PLAYERS} players, unlimited lobby)`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://<your-ip>:${PORT}\n`);
});
