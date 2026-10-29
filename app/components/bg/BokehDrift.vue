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
  // Canvas area per disc: a handful of big soft lights at thumbnail size,
  // a full crowd of them at 1440p, without either turning into fog.
  orbArea: 15500,
  minOrbs: 11,
  maxOrbs: 124,
  radiusRange: [0.042, 0.148],
  bandBias: 0.58,
  bandWidth: 0.26,
  drift: 0.16,
  sway: 0.5,
  breathe: 0.13,
  rimShare: 0.34,
  vignette: 0.7,
  shade: 0.34,
  warmAnchor: [0.14, 0.88],
  coolAnchor: [0.88, 0.12],
  warmWeight: 0.6,
  warmup: 30,
};

const TAU = Math.PI * 2;

const PALETTE = [
  { rgb: "255, 178, 72", warm: true },
  { rgb: "255, 214, 138", warm: true },
  { rgb: "255, 136, 92", warm: true },
  { rgb: "232, 96, 120", warm: true },
  { rgb: "62, 216, 206", warm: false },
  { rgb: "108, 208, 255", warm: false },
  { rgb: "168, 246, 224", warm: false },
  { rgb: "196, 176, 255", warm: false },
];

let ctx = null;
let sprites = [];
let orbs = [];
let shades = [];
let frameId = null;
let frame = 0;
let width = 0;
let height = 0;

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// A disc seen out of focus is not a gaussian: real bokeh carries most of its
// energy in a brighter rim, so both falloffs are baked once per colour.
const makeSprite = (rgb, rim) => {
  const size = 160;
  const half = size / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const s = canvas.getContext("2d");
  if (!s) return canvas;

  const glow = s.createRadialGradient(half, half, 0, half, half, half);
  if (rim) {
    glow.addColorStop(0, `rgba(${rgb}, 0.34)`);
    glow.addColorStop(0.42, `rgba(${rgb}, 0.5)`);
    glow.addColorStop(0.72, `rgba(${rgb}, 0.92)`);
    glow.addColorStop(0.84, `rgba(${rgb}, 0.4)`);
    glow.addColorStop(0.94, `rgba(${rgb}, 0.08)`);
    glow.addColorStop(1, `rgba(${rgb}, 0)`);
  } else {
    glow.addColorStop(0, `rgba(${rgb}, 0.96)`);
    glow.addColorStop(0.24, `rgba(${rgb}, 0.62)`);
    glow.addColorStop(0.48, `rgba(${rgb}, 0.3)`);
    glow.addColorStop(0.74, `rgba(${rgb}, 0.09)`);
    glow.addColorStop(1, `rgba(${rgb}, 0)`);
  }
  s.fillStyle = glow;
  s.fillRect(0, 0, size, size);

  return canvas;
};

const buildSprites = () => {
  sprites = PALETTE.map((entry) => [
    makeSprite(entry.rgb, false),
    makeSprite(entry.rgb, true),
  ]);
};

const pickColour = (x, y) => {
  const nx = x / width;
  const ny = y / height;

  const dWarm = Math.hypot(
    nx - config.warmAnchor[0],
    ny - config.warmAnchor[1],
  );
  const dCool = Math.hypot(
    nx - config.coolAnchor[0],
    ny - config.coolAnchor[1],
  );

  // Distance ratio -> 0 near the warm corner, 1 near the cool one, with a
  // deliberate amount of noise so the two families bleed into each other.
  const bias = dWarm / Math.max(0.0001, dWarm + dCool);
  const wantWarm = Math.random() < config.warmWeight * (1 - bias) + 0.2;

  const pool = [];
  PALETTE.forEach((entry, index) => {
    if (entry.warm === wantWarm) pool.push(index);
  });

  if (!pool.length) return 0;
  return pool[Math.floor(Math.random() * pool.length)];
};

const placeOrb = (orb) => {
  const base = Math.sqrt(Math.max(1, width * height));

  if (Math.random() < config.bandBias) {
    // A loose diagonal current instead of a uniform scatter: gives the frame
    // an axis to read while the discs drift.
    const t = Math.random();
    const ax = width * 0.1;
    const ay = height * 0.9;
    const dx = width * 0.82;
    const dy = -height * 0.76;
    const len = Math.max(1, Math.hypot(dx, dy));
    const jitter = rand(-1, 1) * base * config.bandWidth;
    orb.x = ax + t * dx - (dy / len) * jitter;
    orb.y = ay + t * dy + (dx / len) * jitter;
  } else {
    orb.x = Math.random() * width;
    orb.y = Math.random() * height;
  }

  orb.depth = rand(0.25, 1);
  orb.colour = pickColour(orb.x, orb.y);
  orb.rim = Math.random() < config.rimShare ? 1 : 0;
  orb.radius =
    base *
    (config.radiusRange[0] +
      Math.random() * (config.radiusRange[1] - config.radiusRange[0])) *
    (0.62 + orb.depth * 0.7);

  // Larger discs are further out of focus, so they carry less energy: that is
  // what keeps a hundred additive lights from lifting the ground to grey.
  const focus = clamp(1.35 - orb.depth, 0.2, 1);
  orb.alpha = clamp(
    (0.1 + focus * 0.4) * (orb.rim ? 0.78 : 1) * rand(0.8, 1.2),
    0.07,
    0.5,
  );

  const angle = rand(-Math.PI * 0.85, -Math.PI * 0.1);
  const speed = config.drift * (0.4 + orb.depth * 1.15);
  orb.vx = Math.cos(angle) * speed;
  orb.vy = Math.sin(angle) * speed;
  orb.seed = rand(0, 100);
  orb.breatheSpeed = rand(0.004, 0.013);
  orb.phase = Math.random() * TAU;

  return orb;
};

