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
  foldRange: [8, 12],
  // Radial reach as a fraction of the diagonal, so the bloom always owns the
  // frame without swallowing the corners at either size.
  reach: 0.345,
  hueSpan: [192, 322],
  hueSpeed: 0.00072,
  layers: [
    {
      scale: 1.0,
      foldMul: 1,
      speed: 0.00105,
      width: 1.75,
      alpha: 0.62,
      fill: 0.085,
      wobble: 1.0,
    },
    {
      scale: 0.74,
      foldMul: 1,
      speed: -0.00152,
      width: 1.5,
      alpha: 0.7,
      fill: 0.1,
      wobble: 1.35,
    },
    {
      scale: 0.52,
      foldMul: 2,
      speed: 0.00205,
      width: 1.3,
      alpha: 0.56,
      fill: 0.07,
      wobble: 1.7,
    },
    {
      scale: 0.3,
      foldMul: 2,
      speed: -0.00268,
      width: 1.25,
      alpha: 0.66,
      fill: 0.11,
      wobble: 2.1,
    },
    {
      scale: 1.22,
      foldMul: 1,
      speed: 0.00058,
      width: 1.35,
      alpha: 0.3,
      fill: 0.045,
      wobble: 0.7,
    },
  ],
  sparkArea: 46000,
  minSparks: 12,
  maxSparks: 60,
  seamAlpha: 0.14,
  coreScale: 0.34,
  warmup: 26,
};

const TAU = Math.PI * 2;

let ctx = null;
let glowSprites = [];
let sparks = [];
let folds = 10;
let frameId = null;
let frame = 0;
let width = 0;
let height = 0;
let reach = 240;

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const buildGlowSprites = () => {
  glowSprites = [];

  for (let i = 0; i < 6; i += 1) {
    const hue =
      config.hueSpan[0] + ((config.hueSpan[1] - config.hueSpan[0]) * i) / 5;
    const size = 48;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const s = canvas.getContext("2d");
    if (!s) {
      glowSprites.push(canvas);
      continue;
    }

    const glow = s.createRadialGradient(24, 24, 0, 24, 24, 24);
    glow.addColorStop(0, `hsla(${hue}, 100%, 94%, 1)`);
    glow.addColorStop(0.2, `hsla(${hue}, 100%, 76%, 0.6)`);
    glow.addColorStop(0.52, `hsla(${hue}, 96%, 56%, 0.16)`);
    glow.addColorStop(1, `hsla(${hue}, 90%, 46%, 0)`);
    s.fillStyle = glow;
    s.fillRect(0, 0, size, size);

    glowSprites.push(canvas);
  }
};

const buildScene = () => {
  reach = Math.hypot(width, height) * config.reach;

  const count = clamp(
    Math.round((width * height) / config.sparkArea),
    config.minSparks,
    config.maxSparks,
  );

  sparks = [];
  for (let i = 0; i < count; i += 1) {
    sparks.push({
      radius: rand(0.24, 1.12) * reach,
      angle: Math.random() * TAU,
      speed: rand(0.0009, 0.0042) * (Math.random() < 0.5 ? -1 : 1),
      wobble: rand(0.04, 0.16),
      wobbleSpeed: rand(0.006, 0.02),
      size: rand(4, 12) * (reach / 260),
      sprite: Math.floor(Math.random() * glowSprites.length),
      phase: Math.random() * TAU,
      pulse: rand(0.01, 0.035),
    });
  }
};

const paintBase = () => {
  const ground = ctx.createRadialGradient(
    width / 2,
    height / 2,
    0,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.78,
  );
  ground.addColorStop(0, "#0a0417");
  ground.addColorStop(0.45, "#05030f");
  ground.addColorStop(1, "#010104");
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, width, height);
};

// One asymmetric petal: the outbound half is fatter and steeper than the return
// half, and the mirror pass turns that into the butterfly wedge the kaleidoscope
// is built from. Every control point is a live sine, so it never stops morphing.
const strokePetal = (length, w1, h1, w2, h2, mirror) => {
  const sign = mirror ? -1 : 1;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(
    length * w1,
    -h1 * sign,
    length * w2,
    -h2 * sign,
    length,
    0,
  );
  ctx.bezierCurveTo(
    length * w2 * 0.86,
    h2 * 0.6 * sign,
    length * w1 * 1.24,
    h1 * 1.42 * sign,
    0,
    0,
  );
  ctx.closePath();
};

