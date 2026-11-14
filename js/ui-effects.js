const header = document.querySelector('.top');
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--header-offset', `${Math.ceil(header.getBoundingClientRect().height) + 12}px`);
}).observe(header);

const starfield = document.getElementById('starfield');

// A seeded decorative field keeps the backdrop stable between visits.
let seed = 731;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

for (let depth = 1; depth <= 3; depth++) {
  const layer = document.createElement('div');
  layer.className = 'star-layer';
  layer.style.setProperty('--depth', String(depth));
  for (let i = 0; i < 48; i++) {
    const star = document.createElement('span');
    star.className = 'star' + (depth === 3 && i % 12 === 0 ? ' beacon' : '');
    star.style.left = `${random() * 100}%`;
    star.style.top = `${random() * 100}%`;
    star.style.setProperty('--size', `${depth === 3 ? 2 : 1}px`);
    star.style.setProperty('--brightness', String(.2 + random() * .5));
    layer.appendChild(star);
  }
  starfield.appendChild(layer);
}

const demo = document.getElementById('motionDemo');
const slider = document.getElementById('demoSlider');
const reveal = document.getElementById('demoReveal');

function updateDemo() {
  const before = Number(slider.value);
  demo.style.setProperty('--reveal', `${before}%`);
  slider.setAttribute('aria-valuetext', `${before}% before, ${100 - before}% after`);
  demo.querySelector('.demo-epoch-before').hidden = before < 12;
  demo.querySelector('.demo-epoch-after').hidden = before > 88;
}

slider.addEventListener('input', updateDemo);
const scene = demo.querySelector('.demo-scene');
function scrubDemo(event) {
  const { left, width } = scene.getBoundingClientRect();
  slider.value = String(Math.round(100 * (event.clientX - left) / width));
  updateDemo();
}

scene.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  scene.setPointerCapture(event.pointerId);
  scrubDemo(event);
});
scene.addEventListener('pointermove', event => {
  if (scene.hasPointerCapture(event.pointerId)) scrubDemo(event);
});
scene.addEventListener('pointerup', event => {
  if (scene.hasPointerCapture(event.pointerId)) scene.releasePointerCapture(event.pointerId);
});
reveal.addEventListener('click', () => {
  const shown = demo.classList.toggle('show-answer');
  reveal.setAttribute('aria-pressed', String(shown));
  reveal.textContent = shown ? 'Hide markers' : 'Show me';
});
updateDemo();

const motion = matchMedia('(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)');
const dock = document.querySelector('.observatory-dock');
const dockProperties = ['--dock-glow-x', '--dock-glow-y', '--dock-drift-x', '--dock-drift-y', '--dock-turn', '--mark-x', '--mark-y', '--mark-turn'];
let dockActive = false;
let pendingFrame = 0;
let pointer = null;

function resetDock() {
  if (!dockActive) return;
  for (const property of dockProperties) dock.style.removeProperty(property);
  dock.classList.remove('is-tracking');
  dockActive = false;
}

function reset() {
  cancelAnimationFrame(pendingFrame);
  pendingFrame = 0;
  pointer = null;
  starfield.style.removeProperty('--star-x');
  starfield.style.removeProperty('--star-y');
  resetDock();
}

function update() {
  pendingFrame = 0;
  const { x, y, overDock } = pointer;
  const rect = overDock ? dock.getBoundingClientRect() : null;
  starfield.style.setProperty('--star-x', `${(x / innerWidth - .5) * -10}px`);
  starfield.style.setProperty('--star-y', `${(y / innerHeight - .5) * -10}px`);
  if (!rect) { resetDock(); return; }
  const nx = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  const ny = Math.max(0, Math.min(1, (y - rect.top) / rect.height));
  dock.style.setProperty('--dock-glow-x', `${nx * 100}%`);
  dock.style.setProperty('--dock-glow-y', `${ny * 100}%`);
  dock.style.setProperty('--dock-drift-x', `${(nx - .5) * 12}px`);
  dock.style.setProperty('--dock-drift-y', `${(ny - .5) * 6}px`);
  dock.style.setProperty('--dock-turn', `${(nx - .5) * .8}deg`);
  dock.style.setProperty('--mark-x', `${(nx - .5) * 5}px`);
  dock.style.setProperty('--mark-y', `${(ny - .5) * 5}px`);
  dock.style.setProperty('--mark-turn', `${(nx - .5) * 24}deg`);
  dock.classList.add('is-tracking');
  dockActive = true;
}

document.addEventListener('pointermove', event => {
  if (!motion.matches || event.pointerType !== 'mouse') return;
  pointer = { x: event.clientX, y: event.clientY, overDock: dock.contains(event.target) };
  if (!pendingFrame) pendingFrame = requestAnimationFrame(update);
}, { passive: true });

document.documentElement.addEventListener('pointerleave', reset);
dock.addEventListener('pointerleave', () => {
  if (pointer) pointer.overDock = false;
  resetDock();
});
document.addEventListener('pointercancel', reset);
window.addEventListener('blur', reset);
window.addEventListener('scroll', reset, { passive: true });
motion.addEventListener('change', reset);
