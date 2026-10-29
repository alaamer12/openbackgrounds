<template>
  <div ref="holderRef" class="absolute inset-0 pointer-events-none">
    <canvas ref="canvasRef" class="block w-full h-full" />
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";

const holderRef = ref(null);
const canvasRef = ref(null);

const fpsMeter = useFpsMeter();

const config = {
  maxDpr: 1.5,
  // Persistence rather than a clean repaint: the buffer is eroded toward the
  // phosphor's resting colour each frame, which is what leaves the short comet
  // tail behind the sweep. The rate is high enough that the ground returns to a
  // genuinely black-green in well under a second.
  fade: "rgba(4, 12, 10, 0.1)",
  emitEvery: 42,
  ringLife: 250,
  ringAlpha: 0.32,
  ringWidth: 1.9,
  echo: 0.974,
  ringHue: 163,
  sweepSpeed: 0.0125,
  sweepSpan: 1.15,
  sweepSteps: 26,
  sweepAlpha: 0.062,
  edgeAlpha: 0.8,
  innerR: 0.05,
  blipArea: 15000,
  minBlips: 26,
  maxBlips: 190,
  blipDecay: 0.9925,
  blipMin: 0.03,
  blipRing: 0.3,
  blipSweep: 1,
  clutter: 18,
  gridRings: 4,
  gridSpokes: 12,
  gridAlpha: 0.13,
  bezelAlpha: 0.2,
  warmup: 180,
};

const TAU = Math.PI * 2;

let ctx = null;
let sprite = null;
let blips = [];
let rings = [];
let frameId = null;
let frame = 0;
let sweep = 0;
let width = 0;
let height = 0;
let cx = 0;
let cy = 0;
let gridR = 100;
let maxR = 200;

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const makeBlipGlow = () => {
  const size = 64;
  const half = size / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const s = canvas.getContext("2d");
  if (!s) return canvas;

  const glow = s.createRadialGradient(half, half, 0, half, half, half);
  glow.addColorStop(0, "rgba(198, 255, 232, 0.95)");
  glow.addColorStop(0.14, "rgba(96, 255, 208, 0.5)");
  glow.addColorStop(0.4, "rgba(34, 214, 168, 0.14)");
  glow.addColorStop(0.72, "rgba(18, 140, 118, 0.03)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  s.fillStyle = glow;
  s.fillRect(0, 0, size, size);

  return canvas;
};

const buildBlips = () => {
  const count = clamp(
    Math.round((width * height) / config.blipArea),
    config.minBlips,
    config.maxBlips,
  );

  blips = [];
  for (let i = 0; i < count; i += 1) {
    // Uniform over the disc rather than over the radius, and a weight per
    // target so the field has primary returns and faint ones.
    const angle = Math.random() * TAU;
    const radius = maxR * Math.sqrt(Math.random()) * 0.97;

    blips.push({
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      angle,
      radius,
      charge: Math.random(),
      weight: rand(0.4, 1),
      size: rand(2.1, 3.6),
    });
  }
};

const crossed = (angle, from, to) => {
  const span = (((to - from) % TAU) + TAU) % TAU;
  const rel = (((angle - from) % TAU) + TAU) % TAU;
  return rel <= span;
};

const emitRing = () => {
  rings.push({
    age: 0,
    hue: config.ringHue + rand(-12, 16),
    weight: rand(0.72, 1),
  });
};

const advance = () => {
  const previous = sweep;
  sweep = (frame * config.sweepSpeed) % TAU;

  if (frame % config.emitEvery === 0) emitRing();

  for (let i = rings.length - 1; i >= 0; i -= 1) {
    rings[i].age += 1;
    if (rings[i].age > config.ringLife) rings.splice(i, 1);
  }

  for (const b of blips) {
    b.charge *= config.blipDecay;

    if (crossed(b.angle, previous, sweep)) b.charge = config.blipSweep;

    // The emitted pulse also grazes every target it runs over, which gives the
    // whole field a soft breathing ring of returns between sweeps.
    for (const ring of rings) {
      const r = (ring.age / config.ringLife) * maxR;
      if (Math.abs(r - b.radius) < 3.2) {
        b.charge = Math.max(b.charge, config.blipRing * ring.weight);
      }
    }
  }
};

const paintGrid = () => {
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = `hsla(162, 62%, 26%, ${config.gridAlpha})`;

  for (let i = 1; i <= config.gridRings; i += 1) {
    const r = (gridR * i) / config.gridRings;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();
  }

  ctx.beginPath();
  for (let i = 0; i < config.gridSpokes; i += 1) {
    const angle = (i / config.gridSpokes) * TAU;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * gridR, cy + Math.sin(angle) * gridR);
  }
  ctx.stroke();

  // Bezel ticks: the shortest possible cue that this is an instrument and not
  // an abstract circle pattern.
  ctx.strokeStyle = `hsla(162, 62%, 32%, ${config.bezelAlpha})`;
  ctx.beginPath();
  for (let i = 0; i < 72; i += 1) {
    const angle = (i / 72) * TAU;
    const long = i % 6 === 0;
    const inner = gridR * (long ? 1.02 : 1.055);
    const outer = gridR * (long ? 1.085 : 1.075);
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
  }
  ctx.stroke();
};