const buildScene = () => {
  const area = Math.max(1, width * height);
  const count = clamp(
    Math.round(area / config.orbArea),
    config.minOrbs,
    config.maxOrbs,
  );

  orbs = [];
  for (let i = 0; i < count; i += 1) orbs.push(placeOrb({}));

  // Slow negative lights. They punch holes back into the accumulated glow so
  // the darkest areas stay genuinely black instead of milky.
  shades = [];
  for (let i = 0; i < 3; i += 1) {
    shades.push({
      x: Math.random() * width,
      y: Math.random() * height,
      radius: Math.sqrt(area) * rand(0.28, 0.5),
      vx: rand(-0.05, 0.05),
      vy: rand(-0.04, 0.04),
      seed: rand(0, 40),
    });
  }
};

const paintBase = () => {
  const ground = ctx.createLinearGradient(0, height, width, 0);
  ground.addColorStop(0, "#0b0704");
  ground.addColorStop(0.45, "#04080a");
  ground.addColorStop(1, "#03060b");
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, width, height);
};

const advance = () => {
  for (const o of orbs) {
    const sway = Math.sin(frame * 0.0022 + o.seed);
    o.x += o.vx + sway * config.sway * 0.06;
    o.y += o.vy + Math.cos(frame * 0.0018 + o.seed) * config.sway * 0.05;

    const pad = o.radius * 1.1;
    if (o.x < -pad) o.x += width + pad * 2;
    else if (o.x > width + pad) o.x -= width + pad * 2;
    if (o.y < -pad) o.y += height + pad * 2;
    else if (o.y > height + pad) o.y -= height + pad * 2;
  }

  for (const s of shades) {
    s.x += s.vx + Math.sin(frame * 0.0012 + s.seed) * 0.05;
    s.y += s.vy + Math.cos(frame * 0.0011 + s.seed) * 0.05;

    if (s.x < -s.radius) s.x = width + s.radius;
    else if (s.x > width + s.radius) s.x = -s.radius;
    if (s.y < -s.radius) s.y = height + s.radius;
    else if (s.y > height + s.radius) s.y = -s.radius;
  }
};

const drawOrbs = () => {
  ctx.globalCompositeOperation = "lighter";

  for (const o of orbs) {
    const breathe =
      1 + config.breathe * Math.sin(frame * o.breatheSpeed + o.phase);
    const size = o.radius * 2 * breathe;

    ctx.globalAlpha = clamp(
      o.alpha *
        (0.86 + 0.24 * Math.sin(frame * o.breatheSpeed * 1.7 + o.phase)),
      0.05,
      0.55,
    );
    ctx.drawImage(
      sprites[o.colour][o.rim],
      o.x - size / 2,
      o.y - size / 2,
      size,
      size,
    );
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
};

const drawShades = () => {
  ctx.globalCompositeOperation = "multiply";

  for (const s of shades) {
    const shade = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.radius);
    shade.addColorStop(0, `rgba(12, 12, 18, ${config.shade})`);
    shade.addColorStop(0.6, `rgba(16, 16, 22, ${config.shade * 0.45})`);
    shade.addColorStop(1, "rgba(24, 24, 30, 0)");
    ctx.fillStyle = shade;
    ctx.fillRect(s.x - s.radius, s.y - s.radius, s.radius * 2, s.radius * 2);
  }

  ctx.globalCompositeOperation = "source-over";
};

const paintVignette = () => {
  const radius = Math.max(width, height) * 0.82;
  const vignette = ctx.createRadialGradient(
    width * 0.5,
    height * 0.5,
    radius * 0.28,
    width * 0.5,
    height * 0.5,
    radius,
  );
  vignette.addColorStop(0, "rgba(2, 3, 6, 0)");
  vignette.addColorStop(1, `rgba(2, 3, 6, ${config.vignette})`);
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
};

const drawFrame = () => {
  frame += 1;

  advance();
  paintBase();
  drawOrbs();
  drawShades();
  paintVignette();
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

  buildScene();
};

const onResize = () => resize();

onMounted(() => {
  if (!holderRef.value || !canvasRef.value) return;

  ctx = canvasRef.value.getContext("2d", { alpha: false });
  if (!ctx) {
    console.error("BokehDrift: canvas 2d context unavailable");
    return;
  }

  buildSprites();
  resize();

  // Nothing accumulates between frames, but letting the crowd drift apart
  // before the first paint avoids a stack of discs on the spawn diagonal.
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
  sprites = [];
  orbs = [];
  shades = [];
});
</script>
