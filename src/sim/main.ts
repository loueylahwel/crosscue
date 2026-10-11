import { SimScene } from './scene';
import { Sim, type Input } from './sim';
import { Ui } from './ui';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const sim = new Sim();
const scene = new SimScene(canvas, sim);
const panel = document.getElementById('panel')!;
const ui = new Ui(sim, scene, panel);
if (window.innerWidth < 760) panel.classList.add('collapsed');

// ---- input ------------------------------------------------------------------------------------

const keys = new Set<string>();
const isTyping = (e: Event) => e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && e.target.type !== 'range';

window.addEventListener('keydown', (e) => {
  if (isTyping(e)) return;
  if (e.code === 'Tab') {
    e.preventDefault();
    ui.swapView();
    return;
  }
  if (e.code === 'Space') {
    e.preventDefault();
    sim.params.paused = !sim.params.paused;
    return;
  }
  if (e.code === 'KeyR') sim.reset();
  if (/^Digit[1-4]$/.test(e.code)) sim.controlled = Number(e.code.slice(5)) - 1;
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

let drag: { x: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const v = sim.viewer;
  if (v.alive) v.yaw -= (e.clientX - drag.x) * 0.004; // drag right = turn right = yaw decreases
  drag.x = e.clientX;
});
canvas.addEventListener('pointerup', () => (drag = null));

function readInput(): Input {
  const down = (...codes: string[]) => (codes.some((c) => keys.has(c)) ? 1 : 0);
  return {
    forward: down('KeyW', 'ArrowUp') - down('KeyS', 'ArrowDown'),
    strafe: down('KeyD') - down('KeyA'),
    turn: down('KeyQ', 'ArrowLeft') - down('KeyE', 'ArrowRight'),
  };
}

// ---- main loop --------------------------------------------------------------------------------

function resize(): void {
  scene.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', resize);
resize();

const STEP = 1 / 60;
let last = performance.now();
let acc = 0;

function frame(nowMs: number): void {
  const dt = Math.min(0.1, (nowMs - last) / 1000);
  last = nowMs;
  acc += dt;
  const input = readInput();
  while (acc >= STEP) {
    sim.step(STEP, input);
    acc -= STEP;
  }
  scene.leftInset = window.innerWidth >= 760 ? Math.round(panel.getBoundingClientRect().right + 8) : 0;
  const labels = scene.sync();
  scene.render();
  ui.update(labels, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy from the browser console: __sim.run(5) fast-forwards 5 simulated seconds.
(window as unknown as { __sim: unknown }).__sim = sim;
