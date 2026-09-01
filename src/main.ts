import './style.css';
import { Game } from './game/game';
import { TIERS } from './game/tiers';
import { View } from './render/scene';
import { randomSeedWord } from './core/rng';
import { COVERED, FLAGGED } from './core/grid';
import { isDiggable } from './core/board';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('stage');
const menu = $('menu');
const busy = $('busy');
const end = $('end');
const hud = $('hud');
const bar = $('bar');
const labels = $('labels');
const toastEl = $('toast');

type Mode = 'dig' | 'flag' | 'sonar';

let game: Game | null = null;
let view: View | null = null;
let mode: Mode = 'dig';
let selectedTier = 'deepcore';
let toastTimer = 0;

/* ---------------- menu ---------------- */

const tierPick = $('tier-pick');
for (const t of TIERS) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tier';
  btn.setAttribute('role', 'radio');
  btn.setAttribute('aria-checked', String(t.id === selectedTier));
  btn.innerHTML = `<b>${t.name}</b><span>${t.n}³ · ${t.cores} cores · ${t.hull} hull</span>`;
  btn.addEventListener('click', () => {
    selectedTier = t.id;
    for (const el of tierPick.children) el.setAttribute('aria-checked', String(el === btn));
  });
  tierPick.appendChild(btn);
}

const seedInput = $<HTMLInputElement>('seed-input');
seedInput.value = randomSeedWord();
$('btn-reroll').addEventListener('click', () => { seedInput.value = randomSeedWord(); });
$('btn-start').addEventListener('click', () => start(selectedTier, seedInput.value.trim() || randomSeedWord()));
$('btn-again').addEventListener('click', () => { end.hidden = true; menu.hidden = false; seedInput.value = randomSeedWord(); });
$('btn-retry').addEventListener('click', () => { if (game) start(game.tier.id, game.seedText); });
$('btn-quit').addEventListener('click', () => { end.hidden = true; menu.hidden = false; });

/* ---------------- lifecycle ---------------- */

function start(tierId: string, seed: string): void {
  menu.hidden = true;
  end.hidden = true;
  busy.hidden = false;
  // Yield two frames so the spinner actually paints before generation blocks
  // the main thread searching for a board that reads without guessing.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    game = new Game(tierId, seed);
    if (!view) view = new View(canvas, game);
    else view.setGame(game);
    view.resize();
    mode = 'dig';
    syncTools();
    busy.hidden = true;
    hud.hidden = false;
    bar.hidden = false;
    $('tier-name').textContent = game.tier.name;
    $('seed-label').textContent = `seed · ${game.seedText}`;
    refresh();
    // Small inspection hook: lets the browser smoke test assert against real
    // board state rather than scraping the HUD, and is handy in the console.
    (window as unknown as { chondrite: unknown }).chondrite = { game, view };
    toast(game.generatedClean
      ? 'Every core is reachable by deduction on this rock. No guessing required.'
      : 'This rock has a stubborn patch. Hint is there if it stalls.', game.generatedClean ? 'good' : 'warn');
  }));
}

