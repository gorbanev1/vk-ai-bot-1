const W = 900;
const H = 1600;
const FIXED_DT = 1 / 180;
const MAX_FRAME_DT = 0.05;
const GRAVITY = 1080;
const BALL_R = 17;
const MAX_BALL_SPEED = 2150;
const COLORS = {
  cyan: '#00f5ff', pink: '#ff2bd6', violet: '#8a5cff', lime: '#9cff00',
  amber: '#ffcc33', danger: '#ff365f', white: '#f8f7ff', bg: '#05030d',
};

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const ui = {
  score: $('score'), best: $('bestScore'), ball: $('ballCount'), multiplier: $('multiplier'),
  ribbon: $('statusRibbon'), start: $('startOverlay'), pause: $('pauseOverlay'), gameOver: $('gameOverOverlay'),
  leaderboard: $('leaderboardOverlay'), leaderboardList: $('leaderboard'), leaderboardNote: $('leaderboardNote'),
  finalScore: $('finalScore'), finalStats: $('finalStats'), toast: $('toast'), auth: $('authState'),
  launchLabel: $('launchLabel'), launchMeter: $('launchMeter'),
};

const tg = window.Telegram?.WebApp || null;
try {
  tg?.ready?.();
  tg?.expand?.();
  tg?.disableVerticalSwipes?.();
  tg?.setHeaderColor?.('#05030d');
  tg?.setBackgroundColor?.('#05030d');
  tg?.setBottomBarColor?.('#05030d');
} catch {}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hypot = (x, y) => Math.hypot(x, y);
const fmt = (n) => Math.max(0, Math.round(n || 0)).toLocaleString('ru-RU');
const now = () => performance.now();
const rand = (a, b) => a + Math.random() * (b - a);
const sign = () => (Math.random() < .5 ? -1 : 1);

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const tt = t * t; const uu = u * u;
  return {
    x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
    y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y,
  };
}

class Synth {
  constructor() { this.ac = null; this.master = null; this.enabled = true; }
  unlock() {
    if (!this.enabled) return;
    try {
      if (!this.ac) {
        this.ac = new (window.AudioContext || window.webkitAudioContext)();
        this.master = this.ac.createGain();
        this.master.gain.value = .22;
        this.master.connect(this.ac.destination);
      }
      if (this.ac.state === 'suspended') void this.ac.resume();
    } catch { this.enabled = false; }
  }
  tone(freq = 220, duration = .08, { type = 'sine', gain = .12, slide = 1, detune = 0 } = {}) {
    if (!this.ac || !this.master || !this.enabled) return;
    const t = this.ac.currentTime;
    const o = this.ac.createOscillator();
    const g = this.ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); o.detune.value = detune;
    o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + duration);
    g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + .008);
    g.gain.exponentialRampToValueAtTime(.0001, t + duration);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + duration + .02);
  }
  click(side = 1) { this.tone(90 + side * 20, .045, { type: 'square', gain: .09, slide: 1.8 }); }
  bumper() { this.tone(rand(180, 300), .12, { type: 'square', gain: .22, slide: 2.35 }); this.tone(rand(520, 760), .055, { type: 'triangle', gain: .10, slide: .72 }); }
  target() { this.tone(rand(520, 700), .06, { type: 'square', gain: .08, slide: .75 }); }
  ramp() { this.tone(160, .24, { type: 'sawtooth', gain: .08, slide: 4 }); }
  jackpot() { [0, .07, .14, .21].forEach((d, i) => setTimeout(() => this.tone(330 * (1 + i * .25), .18, { type: 'triangle', gain: .12, slide: 1.5 }), d * 1000)); }
  drain() { this.tone(180, .42, { type: 'sawtooth', gain: .12, slide: .18 }); }
  launch() { this.tone(95, .2, { type: 'sawtooth', gain: .1, slide: 4.4 }); }
  multiball() { [220, 330, 440, 660, 880].forEach((f, i) => setTimeout(() => this.tone(f, .18, { type: 'square', gain: .09, slide: 1.15 }), i * 55)); }
}
const synth = new Synth();

function haptic(kind = 'light') {
  try {
    if (kind === 'success' || kind === 'error') tg?.HapticFeedback?.notificationOccurred?.(kind);
    else tg?.HapticFeedback?.impactOccurred?.(kind);
  } catch {}
}

let toastTimer = 0;
function toast(text, ms = 1500) {
  ui.toast.textContent = text;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), ms);
}

const controls = { left: false, right: false, launch: false };
const particles = [];
const floats = [];
const flashes = new Map();
let ballSeq = 0;

const state = {
  phase: 'idle', paused: false, score: 0, best: Number(localStorage.getItem('gigoravePinballBest') || 0),
  ballsRemaining: 3, multiplier: 1, maxMultiplier: 1, combo: 0, maxCombo: 0, comboUntil: 0,
  gameStartedAt: 0, ballStartedAt: 0, ballSaveUntil: 0, launchCharge: 0, launchHeldAt: 0,
  lastLaunchAt: 0, skillShotAvailable: false, tilt: 0, tilted: false, tiltClearAt: 0,
  bumpers: 0, ramps: 0, jackpots: 0, multiballs: 0, targets: 0, nudges: 0,
  rave: [false, false, false, false], gigo: [false, false, false, false], lockQualified: false,
  overdriveUntil: 0, jackpotLitUntil: 0, lastRampSide: '', lastRampAt: 0,
  balls: [], pendingSpawnAt: 0, pendingGameOverAt: 0, cameraShake: 0,
  sessionToken: '', remoteAuthenticated: false, remoteUser: null, submitted: false,
};

ui.best.textContent = fmt(state.best);

function segment(x1, y1, x2, y2, opts = {}) { return { x1, y1, x2, y2, r: opts.r ?? 9, e: opts.e ?? .66, friction: opts.friction ?? .02, kick: opts.kick ?? 0, label: opts.label || '', score: opts.score || 0, color: opts.color || COLORS.violet, glow: opts.glow ?? 1, oneWay: opts.oneWay || 0 }; }
function bezierWall(p0, p1, p2, p3, opts = {}, steps = 10) {
  const out = [];
  let previous = p0;
  for (let i = 1; i <= steps; i += 1) {
    const point = bezier(p0, p1, p2, p3, i / steps);
    out.push(segment(previous.x, previous.y, point.x, point.y, opts));
    previous = point;
  }
  return out;
}
function bezierTangent(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const dx = 3*u*u*(p1.x-p0.x) + 6*u*t*(p2.x-p1.x) + 3*t*t*(p3.x-p2.x);
  const dy = 3*u*u*(p1.y-p0.y) + 6*u*t*(p2.y-p1.y) + 3*t*t*(p3.y-p2.y);
  const len = hypot(dx,dy) || 1;
  return { x:dx/len, y:dy/len };
}
function sensorRect(id, x, y, w, h, action) { return { id, type: 'rect', x, y, w, h, action }; }
function sensorCircle(id, x, y, r, action) { return { id, type: 'circle', x, y, r, action }; }

