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

const players = {};
const bullets = [];
let nextBulletId = 0;

function createPlayer(id, slot) {
  return {
    id,
    slot,                        // 0 = blue, 1 = red
    x: slot === 0 ? 200 : 700,
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
  };
}

function respawnPlayer(p) {
  p.x = p.slot === 0 ? 200 : 700;
  p.y = 400;
  p.vx = 0;
  p.vy = 0;
  p.hp = MAX_HP;
  p.alive = true;
  p.shootCooldown = 0;
  p.recoilTimer = 0;
}

// ── Connections ──
let slotCounter = 0;

wss.on('connection', (ws) => {
  if (Object.keys(players).length >= 2) {
    ws.send(JSON.stringify({ type: 'full' }));
    ws.close();
    return;
  }

  const slot = slotCounter % 2;
  slotCounter++;
  const id = 'p' + slot;

  // If slot taken, give other slot
  const actualSlot = players[`p0`] ? 1 : (players[`p1`] ? 0 : slot);
  const actualId = 'p' + actualSlot;

  const player = createPlayer(actualId, actualSlot);
  players[actualId] = player;
  ws.playerId = actualId;

  ws.send(JSON.stringify({
    type: 'init',
    id: actualId,
    slot: actualSlot,
    platforms,
  }));

  console.log(`Player ${actualId} connected (${actualSlot === 0 ? 'BLUE' : 'RED'})`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const p = players[ws.playerId];
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
    console.log(`Player ${ws.playerId} disconnected`);
    delete players[ws.playerId];
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
        respawnPlayer(p);
        events.push({ type: 'respawn', id });
      }
      continue;
    }

    // Gun angle
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2 - 8;
    p.gunAngle = Math.atan2(p.mouseY - cy, p.mouseX - cx);

    // Movement
    if (p.keys.left) p.vx -= MOVE_SPEED;
    if (p.keys.right) p.vx += MOVE_SPEED;

    // Shooting
    if (p.shootCooldown > 0) p.shootCooldown--;
    if (p.recoilTimer > 0) p.recoilTimer--;

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
        if (b.x > p.x && b.x < p.x + p.w && b.y > p.y && b.y < p.y + p.h) {
          remove = true;
          p.hp -= BULLET_DAMAGE;
          events.push({ type: 'hit', target: id, x: b.x, y: b.y, hp: p.hp });

          if (p.hp <= 0) {
            p.hp = 0;
            p.alive = false;
            p.respawnTimer = RESPAWN_TIME;
            p.deaths++;
            const killer = players[b.owner];
            if (killer) killer.kills++;
            events.push({ type: 'death', id, killer: b.owner });
          }
          break;
        }
      }
    }

    if (remove) bullets.splice(i, 1);
  }

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
  console.log(`\n🦆 Duck Fight server running!`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://<your-ip>:${PORT}`);
  console.log(`\n   Open in 2 browser tabs/windows to play!\n`);
});
