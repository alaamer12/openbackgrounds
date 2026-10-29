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
  // Emulsion is baked into a handful of tiles and stamped over the frame: one
  // ImageData pass per tile is far cheaper than per-pixel work on the main
  // canvas, and tiles let the grain clump instead of reading as TV snow.
  grainTile: 232,
  grainVariants: 6,
  grainPeak: 0.4,
  grainGamma: 1.55,
  // The whole grid jumps to a new random offset and tile mix every frame, so
  // the speckle boils like a printed stock instead of sitting like a screen
  // door. Tile size is in CSS px, so the grain keeps the same visible weight at
  // 640x400 and full viewport.
  grainAlpha: 0.62,
  breatheSpeed: 0.0016,
  lampSpeed: 0.0011,
  lampAlpha: 0.12,
  // Two gate bands on different periods so the rolling highlight never laps in
  // lockstep. Width is a fraction of the shorter edge for the same reason.
  gateA: { period: 940, width: 0.5, alpha: 0.085, angle: -0.36 },
  gateB: { period: 1610, width: 0.86, alpha: 0.05, angle: 0.52 },
  flickerAlpha: 0.026,
  vignette: 0.8,
  warmup: 46,
};

let ctx = null;
let tiles = [];
let frameId = null;
let frame = 0;
let width = 0;
let height = 0;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const makeGrainTile = () => {
  const size = config.grainTile;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const g = canvas.getContext("2d");
  if (!g) return canvas;

  const image = g.createImageData(size, size);
  const px = image.data;

  // A coarse random grid carries the clumps, fine randomness breaks it up.
  // Real emulsion is lumpy at a couple of scales at once.
  const blocks = Math.ceil(size / 3);
  const coarse = new Float32Array(blocks * blocks);
  for (let i = 0; i < coarse.length; i += 1) coarse[i] = Math.random() * 2 - 1;

  for (let y = 0; y < size; y += 1) {
    const row = (y / 3) | 0;
    for (let x = 0; x < size; x += 1) {
      const low = coarse[row * blocks + ((x / 3) | 0)];
      const v = clamp(low * 0.46 + (Math.random() * 2 - 1) * 0.56, -1, 1);
      const idx = (y * size + x) * 4;

      // Positive grains are warm silver, negative ones are clear base. Both
      // ride on the same alpha channel so one pass per cell does the job.
      if (v >= 0) {
        px[idx] = 255;
        px[idx + 1] = 243;
        px[idx + 2] = 219;
      } else {
        px[idx] = 7;
        px[idx + 1] = 5;
        px[idx + 2] = 9;
      }
      px[idx + 3] = Math.round(
        Math.pow(Math.abs(v), config.grainGamma) * config.grainPeak * 255,
      );
    }
  }

  g.putImageData(image, 0, 0);
  return canvas;
};

const buildTiles = () => {
  tiles = [];
  for (let i = 0; i < config.grainVariants; i += 1) tiles.push(makeGrainTile());
};

const paintGround = () => {
  const breathe = 0.5 + 0.5 * Math.sin(frame * config.breatheSpeed);
  const lift = 3.4 * breathe;

  const ground = ctx.createLinearGradient(0, 0, width * 0.22, height);
  ground.addColorStop(0, `hsl(33, 36%, ${9.4 + lift}%)`);
  ground.addColorStop(0.44, `hsl(27, 27%, ${6.2 + lift * 0.7}%)`);
  ground.addColorStop(1, `hsl(228, 22%, ${3.2 + lift * 0.35}%)`);
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, width, height);
};

const paintLamp = () => {
  const t = frame * config.lampSpeed;
  const cx = width * (0.5 + 0.32 * Math.sin(t));
  const cy = height * (0.46 + 0.28 * Math.sin(t * 1.37 + 2.1));
  const radius = Math.hypot(width, height) * 0.62;
  const pulse = 0.72 + 0.28 * Math.sin(frame * 0.0031);

  const lamp = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  lamp.addColorStop(0, `rgba(255, 208, 152, ${config.lampAlpha * pulse})`);
  lamp.addColorStop(0.34, `rgba(226, 168, 112, ${config.lampAlpha * 0.36})`);
  lamp.addColorStop(0.7, "rgba(120, 82, 58, 0.03)");
  lamp.addColorStop(1, "rgba(0, 0, 0, 0)");

  // Additive like the bands and the exposure lift, so the warm bloom and the
  // gate highlight stack instead of replacing each other: the caller owns the
  // composite mode.
  ctx.fillStyle = lamp;
  ctx.fillRect(0, 0, width, height);
};