const walls = [
  // V127 outer cabinet: long tangent curves instead of hard polygon corners.
  segment(70, 1540, 70, 360, { r: 14, color: COLORS.pink }),
  ...bezierWall({ x:70, y:360 }, { x:70, y:235 }, { x:145, y:125 }, { x:225, y:105 }, { r:14, color:COLORS.pink }, 12),
  ...bezierWall({ x:225, y:105 }, { x:365, y:88 }, { x:540, y:82 }, { x:650, y:92 }, { r:14, color:COLORS.cyan }, 12),
  ...bezierWall({ x:650, y:92 }, { x:740, y:105 }, { x:815, y:180 }, { x:825, y:270 }, { r:14, color:COLORS.cyan }, 12),
  segment(825, 270, 830, 1540, { r: 14, color: COLORS.cyan }),

  // Full-length right-side shooter lane, like a conventional real machine.
  // Its divider ends in a broad radius so there is no corner for the ball to spear.
  segment(746, 1505, 746, 610, { r: 8, color: '#5635a7', e: .5 }),
  ...bezierWall({ x:746, y:610 }, { x:746, y:500 }, { x:730, y:415 }, { x:680, y:350 }, { r:8, color:'#5635a7', e:.5 }, 12),

  // Lower return/outlane guides are curved and leave the shooter channel clear.
  ...bezierWall({ x:70, y:1240 }, { x:95, y:1280 }, { x:140, y:1345 }, { x:180, y:1390 }, { r:12, color:COLORS.pink }, 8),
  ...bezierWall({ x:742, y:1230 }, { x:710, y:1280 }, { x:675, y:1340 }, { x:640, y:1380 }, { r:12, color:COLORS.cyan }, 8),
  ...bezierWall({ x:180, y:1390 }, { x:192, y:1430 }, { x:200, y:1470 }, { x:205, y:1510 }, { r:10, color:'#6b2d77' }, 6),
  ...bezierWall({ x:720, y:1390 }, { x:710, y:1435 }, { x:700, y:1475 }, { x:695, y:1510 }, { r:10, color:'#2f6077' }, 6),
  ...bezierWall({ x:760, y:1518 }, { x:778, y:1530 }, { x:808, y:1530 }, { x:825, y:1518 }, { r:10, color:COLORS.amber, e:.35 }, 6),

  // Inlane guides: smooth rubber/metal arcs, not intersecting V-shaped corners.
  ...bezierWall({ x:145, y:1175 }, { x:175, y:1205 }, { x:220, y:1270 }, { x:250, y:1310 }, { r:9, color:'#7343d7' }, 8),
  ...bezierWall({ x:210, y:1160 }, { x:240, y:1190 }, { x:280, y:1260 }, { x:305, y:1300 }, { r:7, color:'#4b3284' }, 8),
  ...bezierWall({ x:735, y:1175 }, { x:710, y:1205 }, { x:675, y:1270 }, { x:650, y:1310 }, { r:9, color:'#3571d7' }, 8),
  ...bezierWall({ x:690, y:1160 }, { x:660, y:1190 }, { x:620, y:1260 }, { x:595, y:1300 }, { r:7, color:'#315084' }, 8),

  // V128: the middle of the playfield is intentionally empty. The decorative
  // upper/center guide rails from V127 were removed because they made the ball
  // ricochet through a cramped obstacle cluster instead of giving shots room to develop.
];

const slings = [
  segment(205, 1190, 315, 1335, { r: 17, e: .9, kick: 360, label: 'SLING-L', score: 2500, color: COLORS.pink }),
  segment(695, 1190, 585, 1335, { r: 17, e: .9, kick: 360, label: 'SLING-R', score: 2500, color: COLORS.cyan }),
];

// V128 wide layout: three pop bumpers live on alternating sides instead of a
// four-bumper knot in the middle. A clear central corridor is kept open for the ball.
const bumpers = [
  { id: 'B1', x: 225, y: 455, r: 42, e: 1.12, kick: 1080, minExitSpeed: 1250, score: 6000, color: COLORS.pink },
  { id: 'B2', x: 635, y: 520, r: 44, e: 1.13, kick: 1140, minExitSpeed: 1325, score: 7000, color: COLORS.cyan },
  { id: 'B3', x: 235, y: 735, r: 40, e: 1.12, kick: 1040, minExitSpeed: 1225, score: 5500, color: COLORS.lime },
];

// The RAVE targets are two separate side banks. Nothing spans the middle anymore.
const targets = [
  { id: 'R', x1: 120, y1: 900, x2: 205, y2: 875, color: COLORS.pink, index: 0 },
  { id: 'A', x1: 135, y1: 1015, x2: 220, y2: 990, color: COLORS.violet, index: 1 },
  { id: 'V', x1: 590, y1: 990, x2: 675, y2: 1015, color: COLORS.cyan, index: 2 },
  { id: 'E', x1: 605, y1: 875, x2: 690, y2: 900, color: COLORS.lime, index: 3 },
].map((t) => ({ ...t, wall: segment(t.x1, t.y1, t.x2, t.y2, { r: 12, e: .52, kick: 160, label: `TARGET-${t.id}`, score: 15000, color: t.color }) }));

const SCOOP = Object.freeze({ x: 450, y: 1080, r: 40 });

const sensors = [
  sensorCircle('G', 195, 225, 30, (b) => hitGigo(0, b)),
  sensorCircle('I', 345, 175, 30, (b) => hitGigo(1, b)),
  sensorCircle('G2', 500, 170, 30, (b) => hitGigo(2, b)),
  sensorCircle('O', 650, 220, 30, (b) => hitGigo(3, b)),
  sensorRect('LEFT_RAMP', 82, 645, 112, 145, (b) => enterRamp(b, 'left')),
  sensorRect('RIGHT_RAMP', 660, 685, 82, 150, (b) => enterRamp(b, 'right')),
  sensorCircle('SCOOP', SCOOP.x, SCOOP.y, SCOOP.r + 4, (b) => hitScoop(b)),
  sensorRect('LEFT_INLANE', 205, 1260, 78, 90, () => addScore(8500, 'INLANE')), 
  sensorRect('RIGHT_INLANE', 617, 1260, 78, 90, () => addScore(8500, 'INLANE')),
  sensorRect('LEFT_ORBIT', 82, 330, 90, 250, () => addScore(12000, 'VOID ORBIT')),
  sensorRect('RIGHT_ORBIT', 670, 300, 70, 250, () => addScore(12000, 'NEON ORBIT')),
];

// Conventional two-flipper bottom: the V127 upper flipper was removed so the
// right-middle playfield is no longer another collision choke point.
const flippers = [
  { id: 'L', pivot: { x: 255, y: 1435 }, length: 168, radius: 19, angle: -.12, rest: -.12, active: -.78, omega: 0, pressed: false, color: COLORS.pink },
  { id: 'R', pivot: { x: 645, y: 1435 }, length: 168, radius: 19, angle: Math.PI + .12, rest: Math.PI + .12, active: Math.PI + .78, omega: 0, pressed: false, color: COLORS.cyan },
];

const rampPaths = {
  // Side-specific ramps: neither dashed path crosses the central shot corridor.
  // Both mouths still use V127's one-way capture and tangent-exit mechanics.
  left: { p0: { x: 135, y: 720 }, p1: { x: 95, y: 555 }, p2: { x: 140, y: 440 }, p3: { x: 340, y: 610 }, color: COLORS.pink, exitSpeed: 640 },
  right: { p0: { x: 705, y: 760 }, p1: { x: 735, y: 600 }, p2: { x: 690, y: 470 }, p3: { x: 560, y: 650 }, color: COLORS.cyan, exitSpeed: 640 },
};

function flipperEndpoints(f) {
  return { x1: f.pivot.x, y1: f.pivot.y, x2: f.pivot.x + Math.cos(f.angle) * f.length, y2: f.pivot.y + Math.sin(f.angle) * f.length };
}