function toast(text: string, kind: 'info' | 'warn' | 'good' = 'info'): void {
  toastEl.textContent = text;
  toastEl.className = `toast ${kind === 'info' ? '' : kind}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toastEl.hidden = true; }, 4200);
}

function refresh(): void {
  if (!game) return;
  $('stat-cores').textContent = `${game.coresExtracted}/${game.coresTotal}`;
  $('stat-pings').textContent = String(game.charges);
  $('stat-mines').textContent = String(game.minesLeft);
  $('stat-score').textContent = String(game.score);
  const pips = $('stat-hull');
  pips.className = 'pips';
  pips.innerHTML = '';
  for (let i = 0; i < game.tier.hull; i++) {
    const pip = document.createElement('i');
    if (i < game.hull) pip.className = 'on';
    pips.appendChild(pip);
  }
  view?.markDirty();
}

function finish(): void {
  if (!game) return;
  const won = game.phase === 'won';
  $('end-kicker').textContent = won ? 'Extraction complete' : 'Run ended';
  $('end-title').textContent = won ? 'Cores are out.' : 'The rock won.';
  $('end-reason').textContent = game.endReason;
  const secs = Math.round(game.elapsedMs / 1000);
  const rows: [string, string][] = [
    ['Score', String(game.score)],
    ['Cores', `${game.coresExtracted} / ${game.coresTotal}`],
    ['Cells cleared', String(game.revealedCount)],
    ['Time', `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`],
    ['Hull left', `${Math.max(0, game.hull)} / ${game.tier.hull}`],
    ['Seed', game.seedText],
  ];
  $('end-stats').innerHTML = rows
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');
  end.hidden = false;
}

/* ---------------- tools ---------------- */

function syncTools(): void {
  $('btn-flag').setAttribute('aria-pressed', String(mode === 'flag'));
  $('btn-sonar').setAttribute('aria-pressed', String(mode === 'sonar'));
  $('btn-xray').setAttribute('aria-pressed', String(view?.xray ?? false));
  if (view && mode !== 'sonar') { view.sonarPreview = null; view.markDirty(); }
}

function setMode(next: Mode): void {
  mode = mode === next ? 'dig' : next;
  syncTools();
}

$('btn-flag').addEventListener('click', () => setMode('flag'));
$('btn-sonar').addEventListener('click', () => setMode('sonar'));
$('btn-xray').addEventListener('click', () => { if (view) { view.xray = !view.xray; view.markDirty(); syncTools(); } });
$('btn-hint').addEventListener('click', useHint);

function useHint(): void {
  if (!game || !view || game.phase !== 'playing') return;
  const cell = game.hint();
  if (cell === null) {
    toast('Nothing is provable from what is exposed right now. Spend a ping.', 'warn');
    return;
  }
  applyDig(cell);
  toast('Hint dug. −100 score.', 'warn');
}

/* ---------------- interaction ---------------- */

function applyDig(cell: number): void {
  if (!game || !view) return;
  const before = game.coresExtracted;
  const out = game.dig(cell);
  if (out.kind === 'illegal') return;

  if (out.kind === 'detonated') {
    for (const i of out.blast.detonated) view.addShockwave(i);
    game.settle();
    if (game.phase === 'lost') {
      toast(game.endReason, 'warn');
    } else {
      toast(`Detonation. ${out.blast.destroyed.length} cells gone, hull at ${game.hull}.`, 'warn');
    }
  } else if (out.kind === 'extracted' && game.coresExtracted > before) {
    toast(`Core extracted — ${game.coresExtracted} of ${game.coresTotal}. +2 pings.`, 'good');
  }
  refresh();
  if (game.phase !== 'playing') setTimeout(finish, out.kind === 'detonated' ? 700 : 350);
}

function applyFlag(cell: number): void {
  if (!game || !view) return;
  const b = game.board;
  if (b.state[cell] !== FLAGGED && !isDiggable(b, cell)) return;
  if (b.state[cell] !== COVERED && b.state[cell] !== FLAGGED) return;
  game.flag(cell);
  refresh();
}

function applySonar(cell: number): void {
  if (!game || !view) return;
  const axis = view.cameraAxis();
  const before = game.charges;
  const value = game.ping(cell, axis);
  if (value === null) {
    toast('No pings left. Clear 40 more cells to earn one.', 'warn');
    return;
  }
  const name = 'XYZ'[axis];
  toast(before === game.charges
    ? `Already pinged that ${name} line: ${value} mines.`
    : `${name} line reads ${value} ${value === 1 ? 'mine' : 'mines'}.`);
  mode = 'dig';
  syncTools();
  refresh();
}

let downX = 0, downY = 0, downBtn = 0, dragged = false;

canvas.addEventListener('pointerdown', (e) => {
  downX = e.clientX; downY = e.clientY; downBtn = e.button; dragged = false;
  canvas.classList.add('grabbing');
});

canvas.addEventListener('pointermove', (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) dragged = true;
  if (!view || !game || game.phase !== 'playing') return;
  const cell = view.cellAt(e.clientX, e.clientY);
  view.setHover(cell);
  if (mode === 'sonar') {
    const next = cell >= 0 ? { cell, axis: view.cameraAxis() } : null;
    const cur = view.sonarPreview;
    if ((next?.cell ?? -1) !== (cur?.cell ?? -1) || (next?.axis ?? -1) !== (cur?.axis ?? -1)) {
      view.sonarPreview = next;
      view.markDirty();
    }
  }
});

canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('grabbing');
  if (dragged || !view || !game || game.phase !== 'playing') return;
  const cell = view.cellAt(e.clientX, e.clientY);
  if (cell < 0) return;
  if (mode === 'sonar') applySonar(cell);
  else if (downBtn === 2 || mode === 'flag' || e.shiftKey) applyFlag(cell);
  else applyDig(cell);
});

canvas.addEventListener('pointerleave', () => { view?.setHover(-1); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Long press on touch flags, so mobile keeps both verbs without a mode switch.
let pressTimer = 0;
canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  const t = e.touches[0]!;
  pressTimer = window.setTimeout(() => {
    if (dragged || !view || !game || game.phase !== 'playing') return;
    const cell = view.cellAt(t.clientX, t.clientY);
    if (cell >= 0) { applyFlag(cell); dragged = true; navigator.vibrate?.(18); }
  }, 420);
}, { passive: true });
for (const ev of ['touchend', 'touchmove', 'touchcancel']) {
  canvas.addEventListener(ev, () => clearTimeout(pressTimer), { passive: true });
}

window.addEventListener('keydown', (e) => {
  if (!view || !game) return;
  if (e.target instanceof HTMLInputElement) return;
  switch (e.key) {
    case '1': view.snapToAxis(0); break;
    case '2': view.snapToAxis(1); break;
    case '3': view.snapToAxis(2); break;
    case '[': view.peel = Math.max(0, view.peel - 1); view.markDirty(); break;
    case ']': view.peel = Math.min(Math.ceil(game.board.grid.n / 2), view.peel + 1); view.markDirty(); break;
    case 'f': case 'F': setMode('flag'); break;
    case 's': case 'S': setMode('sonar'); break;
    case 'h': case 'H': useHint(); break;
    case 'x': case 'X': view.xray = !view.xray; view.markDirty(); syncTools(); break;
    case ' ':
      e.preventDefault();
      if (!view.xray) { view.xray = true; view.markDirty(); syncTools(); }
      break;
    case 'Escape': if (mode !== 'dig') { mode = 'dig'; syncTools(); } break;
    default: return;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === ' ' && view?.xray) { view.xray = false; view.markDirty(); syncTools(); }
});

window.addEventListener('resize', () => view?.resize());

/* ---------------- frame loop ---------------- */

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (view && game) {
    view.render(dt);
    if (game.phase === 'playing') {
      const secs = Math.floor(game.elapsedMs / 1000);
      $('stat-time').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    }
    const marks = view.sonarLabels();
    while (labels.children.length > marks.length) labels.lastElementChild!.remove();
    while (labels.children.length < marks.length) {
      const d = document.createElement('div');
      d.className = 'slab';
      labels.appendChild(d);
    }
    marks.forEach((m, i) => {
      const el = labels.children[i] as HTMLElement;
      el.style.display = m.visible ? 'block' : 'none';
      el.style.left = `${m.x}px`;
      el.style.top = `${m.y}px`;
      el.textContent = m.text;
    });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
