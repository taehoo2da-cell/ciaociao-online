import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

/** ===== 룰 설정 ===== */
const BRIDGE_LEN = 8;      // 다리 칸 수
const WIN_CROSSED = 3;     // 3개 골인하면 즉시 승리
const PAWNS_TOTAL = 7;     // 말 총 개수

function rollDie() {
  // 1,2,3,4,X,X  (X 2면)
  const faces = [1, 2, 3, 4, "X", "X"];
  return faces[Math.floor(Math.random() * faces.length)];
}

function makeInitialPlayer({ id, name, color }) {
  return {
    id,
    name,
    color,
    reserve: PAWNS_TOTAL, // 아직 다리에 올리지 않은 말
    onBridge: null,       // 다리 위 현재 말 위치(0~BRIDGE_LEN-1)
    podium: [],           // 골인한 말들의 순서 step 기록
    eliminated: 0         // 낙하로 제거된 말 수
  };
}

function ensurePawnOnBridge(p) {
  if (p.onBridge !== null) return;
  if (p.reserve > 0) {
    p.reserve -= 1;
    p.onBridge = 0;
  }
}

function pushOffBridge(p) {
  if (p.onBridge === null) return;
  p.onBridge = null;
  p.eliminated += 1;
  ensurePawnOnBridge(p);
}

function movePawnForward(p, steps, podiumState) {
  if (p.onBridge === null) return;
  const newPos = p.onBridge + steps;
  if (newPos >= BRIDGE_LEN) {
    const step = podiumState.nextStep++;
    p.podium.push(step);
    p.onBridge = null;
    ensurePawnOnBridge(p);
  } else {
    p.onBridge = newPos;
  }
}

function hasWin(p) {
  return p.podium.length >= WIN_CROSSED;
}

function computeScore(p) {
  return p.podium.reduce((a, b) => a + b, 0);
}

function isStalemate(game) {
  const totalPodium = game.players.reduce((s, p) => s + p.podium.length, 0);
  const anyOnBridge = game.players.some((p) => p.onBridge !== null);
  const anyReserve = game.players.some((p) => p.reserve > 0);
  const noWinner = !game.winnerId;
  return noWinner && totalPodium <= 2 && !anyOnBridge && !anyReserve;
}

/** ===== 방/게임 상태 ===== */
const rooms = new Map();

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function nextSeat(room, seat) {
  return (seat + 1) % room.game.players.length;
}

function isCurrentTurn(room, socketId) {
  const seat = room.players.findIndex(p => p.socketId === socketId);
  return seat === room.game.turnSeat;
}

function broadcast(room) {
  io.to(room.code).emit("room:update", publicState(room));
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
    game = {
      started: true,
      phase: room.game.phase, // ROLL/DECLARE/CHALLENGE/END
      turnSeat: room.game.turnSeat,
      declared: room.game.declared ?? null,
      pendingChallengeSeat: room.game.pendingChallengeSeat ?? null,
      lastAction: room.game.lastAction ?? null,
      winnerId: room.game.winnerId ?? null,
      winnerReason: room.game.winnerReason ?? null,
      players: room.game.players.map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        reserve: p.reserve,
        onBridge: p.onBridge,
        podium: p.podium,
        eliminated: p.eliminated,
      })),
      bridgeLen: BRIDGE_LEN,
      winCrossed: WIN_CROSSED,
      pawnsTotal: PAWNS_TOTAL,
    };
  }

  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    players,
    game,
  };
}

function startGame(room) {
  const gamePlayers = room.players.map(p =>
    makeInitialPlayer({ id: p.socketId, name: p.name, color: p.color })
  );
  gamePlayers.forEach(ensurePawnOnBridge);

  room.started = true;
  room.game = {
    players: gamePlayers,
    podium: { nextStep: 1 },
    turnSeat: 0,
    phase: "ROLL",
    currentRoll: null, // 비공개
    declared: null,    // 공개
    challengersOrder: null,
    pendingChallengeSeat: null,
    winnerId: null,
    winnerReason: null,
    lastAction: "게임 시작",
  };
}

function endWithWinner(room, playerId, reason) {
  room.game.winnerId = playerId;
  room.game.winnerReason = reason;
  room.game.phase = "END";
}

