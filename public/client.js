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
const stairsEl = $("stairs");

const statsCard = $("statsCard");
const statsEl = $("stats");

const modal = $("modal");
const rollValue = $("rollValue");
const closeModal = $("closeModal");

let state = null;
let myId = null;

/** ===== Animation state (FLIP + splash) ===== */
let prevRects = new Map(); // key -> DOMRect
let prevKeys = new Set();

function keyForDot(where, playerId, index = 0) {
  return `${where}:${playerId}:${index}`;
}

function takeSnapshot() {
  prevRects = new Map();
  prevKeys = new Set();
  document.querySelectorAll("[data-dotkey]").forEach(el => {
    const k = el.getAttribute("data-dotkey");
    prevKeys.add(k);
    prevRects.set(k, el.getBoundingClientRect());
  });
}

function playFLIP() {
  document.querySelectorAll("[data-dotkey]").forEach(el => {
    const k = el.getAttribute("data-dotkey");
    const prev = prevRects.get(k);
    if (!prev) return;
    const now = el.getBoundingClientRect();
    const dx = prev.left - now.left;
    const dy = prev.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = "transform 260ms cubic-bezier(.2,.9,.2,1)";
      el.style.transform = "translate(0,0)";
    });
  });
}

function spawnSplashAt(rect, color) {
  const dot = document.createElement("div");
  dot.className = "ghostDot";
  dot.style.background = color;
  dot.style.left = `${rect.left + rect.width/2 - 6}px`;
  dot.style.top = `${rect.top + rect.height/2 - 6}px`;
  document.body.appendChild(dot);

  const ring = document.createElement("div");
  ring.className = "splashRing";
  ring.style.left = `${rect.left + rect.width/2 - 5}px`;
  ring.style.top = `${rect.top + rect.height/2 + 18}px`;
  document.body.appendChild(ring);

  setTimeout(() => dot.remove(), 700);
  setTimeout(() => ring.remove(), 700);
}

function isHost() {
  return state && state.hostId === myId;
}
function mySeat() {
  if (!state) return -1;
  return state.players.findIndex(p => p.socketId === myId);
}
function currentTurnSeat() {
  return state?.game?.turnSeat ?? -1;
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
  for (let i = 0; i < g.bridgeLen; i++) {
    const cell = document.createElement("div");
    cell.className = "cell stone";
    cell.innerHTML = `<small>${i}</small>`;

    const token = document.createElement("div");
    token.className = "token";

    g.players.forEach((p) => {
      if (p.onBridge === i) {
        const dot = document.createElement("div");
        dot.className = "dot";
        dot.style.background = p.color;
        dot.setAttribute("data-dotkey", keyForDot("bridge", p.id, 0));
        token.appendChild(dot);
      }
    });

    cell.appendChild(token);
    bridgeEl.appendChild(cell);
  }
}

function renderStairs() {
  stairsEl.innerHTML = "";
  const g = state.game;
  const order = g.stairsOrder;

  for (let i = 1; i <= g.stairsSlots; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.innerHTML = `<small>${i}점</small>`;

    const token = document.createElement("div");
    token.className = "token";

    const pid = order[i - 1];
    if (pid) {
      const p = g.players.find(x => x.id === pid);
      if (p) {
        const dot = document.createElement("div");
        dot.className = "dot";
        dot.style.background = p.color;
        dot.setAttribute("data-dotkey", keyForDot("stairs", p.id, i));
        token.appendChild(dot);
      }
    }

    cell.appendChild(token);
    stairsEl.appendChild(cell);
  }
}

function renderStatus() {
  const g = state.game;
  const turnP = state.players[g.turnSeat];

  const labels = {
    ROLL: "주사위를 굴릴 차례",
    DECLARE: "1~4 선언",
    CHALLENGE: "의심 단계(계단 보유자만)",
    RESOLVE: "판정 중",
    END: "게임 종료",
  };

  statusEl.textContent = `${turnP?.name ?? "-"} — ${labels[g.phase] ?? g.phase}`;

  const declared = g.declared ? `선언=${g.declared}` : "";
  const elig = (g.phase === "CHALLENGE") ? `의심 가능 인원=${(g.eligibleSeats || []).length}` : "";
  const prog = (g.phase === "CHALLENGE") ? `선택 진행=${g.decisionsCount}/${(g.eligibleSeats||[]).length}` : "";
  const winner = g.winnerId
    ? `승자: ${state.players.find(x=>x.socketId===g.winnerId)?.name ?? "?"} (${g.winnerReason})`
    : "";

  substatusEl.textContent = [declared, elig, prog, winner, g.lastAction].filter(Boolean).join(" | ");
}

