import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

/** ===== RULES ===== */
const BRIDGE_LEN = 8;
const STAIRS_SLOTS = 10;
const PAWNS_TOTAL = 7;
const INSTANT_WIN_STAIRS = 3;

// ✅ 버전 확인용(적용 확인 끝나면 지워도 됨)
console.log("SERVER VERSION: 2026-02-21-FINAL");

function rollDie() {
  const faces = [1, 2, 3, 4, "X", "X"];
  return faces[Math.floor(Math.random() * faces.length)];
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeInitialPlayer({ id, name, color }) {
  return { id, name, color, reserve: PAWNS_TOTAL, onBridge: null, eliminated: 0 };
}

function ensurePawnOnBridge(p) {
  if (p.onBridge !== null) return false;
  if (p.reserve > 0) {
    p.reserve -= 1;
    p.onBridge = 0;
    return true;
  }
  return false;
}

// ✅ “움직일 말 있음” 정의
function hasMovablePawn(p) {
  return p.reserve > 0 || p.onBridge !== null;
}

function dropBridgePawn(p) {
  if (p.onBridge === null) return false;
  p.onBridge = null;
  p.eliminated += 1;
  ensurePawnOnBridge(p);
  return true;
}

/** stairsOrder index+1 = score (1..10) */
function stairsScore(stairsOrder, playerId) {
  let sum = 0;
  for (let i = 0; i < stairsOrder.length; i++) {
    if (stairsOrder[i] === playerId) sum += (i + 1);
  }
  return sum;
}

function stairsCount(stairsOrder, playerId) {
  let c = 0;
  for (const x of stairsOrder) if (x === playerId) c++;
  return c;
}

function addToStairs(game, playerId) {
  if (game.stairsOrder.length >= STAIRS_SLOTS) return false;
  game.stairsOrder.push(playerId);
  return true;
}

// ✅ lowest score (1-point side) remove + shift
function removeOneLowestStairsAndShift(game, victimPlayerId) {
  const idx = game.stairsOrder.findIndex((x) => x === victimPlayerId);
  if (idx === -1) return false;
  game.stairsOrder.splice(idx, 1);
  return true;
}

function moveForward(game, player, steps) {
  if (player.onBridge === null) {
    const ok = ensurePawnOnBridge(player);
    if (!ok) return { moved: false, toStairs: false };
  }

  const newPos = player.onBridge + steps;
  if (newPos >= BRIDGE_LEN) {
    player.onBridge = null;
    const ok = addToStairs(game, player.id);
    ensurePawnOnBridge(player);
    return { moved: true, toStairs: ok };
  } else {
    player.onBridge = newPos;
    return { moved: true, toStairs: false };
  }
}

function endGameByScore(room, reason) {
  let best = null;
  for (const p of room.game.players) {
    const score = stairsScore(room.game.stairsOrder, p.id);
    if (!best || score > best.score) best = { id: p.id, score };
  }
  room.game.winnerId = best?.id ?? null;
  room.game.winnerReason = `${reason} | 점수승 (${best?.score ?? 0}점)`;
  room.game.phase = "END";
}

function checkEndConditions(room) {
  const g = room.game;

  // 1) instant win by stairs count
  for (const p of g.players) {
    if (stairsCount(g.stairsOrder, p.id) >= INSTANT_WIN_STAIRS) {
      g.winnerId = p.id;
      g.winnerReason = "계단 3개 즉시승";
      g.phase = "END";
      return true;
    }
  }

  // 2) stairs full -> score end
  if (g.stairsOrder.length >= STAIRS_SLOTS) {
    endGameByScore(room, "계단 10칸 종료");
    return true;
  }

  // 3) nobody has movable pawn -> score end
  const anyMovable = g.players.some((p) => hasMovablePawn(p));
  if (!anyMovable) {
    endGameByScore(room, "움직일 말 없음 종료");
    return true;
  }

  return false;
}

function nextSeatFixed(room, seat) {
  // ✅ fixed order round-robin
  return (seat + 1) % room.game.players.length;
}

/**
 * ✅ 선택(믿음/의심) 가능 조건
 * - (움직일 말 있음) OR (움직일 말 없음 AND 계단 말 있음)
 * - 턴 플레이어는 선택 불가
 */
function canDecide(game, seat) {
  if (seat === game.turnSeat) return false;
  const p = game.players[seat];
  if (hasMovablePawn(p)) return true;
  return stairsCount(game.stairsOrder, p.id) > 0;
}

function computeEligibleSeats(game) {
  const eligible = [];
  for (let s = 0; s < game.players.length; s++) {
    if (canDecide(game, s)) eligible.push(s);
  }
  return eligible;
}

/** ===== ROOMS ===== */
const rooms = new Map();

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function publicState(room) {
  const players = room.players.map((p, idx) => ({
    socketId: p.socketId,
    name: p.name,
    color: p.color,
    seat: idx,
  }));

  let game = null;
  if (room.game) {
    const g = room.game;
    game = {
      started: true,
      phase: g.phase,
      turnSeat: g.turnSeat,
      declared: g.declared ?? null,
      lastAction: g.lastAction ?? null,
      winnerId: g.winnerId ?? null,
      winnerReason: g.winnerReason ?? null,

      bridgeLen: BRIDGE_LEN,
      stairsSlots: STAIRS_SLOTS,
      pawnsTotal: PAWNS_TOTAL,
      instantWinStairs: INSTANT_WIN_STAIRS,

      stairsOrder: g.stairsOrder,
      challengers: g.challengers ?? [],
      eligibleSeats: g.eligibleSeats ?? [],
      decisionsCount: g.decisions ? Object.keys(g.decisions).length : 0,

      players: g.players.map((pp) => ({
        id: pp.id,
        name: pp.name,
        color: pp.color,
        reserve: pp.reserve,
        onBridge: pp.onBridge,
        eliminated: pp.eliminated,
        stairsCount: stairsCount(g.stairsOrder, pp.id),
        score: stairsScore(g.stairsOrder, pp.id),
        movable: hasMovablePawn(pp),
      })),
    };
  }

  return { code: room.code, hostId: room.hostId, started: room.started, players, game };
}

function broadcast(room) {
  io.to(room.code).emit("room:update", publicState(room));
}

function startGame(room) {
  // start order random once
  shuffleInPlace(room.players);

  const gamePlayers = room.players.map((p) =>
    makeInitialPlayer({ id: p.socketId, name: p.name, color: p.color })
  );
  gamePlayers.forEach(ensurePawnOnBridge);

  room.started = true;
  room.game = {
    players: gamePlayers,
    turnSeat: 0,
    phase: "ROLL",
    currentRoll: null,
    declared: null,
    challengers: [],
    decisions: null,
    eligibleSeats: null,
    stairsOrder: [],
    winnerId: null,
    winnerReason: null,
    lastAction: "게임 시작(랜덤 턴)",
  };
}

function isCurrentTurn(room, socketId) {
  const seat = room.players.findIndex((p) => p.socketId === socketId);
  return seat === room.game.turnSeat;
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name }) => {
    let code = makeRoomCode();
    while (rooms.has(code)) code = makeRoomCode();

    const room = { code, hostId: socket.id, started: false, players: [], game: null };
    rooms.set(code, room);

    socket.join(code);
    room.players.push({ socketId: socket.id, name: (name || "Player").slice(0, 12), color: null });

    const colors = ["#ff5a5f", "#4dabf7", "#69db7c", "#ffd43b"];
    room.players.forEach((p, i) => (p.color = colors[i]));

    broadcast(room);
  });

  socket.on("room:join", ({ code, name }) => {
    code = (code || "").toUpperCase();
    const room = rooms.get(code);
    if (!room) return socket.emit("error:msg", "존재하지 않는 방 코드야.");
    if (room.started) return socket.emit("error:msg", "이미 시작된 방이야.");
    if (room.players.length >= 4) return socket.emit("error:msg", "방이 가득 찼어(최대 4명).");

    socket.join(code);
    room.players.push({ socketId: socket.id, name: (name || "Player").slice(0, 12), color: null });

    const colors = ["#ff5a5f", "#4dabf7", "#69db7c", "#ffd43b"];
    room.players.forEach((p, i) => (p.color = colors[i]));

    broadcast(room);
  });

  socket.on("game:start", ({ code }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.players.length < 2) return socket.emit("error:msg", "최소 2명이 필요해.");
    startGame(room);
    broadcast(room);
  });

  socket.on("game:roll", ({ code }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room?.game) return;
    if (room.game.phase !== "ROLL") return;
    if (!isCurrentTurn(room, socket.id)) return;

    const actor = room.game.players[room.game.turnSeat];

    // fixed order: no movable -> pass
    if (!hasMovablePawn(actor)) {
      room.game.lastAction = "움직일 말 없음 → 리타이어(턴 패스)";
      room.game.turnSeat = nextSeatFixed(room, room.game.turnSeat);
      checkEndConditions(room);
      broadcast(room);
      return;
    }

    ensurePawnOnBridge(actor);

    const roll = rollDie();
    room.game.currentRoll = roll;
    room.game.declared = null;
    room.game.challengers = [];
    room.game.decisions = null;
    room.game.eligibleSeats = null;

    room.game.phase = "DECLARE";
    room.game.lastAction = "주사위 굴림(비공개)";
    socket.emit("game:privateRoll", { roll });

    broadcast(room);
  });

  socket.on("game:declare", ({ code, value }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room?.game) return;
    if (room.game.phase !== "DECLARE") return;
    if (!isCurrentTurn(room, socket.id)) return;

    const declared = Number(value);
    if (![1, 2, 3, 4].includes(declared)) return;

    room.game.declared = declared;
    room.game.phase = "CHALLENGE";
    room.game.lastAction = `선언: ${declared}`;

    room.game.decisions = {};
    room.game.challengers = [];

    const eligible = computeEligibleSeats(room.game);
    room.game.eligibleSeats = eligible;

    // if nobody can decide -> auto move
    if (eligible.length === 0) {
      const actor = room.game.players[room.game.turnSeat];
      room.game.lastAction = `선언: ${declared} | 선택자 0명 → 자동 전진`;
      moveForward(room.game, actor, declared);

      room.game.currentRoll = null;
      room.game.declared = null;
      room.game.decisions = null;
      room.game.challengers = [];
      room.game.eligibleSeats = null;

      if (!checkEndConditions(room)) {
        room.game.turnSeat = nextSeatFixed(room, room.game.turnSeat);
        room.game.phase = "ROLL";
      }
      broadcast(room);
      return;
    }

    broadcast(room);
  });

  socket.on("game:challengeDecision", ({ code, decision }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room?.game) return;
    if (room.game.phase !== "CHALLENGE") return;

    const seat = room.players.findIndex((p) => p.socketId === socket.id);
    if (seat === -1) return;

    const eligibleSeats = room.game.eligibleSeats || [];
    if (!eligibleSeats.includes(seat)) return;

    room.game.decisions ??= {};
    if (room.game.decisions[seat]) return;

    const d = String(decision);
    if (d !== "challenge" && d !== "believe") return;

    room.game.decisions[seat] = d;
    if (d === "challenge") room.game.challengers.push(seat);

    const needed = eligibleSeats.length;
    const decided = Object.keys(room.game.decisions).length;

    room.game.lastAction = `결정 진행: ${decided}/${needed}`;
    if (decided < needed) {
      broadcast(room);
      return;
    }

    // ✅ FIX: all-believe => always move actor (even X)
    const challengersSeats = room.game.challengers.slice();
    if (challengersSeats.length === 0) {
      const actor = room.game.players[room.game.turnSeat];
      const declared = room.game.declared;

      room.game.lastAction = `전원 믿음 → ${declared}칸 전진`;
      moveForward(room.game, actor, declared);

      room.game.currentRoll = null;
      room.game.declared = null;
      room.game.decisions = null;
      room.game.eligibleSeats = null;
      room.game.challengers = [];

      if (!checkEndConditions(room)) {
        room.game.turnSeat = nextSeatFixed(room, room.game.turnSeat);
        room.game.phase = "ROLL";
      }

      broadcast(room);
      return;
    }

    // reveal/resolve
    room.game.phase = "RESOLVE";

    const actor = room.game.players[room.game.turnSeat];
    const roll = room.game.currentRoll;
    const declared = room.game.declared;

    const truthful = roll !== "X" && roll === declared;
    room.game.lastAction = `공개=${roll} | ${truthful ? "정직" : "거짓/X"} | 의심자 ${challengersSeats.length}명`;

    if (truthful) {
      for (const s of challengersSeats) {
        const ch = room.game.players[s];
        const fell = dropBridgePawn(ch);
        if (!fell) removeOneLowestStairsAndShift(room.game, ch.id);
      }
      moveForward(room.game, actor, declared);
    } else {
      ensurePawnOnBridge(actor);
      dropBridgePawn(actor);

      for (const s of challengersSeats) {
        const ch = room.game.players[s];
        moveForward(room.game, ch, declared);
      }
    }

    room.game.currentRoll = null;
    room.game.declared = null;
    room.game.decisions = null;
    room.game.eligibleSeats = null;
    room.game.challengers = [];

    if (!checkEndConditions(room)) {
      room.game.turnSeat = nextSeatFixed(room, room.game.turnSeat);
      room.game.phase = "ROLL";
    }

    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("running on", PORT));