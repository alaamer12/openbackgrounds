<template>
  <div ref="holderRef" class="absolute inset-0 pointer-events-none">
    <canvas ref="canvasRef" class="block w-full h-full" />
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import { createNoise3D } from "simplex-noise";

const holderRef = ref(null);
const canvasRef = ref(null);

const fpsMeter = useFpsMeter();

const config = {
  maxDpr: 1.5,
  puffArea: 3000,
  minPuffs: 80,
  maxPuffs: 460,
  strands: [0.22, 0.47, 0.71, 0.88],
  emitterY: 1.04,
  radiusRange: [0.038, 0.09],
  grow: 2.5,
  // Rise is a fraction of canvas height per frame, so a parcel crosses roughly
  // the whole frame in one life at thumbnail scale as well as full viewport.
  riseShare: 0.0021,
  life: [360, 620],
  noiseScale: 0.0021,
  epsilon: 7,
  // The curl of a scalar noise field is divergence free, which is what keeps
  // the ribbons from collapsing into a single point: the puffs shear and roll
  // instead of piling up.
  swirl: 320,
  evolution: 0.0009,
  spread: 0.16,
  puffAlpha: 0.58,
  warmup: 300,
};

const TINTS = ["178, 170, 208", "150, 158, 196", "204, 190, 214"];

let ctx = null;
let noise3D = null;
let sprites = [];
let strands = [];
let puffs = [];
let frameId = null;
let frame = 0;
let width = 0;
let height = 0;
let rise = 1;

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const makePuff = (rgb, soft) => {
  const size = 128;
  const half = size / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const s = canvas.getContext("2d");
  if (!s) return canvas;

  // Two falloff families: a baggy cloud and a tighter core. Mixing them stops
  // the plume reading as a stack of identical bubbles.
  const glow = s.createRadialGradient(half, half, 0, half, half, half);
  if (soft) {
    glow.addColorStop(0, `rgba(${rgb}, 0.66)`);
    glow.addColorStop(0.3, `rgba(${rgb}, 0.4)`);
    glow.addColorStop(0.58, `rgba(${rgb}, 0.19)`);
    glow.addColorStop(0.82, `rgba(${rgb}, 0.055)`);
    glow.addColorStop(1, `rgba(${rgb}, 0)`);
  } else {
    glow.addColorStop(0, `rgba(${rgb}, 0.84)`);
    glow.addColorStop(0.16, `rgba(${rgb}, 0.52)`);
    glow.addColorStop(0.4, `rgba(${rgb}, 0.24)`);
    glow.addColorStop(0.7, `rgba(${rgb}, 0.06)`);
    glow.addColorStop(1, `rgba(${rgb}, 0)`);
  }
  s.fillStyle = glow;
  s.fillRect(0, 0, size, size);

  return canvas;
};

const buildSprites = () => {
  sprites = [];
  for (const tint of TINTS) {
    sprites.push(makePuff(tint, false));
    sprites.push(makePuff(tint, true));
  }
};

const buildStrands = () => {
  strands = config.strands.map((fraction, index) => ({
    x: width * fraction,
    y: height * config.emitterY,
    seed: index * 37.13,
    bias: rand(-0.22, 0.34),
  }));
};

const puffRadius = (puff, t) =>
  puff.r0 * (1 + (config.grow - 1) * t) * (0.6 + puff.depth * 0.8);

const respawn = (puff, strand, ageFrac) => {
  const t = clamp(ageFrac, 0, 1);

  puff.strand = strand;
  puff.life = rand(config.life[0], config.life[1]);
  puff.age = t * puff.life;
  puff.depth = rand(0.35, 1);
  puff.r0 =
    Math.max(1, Math.sqrt(width * height)) *
    (config.radiusRange[0] +
      Math.random() * (config.radiusRange[1] - config.radiusRange[0]));
  puff.sprite = (Math.random() * sprites.length) | 0;
  puff.wobble = rand(0.004, 0.013);
  puff.seed = rand(0, 90);
  puff.alpha = config.puffAlpha * rand(0.62, 1);

  // Emission jitter is deliberately tiny: puffs leave almost on the axis and
  // the curl field is what fans them out into a ribbon. Seeded puffs are spread
  // across the column by the same profile the rise will actually follow.
  const column = t > 0 ? width * config.spread * t * 0.8 : width * 0.012;
  puff.x = strand.x + rand(-column, column) + strand.bias * t * width * 0.06;
  puff.y = strand.y - puff.age * rise * (0.5 + 0.5 * puff.depth);

  return puff;
};

const buildPuffs = () => {
  const count = clamp(
    Math.round((width * height) / config.puffArea),
    config.minPuffs,
    config.maxPuffs,
  );
  const perStrand = Math.max(1, Math.ceil(count / strands.length));

  puffs = [];
  for (let i = 0; i < count; i += 1) {
    const strand = strands[i % strands.length];
    const slot = Math.floor(i / strands.length);

    puffs.push(respawn({}, strand, slot / perStrand));
  }
};