function newBall({ launcher = true, x = null, y = null, vx = 0, vy = 0 } = {}) {
  const b = {
    id: ++ballSeq, x: x ?? (launcher ? 790 : 450), y: y ?? (launcher ? 1475 : 760),
    vx, vy, r: BALL_R, alive: true, inLauncher: launcher, trail: [], sensorInside: new Set(),
    hitCooldown: new Map(), ramp: null, bornAt: now(), hue: rand(180, 330),
    shooterMotion: null, launchPower: 0, rampLockoutUntil: 0,
  };
  state.balls.push(b);
  return b;
}

function resetState() {
  state.score = 0; state.ballsRemaining = 3; state.multiplier = 1; state.maxMultiplier = 1;
  state.combo = 0; state.maxCombo = 0; state.comboUntil = 0; state.gameStartedAt = now(); state.ballStartedAt = now();
  state.ballSaveUntil = 0; state.launchCharge = 0; state.launchHeldAt = 0; state.lastLaunchAt = 0; state.skillShotAvailable = false;
  state.tilt = 0; state.tilted = false; state.tiltClearAt = 0; state.bumpers = 0; state.ramps = 0; state.jackpots = 0;
  state.multiballs = 0; state.targets = 0; state.nudges = 0; state.rave = [false,false,false,false]; state.gigo = [false,false,false,false];
  state.lockQualified = false; state.overdriveUntil = 0; state.jackpotLitUntil = 0; state.lastRampSide = ''; state.lastRampAt = 0;
  state.balls.length = 0; state.pendingSpawnAt = 0; state.pendingGameOverAt = 0; state.submitted = false;
  particles.length = 0; floats.length = 0; flashes.clear();
  newBall({ launcher: true });
  state.ballSaveUntil = 0;
  setRibbon('HOLD SPACE · RELEASE TO LAUNCH');
  updateUI();
}

function startGame() {
  synth.unlock(); haptic('medium');
  try { tg?.requestFullscreen?.(); } catch {}
  ui.start.classList.remove('open'); ui.gameOver.classList.remove('open'); ui.pause.classList.remove('open');
  state.phase = 'playing'; state.paused = false; resetState();
}

function gameOver() {
  if (state.phase === 'gameover') return;
  state.phase = 'gameover'; state.paused = false; state.balls.length = 0;
  state.best = Math.max(state.best, state.score); localStorage.setItem('gigoravePinballBest', String(state.best));
  ui.best.textContent = fmt(state.best); ui.finalScore.textContent = fmt(state.score);
  const duration = Math.max(0, Math.round(now() - state.gameStartedAt));
  ui.finalStats.innerHTML = [
    ['MAX COMBO', state.maxCombo], ['MAX MULTI', `×${state.maxMultiplier}`], ['BUMPER HITS', state.bumpers],
    ['RAMPS', state.ramps], ['JACKPOTS', state.jackpots], ['MULTIBALLS', state.multiballs],
  ].map(([k,v]) => `<div><b>${v}</b><br><span>${k}</span></div>`).join('');
  ui.gameOver.classList.add('open'); setRibbon('END OF TRANSMISSION'); synth.drain(); haptic('error');
  void submitScore({ durationMs: duration });
}

function togglePause(force) {
  if (state.phase !== 'playing') return;
  state.paused = typeof force === 'boolean' ? force : !state.paused;
  ui.pause.classList.toggle('open', state.paused);
  setRibbon(state.paused ? 'SYSTEM HALT' : 'BALL IN PLAY');
}

function setRibbon(text) { ui.ribbon.textContent = text; }
function updateUI() {
  ui.score.textContent = fmt(state.score); ui.best.textContent = fmt(Math.max(state.best, state.score));
  ui.ball.textContent = String(state.ballsRemaining); ui.multiplier.textContent = `×${state.multiplier}`;
  ui.launchMeter.style.width = `${Math.round(state.launchCharge * 100)}%`;
  ui.launchLabel.textContent = state.launchCharge > .02 ? `POWER ${Math.round(state.launchCharge * 100)}%` : 'LAUNCH';
}

function burst(x, y, color = COLORS.cyan, count = 12, power = 320) {
  const cap = innerWidth < 650 ? Math.min(count, 10) : count;
  for (let i = 0; i < cap; i++) {
    const a = Math.random() * Math.PI * 2; const s = rand(power * .35, power);
    particles.push({ x, y, vx: Math.cos(a)*s, vy: Math.sin(a)*s, life: rand(.28,.8), maxLife: 1, size: rand(2,7), color });
  }
}
function floatText(text, x, y, color = COLORS.white, size = 26) { floats.push({ text, x, y, vy: -70, life: 1.1, maxLife: 1.1, color, size }); }
function flash(id, ms = 150) { flashes.set(id, now() + ms); }

function addScore(base, label = '', { x = 450, y = 700, color = COLORS.white, noCombo = false } = {}) {
  if (state.phase !== 'playing' || state.tilted) return 0;
  const t = now();
  if (!noCombo) {
    state.combo = t <= state.comboUntil ? Math.min(30, state.combo + 1) : 1;
    state.comboUntil = t + 2400;
    state.maxCombo = Math.max(state.maxCombo, state.combo);
  }
  const comboMult = 1 + Math.floor(Math.max(0, state.combo - 1) / 5) * .25;
  const modeMult = t < state.overdriveUntil ? 2 : 1;
  const points = Math.round(base * state.multiplier * comboMult * modeMult);
  state.score += points; state.best = Math.max(state.best, state.score);
  floatText(`+${fmt(points)}${label ? ` ${label}` : ''}`, x, y, color, label.includes('JACKPOT') ? 34 : 24);
  if (state.combo >= 5 && state.combo % 5 === 0) toast(`COMBO ×${state.combo}`);
  updateUI(); return points;
}

function hitGigo(index, ball) {
  if (state.gigo[index]) return;
  state.gigo[index] = true; addScore(12000, 'LANE', { x: ball.x, y: ball.y, color: COLORS.cyan }); synth.target();
  if (state.skillShotAvailable && now() - state.lastLaunchAt < 4500) {
    state.skillShotAvailable = false; addScore(125000, 'SKILL SHOT', { x: ball.x, y: ball.y, color: COLORS.lime, noCombo: true }); toast('⚡ SKILL SHOT +125K'); haptic('success');
  }
  if (state.gigo.every(Boolean)) {
    state.gigo.fill(false); state.multiplier = Math.min(5, state.multiplier + 1); state.maxMultiplier = Math.max(state.maxMultiplier, state.multiplier);
    addScore(75000, `MULTI ×${state.multiplier}`, { x: 450, y: 260, color: COLORS.lime, noCombo: true }); synth.jackpot();
  }
}

function handleTarget(label, ball) {
  const t = targets.find((item) => `TARGET-${item.id}` === label); if (!t) return;
  state.targets += 1; state.rave[t.index] = true; flash(label, 180); synth.target(); haptic('light');
  if (state.rave.every(Boolean)) {
    state.rave.fill(false); state.lockQualified = true; state.overdriveUntil = now() + 20000;
    addScore(180000, 'RAVE COMPLETE', { x: 450, y: 820, color: COLORS.pink, noCombo: true });
    toast('☣ RAVE COMPLETE · SCOOP LIT · 2× 20s', 2600); synth.jackpot(); haptic('success'); setRibbon('SCOOP LIT · MULTIBALL READY');
  }
}

function hitScoop(ball) {
  if (ball.ramp || now() - (ball.lastScoopAt || 0) < 1200) return;
  ball.lastScoopAt = now();
  if (state.lockQualified && state.balls.length <= 2) {
    state.lockQualified = false; startMultiball(ball); return;
  }
  addScore(25000, 'VOID SCOOP', { x: ball.x, y: ball.y, color: COLORS.violet });
  ball.vy = -520; ball.vx += sign() * 220;
}

