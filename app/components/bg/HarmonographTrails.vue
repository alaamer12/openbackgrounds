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
  pens: 4,
  // Cycles per time unit for each axis. Small integer pairs close the figure
  // into a readable rosette; the detune applied later stops it ever lapping
  // exactly, which is what makes the drawing build up instead of overwriting.
  ratios: [
    [3, 2],
    [5, 4],
    [2, 1],
    [5, 2],
    [4, 3],
    [7, 5],
    [9, 8],
  ],
  baseFreq: 0.62,
  detune: 0.0075,
  // Segment length is chosen so a chord is a few pixels at the fastest part of
  // the swing: shorter than that and the mount-time warmup gets expensive,
  // longer and the curve reads as a polygon.
  segment: 1 / 60,
  segments: 3,
  decayRange: [0.02, 0.036],
  endDecay: 0.1,
  ampRange: [0.31, 0.44],
  squashRange: [0.78, 1],
  centreDrift: 0.05,
  lineWidth: 1.3,
  // Per-stroke alpha is deliberately low: the figure retraces every ~30 frames
  // and the accumulation, not a single pass, is what draws the pattern. Any
  // higher and the crossing points blow out to white.
  baseAlpha: 0.26,
  fade: 0.02,
  warmup: 340,
};

const TAU = Math.PI * 2;

const PALETTE = [
  { hue: 44, sat: 92, light: 66 },
  { hue: 34, sat: 86, light: 60 },
  { hue: 16, sat: 82, light: 58 },
  { hue: 344, sat: 74, light: 64 },
  { hue: 158, sat: 72, light: 62 },
  { hue: 186, sat: 78, light: 66 },
];

let ctx = null;
let pens = [];
let frameId = null;
let frame = 0;
let width = 0;
let height = 0;

const rand = (min, max) => min + Math.random() * (max - min);

const newPen = (pen) => {
  const ratio = config.ratios[(Math.random() * config.ratios.length) | 0];
  const colour = PALETTE[(Math.random() * PALETTE.length) | 0];
  const base = Math.min(width, height);

  pen.fx = ratio[0] * config.baseFreq * (1 + rand(-1, 1) * config.detune);
  pen.fy = ratio[1] * config.baseFreq * (1 + rand(-1, 1) * config.detune);
  pen.px = rand(0, TAU);
  pen.py = rand(0, TAU);
  pen.decay = rand(config.decayRange[0], config.decayRange[1]);
  pen.t = 0;
  pen.amp = base * rand(config.ampRange[0], config.ampRange[1]);
  pen.squash = rand(config.squashRange[0], config.squashRange[1]);
  pen.cx = width * 0.5 + rand(-1, 1) * width * 0.07;
  pen.cy = height * 0.5 + rand(-1, 1) * height * 0.05;
  pen.rotation = rand(-0.42, 0.42);
  pen.seed = rand(0, 100);
  pen.colour = colour;
  pen.width = Math.max(1.2, config.lineWidth * rand(0.88, 1.42));

  return pen;
};

const buildPens = () => {
  pens = [];
  for (let i = 0; i < config.pens; i += 1) pens.push(newPen({}));
};

const paintBase = () => {
  const ground = ctx.createLinearGradient(0, 0, width, height);
  ground.addColorStop(0, "#080610");
  ground.addColorStop(0.5, "#05040c");
  ground.addColorStop(1, "#090711");
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, width, height);
};

const drawPen = (pen) => {
  const cosR = Math.cos(pen.rotation);
  const sinR = Math.sin(pen.rotation);
  const kx = TAU * pen.fx;
  const ky = TAU * pen.fy;

  // The registration point itself breathes, so a long-lived pen never repaints
  // exactly the same pixels and the figure grows outward instead of thickening
  // in place.
  const ox = Math.sin(frame * 0.0011 + pen.seed) * pen.amp * config.centreDrift;
  const oy =
    Math.cos(frame * 0.0009 + pen.seed * 1.7) * pen.amp * config.centreDrift;

  ctx.beginPath();
  for (let i = 0; i < config.segments; i += 1) {
    pen.t += config.segment;

    const d = Math.exp(-pen.decay * pen.t);
    const lx = Math.sin(kx * pen.t + pen.px) * pen.amp * d;
    const ly = Math.sin(ky * pen.t + pen.py) * pen.amp * d * pen.squash;

    const x = pen.cx + ox + lx * cosR - ly * sinR;
    const y = pen.cy + oy + lx * sinR + ly * cosR;

    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  const d = Math.exp(-pen.decay * pen.t);
  const grow = Math.min(1, pen.t / 4);
  const alpha = config.baseAlpha * grow * (0.32 + 0.68 * d);
  const { hue, sat, light } = pen.colour;

  ctx.lineWidth = pen.width;
  ctx.strokeStyle = `hsla(${hue}, ${sat}%, ${light + (1 - d) * 12}%, ${alpha})`;
  ctx.stroke();

  return d;
};

const drawFrame = () => {
  frame += 1;
  if (!ctx || width < 2 || height < 2 || !pens.length) return;

  // A very slow wipe: old ink has to survive long enough for the near-repeats
  // to stack into the full figure, but it still has to reach true black so the
  // ground never greys over as the drawing accumulates.
  ctx.fillStyle = `rgba(5, 4, 10, ${config.fade})`;
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";

  for (const pen of pens) {
    const decay = drawPen(pen);

    // Retired once the swing is inside a tenth of its travel: the last few
    // percent of amplitude only smudges the centre of the figure.
    if (decay < config.endDecay) newPen(pen);
  }

  ctx.globalCompositeOperation = "source-over";
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
  ctx.lineCap = "round";

  paintBase();
  buildPens();
};

const onResize = () => resize();

onMounted(() => {
  if (!holderRef.value || !canvasRef.value) return;

  ctx = canvasRef.value.getContext("2d", { alpha: false });
  if (!ctx) {
    console.error("HarmonographTrails: canvas 2d context unavailable");
    return;
  }

  resize();

  // Each pen needs hundreds of frames before its rosette is drawn in, so the
  // first rAF would otherwise show four short arcs.
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
  pens = [];
});
</script>