const advance = (puff) => {
  const s = config.noiseScale;
  const e = config.epsilon;
  const t = frame * config.evolution;

  const n1 = noise3D((puff.x + e) * s, puff.y * s, t);
  const n0 = noise3D((puff.x - e) * s, puff.y * s, t);
  const m1 = noise3D(puff.x * s, (puff.y + e) * s, t);
  const m0 = noise3D(puff.x * s, (puff.y - e) * s, t);

  const vx = ((m1 - m0) / (2 * e)) * config.swirl;
  const vy = -((n1 - n0) / (2 * e)) * config.swirl;

  const age = clamp(puff.age / puff.life, 0, 1);

  // Buoyancy fades as the parcel cools and entrains air, so the plume slows
  // and spreads on its way up instead of shooting off frame.
  puff.x += vx + Math.sin(puff.age * puff.wobble + puff.seed) * 0.14;
  puff.y += vy - rise * (0.42 + 0.58 * (1 - age)) * (0.6 + puff.depth * 0.7);

  puff.age += 1;

  const r = puffRadius(puff, age);
  if (
    puff.age > puff.life ||
    puff.y < -r * 1.4 ||
    puff.x < -r * 2 ||
    puff.x > width + r * 2
  ) {
    respawn(puff, puff.strand, 0);
  }
};

const paintGround = () => {
  const ground = ctx.createLinearGradient(0, height, width * 0.3, 0);
  ground.addColorStop(0, "hsl(258, 26%, 7.6%)");
  ground.addColorStop(0.45, "hsl(250, 24%, 5.2%)");
  ground.addColorStop(1, "hsl(232, 22%, 3.4%)");
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, width, height);

  // A single cool key light high in the frame: smoke only reads as smoke when
  // there is something behind it to break.
  const gx = width * (0.6 + 0.05 * Math.sin(frame * 0.0007));
  const gy = height * 0.2;
  const radius = Math.max(width, height) * 0.66;
  const key = ctx.createRadialGradient(gx, gy, 0, gx, gy, radius);
  key.addColorStop(0, "rgba(128, 132, 190, 0.1)");
  key.addColorStop(0.42, "rgba(78, 74, 128, 0.04)");
  key.addColorStop(1, "rgba(0, 0, 0, 0)");

  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = key;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = "source-over";
};

const drawPuffs = () => {
  // source-over rather than lighter: overlapping translucent veils converge on
  // the sprite colour, which caps the plume at a mid grey. Additive stacking is
  // what would turn this into white mud.
  for (const puff of puffs) {
    const age = clamp(puff.age / puff.life, 0, 1);
    const env = Math.pow(Math.sin(Math.PI * age), 1.25);
    if (env <= 0.004) continue;

    const size = puffRadius(puff, age) * 2;
    ctx.globalAlpha = clamp(puff.alpha * env, 0, 0.5);
    ctx.drawImage(
      sprites[puff.sprite],
      puff.x - size / 2,
      puff.y - size / 2,
      size,
      size,
    );
  }

  ctx.globalAlpha = 1;
};

const paintVeil = () => {
  const veil = ctx.createLinearGradient(0, 0, 0, height);
  veil.addColorStop(0, "rgba(3, 3, 9, 0.55)");
  veil.addColorStop(0.3, "rgba(4, 4, 10, 0.1)");
  veil.addColorStop(0.82, "rgba(3, 3, 8, 0.16)");
  veil.addColorStop(1, "rgba(2, 2, 6, 0.7)");
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, width, height);

  const radius = Math.hypot(width, height) * 0.64;
  const vignette = ctx.createRadialGradient(
    width * 0.5,
    height * 0.5,
    radius * 0.3,
    width * 0.5,
    height * 0.5,
    radius,
  );
  vignette.addColorStop(0, "rgba(2, 2, 6, 0)");
  vignette.addColorStop(1, "rgba(2, 2, 6, 0.62)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
};

const drawFrame = () => {
  frame += 1;
  if (!ctx || !noise3D || !sprites.length || width < 2 || height < 2) return;

  for (const puff of puffs) advance(puff);

  paintGround();
  drawPuffs();
  paintVeil();
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

  rise = height * config.riseShare;
  buildStrands();
  buildPuffs();
};

const onResize = () => resize();

onMounted(() => {
  if (!holderRef.value || !canvasRef.value) return;

  ctx = canvasRef.value.getContext("2d", { alpha: false });
  if (!ctx) {
    console.error("SmokeWisps: canvas 2d context unavailable");
    return;
  }

  noise3D = createNoise3D();
  buildSprites();
  resize();

  // The seeding above only approximates the column; these frames let the curl
  // field take the puffs onto real paths so the ribbons are formed on frame 1.
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
  noise3D = null;
  sprites = [];
  strands = [];
  puffs = [];
});
</script>
