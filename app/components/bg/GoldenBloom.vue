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
  // Seeds scale with canvas area, so the packing density stays constant and the
  // spiral arms are equally readable at thumbnail and viewport size.
  seedArea: 620,
  minSeeds: 640,
  maxSeeds: 2100,
  radiusFill: 0.53,
  hues: 18,
  hueRange: [38, 104],
  armA: 0.052,
  armB: 0.031,
  armBias: 0.62,
  phaseSpeed: 0.0125,
  rotation: 0.0016,
  // Bounded rather than accumulating: a constant differential spin would wind
  // the spiral arms into mush over several minutes, this lets them breathe.
  shear: 0.62,
  shearSpeed: 0.0009,
  breathe: 0.06,
  twinkle: 0.18,
  sizeRange: [0.8, 2.05],
  alphaRange: [0.34, 0.95],
  vignette: 0.6,
  warmup: 60,
};

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

let ctx = null;
let sprites = [];
let phase = null;
let rate = null;
let frameId = null;
let frame = 0;
let width = 0;
let height = 0;
let count = 0;
let radiusUnit = 1;
let spacing = 20;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// One soft glow sprite per hue step: a pale core of the same hue falling off to
// nothing. Additive stacking then does the mixing, which is what makes the
// centre burn gold and the rim stay deep green.
const buildSprites = () => {
  sprites = [];

  for (let h = 0; h < config.hues; h += 1) {
    const hue =
      config.hueRange[0] +
      (config.hueRange[1] - config.hueRange[0]) * (h / (config.hues - 1));

    const size = 48;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const s = canvas.getContext("2d");
    if (!s) {
      sprites.push(canvas);
      continue;
    }

    const glow = s.createRadialGradient(24, 24, 0, 24, 24, 24);
    glow.addColorStop(0, `hsla(${hue}, 100%, 92%, 1)`);
    glow.addColorStop(0.16, `hsla(${hue}, 100%, 74%, 0.78)`);
    glow.addColorStop(0.36, `hsla(${hue}, 94%, 54%, 0.3)`);
    glow.addColorStop(0.66, `hsla(${hue}, 88%, 38%, 0.08)`);
    glow.addColorStop(1, `hsla(${hue}, 80%, 30%, 0)`);
    s.fillStyle = glow;
    s.fillRect(0, 0, size, size);

    sprites.push(canvas);
  }
};

const buildScene = () => {
  const area = Math.max(1, width * height);
  count = clamp(
    Math.round(area / config.seedArea),
    config.minSeeds,
    config.maxSeeds,
  );

  const reach = Math.hypot(width, height) * config.radiusFill;
  radiusUnit = reach / Math.sqrt(count);
  spacing = Math.sqrt(area / count);

  phase = new Float32Array(count);
  rate = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    phase[i] = Math.random() * TAU;
    rate[i] = 0.6 + Math.random() * 0.8;
  }
};

const paintBase = () => {
  const ground = ctx.createLinearGradient(0, 0, width, height);
  ground.addColorStop(0, "#050402");
  ground.addColorStop(0.5, "#03060a");
  ground.addColorStop(1, "#010302");
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = "lighter";
  const cx = width / 2;
  const cy = height / 2;
  const reach = Math.max(width, height) * 0.62;

  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach);
  core.addColorStop(0, "rgba(96, 62, 14, 0.4)");
  core.addColorStop(0.35, "rgba(40, 44, 22, 0.16)");
  core.addColorStop(1, "rgba(4, 12, 10, 0)");
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = "source-over";
};

const drawFrame = () => {
  frame += 1;

  const wave = frame * config.phaseSpeed;
  const spin = frame * config.rotation;
  const cx = width / 2;
  const cy = height / 2;
  const grow = 1 + config.breathe * Math.sin(frame * 0.0037);
  const twist = config.shear * Math.sin(frame * config.shearSpeed);

  paintBase();

  ctx.globalCompositeOperation = "lighter";

  const hueLast = config.hues - 1;
  const minSize = spacing * config.sizeRange[0];
  const sizeSpan = spacing * (config.sizeRange[1] - config.sizeRange[0]);

  for (let i = 0; i < count; i += 1) {
    const index = i + 1;
    const t = index / count;

    // Interference of two index waves: because the index also *is* the angle
    // (golden angle), the beats resolve into the 8 and 13 arm Fibonacci
    // spirals that make phyllotaxis recognisable.
    let beat =
      Math.sin(index * config.armA - wave) +
      config.armBias * Math.sin(index * config.armB + wave * 0.72);
    beat = clamp((beat / (1 + config.armBias) + 1) * 0.5, 0, 1);

    const sparkle =
      1 + config.twinkle * Math.sin(frame * 0.024 * rate[i] + phase[i]);

    const bloom = clamp(beat * sparkle, 0, 1.15);
    const radial =
      radiusUnit * Math.sqrt(index) * grow * (1 + 0.05 * (bloom - 0.5));
    const angle = index * GOLDEN_ANGLE + spin + twist * t;

    const x = cx + Math.cos(angle) * radial;
    const y = cy + Math.sin(angle) * radial;

    if (x < -spacing || x > width + spacing) continue;
    if (y < -spacing || y > height + spacing) continue;

    const size = minSize + sizeSpan * bloom;
    const hueIndex = Math.round(clamp(t * hueLast * 1.06, 0, hueLast));

    ctx.globalAlpha = clamp(
      config.alphaRange[0] +
        (config.alphaRange[1] - config.alphaRange[0]) *
          Math.pow(bloom, 0.85) *
          (1.08 - 0.28 * t),
      0.12,
      0.95,
    );

    ctx.drawImage(sprites[hueIndex], x - size / 2, y - size / 2, size, size);
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  const radius = Math.max(width, height) * 0.8;
  const vignette = ctx.createRadialGradient(
    cx,
    cy,
    radius * 0.3,
    cx,
    cy,
    radius,
  );
  vignette.addColorStop(0, "rgba(1, 3, 3, 0)");
  vignette.addColorStop(1, `rgba(1, 3, 3, ${config.vignette})`);
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
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
    console.error("GoldenBloom: canvas 2d context unavailable");
    return;
  }

  buildSprites();
  resize();

  // The bloom is wave driven: priming the clock opens on a mid unfurl instead
  // of the flat standing pattern every wave shares at phase zero.
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
  phase = null;
  rate = null;
});
</script>
