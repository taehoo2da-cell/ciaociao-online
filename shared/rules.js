export const BRIDGE_LEN = 8;

export const DieFace = Object.freeze({ X: "X" });

export function rollDie(rng = Math.random) {
  const faces = [1, 2, 3, 4, DieFace.X, DieFace.X];
  return faces[Math.floor(rng() * faces.length)];
}

export function makeInitialPlayerState({ id, name, color }) {
  return {
    id,
    name,
    color,
    reserve: 7,
    onBridge: null,
    podium: [],
    eliminated: 0,
  };
}

export function ensurePawnOnBridge(player) {
  if (player.onBridge !== null) return;
  if (player.reserve > 0) {
    player.reserve -= 1;
    player.onBridge = 0;
  }
}

export function pushOffBridge(player) {
  if (player.onBridge === null) return;
  player.onBridge = null;
  player.eliminated += 1;
  ensurePawnOnBridge(player);
}

export function movePawnForward(player, steps, podiumState) {
  if (player.onBridge === null) return;

  const newPos = player.onBridge + steps;
  if (newPos >= BRIDGE_LEN) {
    const step = podiumState.nextStep++;
    player.podium.push(step);
    player.onBridge = null;
    ensurePawnOnBridge(player);
  } else {
    player.onBridge = newPos;
  }
}

export function hasImmediateWin(player) {
  return player.podium.length >= 3;
}

export function computeScore(player) {
  return player.podium.reduce((a, b) => a + b, 0);
}

export function isStalemateEnd(game) {
  const totalPodium = game.players.reduce((s, p) => s + p.podium.length, 0);
  const anyOnBridge = game.players.some((p) => p.onBridge !== null);
  const anyReserve = game.players.some((p) => p.reserve > 0);
  const noOneWon = !game.winnerId;

  return noOneWon && totalPodium <= 2 && !anyOnBridge && !anyReserve;
}