function renderStats() {
  if (!state?.game) {
    statsCard.style.display = "none";
    return;
  }
  statsCard.style.display = "block";

  const g = state.game;
  const WIN = g.instantWinStairs;
  const TOTAL = g.pawnsTotal;

  statsEl.innerHTML = "";
  g.players.forEach((p) => {
    const crossed = p.stairsCount;
    const fallen = p.eliminated;
    const remaining = TOTAL - crossed - fallen;
    const pos = (p.onBridge === null) ? "-" : String(p.onBridge);
    const progress = Math.min(100, Math.round((crossed / WIN) * 100));

    const div = document.createElement("div");
    div.className = "playerStat";
    div.innerHTML = `
      <div class="top">
        <div class="name" style="color:${p.color}">${p.name}${p.id===myId?" (나)":""}</div>
        <div class="small">점수 <b>${p.score}</b>점</div>
      </div>
      <div class="small" style="margin-top:6px">
        다리 위치: <b>${pos}</b> | 굴림 가능: <b>${p.canRoll ? "O" : "X"}</b>
      </div>
      <div class="small" style="margin-top:6px">
        남은 말: <b>${remaining}</b>/${TOTAL} | 낙하: <b>${fallen}</b> | 계단: <b>${crossed}/${WIN}</b>
      </div>
      <div class="bar"><div style="width:${progress}%"></div></div>
    `;
    statsEl.appendChild(div);
  });
}

function setControls() {
  const inRoom = !!state;
  btnLeave.disabled = !inRoom;
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

  // ✅ 의심 가능 조건: 계단 말 가진 사람만 + 턴 플레이어 제외 + CHALLENGE 단계
  const iAmEligible = (g.eligibleSeats || []).includes(seat);
  const canDecide = (g.phase === "CHALLENGE" && iAmEligible);
  btnBelieve.disabled = !canDecide;
  btnChallenge.disabled = !canDecide;
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
    renderStairs();
    renderStats();
  } else {
    statsCard.style.display = "none";
  }

  setControls();
}

/** UI 이벤트 */
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
  btnBelieve.disabled = true;
  btnChallenge.disabled = true;
});

btnChallenge.addEventListener("click", () => {
  socket.emit("game:challengeDecision", { code: state.code, decision: "challenge" });
  btnBelieve.disabled = true;
  btnChallenge.disabled = true;
});

/** 모달 */
closeModal.addEventListener("click", () => modal.classList.remove("show"));
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("show"); });

/** 소켓 */
socket.on("connect", () => {
  myId = socket.id;
  if (state) renderAll();
});

socket.on("room:update", (s) => {
  // 렌더 전 위치 기록
  takeSnapshot();

  // 상태 갱신 + 렌더
  state = s;
  if (!myId && socket.id) myId = socket.id;
  renderAll();

  // 이동 애니메이션
  playFLIP();

  // 낙하 애니메이션(사라진 dot 키)
  const nowKeys = new Set();
  document.querySelectorAll("[data-dotkey]").forEach(el => nowKeys.add(el.getAttribute("data-dotkey")));

  for (const k of prevKeys) {
    if (nowKeys.has(k)) continue;
    const rect = prevRects.get(k);
    if (!rect) continue;

    const parts = k.split(":"); // where:pid:index
    const pid = parts[1];
    const p = state?.game?.players?.find(x => x.id === pid);
    const color = p?.color || "#7aa2ff";
    spawnSplashAt(rect, color);
  }
});

socket.on("game:privateRoll", ({ roll }) => {
  rollValue.textContent = String(roll);
  modal.classList.add("show");
});

socket.on("error:msg", (m) => alert(m));