function startMultiball(sourceBall) {
  state.multiballs += 1; state.jackpotLitUntil = now() + 35000; state.cameraShake = 18;
  addScore(250000, 'MULTIBALL', { x: sourceBall.x, y: sourceBall.y, color: COLORS.lime, noCombo: true });
  sourceBall.x = 445; sourceBall.y = 700; sourceBall.vx = -350; sourceBall.vy = -650; sourceBall.inLauncher = false;
  newBall({ launcher: false, x: 470, y: 720, vx: 420, vy: -720 });
  setTimeout(() => { if (state.phase === 'playing') newBall({ launcher:false, x:430, y:750, vx:-180, vy:-820 }); }, 220);
  synth.multiball(); haptic('success'); toast('☢ MULTIBALL · JACKPOT LIT', 2600); setRibbon('MULTIBALL · HIT RAMPS FOR JACKPOT');
}

function enterRamp(ball, side) {
  const t = now();
  if (ball.ramp || ball.inLauncher || t < (ball.rampLockoutUntil || 0)) return false;
  const p = rampPaths[side];
  // One-way ramp mouth. A descending/sideways ball may roll across the artwork,
  // but only a real up-table shot can climb onto the ramp. This prevents the
  // opposite ramp mouth from recapturing a ball immediately after an exit.
  const entryTangent = bezierTangent(p.p0,p.p1,p.p2,p.p3,0);
  const entrySpeed = ball.vx*entryTangent.x + ball.vy*entryTangent.y;
  if (entrySpeed < 260 || ball.vy > -180) return false;

  ball.lastRampAt = t;
  ball.ramp = { side, startedAt: t, duration: 1050, ...p };
  ball.sensorInside.clear();
  state.ramps += 1; addScore(50000, `${side.toUpperCase()} RAMP`, { x: ball.x, y: ball.y, color: p.color }); synth.ramp(); haptic('medium');
  if (t < state.jackpotLitUntil) {
    state.jackpots += 1; addScore(300000 + state.jackpots * 50000, 'JACKPOT', { x: 450, y: 430, color: COLORS.lime, noCombo: true });
    state.jackpotLitUntil = t + 12000; synth.jackpot(); state.cameraShake = 14; toast(`💥 JACKPOT ${fmt(300000 + state.jackpots*50000)}`, 2200);
  }
  if (state.lastRampSide && state.lastRampSide !== side && t - state.lastRampAt < 8000) {
    addScore(175000, 'CROSS-RAMP', { x: 450, y: 520, color: COLORS.amber, noCombo: true }); toast('⚡ CROSS-RAMP COMBO');
  }
  state.lastRampSide = side; state.lastRampAt = t;
  return true;
}

const SHOOTER_TRACK_CURVES = Object.freeze([
  Object.freeze([
    Object.freeze({ x:790, y:1475 }),
    Object.freeze({ x:790, y:1000 }),
    Object.freeze({ x:800, y:480 }),
    Object.freeze({ x:760, y:265 }),
  ]),
  Object.freeze([
    Object.freeze({ x:760, y:265 }),
    Object.freeze({ x:738, y:175 }),
    Object.freeze({ x:675, y:155 }),
    Object.freeze({ x:585, y:350 }),
  ]),
]);

function buildShooterTrack(curves, stepsPerCurve = 80) {
  const points = [];
  for (let c = 0; c < curves.length; c += 1) {
    const [p0,p1,p2,p3] = curves[c];
    for (let i = 0; i <= stepsPerCurve; i += 1) {
      if (c > 0 && i === 0) continue;
      points.push(bezier(p0,p1,p2,p3,i/stepsPerCurve));
    }
  }
  let distance = 0;
  const samples = points.map((p, i) => {
    if (i > 0) distance += hypot(p.x-points[i-1].x,p.y-points[i-1].y);
    return { x:p.x, y:p.y, s:distance };
  });
  return Object.freeze({ points:Object.freeze(samples), length:distance });
}

const SHOOTER_TRACK = buildShooterTrack(SHOOTER_TRACK_CURVES);
const SHOOTER_START_SPEED = 1640;
const SHOOTER_CHARGE_SPEED = 700;
const SHOOTER_ROLLING_DRAG = 55;

function sampleShooterTrack(distance) {
  const s = clamp(distance, 0, SHOOTER_TRACK.length);
  const points = SHOOTER_TRACK.points;
  let lo = 0; let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].s <= s) lo = mid; else hi = mid;
  }
  const a = points[lo]; const b = points[Math.min(lo + 1, points.length - 1)];
  const ds = Math.max(.0001, b.s - a.s);
  const q = clamp((s - a.s) / ds, 0, 1);
  const dx = b.x-a.x; const dy = b.y-a.y; const len = hypot(dx,dy) || 1;
  return { x:lerp(a.x,b.x,q), y:lerp(a.y,b.y,q), tx:dx/len, ty:dy/len, s };
}

function nearestShooterDistance(x, y) {
  const points = SHOOTER_TRACK.points;
  let bestS = 0; let bestD2 = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]; const b = points[i+1];
    const p = closestPointSegment(x,y,a.x,a.y,b.x,b.y);
    const dx=x-p.x,dy=y-p.y,d2=dx*dx+dy*dy;
    if (d2 < bestD2) { bestD2=d2; bestS=lerp(a.s,b.s,p.t); }
  }
  return { s:bestS, distance:Math.sqrt(bestD2) };
}

function resetShooterBall(ball, { announce = true } = {}) {
  const start = SHOOTER_TRACK.points[0];
  ball.x=start.x; ball.y=start.y; ball.vx=0; ball.vy=0;
  ball.inLauncher=true; ball.shooterMotion=null; ball.launchPower=0;
  if (announce) {
    state.launchCharge=0; state.launchHeldAt=0;
    setRibbon('BALL RETURNED · HOLD SPACE · RELEASE TO PLUNGE AGAIN');
    toast('↩ BALL RETURNED · PLUNGE AGAIN', 1700);
  }
}

function launchBall() {
  const ball = state.balls.find((b) => b.inLauncher && !b.ramp && !b.shooterMotion);
  if (!ball || state.phase !== 'playing' || state.paused) return false;
  const charge = clamp(state.launchCharge, 0, 1);
  ball.launchPower = charge;
  ball.inLauncher = false;
  ball.vx = 0; ball.vy = 0;
  ball.shooterMotion = {
    s: 0,
    v: SHOOTER_START_SPEED + SHOOTER_CHARGE_SPEED * charge,
  };
  state.launchCharge = 0;
  synth.launch(); haptic('medium');
  setRibbon(charge < .10 ? 'SOFT PLUNGE · MAY ROLL BACK' : 'PLUNGE · SHOOTER LANE');
  return true;
}

function updateShooterMotion(ball, dt) {
  const motion = ball.shooterMotion;
  if (!motion) return false;
  const before = sampleShooterTrack(motion.s);
  // Project table gravity onto the tangent of the shooter lane. Going uphill slows
  // the ball; after the rounded crest gravity helps it flow into the playfield.
  let acceleration = GRAVITY * before.ty;
  if (Math.abs(motion.v) > 1) acceleration -= Math.sign(motion.v) * SHOOTER_ROLLING_DRAG;
  motion.v += acceleration * dt;
  motion.s += motion.v * dt;

  if (motion.s <= 0 && motion.v <= 0) {
    resetShooterBall(ball);
    return true;
  }

  if (motion.s >= SHOOTER_TRACK.length) {
    const exit = sampleShooterTrack(SHOOTER_TRACK.length);
    const speed = Math.max(560, motion.v);
    ball.x=exit.x; ball.y=exit.y; ball.shooterMotion=null; ball.inLauncher=false;
    ball.vx=exit.tx*speed; ball.vy=exit.ty*speed;
    state.lastLaunchAt=now(); state.skillShotAvailable=true; state.ballSaveUntil=now()+9000;
    setRibbon('BALL SAVE 9s · GIGO LANES = SKILL SHOT');
    burst(ball.x,ball.y,COLORS.amber,10,180);
    return false;
  }

  const pos = sampleShooterTrack(motion.s);
  ball.x=pos.x; ball.y=pos.y; ball.vx=pos.tx*motion.v; ball.vy=pos.ty*motion.v;
  return true;
}