const drawBloom = (time) => {
  const hueCycle = 0.5 + 0.5 * Math.sin(time * config.hueSpeed * TAU);
  const baseHue =
    config.hueSpan[0] + (config.hueSpan[1] - config.hueSpan[0]) * hueCycle;

  ctx.globalCompositeOperation = "lighter";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (let l = 0; l < config.layers.length; l += 1) {
    const layer = config.layers[l];
    const layerFolds = folds * layer.foldMul;
    const spin = time * layer.speed * TAU;

    const breathe =
      0.84 + 0.17 * Math.sin(time * 0.0026 * layer.wobble + l * 1.7);

    const w1 = 0.26 + 0.15 * Math.sin(time * 0.0031 * layer.wobble + l);
    const w2 = 0.6 + 0.19 * Math.cos(time * 0.0024 * layer.wobble + l * 2.3);
    const bulgeA =
      0.3 + 0.16 * Math.sin(time * 0.0037 * layer.wobble + l * 0.9);
    const bulgeB =
      0.19 + 0.11 * Math.cos(time * 0.0029 * layer.wobble + l * 2.1);

    const length = reach * layer.scale * breathe;

    for (let f = 0; f < layerFolds; f += 1) {
      const wedge = (f / layerFolds) * TAU;
      const hue = baseHue + 46 * Math.sin(wedge * 2 + spin * 0.5) + l * 9;
      const sat = 92;
      const strokeLight = 62 + 12 * Math.sin(time * 0.004 + f);

      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.rotate(wedge + spin);

      for (let m = 0; m < 2; m += 1) {
        const mirror = m === 1;
        const h1 = length * bulgeA * (mirror ? 1.28 : 1);
        const h2 = length * bulgeB * (mirror ? 0.72 : 1);

        strokePetal(length, w1, h1, w2, h2, mirror);

        ctx.fillStyle = `hsla(${(hue + 26).toFixed(1)}, ${sat}%, ${clamp(strokeLight - 16, 26, 70).toFixed(1)}%, ${layer.fill})`;
        ctx.fill();

        ctx.strokeStyle = `hsla(${hue.toFixed(1)}, ${sat}%, ${strokeLight.toFixed(1)}%, ${layer.alpha})`;
        ctx.lineWidth = layer.width;
        ctx.stroke();
      }

      // Bright bead at the petal tip ties the folds together into a ring.
      const tip = length * 1.01;
      ctx.globalAlpha = clamp(layer.alpha * 0.75, 0.12, 0.85);
      const bead = layer.width * 5.5 * (0.85 + 0.3 * Math.sin(time * 0.01 + f));
      ctx.drawImage(
        glowSprites[(f + l) % glowSprites.length],
        tip - bead / 2,
        -bead / 2,
        bead,
        bead,
      );
      ctx.globalAlpha = 1;

      ctx.restore();
    }
  }

  // Glass seams along the fold boundaries: barely visible, but they make the
  // symmetry read as a device rather than a flower.
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.strokeStyle = `rgba(198, 224, 255, ${config.seamAlpha})`;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  for (let f = 0; f < folds; f += 1) {
    const wedge = (f / folds) * TAU + frame * 0.0004 * TAU;
    ctx.moveTo(Math.cos(wedge) * reach * 0.12, Math.sin(wedge) * reach * 0.12);
    ctx.lineTo(Math.cos(wedge) * reach * 1.32, Math.sin(wedge) * reach * 1.32);
  }
  ctx.stroke();
  ctx.restore();
};

const drawCore = (time) => {
  const pulse =
    0.86 + 0.2 * Math.sin(time * 0.011) + 0.07 * Math.sin(time * 0.037);
  const size = reach * config.coreScale * pulse;
  const hue = 300 + 30 * Math.sin(time * 0.002);

  ctx.globalCompositeOperation = "lighter";

  const core = ctx.createRadialGradient(
    width / 2,
    height / 2,
    0,
    width / 2,
    height / 2,
    size,
  );
  core.addColorStop(0, `hsla(${hue}, 100%, 92%, 0.85)`);
  core.addColorStop(0.18, `hsla(${hue - 14}, 100%, 72%, 0.4)`);
  core.addColorStop(0.46, `hsla(${hue - 40}, 96%, 56%, 0.14)`);
  core.addColorStop(1, "hsla(280, 90%, 40%, 0)");
  ctx.fillStyle = core;
  ctx.fillRect(width / 2 - size, height / 2 - size, size * 2, size * 2);

  for (const s of sparks) {
    const angle = s.angle + time * s.speed * TAU;
    const radius =
      s.radius * (1 + s.wobble * Math.sin(time * s.wobbleSpeed + s.phase));
    const x = width / 2 + Math.cos(angle) * radius;
    const y = height / 2 + Math.sin(angle) * radius * 0.86;
    const sparkSize = s.size * (0.8 + 0.4 * Math.sin(time * s.pulse + s.phase));

    ctx.globalAlpha = clamp(
      0.36 + 0.34 * Math.sin(time * s.pulse * 1.4 + s.phase),
      0.12,
      0.8,
    );
    ctx.drawImage(
      glowSprites[s.sprite],
      x - sparkSize,
      y - sparkSize,
      sparkSize * 2,
      sparkSize * 2,
    );
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
};

const paintVignette = () => {
  const radius = Math.max(width, height) * 0.76;
  const vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    radius * 0.34,
    width / 2,
    height / 2,
    radius,
  );
  vignette.addColorStop(0, "rgba(2, 1, 8, 0)");
  vignette.addColorStop(1, "rgba(2, 1, 8, 0.72)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
};

const drawFrame = () => {
  frame += 1;
  const time = frame;

  paintBase();
  drawBloom(time);
  drawCore(time);
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
    console.error("KaleidoBloom: canvas 2d context unavailable");
    return;
  }

  folds = Math.round(rand(config.foldRange[0], config.foldRange[1]));

  buildGlowSprites();
  resize();

  // Petal geometry is all sine driven, so stepping the clock first opens on a
  // mid-morph frame instead of the symmetric pose every wave shares at zero.
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
  glowSprites = [];
  sparks = [];
});
</script>