function maybeEndStalemate(room) {
  if (!room.game || room.game.winnerId) return;
  if (isStalemate(room.game)) {
    let best = null;
    for (const p of room.game.players) {
      const score = computeScore(p);
      if (!best || score > best.score) best = { id: p.id, score, name: p.name };
    }
    endWithWinner(room, best.id, `스테일메이트 점수승 (${best.score}점)`);
  }
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

  socket.on("room:leave", () => {
    for (const room of rooms.values()) {
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        socket.leave(room.code);
        if (room.players.length === 0) rooms.delete(room.code);
        else {
          if (room.hostId === socket.id) room.hostId = room.players[0].socketId;
          broadcast(room);
        }
        break;
      }
    }
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

    const roll = rollDie();
    room.game.currentRoll = roll;
    room.game.declared = null;

    room.game.phase = "DECLARE";
    room.game.lastAction = "주사위 굴림(비공개)";

    // 🔍 X가 진짜 나오는지 서버에서 확인용 로그
    console.log(`[${room.code}] roll =`, roll);

    // ✅ 굴린 사람에게만 결과 제공
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

    // 시계방향 의심 순서
    const order = [];
    let s = nextSeat(room, room.game.turnSeat);
    while (s !== room.game.turnSeat) {
      order.push(s);
      s = nextSeat(room, s);
    }
    room.game.challengersOrder = order;
    room.game.pendingChallengeSeat = order.length ? order[0] : null;

    broadcast(room);
  });

  socket.on("game:challengeDecision", ({ code, decision }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room?.game) return;
    if (room.game.phase !== "CHALLENGE") return;

    const seat = room.players.findIndex(p => p.socketId === socket.id);
    if (seat !== room.game.pendingChallengeSeat) return;

    const d = String(decision);

    if (d === "challenge") {
      const actorSeat = room.game.turnSeat;
      const actor = room.game.players[actorSeat];
      const challenger = room.game.players[seat];

      const roll = room.game.currentRoll;
      const declared = room.game.declared;

      const truthful = roll !== "X" && roll === declared;
      room.game.lastAction = `${room.players[seat].name} 의심! | 공개=${roll}`;

      if (truthful) {
        pushOffBridge(challenger);
        room.game.lastAction += " (진실) → 의심자 낙하";
      } else {
        pushOffBridge(actor);
        movePawnForward(challenger, declared, room.game.podium);
        room.game.lastAction += " (거짓) → 블러퍼 낙하, 의심자 전진";
      }

      if (hasWin(actor)) return endWithWinner(room, actor.id, "3개 골인"), broadcast(room);
      if (hasWin(challenger)) return endWithWinner(room, challenger.id, "3개 골인"), broadcast(room);

      // 다음 턴
      room.game.turnSeat = nextSeat(room, room.game.turnSeat);
      room.game.phase = "ROLL";
      room.game.currentRoll = null;
      room.game.declared = null;
      room.game.challengersOrder = null;
      room.game.pendingChallengeSeat = null;

      maybeEndStalemate(room);
      return broadcast(room);
    }

    if (d === "believe") {
      const order = room.game.challengersOrder || [];
      const idx = order.indexOf(seat);
      const next = idx === -1 ? null : (order[idx + 1] ?? null);

      room.game.pendingChallengeSeat = next;
      room.game.lastAction = `${room.players[seat].name}: 믿음`;

      if (next === null) {
        // 아무도 의심 안 함 → 선언값만큼 현재 플레이어 전진
        const actor = room.game.players[room.game.turnSeat];
        movePawnForward(actor, room.game.declared, room.game.podium);

        if (hasWin(actor)) return endWithWinner(room, actor.id, "3개 골인"), broadcast(room);

        room.game.turnSeat = nextSeat(room, room.game.turnSeat);
        room.game.phase = "ROLL";
        room.game.currentRoll = null;
        room.game.declared = null;
        room.game.challengersOrder = null;
        room.game.pendingChallengeSeat = null;

        maybeEndStalemate(room);
      }

      return broadcast(room);
    }
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const idx = room.players.findIndex(p => p.socketId === socket.id);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        socket.leave(room.code);

        if (room.players.length === 0) rooms.delete(room.code);
        else {
          if (room.hostId === socket.id) room.hostId = room.players[0].socketId;

          if (room.game && room.players.length < 2 && !room.game.winnerId) {
            endWithWinner(room, room.players[0].socketId, "상대 이탈");
          }
          broadcast(room);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("running on", PORT));