function captureShooterReturn(ball) {
  if (ball.inLauncher || ball.shooterMotion || ball.ramp) return false;
  // A ball that really comes back down the isolated right shooter channel is not
  // a drain. Capture it onto the rail and let it settle back on the plunger.
  if (ball.x < 758 || ball.x > 836 || ball.y < 520 || ball.vy < -120) return false;
  const nearest = nearestShooterDistance(ball.x,ball.y);
  if (nearest.distance > 42) return false;
  const pos = sampleShooterTrack(nearest.s);
  const along = ball.vx*pos.tx + ball.vy*pos.ty;
  ball.shooterMotion={ s:nearest.s, v:Math.min(-180, along) };
  ball.inLauncher=false; ball.vx=0; ball.vy=0;
  return true;
}

function nudge(dx, dy) {
  if (state.phase !== 'playing' || state.paused || state.tilted) return;
  synth.unlock(); state.nudges += 1; state.tilt += 32; state.cameraShake = Math.max(state.cameraShake, 7); haptic('heavy');
  for (const b of state.balls) { if (!b.ramp) { b.vx += dx; b.vy += dy; } }
  if (state.tilt >= 100) triggerTilt(); else toast(`NUDGE · TILT ${Math.round(state.tilt)}%`, 700);
}
function triggerTilt() {
  if (state.tilted) return; state.tilted = true; state.tiltClearAt = now() + 1300; state.cameraShake = 20;
  setRibbon('TILT · BALL LOST'); toast('⚠ TILT', 1400); haptic('error'); synth.drain();
}

function closestPointSegment(px, py, x1, y1, x2, y2) {
  const dx = x2-x1, dy = y2-y1; const l2 = dx*dx+dy*dy || 1;
  const t = clamp(((px-x1)*dx+(py-y1)*dy)/l2,0,1); return { x:x1+t*dx, y:y1+t*dy, t };
}

function hitCooldown(ball, key, ms = 120) {
  const t = now(); const last = ball.hitCooldown.get(key) || 0;
  if (t - last < ms) return false; ball.hitCooldown.set(key, t); return true;
}

function collideSegment(ball, s, moving = null) {
  const p = closestPointSegment(ball.x, ball.y, s.x1, s.y1, s.x2, s.y2);
  let nx = ball.x-p.x, ny = ball.y-p.y; let d = hypot(nx,ny); const min = ball.r + s.r;
  if (d >= min) return false;
  if (d < .001) { const sx=s.x2-s.x1, sy=s.y2-s.y1; nx=-sy; ny=sx; d=hypot(nx,ny)||1; }
  nx/=d; ny/=d; const pen=min-d; ball.x += nx*pen; ball.y += ny*pen;
  let cvx=0,cvy=0;
  if (moving) { const rx=p.x-moving.pivot.x, ry=p.y-moving.pivot.y; cvx=-moving.omega*ry; cvy=moving.omega*rx; }
  const rvx=ball.vx-cvx, rvy=ball.vy-cvy; const vn=rvx*nx+rvy*ny;
  if (vn < 0) {
    const e=s.e ?? .65; ball.vx -= (1+e)*vn*nx; ball.vy -= (1+e)*vn*ny;
    if (moving) { ball.vx += cvx*.42; ball.vy += cvy*.42; }
    const kick=s.kick||0; if (kick) { ball.vx += nx*kick; ball.vy += ny*kick; }
    const tx=-ny,ty=nx; const tv=ball.vx*tx+ball.vy*ty; const fr=s.friction??.02; ball.vx-=tv*fr*tx; ball.vy-=tv*fr*ty;
  }
  if (s.label && hitCooldown(ball,s.label,130)) {
    if (s.label.startsWith('TARGET-')) handleTarget(s.label,ball);
    else if (s.score) { addScore(s.score,s.label,{x:p.x,y:p.y,color:s.color}); synth.target(); flash(s.label,110); }
  }
  return true;
}

function collideCircle(ball, c) {
  let dx=ball.x-c.x,dy=ball.y-c.y,d=hypot(dx,dy); const min=ball.r+c.r;
  if (d>=min) return false; if (d<.001){dx=1;dy=0;d=1;} const nx=dx/d,ny=dy/d;
  const pen=min-d; ball.x+=nx*pen; ball.y+=ny*pen; const vn=ball.vx*nx+ball.vy*ny;
  if(vn<0){
    // Pop bumpers are active solenoids: a valid hit should kick decisively outward,
    // not behave like a soft passive rubber post.
    ball.vx-=(1+(c.e??.9))*vn*nx;ball.vy-=(1+(c.e??.9))*vn*ny;
    ball.vx+=nx*(c.kick||0);ball.vy+=ny*(c.kick||0);
    const outward=ball.vx*nx+ball.vy*ny;const minimum=c.minExitSpeed||0;
    if(outward<minimum){const boost=minimum-outward;ball.vx+=nx*boost;ball.vy+=ny*boost;}
    state.cameraShake=Math.max(state.cameraShake,8);
  }
  if(hitCooldown(ball,c.id,140)){state.bumpers+=1;addScore(c.score,c.id,{x:c.x,y:c.y,color:c.color});burst(c.x,c.y,c.color,28,680);flash(c.id,220);synth.bumper();haptic('medium');if(state.bumpers%12===0){state.overdriveUntil=now()+20000;toast('⚡ NEON OVERDRIVE · 2× 20s',2200);}}
  return true;
}

function collideBalls(a,b){
  const dx=b.x-a.x,dy=b.y-a.y;let d=hypot(dx,dy),min=a.r+b.r;if(d>=min||d<.001)return;const nx=dx/d,ny=dy/d;const pen=(min-d)/2;a.x-=nx*pen;a.y-=ny*pen;b.x+=nx*pen;b.y+=ny*pen;const rv=(b.vx-a.vx)*nx+(b.vy-a.vy)*ny;if(rv>=0)return;const j=-(1+.82)*rv/2;a.vx-=j*nx;a.vy-=j*ny;b.vx+=j*nx;b.vy+=j*ny;
}

function sensorContains(s,b){ if(s.type==='circle')return hypot(b.x-s.x,b.y-s.y)<=s.r+b.r*.25; return b.x>=s.x&&b.x<=s.x+s.w&&b.y>=s.y&&b.y<=s.y+s.h; }
function processSensors(ball){
  for(const s of sensors){const inside=sensorContains(s,ball);const had=ball.sensorInside.has(s.id);if(inside&&!had){ball.sensorInside.add(s.id);try{s.action(ball);}catch(e){console.error(e);}}else if(!inside&&had){ball.sensorInside.delete(s.id);}}
}