const paintRings = () => {
  for (const ring of rings) {
    const t = ring.age / config.ringLife;
    const radius = t * maxR;
    if (radius < 1) continue;

    const alpha = config.ringAlpha * ring.weight * Math.pow(1 - t, 1.15);
    if (alpha < 0.004) continue;

    ctx.lineWidth = Math.max(1.2, config.ringWidth * (1 - t * 0.45));
    ctx.strokeStyle = `hsla(${ring.hue}, 100%, ${64 - t * 12}%, ${alpha})`;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.stroke();

    // A faint echo just inside the wavefront keeps a single ring from reading
    // as a static circle as it expands.
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = `hsla(${ring.hue + 10}, 100%, 70%, ${alpha * 0.3})`;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * config.echo, 0, TAU);
    ctx.stroke();
  }
};

const paintSweep = () => {
  const inner = gridR * config.innerR;

  for (let i = 0; i < config.sweepSteps; i += 1) {
    const a0 = sweep - (config.sweepSpan * i) / config.sweepSteps;
    const a1 = sweep - (config.sweepSpan * (i + 1)) / config.sweepSteps;
    const k = Math.pow(1 - i / config.sweepSteps, 2.3);
    const outerX = cx + Math.cos(a0) * maxR;
    const outerY = cy + Math.sin(a0) * maxR;

    ctx.fillStyle = `hsla(166, 100%, ${50 + 16 * k}%, ${config.sweepAlpha * k})`;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a0) * inner, cy + Math.sin(a0) * inner);
    ctx.lineTo(outerX, outerY);
    // Angles decrease from a0 to a1, so the tail is drawn anticlockwise.
    ctx.arc(cx, cy, maxR, a0, a1, true);
    ctx.lineTo(cx + Math.cos(a1) * inner, cy + Math.sin(a1) * inner);
    ctx.closePath();
    ctx.fill();
  }

  const edgeX = cx + Math.cos(sweep) * maxR;
  const edgeY = cy + Math.sin(sweep) * maxR;
  const edge = ctx.createLinearGradient(cx, cy, edgeX, edgeY);
  edge.addColorStop(0, `hsla(168, 100%, 82%, ${config.edgeAlpha})`);
  edge.addColorStop(0.45, `hsla(164, 100%, 68%, ${config.edgeAlpha * 0.55})`);
  edge.addColorStop(1, "hsla(160, 100%, 60%, 0.06)");

  ctx.strokeStyle = edge;
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(edgeX, edgeY);
  ctx.stroke();
};

const paintBlips = () => {
  for (const b of blips) {
    // A discharged target is not drawn at all: with persistence on, even a
    // tiny per-frame deposit amplifies into a standing glow, which would erase
    // the difference between a lit return and a cold one.
    if (b.charge < config.blipMin) continue;

    const glow = b.size * (5.2 + b.charge * 7.4);

    ctx.globalAlpha = clamp(b.charge * 0.66 * b.weight, 0, 0.85);
    ctx.drawImage(sprite, b.x - glow / 2, b.y - glow / 2, glow, glow);

    // The marker itself is a hard diamond: the crisp centre against the soft
    // bloom is what makes it read as a return rather than a dust mote.
    ctx.globalAlpha = clamp(b.charge * 0.9, 0, 0.96);
    ctx.fillStyle = "rgb(226, 255, 240)";
    ctx.beginPath();
    ctx.moveTo(b.x, b.y - b.size);
    ctx.lineTo(b.x + b.size, b.y);
    ctx.lineTo(b.x, b.y + b.size);
    ctx.lineTo(b.x - b.size, b.y);
    ctx.closePath();
    ctx.fill();
  }

  ctx.globalAlpha = 1;
};

