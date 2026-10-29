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
  // Target number of screen dots for the whole surface. Spacing is derived from
  // area / cells, so the halftone reads at the same scale on a 640x400
  // thumbnail and on a 4K viewport instead of beading out on one of them.
  cells: 2400,
  minSpacing: 8.5,
  maxSpacing: 24,
  // Print screens sit off the page edge; a rotated lattice stops the grid
  // reading as a spreadsheet and makes the sweep look like ink.
  gridAngle: 0.26,
  maxRadiusFactor: 0.56,
  minRadiusFactor: 0.16,
  buckets: 20,
  // Waves per sqrt(canvas area).
  sweepWaves: 2.4,
  rippleWaves: 3.6,
  tiltWaves: 1.1,
  sweepSpeed: 0.0125,
  rippleSpeed: 0.0165,
  tiltSpeed: 0.0042,
  rotateSpeed: 0.00062,
  inkHue: 186,
  inkLight: 63,
  alphaRange: [0.5, 0.97],
  crestBuckets: 4,
  warmup: 40,
};

const TAU = Math.PI * 2;
const ROW_PITCH = 0.8660254; // sqrt(3) / 2, hex-packed rows

let ctx = null;
let paths = [];
let frameId = null;
let frame = 0;
let width = 0;
let height = 0;
let spacing = 16;
let maxRadius = 9;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const buildScene = () => {
  const area = Math.max(1, width * height);
  spacing = clamp(
    Math.sqrt(area / config.cells),
    config.minSpacing,
    config.maxSpacing,
  );
  maxRadius = spacing * config.maxRadiusFactor;

  paths = [];
  for (let i = 0; i < config.buckets; i += 1) paths.push(new Path2D());
};

const paintBase = () => {
  ctx.fillStyle = "#04060a";
  ctx.fillRect(0, 0, width, height);

  const wash = ctx.createLinearGradient(0, 0, width, height);
  wash.addColorStop(0, "rgba(11, 18, 25, 0.8)");
  wash.addColorStop(0.55, "rgba(6, 11, 16, 0.35)");
  wash.addColorStop(1, "rgba(2, 4, 7, 0.85)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, width, height);
};

const drawFrame = () => {
  frame += 1;

  const buckets = config.buckets;
  for (let i = 0; i < buckets; i += 1) paths[i] = new Path2D();

  const base = Math.sqrt(Math.max(1, width * height));
  const cx = width / 2;
  const cy = height / 2;

  const angle = frame * config.rotateSpeed;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);

  const sweepK = (TAU * config.sweepWaves) / base;
  const rippleK = (TAU * config.rippleWaves) / base;
  const sweepPhase = frame * config.sweepSpeed;
  const ripplePhase = frame * config.rippleSpeed;
  const tiltPhase = frame * config.tiltSpeed;

  // The ripple origin walks a lissajous so the interference never repeats
  // while the main tide keeps one clearly readable direction.
  const fx = cx + width * 0.36 * Math.cos(frame * 0.0019);
  const fy = cy + height * 0.33 * Math.sin(frame * 0.00257);

  const cosA = Math.cos(config.gridAngle);
  const sinA = Math.sin(config.gridAngle);
  const iMax = Math.ceil((width * cosA + height * sinA) / spacing) + 2;
  const jMax =
    Math.ceil((width * sinA + height * cosA) / (spacing * ROW_PITCH)) + 2;

  const margin = maxRadius * 1.6;
  const minRadius = spacing * config.minRadiusFactor;
  const radiusSpan = maxRadius - minRadius;

  for (let j = -jMax; j <= jMax; j += 1) {
    const rowY = j * spacing * ROW_PITCH;
    const stagger = (Math.abs(j) % 2) * spacing * 0.5;

    for (let i = -iMax; i <= iMax; i += 1) {
      const lx = i * spacing + stagger;
      const x = cx + lx * cosA - rowY * sinA;
      const y = cy + lx * sinA + rowY * cosA;

      if (x < -margin || x > width + margin) continue;
      if (y < -margin || y > height + margin) continue;

      const travel = Math.sin((x * dirX + y * dirY) * sweepK - sweepPhase);
      const ripple = Math.sin(
        Math.hypot(x - fx, y - fy) * rippleK - ripplePhase,
      );
      const tilt = Math.sin(
        (x / Math.max(1, width) - (y / Math.max(1, height)) * 0.55) *
          config.tiltWaves *
          TAU +
          tiltPhase,
      );

      let h = 0.5 + 0.5 * (0.52 * travel + 0.3 * ripple + 0.18 * tilt);
      h = clamp(h, 0, 1);
      h = h * h * (3 - 2 * h);

      const radius = minRadius + radiusSpan * Math.pow(h, 1.35);
      const bucket = clamp(Math.floor(h * buckets), 0, buckets - 1);

      const path = paths[bucket];
      path.moveTo(x + radius, y);
      path.arc(x, y, radius, 0, TAU);
    }
  }

  paintBase();

  // The crest of the tide is the same ink, just laid down thicker: a gradient
  // along the sweep direction lifts the largest dots toward specular white.
  const crest = ctx.createLinearGradient(
    cx - dirX * base * 0.6,
    cy - dirY * base * 0.6,
    cx + dirX * base * 0.6,
    cy + dirY * base * 0.6,
  );
  crest.addColorStop(0, `hsl(${config.inkHue}, 100%, ${config.inkLight}%)`);
  crest.addColorStop(0.5, `hsl(${config.inkHue + 12}, 100%, 84%)`);
  crest.addColorStop(1, `hsl(${config.inkHue - 6}, 100%, 68%)`);

  const crestFrom = buckets - config.crestBuckets;
  const flat = `hsl(${config.inkHue}, 100%, ${config.inkLight}%)`;

  for (let b = 0; b < buckets; b += 1) {
    const t = (b + 1) / buckets;
    ctx.fillStyle = b >= crestFrom ? crest : flat;
    ctx.globalAlpha =
      config.alphaRange[0] +
      (config.alphaRange[1] - config.alphaRange[0]) * Math.pow(t, 0.75);
    ctx.fill(paths[b]);
  }

  ctx.globalAlpha = 1;
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
    console.error("HalftoneTide: canvas 2d context unavailable");
    return;
  }

  resize();

  // The tide is phase driven, so advancing the clock a few dozen frames opens
  // on a settled sweep rather than the aligned standing wave at t = 0.
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
  paths = [];
});
</script>
