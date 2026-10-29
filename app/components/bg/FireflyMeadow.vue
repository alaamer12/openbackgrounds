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
  moteArea: 5200,
  minMotes: 26,
  maxMotes: 320,
  // Halo diameter as a fraction of sqrt(canvas area). Kept small on purpose:
  // these are pinpricks with a bloom, not out-of-focus discs.
  haloRange: [0.034, 0.092],
  coreRange: [0.9, 2.4],
  speed: 0.3,
  noiseScale: 0.0017,
  fieldDrift: 0.00042,
  bob: 0.075,
  // A pulse period is in frames, so the meadow desynchronises on screen time
  // rather than on a shared beat.
  period: [150, 620],
  // Fraction of a cycle that carries light, and where inside that window the
  // strike peaks.
  duty: 0.42,
  rise: 0.22,
  coreAlpha: 0.95,
  haloAlpha: 0.5,
  ember: 0.07,
  horizonY: 0.66,
  warmup: 96,
};

const TAU = Math.PI * 2;

const TINTS = ["255, 214, 138", "255, 236, 186", "214, 255, 190"];

let ctx = null;
let noise2D = null;
let sprites = [];
let motes = [];
let frameId = null;
let frame = 0;
let width = 0;
let height = 0;

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Baked once per tint: an asymmetric falloff with a tight bright shoulder is
// what reads as a point source in air, and it costs far less than a gradient
// created per mote per frame.
const makeHalo = (rgb) => {
  const size = 128;
  const half = size / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const s = canvas.getContext("2d");
  if (!s) return canvas;

  const glow = s.createRadialGradient(half, half, 0, half, half, half);
  glow.addColorStop(0, `rgba(${rgb}, 0.9)`);
  glow.addColorStop(0.09, `rgba(${rgb}, 0.46)`);
  glow.addColorStop(0.22, `rgba(${rgb}, 0.16)`);
  glow.addColorStop(0.46, `rgba(${rgb}, 0.05)`);
  glow.addColorStop(0.76, `rgba(${rgb}, 0.014)`);
  glow.addColorStop(1, `rgba(${rgb}, 0)`);
  s.fillStyle = glow;
  s.fillRect(0, 0, size, size);

  return canvas;
};

const buildSprites = () => {
  sprites = TINTS.map((tint) => makeHalo(tint));
};

const placeMote = (mote) => {
  const area = Math.max(1, width * height);

  // Density falls off with height: the population sits low over the meadow and
  // thins out into the sky.
  const t = Math.pow(Math.random(), 0.72);
  mote.x = Math.random() * width;
  mote.y = height * (0.2 + 0.8 * t);
  mote.depth = rand(0.18, 1);
  mote.tint = (Math.random() * sprites.length) | 0;
  mote.halo =
    Math.sqrt(area) *
    (config.haloRange[0] +
      Math.random() * (config.haloRange[1] - config.haloRange[0])) *
    (0.5 + mote.depth * 0.85);
  mote.core = config.coreRange[0] + Math.random() * config.coreRange[1];
  mote.seed = rand(0, 400);
  mote.bobSpeed = rand(0.006, 0.019);
  mote.phase = Math.random();
  mote.period = rand(config.period[0], config.period[1]);
  mote.speed = config.speed * (0.4 + mote.depth * 0.9);

  return mote;
};

const buildMotes = () => {
  const count = clamp(
    Math.round((width * height) / config.moteArea),
    config.minMotes,
    config.maxMotes,
  );

  motes = [];
  for (let i = 0; i < count; i += 1) motes.push(placeMote({}));
};

const envelope = (phase) => {
  // Most of a cycle is dark: a meadow reads as scattered flashes precisely
  // because most of the population is off at any instant.
  if (phase >= config.duty) return 0;

  const t = phase / config.duty;

  // Sharp strike, long decay. A symmetric sine blink looks mechanical; an
  // insect's flash snaps on and drains away.
  if (t < config.rise) return Math.pow(t / config.rise, 0.6);

  return Math.pow(1 - (t - config.rise) / (1 - config.rise), 1.9);
};