function updateFlippers(dt){
  for(const f of flippers){
    const pressed=f.upper?controls.right:(f.id==='L'?controls.left:controls.right);f.pressed=pressed&&!state.tilted;
    const target=f.pressed?f.active:f.rest;let diff=target-f.angle;while(diff>Math.PI)diff-=Math.PI*2;while(diff<-Math.PI)diff+=Math.PI*2;
    const accel=diff*155-f.omega*18;f.omega+=accel*dt;f.omega=clamp(f.omega,-19,19);f.angle+=f.omega*dt;
    if(Math.abs(diff)<.006&&Math.abs(f.omega)<.2){f.angle=target;f.omega=0;}
  }
}

function updateRamp(ball,t){
  const r=ball.ramp;if(!r)return false;
  const p=clamp((t-r.startedAt)/r.duration,0,1);
  const pos=bezier(r.p0,r.p1,r.p2,r.p3,p);
  const tangent=bezierTangent(r.p0,r.p1,r.p2,r.p3,p);
  ball.x=pos.x;ball.y=pos.y;ball.vx=tangent.x*r.exitSpeed;ball.vy=tangent.y*r.exitSpeed;
  if(p>=1){
    // Preserve the end tangent instead of reversing X at the dashed-arc endpoint.
    // Give the ball a short one-way-gate lockout so the nearby opposite ramp mouth
    // cannot immediately grab it while it is descending back to the playfield.
    ball.ramp=null;ball.rampLockoutUntil=t+850;ball.sensorInside.clear();
    ball.x+=tangent.x*(ball.r+12);ball.y+=tangent.y*(ball.r+12);
    ball.vx=tangent.x*r.exitSpeed;ball.vy=tangent.y*r.exitSpeed;
    burst(ball.x,ball.y,r.color,14,300);
  }
  return true;
}

function physicsStep(dt){
  if(state.phase!=='playing'||state.paused)return;const t=now();updateFlippers(dt);state.tilt=Math.max(0,state.tilt-dt*9);
  if(state.tilted&&t>=state.tiltClearAt){for(const b of state.balls){b.y=1585;b.vy=900;}state.tilted=false;state.tilt=0;}
  for(const b of state.balls){
    if(!b.alive)continue;if(updateRamp(b,t))continue;if(updateShooterMotion(b,dt))continue;
    if(captureShooterReturn(b)){updateShooterMotion(b,dt);continue;}
    if(b.inLauncher){b.vx*=.94;}
    b.vy+=GRAVITY*dt;b.vx*=Math.pow(.997,dt*180);b.vy*=Math.pow(.9993,dt*180);
    const sp=hypot(b.vx,b.vy);if(sp>MAX_BALL_SPEED){const q=MAX_BALL_SPEED/sp;b.vx*=q;b.vy*=q;}
    b.x+=b.vx*dt;b.y+=b.vy*dt;
    for(const s of walls)collideSegment(b,s);for(const s of slings)collideSegment(b,s);for(const tdef of targets)collideSegment(b,tdef.wall);
    for(const f of flippers){const e=flipperEndpoints(f);collideSegment(b,{...e,r:f.radius,e:.72,friction:.02,kick:0,label:''},f);}
    for(const c of bumpers)collideCircle(b,c);processSensors(b);
    if(b.y>1565||b.x<-80||b.x>980||b.y<-150)b.alive=false;
  }
  for(let i=0;i<state.balls.length;i++)for(let j=i+1;j<state.balls.length;j++){const a=state.balls[i],b=state.balls[j];if(a.alive&&b.alive&&!a.ramp&&!b.ramp)collideBalls(a,b);}
  const drained=state.balls.filter(b=>!b.alive);if(drained.length){state.balls=state.balls.filter(b=>b.alive);for(const b of drained)handleDrain(b,t);}
}

function handleDrain(ball,t){
  synth.drain();burst(clamp(ball.x,100,800),1515,COLORS.danger,18,260);
  if(t<state.ballSaveUntil&&state.balls.length===0&&!state.tilted){toast('BALL SAVE',1200);setTimeout(()=>{if(state.phase==='playing'&&state.balls.length===0)newBall({launcher:true});},350);return;}
  if(state.balls.length>0){toast(`MULTIBALL · ${state.balls.length} BALL${state.balls.length>1?'S':''}`,700);return;}
  state.ballsRemaining-=1;updateUI();
  if(state.ballsRemaining>0){state.pendingSpawnAt=t+1100;setRibbon(`BALL ${4-state.ballsRemaining} DRAINED · NEXT BALL`);}else{state.pendingGameOverAt=t+1000;}
}

function updateTimers(dt){
  if(state.phase!=='playing'||state.paused)return;const t=now();if(controls.launch&&state.balls.some(b=>b.inLauncher)){if(!state.launchHeldAt)state.launchHeldAt=t;state.launchCharge=clamp((t-state.launchHeldAt)/1500,0,1);}else state.launchHeldAt=0;
  if(state.pendingSpawnAt&&t>=state.pendingSpawnAt){state.pendingSpawnAt=0;newBall({launcher:true});state.ballStartedAt=t;state.ballSaveUntil=0;setRibbon('HOLD SPACE · RELEASE TO LAUNCH');}
  if(state.pendingGameOverAt&&t>=state.pendingGameOverAt){state.pendingGameOverAt=0;gameOver();}
  if(state.combo&&t>state.comboUntil)state.combo=0;
  if(state.overdriveUntil&&t>state.overdriveUntil){state.overdriveUntil=0;toast('OVERDRIVE OFF',700);}
  if(state.jackpotLitUntil&&t>state.jackpotLitUntil){state.jackpotLitUntil=0;}
  state.cameraShake=Math.max(0,state.cameraShake-dt*26);updateUI();
}

function updateEffects(dt){for(const p of particles){p.life-=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=320*dt;p.vx*=.985;}for(let i=particles.length-1;i>=0;i--)if(particles[i].life<=0)particles.splice(i,1);for(const f of floats){f.life-=dt;f.y+=f.vy*dt;f.vy*=.97;}for(let i=floats.length-1;i>=0;i--)if(floats[i].life<=0)floats.splice(i,1);}

function drawGlowLine(s,alpha=1){ctx.save();ctx.lineCap='round';ctx.lineWidth=s.r*2;ctx.strokeStyle=s.color;ctx.globalAlpha=.18*alpha;ctx.shadowColor=s.color;ctx.shadowBlur=25*s.glow;ctx.beginPath();ctx.moveTo(s.x1,s.y1);ctx.lineTo(s.x2,s.y2);ctx.stroke();ctx.globalAlpha=.88*alpha;ctx.lineWidth=Math.max(2,s.r*.45);ctx.shadowBlur=9;ctx.stroke();ctx.restore();}
function pathRamp(r){ctx.save();ctx.strokeStyle=r.color;ctx.lineCap='round';ctx.lineWidth=42;ctx.globalAlpha=.08;ctx.shadowColor=r.color;ctx.shadowBlur=28;ctx.beginPath();ctx.moveTo(r.p0.x,r.p0.y);ctx.bezierCurveTo(r.p1.x,r.p1.y,r.p2.x,r.p2.y,r.p3.x,r.p3.y);ctx.stroke();ctx.lineWidth=5;ctx.globalAlpha=.55;ctx.setLineDash([16,18]);ctx.stroke();ctx.restore();}

