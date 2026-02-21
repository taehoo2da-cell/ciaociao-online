const socket = io();
const $ = (id) => document.getElementById(id);

const nameEl = $("name");
const codeEl = $("code");
const btnCreate = $("btnCreate");
const btnJoin = $("btnJoin");
const btnLeave = $("btnLeave");
const roomCard = $("roomCard");
const roomCode = $("roomCode");
const btnStart = $("btnStart");

const playersEl = $("players");
const gameArea = $("gameArea");
const statusEl = $("status");
const substatusEl = $("substatus");

const btnRoll = $("btnRoll");
const declareEl = $("declare");
const btnDeclare = $("btnDeclare");

const btnBelieve = $("btnBelieve");
const btnChallenge = $("btnChallenge");

const bridgeEl = $("bridge");

const statsCard = $("statsCard");
const statsEl = $("stats");

const modal = $("modal");
const rollValue = $("rollValue");
const closeModal = $("closeModal");

let state = null;
let myId = null;

function isHost() {
  return state && state.hostId === myId;
}

function mySeat() {
  if (!state) return -1;
  return state.players.findIndex(p => p.socketId === myId);
}

function phase() {
  return state?.game?.phase ?? "LOBBY";
}

function currentTurnSeat() {
  return state?.game?.turnSeat ?? -1;
}

function pendingSeat() {
  return state?.game?.pendingChallengeSeat ?? null;
}

function renderPlayers() {
  playersEl.innerHTML = "";
  state.players.forEach((p) => {
    const d = document.createElement("div");
    d.className = "pill";
    d.style.borderColor = p.color;
    d.style.color = p.color;

    const turnMark = (p.seat === currentTurnSeat()) ? " (턴)" : "";
    const hostMark = (p.socketId === state.hostId) ? " ⭐" : "";
    d.textContent = `${p.name}${turnMark}${hostMark}`;
    playersEl.appendChild(d);
  });
}

function renderBridge() {
  bridgeEl.innerHTML = "";
  const g = state.game;
  const len = g.bridgeLen;

  for (let i = 0; i < len; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.textContent = String(i);

    const token = document.createElement("div");
    token.className = "token";

    g.players.forEach((p) => {
      if (p.onBridge === i) {
        const dot = document.createElement("div");
        dot.className = "dot";
        dot.style.background = p.color;
        token.appendChild(dot);
      }
    });

    cell.appendChild(token);
    bridgeEl.appendChild(cell);
  }
}

function renderStatus() {
  if (!state?.game) return;

  const g = state.game;
  const turnP = state.players[g.turnSeat];

  const labels = {
    ROLL: "주사위를 굴릴 차례",
    DECLARE: "1~4 선언",
    CHALLENGE: "의심 단계(시계방향)",
    END: "게임 종료"
  };

  statusEl.textContent = `${turnP?.name ?? "-"} — ${labels[g.phase] ?? g.phase}`;

  const declared = g.declared ? `선언=${g.declared}` : "";
  const pending = (g.pendingChallengeSeat !== null && g.phase === "CHALLENGE")
    ? `다음 선택: ${state.players[g.pendingChallengeSeat]?.name}`
    : "";
  const winner = g.winnerId
    ? `승자: ${state.players.find(x=>x.socketId===g.winnerId)?.name ?? "?"} (${g.winnerReason})`
    : "";

  substatusEl.textContent = [declared, pending, winner, g.lastAction].filter(Boolean).join(" | ");
}