const paintClutter = () => {
  ctx.fillStyle = "hsla(170, 90%, 72%, 0.05)";
  for (let i = 0; i < config.clutter; i += 1) {
    const angle = Math.random() * TAU;
    const radius = maxR * Math.sqrt(Math.random());
    ctx.fillRect(
      cx + Math.cos(angle) * radius,
      cy + Math.sin(angle) * radius,
      1.4,
      1.4,
    );
  }
};

const paintOrigin = () => {
  ctx.fillStyle = "hsla(160, 100%, 88%, 0.85)";
  ctx.beginPath();
  ctx.arc(cx, cy, 2.2, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = "hsla(162, 90%, 60%, 0.4)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(cx, cy, 7, 0, TAU);
  ctx.stroke();
};

const paintBezelShadow = () => {
  const radius = Math.hypot(width, height) * 0.62;
  const shadow = ctx.createRadialGradient(
    cx,
    cy,
    radius * 0.34,
    cx,
    cy,
    radius,
  );
  shadow.addColorStop(0, "rgba(1, 4, 4, 0)");
  shadow.addColorStop(1, "rgba(1, 4, 4, 0.6)");
  ctx.fillStyle = shadow;
  ctx.fillRect(0, 0, width, height);
};

const drawFrame = () => {
  frame += 1;
  if (!ctx || !sprite || width < 2 || height < 2) return;

  advance();

  ctx.fillStyle = config.fade;
  ctx.fillRect(0, 0, width, height);

  // Everything luminous that moves is additive; anything fixed is drawn
  // source-over, because the persistence loop would otherwise amplify a
  // standing element tenfold and burn a hole in the tube.
  paintGrid();

  ctx.globalCompositeOperation = "lighter";
  paintRings();
  paintSweep();
  paintBlips();
  paintClutter();
  ctx.globalCompositeOperation = "source-over";

  paintOrigin();
  paintBezelShadow();
};

const step = () => {
  fpsMeter.tick();
  drawFrame();
  frameId = requestAnimationFrame(step);
};

const resize = () => {
  if (!holderRef.value || !canvasRef.value || !ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, config.maxDpr);
  width = holderRef.value.offsetWidth || window.innerWidth;
  height = holderRef.value.offsetHeight || window.innerHeight;

  canvasRef.value.width = Math.max(1, Math.floor(width * dpr));
  canvasRef.value.height = Math.max(1, Math.floor(height * dpr));
  canvasRef.value.style.width = `${width}px`;
  canvasRef.value.style.height = `${height}px`;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  cx = width * 0.5;
  cy = height * 0.5;
  gridR = Math.min(width, height) * 0.42;
  maxR = Math.hypot(width, height) * 0.56;

  rings = [];
  buildBlips();

  ctx.fillStyle = "#020605";
  ctx.fillRect(0, 0, width, height);
};

const onResize = () => resize();

onMounted(() => {
  if (!holderRef.value || !canvasRef.value) return;

  ctx = canvasRef.value.getContext("2d", { alpha: false });
  if (!ctx) {
    console.error("PulseRadar: canvas 2d context unavailable");
    return;
  }

  sprite = makeBlipGlow();
  resize();

  // The sweep has to make a little over one revolution before the returns are
  // lit in proportion and the pulse train is full, so prime past that.
  for (let i = 0; i < config.warmup; i += 1) drawFrame();

  window.addEventListener("resize", onResize, { passive: true });

  fpsMeter.start();
  frameId = requestAnimationFrame(step);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);

  if (frameId !== null) {
    cancelAnimationFrame(frameId);
    frameId = null;
  }

  fpsMeter.stop();

  ctx = null;
  sprite = null;
  blips = [];
  rings = [];
});
</script>
