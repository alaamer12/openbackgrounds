<template>
  <div ref="holderRef" class="absolute inset-0 pointer-events-none">
    <canvas ref="canvasRef" class="block w-full h-full" />
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import { createNoise2D } from "simplex-noise";

const holderRef = ref(null);
const canvasRef = ref(null);

const fpsMeter = useFpsMeter();

const config = {
  maxDpr: 1.5,
  // Screen area is divided among roughly this many columns, and the edge
  // length is solved from it, so the field keeps the same tile count and a
  // readable scale in a 640x400 thumbnail and on a wide viewport.
  tiles: 440,
  minEdge: 14,
  maxEdge: 58,
  // Iso lattice: horizontal half-step is a * ISO_X, vertical step a * 0.5.
  gridScale: 0.17,
  // Both noise axes advance by the same amount, which translates the pattern
  // straight down the screen: the columns never move, the heights do.
  scrollSpeed: 0.0055,
  waveK: 0.33,
  waveSpeed: 0.0175,
  crossK: 0.19,
  crossSpeed: 0.0105,
  liftMin: 0.06,
  liftSpan: 1.56,
  hue: 249,
  accentHue: 32,
  accentFrom: 0.62,
  accentTo: 0.94,
  accentLight: 57,
  rimAlpha: 0.5,
  haze: 0.62,
  warmup: 14,
};

const ISO_X = 0.8660254; // sqrt(3) / 2

let ctx = null;
let noise2D = null;
let frameId = null;
let frame = 0;
let width = 0;
let height = 0;
let edge = 30;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const lerp = (a, b, t) => a + (b - a) * t;

const smoothstep = (from, to, value) => {
  const t = clamp((value - from) / Math.max(1e-6, to - from), 0, 1);
  return t * t * (3 - 2 * t);
};

const heightAt = (i, j) => {
  const drift = frame * config.scrollSpeed;
  const n = noise2D(i * config.gridScale + drift, j * config.gridScale + drift);
  const along = Math.sin((i + j) * config.waveK - frame * config.waveSpeed);
  const across = Math.sin((i - j) * config.crossK + frame * config.crossSpeed);

  return clamp(0.5 + 0.5 * (0.54 * n + 0.3 * along + 0.16 * across), 0, 1);
};

const paintGround = () => {
  const ground = ctx.createLinearGradient(0, 0, 0, height);
  ground.addColorStop(0, "#07061a");
  ground.addColorStop(0.36, "#0a0722");
  ground.addColorStop(0.62, "#05040f");
  ground.addColorStop(1, "#030209");
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, width, height);

  // Cold horizon bloom behind the far columns, so the field sits in a volume
  // of air instead of floating on a flat fill.
  const glow = ctx.createRadialGradient(
    width * 0.5,
    height * 0.3,
    0,
    width * 0.5,
    height * 0.3,
    Math.max(width, height) * 0.62,
  );
  glow.addColorStop(0, "rgba(96, 88, 224, 0.2)");
  glow.addColorStop(0.45, "rgba(52, 44, 140, 0.08)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
};

const paintHaze = () => {
  const haze = ctx.createLinearGradient(0, 0, 0, height * 0.72);
  haze.addColorStop(0, `rgba(14, 12, 44, ${config.haze})`);
  haze.addColorStop(0.55, "rgba(10, 9, 34, 0.22)");
  haze.addColorStop(1, "rgba(6, 5, 18, 0)");
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, width, height * 0.72);
};