function renderStats() {
  if (!state?.game) {
    statsCard.style.display = "none";
    return;
  }
  statsCard.style.display = "block";

  const g = state.game;
  const WIN = g.winCrossed;
  const TOTAL = g.pawnsTotal;

  statsEl.innerHTML = "";
  g.players.forEach((p) => {
    const crossed = p.podium.length;
    const onBridge = (p.onBridge !== null) ? 1 : 0;
    const fallen = p.eliminated;
    const remaining = TOTAL - crossed - fallen; // 남은 말(다리 위 포함)
    const pos = (p.onBridge === null) ? "-" : String(p.onBridge);
    const progress = Math.min(100, Math.round((crossed / WIN) * 100));
    const podiumText = crossed ? p.podium.join(", ") : "-";

    const div = document.createElement("div");
    div.className = "playerStat";
    div.innerHTML = `
      <div class="top">
        <div class="name" style="color:${p.color}">${p.name}${p.id === myId ? " (나)" : ""}</div>
        <div class="small">다리:${pos} | 다리위:${onBridge}</div>
      </div>
      <div class="small" style="margin-top:6px">
        남은 말: <b>${remaining}</b> / ${TOTAL} |
        낙하: <b>${fallen}</b> |
        골인: <b>${crossed}/${WIN}</b>
      </div>
      <div class="small" style="margin-top:6px">
        포디움: <b>${podiumText}</b>
      </div>
      <div class="bar"><div style="width:${progress}%"></div></div>
    `;
    statsEl.appendChild(div);
  });
}

function setControls() {
  const inRoom = !!state;
  btnLeave.disabled = !inRoom;

  // 호스트 + 시작 전 + 2명 이상
  btnStart.disabled = !(inRoom && isHost() && !state.started && state.players.length >= 2);

  if (!state?.game) {
    btnRoll.disabled = true;
    btnDeclare.disabled = true;
    btnBelieve.disabled = true;
    btnChallenge.disabled = true;
    declareEl.disabled = true;
    return;
  }

  const g = state.game;
  const seat = mySeat();
  const isMyTurn = seat === g.turnSeat;

  btnRoll.disabled = !(g.phase === "ROLL" && isMyTurn);
  btnDeclare.disabled = !(g.phase === "DECLARE" && isMyTurn);
  declareEl.disabled = !(g.phase === "DECLARE" && isMyTurn);

  const isMyDecision = (g.phase === "CHALLENGE" && pendingSeat() === seat);
  btnBelieve.disabled = !isMyDecision;
  btnChallenge.disabled = !isMyDecision;
}

function renderAll() {
  roomCard.style.display = state ? "block" : "none";
  gameArea.style.display = state?.game ? "block" : "none";
  if (!state) return;

  roomCode.textContent = state.code;
  renderPlayers();

  if (state.game) {
    renderStatus();
    renderBridge();
    renderStats();
  } else {
    statsCard.style.display = "none";
  }

  setControls();
}

/** ===== UI 이벤트 ===== */
btnCreate.addEventListener("click", () => {
  socket.emit("room:create", { name: nameEl.value || "Player" });
});

btnJoin.addEventListener("click", () => {
  socket.emit("room:join", { code: codeEl.value, name: nameEl.value || "Player" });
});

btnLeave.addEventListener("click", () => {
  socket.emit("room:leave");
  state = null;
  renderAll();
});

btnStart.addEventListener("click", () => {
  socket.emit("game:start", { code: state.code });
});

btnRoll.addEventListener("click", () => {
  socket.emit("game:roll", { code: state.code });
});

btnDeclare.addEventListener("click", () => {
  const v = Number(declareEl.value);
  socket.emit("game:declare", { code: state.code, value: v });
});

btnBelieve.addEventListener("click", () => {
  socket.emit("game:challengeDecision", { code: state.code, decision: "believe" });
});

btnChallenge.addEventListener("click", () => {
  socket.emit("game:challengeDecision", { code: state.code, decision: "challenge" });
});

/** 모달 */
closeModal.addEventListener("click", () => modal.classList.remove("show"));
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("show"); });

/** ===== 소켓 ===== */
socket.on("connect", () => {
  myId = socket.id;
  if (state) renderAll();
});

socket.on("room:update", (s) => {
  state = s;
  if (!myId && socket.id) myId = socket.id; // 타이밍 보정
  renderAll();
});

socket.on("game:privateRoll", ({ roll }) => {
  rollValue.textContent = String(roll);
  modal.classList.add("show");
});

socket.on("error:msg", (m) => alert(m));