// The band is a slab in the projected axis u = dir . p, so the gradient only
// needs the two ends of that axis and the frame is filled once.
const paintGate = (gate, phase) => {
  const dirX = Math.cos(gate.angle);
  const dirY = Math.sin(gate.angle);

  const corners = [
    0,
    dirX * width,
    dirY * height,
    dirX * width + dirY * height,
  ];
  const uMin = Math.min(...corners);
  const uMax = Math.max(...corners);

  const span = Math.min(width, height) * gate.width;
  const travel = (frame % gate.period) / gate.period;
  const u = uMin - span + travel * (uMax - uMin + span * 2) + phase;

  const band = ctx.createLinearGradient(
    dirX * (u - span),
    dirY * (u - span),
    dirX * (u + span),
    dirY * (u + span),
  );
  band.addColorStop(0, "rgba(255, 240, 216, 0)");
  band.addColorStop(0.42, `rgba(255, 233, 199, ${gate.alpha})`);
  band.addColorStop(0.62, `rgba(255, 224, 184, ${gate.alpha * 0.7})`);
  band.addColorStop(1, "rgba(255, 240, 216, 0)");

  ctx.fillStyle = band;
  ctx.fillRect(0, 0, width, height);
};

const paintFlicker = () => {
  // Three detuned sines stand in for the irregular exposure wobble of a gate.
  const wobble =
    Math.sin(frame * 0.21) * 0.5 +
    Math.sin(frame * 0.37 + 1.7) * 0.3 +
    Math.sin(frame * 1.31 + 0.4) * 0.2;

  ctx.fillStyle = `rgba(255, 232, 198, ${
    config.flickerAlpha * (0.55 + 0.45 * (0.5 + 0.5 * wobble))
  })`;
  ctx.fillRect(0, 0, width, height);
};

const paintVignette = () => {
  const radius = Math.hypot(width, height) * 0.68;
  const vignette = ctx.createRadialGradient(
    width * 0.5,
    height * 0.48,
    radius * 0.3,
    width * 0.5,
    height * 0.48,
    radius,
  );
  vignette.addColorStop(0, "rgba(4, 3, 6, 0)");
  vignette.addColorStop(0.62, "rgba(4, 3, 6, 0.16)");
  vignette.addColorStop(1, `rgba(3, 2, 5, ${config.vignette})`);
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
};

const paintGrain = () => {
  const size = config.grainTile;
  const ox = Math.floor(Math.random() * size);
  const oy = Math.floor(Math.random() * size);

  ctx.globalAlpha = config.grainAlpha;
  for (let y = -oy; y < height; y += size) {
    for (let x = -ox; x < width; x += size) {
      ctx.drawImage(tiles[(Math.random() * tiles.length) | 0], x, y);
    }
  }
  ctx.globalAlpha = 1;
};

const drawFrame = () => {
  frame += 1;
  if (!ctx || width < 2 || height < 2 || !tiles.length) return;

  paintGround();

  ctx.globalCompositeOperation = "lighter";
  paintLamp();
  paintGate(config.gateA, 0);
  paintGate(config.gateB, Math.min(width, height) * 0.4);
  paintFlicker();
  ctx.globalCompositeOperation = "source-over";

  // Vignette first: grain sits on top of it so the corners keep their texture
  // instead of turning into flat black.
  paintVignette();
  paintGrain();
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
  // Nearest-neighbour keeps single-pixel emulsion instead of a grey smear.
  ctx.imageSmoothingEnabled = false;
};

const onResize = () => resize();

onMounted(() => {
  if (!holderRef.value || !canvasRef.value) return;

  ctx = canvasRef.value.getContext("2d", { alpha: false });
  if (!ctx) {
    console.error("AnalogGrain: canvas 2d context unavailable");
    return;
  }

  buildTiles();
  resize();

  // Nothing accumulates, but the bands start off-frame at t = 0, so advance the
  // clock until the first one is already crossing the middle of the shot.
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
  tiles = [];
});
</script>