function drawTable(t){
  ctx.fillStyle='#05030d';ctx.fillRect(0,0,W,H);
  const grad=ctx.createRadialGradient(450,760,80,450,760,900);grad.addColorStop(0,'#16102e');grad.addColorStop(.5,'#080615');grad.addColorStop(1,'#020106');ctx.fillStyle=grad;ctx.fillRect(0,0,W,H);
  ctx.save();ctx.globalAlpha=.08;ctx.strokeStyle=COLORS.violet;ctx.lineWidth=1;for(let x=0;x<W;x+=50){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}for(let y=0;y<H;y+=50){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}ctx.restore();
  pathRamp(rampPaths.left);pathRamp(rampPaths.right);
  for(const s of walls)drawGlowLine(s,.8);for(const s of slings)drawGlowLine(s,flashes.get(s.label)>t?1.8:1);
  for(const td of targets){const lit=state.rave[td.index];drawGlowLine(td.wall,lit?2:.7);ctx.save();ctx.fillStyle=lit?td.color:'#706a84';ctx.shadowColor=td.color;ctx.shadowBlur=lit?28:4;ctx.font='900 30px system-ui';ctx.textAlign='center';ctx.fillText(td.id,(td.x1+td.x2)/2,(td.y1+td.y2)/2-18);ctx.restore();}
  for(const b of bumpers){const hit=flashes.get(b.id)>t;ctx.save();ctx.translate(b.x,b.y);ctx.shadowColor=b.color;ctx.shadowBlur=hit?55:25;ctx.fillStyle=hit?'#fff':b.color;ctx.globalAlpha=hit?1:.45;ctx.beginPath();ctx.arc(0,0,b.r,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;ctx.strokeStyle=b.color;ctx.lineWidth=8;ctx.beginPath();ctx.arc(0,0,b.r+10+Math.sin(t/190+b.x)*4,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#070411';ctx.beginPath();ctx.arc(0,0,b.r*.47,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.font='900 16px system-ui';ctx.textAlign='center';ctx.fillText(b.id,0,6);ctx.restore();}
  // GIGO top lanes
  ['G','I','G','O'].forEach((letter,i)=>{const s=sensors[i];const lit=state.gigo[i];ctx.save();ctx.fillStyle=lit?COLORS.lime:'#4b4660';ctx.shadowColor=COLORS.lime;ctx.shadowBlur=lit?24:0;ctx.font='900 25px system-ui';ctx.textAlign='center';ctx.fillText(letter,s.x,s.y);ctx.restore();});
  // scoop: the only central feature, deliberately below the open mid-field corridor.
  ctx.save();ctx.translate(SCOOP.x,SCOOP.y);ctx.strokeStyle=state.lockQualified?COLORS.lime:COLORS.violet;ctx.lineWidth=7;ctx.shadowColor=state.lockQualified?COLORS.lime:COLORS.violet;ctx.shadowBlur=state.lockQualified?34:14;ctx.beginPath();ctx.arc(0,0,SCOOP.r,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#000';ctx.beginPath();ctx.arc(0,0,SCOOP.r-10,0,Math.PI*2);ctx.fill();ctx.fillStyle=state.lockQualified?COLORS.lime:'#8c7fac';ctx.font='900 13px system-ui';ctx.textAlign='center';ctx.fillText(state.lockQualified?'MULTI':'VOID',0,5);ctx.restore();
  // DMD / mode panel
  ctx.save();ctx.fillStyle='rgba(0,0,0,.42)';ctx.strokeStyle='rgba(255,43,214,.35)';ctx.lineWidth=2;roundRect(ctx,275,285,350,72,13);ctx.fill();ctx.stroke();ctx.fillStyle=state.jackpotLitUntil>t?COLORS.lime:state.overdriveUntil>t?COLORS.amber:COLORS.pink;ctx.font='900 18px ui-monospace,monospace';ctx.textAlign='center';ctx.fillText(state.jackpotLitUntil>t?'JACKPOT LIT':state.overdriveUntil>t?'NEON OVERDRIVE 2×':'GIGORAVE // PSYCHOSIS',450,316);ctx.fillStyle='#918aa9';ctx.font='700 11px ui-monospace,monospace';ctx.fillText(`COMBO ${state.combo} · TILT ${Math.round(state.tilt)}% · RAVE ${state.rave.filter(Boolean).length}/4`,450,338);ctx.restore();
  // Shooter lane centerline follows the exact rounded physical trajectory.
  ctx.save();ctx.strokeStyle=COLORS.amber;ctx.globalAlpha=.42;ctx.setLineDash([8,12]);ctx.lineWidth=3;ctx.beginPath();
  SHOOTER_TRACK.points.forEach((p,i)=>{if(i===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);});
  ctx.stroke();ctx.restore();
}
function roundRect(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();}

function drawFlipper(f){const e=flipperEndpoints(f);ctx.save();ctx.lineCap='round';ctx.strokeStyle=f.color;ctx.shadowColor=f.color;ctx.shadowBlur=f.pressed?32:16;ctx.lineWidth=f.radius*2;ctx.globalAlpha=.26;ctx.beginPath();ctx.moveTo(e.x1,e.y1);ctx.lineTo(e.x2,e.y2);ctx.stroke();ctx.globalAlpha=1;ctx.lineWidth=f.radius*1.15;ctx.stroke();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(e.x1,e.y1,6,0,Math.PI*2);ctx.fill();ctx.restore();}
function drawBall(b){
  ctx.save();for(let i=0;i<b.trail.length;i++){const p=b.trail[i],a=(i+1)/b.trail.length*.22;ctx.globalAlpha=a;ctx.fillStyle=`hsl(${b.hue} 100% 70%)`;ctx.beginPath();ctx.arc(p.x,p.y,b.r*(i+1)/b.trail.length*.8,0,Math.PI*2);ctx.fill();}
  ctx.globalAlpha=1;const g=ctx.createRadialGradient(b.x-6,b.y-8,2,b.x,b.y,b.r);g.addColorStop(0,'#fff');g.addColorStop(.25,'#d9faff');g.addColorStop(.58,`hsl(${b.hue} 90% 62%)`);g.addColorStop(1,'#151526');ctx.fillStyle=g;ctx.shadowColor=`hsl(${b.hue} 100% 65%)`;ctx.shadowBlur=18;ctx.beginPath();ctx.arc(b.x,b.y,b.r,0,Math.PI*2);ctx.fill();ctx.strokeStyle='rgba(255,255,255,.55)';ctx.lineWidth=2;ctx.stroke();ctx.restore();
}
function drawEffects(){for(const p of particles){ctx.save();ctx.globalAlpha=clamp(p.life/p.maxLife,0,1);ctx.fillStyle=p.color;ctx.shadowColor=p.color;ctx.shadowBlur=10;ctx.fillRect(p.x-p.size/2,p.y-p.size/2,p.size,p.size);ctx.restore();}for(const f of floats){ctx.save();ctx.globalAlpha=clamp(f.life/f.maxLife,0,1);ctx.fillStyle=f.color;ctx.shadowColor=f.color;ctx.shadowBlur=15;ctx.font=`900 ${f.size}px system-ui`;ctx.textAlign='center';ctx.fillText(f.text,f.x,f.y);ctx.restore();}}

function render(t){
  const dpr=clamp(window.devicePixelRatio||1,1,2);const rect=canvas.getBoundingClientRect();const desiredW=Math.max(1,Math.round(rect.width*dpr)),desiredH=Math.max(1,Math.round(rect.height*dpr));if(canvas.width!==desiredW||canvas.height!==desiredH){canvas.width=desiredW;canvas.height=desiredH;}
  const sx=canvas.width/W,sy=canvas.height/H,s=Math.min(sx,sy);const ox=(canvas.width-W*s)/2,oy=(canvas.height-H*s)/2;ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#020106';ctx.fillRect(0,0,canvas.width,canvas.height);const shake=state.cameraShake?rand(-state.cameraShake,state.cameraShake):0;ctx.setTransform(s,0,0,s,ox+shake,oy+shake*.55);drawTable(t);for(const f of flippers)drawFlipper(f);for(const b of state.balls){b.trail.push({x:b.x,y:b.y});if(b.trail.length>13)b.trail.shift();drawBall(b);}drawEffects();
}

let last=performance.now(),acc=0;
function frame(ts){const frameDt=Math.min(MAX_FRAME_DT,(ts-last)/1000||0);last=ts;if(!state.paused){acc+=frameDt;let steps=0;while(acc>=FIXED_DT&&steps<12){physicsStep(FIXED_DT);updateTimers(FIXED_DT);updateEffects(FIXED_DT);acc-=FIXED_DT;steps++;}if(steps>=12)acc=0;}render(ts);requestAnimationFrame(frame);}
requestAnimationFrame(frame);

function keyDown(e){
  const k=e.key.toLowerCase();if(['arrowleft','arrowright',' ','arrowup','arrowdown'].includes(k))e.preventDefault();synth.unlock();
  if(k==='a'||k==='arrowleft'){if(!controls.left)synth.click(-1);controls.left=true;}
  if(k==='d'||k==='arrowright'){if(!controls.right)synth.click(1);controls.right=true;}
  if(k===' '||k==='arrowdown'){if(!controls.launch){controls.launch=true;state.launchHeldAt=now();}}
  if(k==='q')nudge(-165,-30);if(k==='e')nudge(165,-30);if(k==='w'||k==='arrowup')nudge(0,-170);
  if((k==='p'||k==='escape')&&!e.repeat)togglePause();if(k==='r'&&state.phase==='gameover')startGame();
}
function keyUp(e){const k=e.key.toLowerCase();if(k==='a'||k==='arrowleft')controls.left=false;if(k==='d'||k==='arrowright')controls.right=false;if(k===' '||k==='arrowdown'){if(controls.launch)launchBall();controls.launch=false;state.launchHeldAt=0;}}
window.addEventListener('keydown',keyDown,{passive:false});window.addEventListener('keyup',keyUp,{passive:false});

function releaseHeldControls({ launch = false } = {}) {
  if (launch && controls.launch) launchBall();
  controls.left = false;
  controls.right = false;
  controls.launch = false;
  state.launchHeldAt = 0;
}

// Focus changes must never create a fake pause screen. If Space/LAUNCH was held,
// release the plunger before dropping the controls so a lost keyup cannot trap the ball.
window.addEventListener('blur',()=>releaseHeldControls({ launch: true }));
document.addEventListener('visibilitychange',()=>{if(document.hidden)releaseHeldControls({ launch: true });});
try{tg?.onEvent?.('deactivated',()=>releaseHeldControls({ launch: true }));}catch{}

for(const el of document.querySelectorAll('[data-control]')){
  const name=el.dataset.control;
  const down=(ev)=>{ev.preventDefault();synth.unlock();el.classList.add('active');if(name==='left'){controls.left=true;synth.click(-1);}if(name==='right'){controls.right=true;synth.click(1);}if(name==='launch'){controls.launch=true;state.launchHeldAt=now();}if(name==='nudge-left')nudge(-165,-40);if(name==='nudge-right')nudge(165,-40);try{el.setPointerCapture?.(ev.pointerId);}catch{}};
  const up=(ev)=>{ev.preventDefault();el.classList.remove('active');if(name==='left')controls.left=false;if(name==='right')controls.right=false;if(name==='launch'){if(controls.launch)launchBall();controls.launch=false;state.launchHeldAt=0;}};
  el.addEventListener('pointerdown',down);el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up);el.addEventListener('pointerleave',(e)=>{if(e.buttons===0)up(e);});
  // Click is a harmless fallback for browsers/WebViews that lose pointer capture.
  if(name==='launch')el.addEventListener('click',()=>{if(state.balls.some((b)=>b.inLauncher))launchBall();});
}

$('startButton').addEventListener('click',startGame);$('restartButton').addEventListener('click',startGame);$('resumeButton').addEventListener('click',()=>togglePause(false));
$('leaderboardButton').addEventListener('click',()=>void showLeaderboard());$('gameOverLeaderboard').addEventListener('click',()=>void showLeaderboard());$('closeLeaderboard').addEventListener('click',()=>ui.leaderboard.classList.remove('open'));

async function fetchJson(path, options={}){const url=new URL(path,location.href);const r=await fetch(url,{...options,headers:{'content-type':'application/json',...(options.headers||{})}});let body={};try{body=await r.json();}catch{}if(!r.ok)throw new Error(body?.error||`HTTP ${r.status}`);return body;}
async function initRemote(){
  const initData=tg?.initData||'';if(!initData){ui.auth.textContent='Рекорды: локально (открой игру из Telegram для онлайн-таблицы)';return;}
  try{const res=await fetchJson('./api/session',{method:'POST',body:JSON.stringify({initData})});state.sessionToken=res.sessionToken||'';state.remoteAuthenticated=Boolean(res.sessionToken);state.remoteUser=res.user||null;ui.auth.textContent=state.remoteAuthenticated?`Telegram: ${res.user?.username?`@${res.user.username}`:res.user?.firstName||'авторизован'} · онлайн-рекорды включены`:'Telegram: локальный режим';}
  catch(e){ui.auth.textContent=`Онлайн-рекорды недоступны: ${e.message}`;}
}
void initRemote();

async function showLeaderboard(){ui.leaderboard.classList.add('open');ui.leaderboardList.innerHTML='<li><span class="player">Загрузка…</span><span></span></li>';try{const data=await fetchJson('./api/leaderboard',{method:'GET',headers:{}});const rows=data.rows||[];ui.leaderboardList.innerHTML=rows.length?rows.map(r=>`<li><span class="player">${escapeHtml(r.name||'PLAYER')}</span><span class="points">${fmt(r.score)}</span></li>`).join(''):'<li><span class="player">Пока пусто. Будь первым.</span><span></span></li>';ui.leaderboardNote.textContent=data.note||'';}catch(e){ui.leaderboardList.innerHTML='<li><span class="player">Онлайн-таблица недоступна</span><span></span></li>';ui.leaderboardNote.textContent=e.message;}}
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
async function submitScore({durationMs}){if(state.submitted)return;state.submitted=true;if(!state.sessionToken)return;try{const data=await fetchJson('./api/score',{method:'POST',body:JSON.stringify({sessionToken:state.sessionToken,score:Math.round(state.score),durationMs,stats:{maxCombo:state.maxCombo,maxMultiplier:state.maxMultiplier,bumpers:state.bumpers,ramps:state.ramps,jackpots:state.jackpots,multiballs:state.multiballs,nudges:state.nudges}})});if(data.accepted)toast(`ONLINE RANK #${data.rank||'?'} · ${fmt(state.score)}`,2600);else toast(`Счёт не принят: ${data.reason||'validation'}`,2200);}catch(e){toast(`Онлайн-счёт: ${e.message}`,1800);}}

// Read-only smoke-test hook. It intentionally exposes no mutation methods.
Object.defineProperty(window, '__gigoravePinballDebug', {
  configurable: false,
  enumerable: false,
  value: Object.freeze({
    snapshot: () => ({
      phase: state.phase, paused: state.paused, score: state.score,
      ballsRemaining: state.ballsRemaining,
      balls: state.balls.map((b) => ({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, inLauncher: b.inLauncher, onShooterPath: Boolean(b.shooterMotion), shooterS: b.shooterMotion?.s ?? null, shooterV: b.shooterMotion?.v ?? null })),
    }),
  }),
});

// Attract-mode particles before the first game.
setInterval(()=>{if(state.phase==='idle'&&particles.length<35)burst(rand(140,760),rand(300,1200),Math.random()<.5?COLORS.pink:COLORS.cyan,4,100);},650);