const drawFrame = () => {
  frame += 1;
  if (!ctx || !noise2D || width < 2 || height < 2) return;

  paintGround();

  const a = edge;
  const w = a * ISO_X;
  const originX = width * 0.5;
  const originY = height * 0.44;
  const maxLift = a * (config.liftMin + config.liftSpan);

  const uMax = Math.ceil(width / (2 * w)) + 1;
  const vMin = Math.floor((maxLift + a * 0.5 - originY) / (a * 0.5)) - 1;
  const vMax = Math.ceil((height + a - originY) / (a * 0.5)) + 1;
  const vSpan = Math.max(1, vMax - vMin);

  // Far to near: v is the depth axis, so ascending v is a correct painter sort
  // and the tall near columns simply overwrite the ones behind them.
  for (let v = vMin; v <= vMax; v += 1) {
    const depthT = clamp((v - vMin) / vSpan, 0, 1);
    const near = 0.34 + 0.66 * Math.pow(depthT, 0.62);
    const saturation = 0.55 + 0.45 * depthT;

    let u = -uMax;
    if ((((u + v) % 2) + 2) % 2 !== 0) u += 1;

    for (; u <= uMax; u += 2) {
      const i = (u + v) / 2;
      const j = (v - u) / 2;
      const h = heightAt(i, j);

      const x = originX + u * w;
      const baseY = originY + v * a * 0.5;
      const lift = a * (config.liftMin + h * config.liftSpan);
      const y = baseY - lift;
      // Every column is anchored to the same ground plane, so a taller body is
      // exactly a taller column: that is what makes the wave legible.
      const body = a * 0.5 + lift;

      const crest = smoothstep(config.accentFrom, config.accentTo, h * near);

      const hue = config.hue - h * 9;
      const light = (11 + h * 43) * near;

      // Top catches the key light, the left face drops into the coldest
      // shadow, the right face is the one that turns amber on a crest.
      ctx.fillStyle = `hsl(${hue}, ${34 + 26 * saturation}%, ${light * 0.92}%)`;
      ctx.beginPath();
      ctx.moveTo(x, y - a * 0.5);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x, y + a * 0.5);
      ctx.lineTo(x - w, y);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = `hsl(${hue + 8}, ${22 + 18 * saturation}%, ${light * 0.3}%)`;
      ctx.beginPath();
      ctx.moveTo(x - w, y);
      ctx.lineTo(x, y + a * 0.5);
      ctx.lineTo(x, y + a * 0.5 + body);
      ctx.lineTo(x - w, y + body);
      ctx.closePath();
      ctx.fill();

      // The hue ramp is taken the long way round the wheel (249 -> 392) so the
      // blend passes through violet and red instead of turning green.
      const warmHue = lerp(config.hue - 6, config.accentHue + 360, crest) % 360;
      const warmSat = lerp(30 + 16 * saturation, 92, crest);
      const warmLight = lerp(
        light * 0.52,
        config.accentLight * (0.5 + 0.5 * near),
        crest,
      );

      ctx.fillStyle = `hsl(${warmHue}, ${warmSat}%, ${warmLight}%)`;
      ctx.beginPath();
      ctx.moveTo(x + w, y);
      ctx.lineTo(x, y + a * 0.5);
      ctx.lineTo(x, y + a * 0.5 + body);
      ctx.lineTo(x + w, y + body);
      ctx.closePath();
      ctx.fill();

      if (crest > 0.05) {
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = `hsla(44, 96%, 78%, ${config.rimAlpha * crest})`;
        ctx.beginPath();
        ctx.moveTo(x - w, y);
        ctx.lineTo(x, y - a * 0.5);
        ctx.lineTo(x + w, y);
        ctx.stroke();
      }
    }
  }

  paintHaze();
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

  edge = clamp(
    Math.sqrt((width * height) / (ISO_X * config.tiles)),
    config.minEdge,
    config.maxEdge,
  );
};

const onResize = () => resize();

onMounted(() => {
  if (!holderRef.value || !canvasRef.value) return;

  ctx = canvasRef.value.getContext("2d", { alpha: false });
  if (!ctx) {
    console.error("IsoDrift: canvas 2d context unavailable");
    return;
  }

  noise2D = createNoise2D();

  resize();

  // Repainted from scratch every frame, so the short run only steps the wave
  // off its aligned t = 0 standing pattern.
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
  noise2D = null;
});
</script>