const advance = () => {
  for (const m of motes) {
    m.phase += 1 / m.period;
    if (m.phase >= 1) {
      m.phase -= 1;
      m.period = rand(config.period[0], config.period[1]);
    }

    // Sampling the noise field on a slowly sliding line gives each mote a
    // wandering, non-repeating heading without a third noise axis.
    const heading =
      noise2D(
        m.x * config.noiseScale + 17,
        m.y * config.noiseScale + frame * config.fieldDrift,
      ) *
      TAU *
      1.7;

    m.x += Math.cos(heading) * m.speed;
    m.y +=
      Math.sin(heading) * m.speed * 0.72 +
      Math.sin(frame * m.bobSpeed + m.seed) * config.bob;

    const pad = m.halo;
    if (m.x < -pad) m.x += width + pad * 2;
    else if (m.x > width + pad) m.x -= width + pad * 2;
    if (m.y < -pad) m.y += height + pad * 2;
    else if (m.y > height + pad) m.y -= height + pad * 2;
  }
};

const paintGround = () => {
  const breathe = 0.5 + 0.5 * Math.sin(frame * 0.0013);
  const ground = ctx.createLinearGradient(0, 0, 0, height);
  ground.addColorStop(0, `hsl(206, 44%, ${3.2 + breathe * 0.6}%)`);
  ground.addColorStop(0.4, `hsl(192, 40%, ${5.2 + breathe * 0.9}%)`);
  ground.addColorStop(
    config.horizonY,
    `hsl(160, 32%, ${7.4 + breathe * 1.3}%)`,
  );
  ground.addColorStop(0.86, "hsl(154, 30%, 3.6%)");
  ground.addColorStop(1, "hsl(150, 24%, 1.9%)");
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, width, height);

  const cx = width * (0.5 + 0.24 * Math.sin(frame * 0.00061));
  const cy = height * config.horizonY;
  const radius = Math.max(width, height) * 0.7;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  glow.addColorStop(0, "rgba(150, 214, 168, 0.13)");
  glow.addColorStop(0.28, "rgba(96, 168, 150, 0.055)");
  glow.addColorStop(0.65, "rgba(40, 82, 92, 0.02)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
};

const drawMotes = () => {
  ctx.globalCompositeOperation = "lighter";

  for (const m of motes) {
    const flash = envelope(m.phase);

    ctx.globalAlpha = clamp(
      config.haloAlpha * flash + config.ember * 0.4,
      0,
      1,
    );
    if (ctx.globalAlpha > 0.004) {
      const size = m.halo * (0.72 + flash * 0.5);
      ctx.drawImage(
        sprites[m.tint],
        m.x - size / 2,
        m.y - size / 2,
        size,
        size,
      );
    }

    ctx.globalAlpha = clamp(config.coreAlpha * flash + config.ember, 0, 1);
    ctx.fillStyle = "rgb(255, 248, 226)";
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.core * (0.55 + m.depth * 0.7), 0, TAU);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
};

// Out-of-focus foreground: the bottom of the frame sinks into darkness, so the
// motes that drift low are partly occluded and the scene gains real depth.
const paintForeground = () => {
  const fg = ctx.createLinearGradient(0, height * 0.55, 0, height);
  fg.addColorStop(0, "rgba(2, 5, 5, 0)");
  fg.addColorStop(0.62, "rgba(2, 5, 5, 0.42)");
  fg.addColorStop(1, "rgba(1, 3, 3, 0.86)");
  ctx.fillStyle = fg;
  ctx.fillRect(0, height * 0.55, width, height * 0.45);

  const radius = Math.hypot(width, height) * 0.66;
  const vignette = ctx.createRadialGradient(
    width * 0.5,
    height * 0.56,
    radius * 0.32,
    width * 0.5,
    height * 0.56,
    radius,
  );
  vignette.addColorStop(0, "rgba(1, 3, 4, 0)");
  vignette.addColorStop(1, "rgba(1, 3, 4, 0.68)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
};

const drawFrame = () => {
  frame += 1;
  if (!ctx || !noise2D || !sprites.length || width < 2 || height < 2) return;

  advance();

  paintGround();
  drawMotes();
  paintForeground();
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

  buildMotes();
};

const onResize = () => resize();

onMounted(() => {
  if (!holderRef.value || !canvasRef.value) return;

  ctx = canvasRef.value.getContext("2d", { alpha: false });
  if (!ctx) {
    console.error("FireflyMeadow: canvas 2d context unavailable");
    return;
  }

  noise2D = createNoise2D();
  buildSprites();
  resize();

  // Phases are randomised at placement, but letting the crowd walk a while
  // before the first paint breaks up the initial even scatter.
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
  sprites = [];
  motes = [];
});
</script>
