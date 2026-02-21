import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const BRIDGE_LEN = 8;
const STAIRS_SLOTS = 10;
const PAWNS_TOTAL = 7;
const INSTANT_WIN_STAIRS = 3;

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

function hasMovablePawn(p) {
  // ✅ “남은 말(움직일 말)” 정의: reserve 또는 다리 위 말
  return p.reserve > 0 || p.onBridge !== null;
}

function dropBridgePawn(p) {
  if (p.onBridge === null) return false;
  p.onBridge = null;
  p.eliminated += 1;
  ensurePawnOnBridge(p);
  return true;
}

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

// 가장 낮은 점수(=1점 쪽) 말 1개 버림 + 자동 압축
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

  for (const p of g.players) {
    if (stairsCount(g.stairsOrder, p.id) >= INSTANT_WIN_STAIRS) {
      g.winnerId = p.id;
      g.winnerReason = "계단 3개 즉시승";
      g.phase = "END";
      return true;
    }
  }

  if (g.stairsOrder.length >= STAIRS_SLOTS) {
    endGameByScore(room, "계단 10칸 종료");
    return true;
  }

  // ✅ “움직일 말이 아무에게도 없으면” 종료(계단이 다 안 차도)
  const anyMovable = g.players.some((p) => hasMovablePawn(p));
  if (!anyMovable) {
    endGameByScore(room, "움직일 말 없음 종료");
    return true;
  }

  return false;
}

function nextSeatFixed(room, seat) {
  return (seat + 1) % room.game.players.length;
}

// ✅ 너가 말한 의심/믿음 가능 조건(핵심):
// - 남은 말 있으면 가능
// - 남은 말 없으면 계단 말 있을 때만 가능
function canDecideChallenge(game, seat) {
  if (seat === game.turnSeat) return false;
  const p = game.players[seat];
  const movable = hasMovablePawn(p);
  if (movable) return true;
  // 남은 말 없음 => 계단 말 있어야 가능
  return stairsCount(game.stairsOrder, p.id) > 0;
}

function computeEligibleSeats(game) {
  const eligible = [];
  for (let s = 0; s < game.players.length; s++) {
    if (canDecideChallenge(game, s)) eligible.push(s);
  }
  return eligible;
}

/** ===== rooms ===== */
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
    const eligibleSeats = (g.phase === "CHALLENGE") ? (g.eligibleSeats ?? []) : [];

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
      eligibleSeats,
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
    room.game.lastAction = `선언: ${declared} | 의심/믿음 가능 조건 적용`;

    room.game.decisions = {};
    room.game.challengers = [];

    // ✅ 핵심: 남은 말 있는 사람은 선택 가능, 남은 말 없으면 계단 말 있어야 가능
    const eligible = computeEligibleSeats(room.game);
    room.game.eligibleSeats = eligible;

    // eligible이 0이면 “아무도 선택할 사람 없음” => 자동 믿음 처리(선언만큼 전진)
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

    // 턴 플레이어는 선택 불가
    if (seat === room.game.turnSeat) return;

    // ✅ eligibleSeats에 포함된 사람만 선택 가능
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

    // ===== 공개/판정 =====
    room.game.phase = "RESOLVE";

    const actor = room.game.players[room.game.turnSeat];
    const roll = room.game.currentRoll;
    const declared = room.game.declared;

    const truthful = roll !== "X" && roll === declared;
    const challengers = room.game.challengers.slice();

    room.game.lastAction = `공개=${roll} | ${truthful ? "정직" : "거짓/X"} | 의심자 ${challengers.length}명`;

    if (truthful) {
      // 정직: 의심자 패널티 + 정직자도 전진
      for (const s of challengers) {
        const ch = room.game.players[s];

        const fell = dropBridgePawn(ch);
        if (!fell) {
          // 다리 말 없으면 계단 말 버림(1점 쪽)
          removeOneLowestStairsAndShift(room.game, ch.id);
        }
      }
      moveForward(room.game, actor, declared);
    } else {
      // 거짓/X: 말한 사람 낙하 + 의심자 전진
      dropBridgePawn(actor);
      for (const s of challengers) {
        const ch = room.game.players[s];
        moveForward(room.game, ch, declared);
      }
    }

    room.game.currentRoll = null;
    room.game.declared = null;
    room.game.decisions = null;
    room.game.eligibleSeats = null;

    if (!checkEndConditions(room)) {
      room.game.turnSeat = nextSeatFixed(room, room.game.turnSeat);
      room.game.phase = "ROLL";
      room.game.challengers = [];
    }

    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("running on", PORT));