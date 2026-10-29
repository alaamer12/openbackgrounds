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
  // Canvas area per node: the graph keeps the same look at 640x400 and at
  // full viewport instead of turning into soup on small surfaces.
  nodeArea: 7600,
  minNodes: 42,
  maxNodes: 460,
  // Link radius as a multiple of the mean nearest-neighbour distance. Below
  // ~1.1 the net breaks apart, above ~1.4 every node touches half the field.
  linkSpan: 1.24,
  linkWidth: 1.25,
  linkAlpha: [0.16, 0.62],
  linkBuckets: 5,
  dustArea: 2900,
  dustBuckets: 3,
  drift: 0.34,
  sway: 0.42,
  noiseScale: 0.0016,
  timeScale: 0.0038,
  starGlow: 7.4,
  vignette: 0.62,
  warmup: 120,
};

const TAU = Math.PI * 2;
const DEPTHS = [0.3, 0.62, 1];

let ctx = null;
let noise2D = null;
let starSprite = null;
let flareSprite = null;
let nodes = [];
let dust = [];
let grid = [];
let gridCols = 1;
let gridRows = 1;
let linkDist = 120;
let frameId = null;
let frame = 0;
let width = 0;
let height = 0;

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const pickDepth = () => {
  const roll = Math.random();
  if (roll < 0.44) return DEPTHS[0];
  if (roll < 0.82) return DEPTHS[1];
  return DEPTHS[2];
};

const placeNode = (node) => {
  node.x = Math.random() * width;
  node.y = Math.random() * height;
  node.depth = pickDepth();
  node.seed = Math.random() * 640;
  node.dir = Math.random() * TAU;
  node.speed = config.drift * (0.42 + node.depth * 0.9);
  node.size = rand(1.35, 2.25) + node.depth * 2.05;
  node.pulseSpeed = rand(0.011, 0.031);
  node.phase = Math.random() * TAU;
  node.flare = node.depth > 0.9 && Math.random() < 0.5;
  return node;
};

const makeSprite = (withFlare) => {
  const size = 64;
  const half = size / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const s = canvas.getContext("2d");
  if (!s) return canvas;

  const glow = s.createRadialGradient(half, half, 0, half, half, half);
  glow.addColorStop(0, "rgba(255, 255, 255, 1)");
  glow.addColorStop(0.09, "rgba(238, 247, 255, 0.94)");
  glow.addColorStop(0.22, "rgba(186, 216, 255, 0.44)");
  glow.addColorStop(0.46, "rgba(140, 178, 240, 0.14)");
  glow.addColorStop(1, "rgba(120, 160, 230, 0)");
  s.fillStyle = glow;
  s.fillRect(0, 0, size, size);

  if (withFlare) {
    s.globalCompositeOperation = "lighter";
    for (let k = 0; k < 2; k += 1) {
      s.save();
      s.translate(half, half);
      s.rotate((k * Math.PI) / 2);
      const spike = s.createLinearGradient(0, 0, half, 0);
      spike.addColorStop(0, "rgba(226, 240, 255, 0.7)");
      spike.addColorStop(0.35, "rgba(200, 222, 255, 0.22)");
      spike.addColorStop(1, "rgba(180, 208, 255, 0)");
      s.fillStyle = spike;
      s.fillRect(0, -0.8, half, 1.6);
      s.fillStyle = spike;
      s.save();
      s.rotate(Math.PI);
      s.fillRect(0, -0.8, half, 1.6);
      s.restore();
      s.restore();
    }
  }

  return canvas;
};

const buildScene = () => {
  const area = Math.max(1, width * height);
  const count = clamp(
    Math.round(area / config.nodeArea),
    config.minNodes,
    config.maxNodes,
  );

  linkDist = config.linkSpan * Math.sqrt(area / count);

  nodes = [];
  for (let i = 0; i < count; i += 1) nodes.push(placeNode({}));

  const dustCount = clamp(Math.round(area / config.dustArea), 90, 1500);
  const buckets = config.dustBuckets;
  dust = [];
  for (let b = 0; b < buckets; b += 1) dust.push([]);
  for (let i = 0; i < dustCount; i += 1) {
    const level = Math.floor(Math.pow(Math.random(), 1.6) * buckets);
    dust[level].push({
      x: Math.random() * width,
      y: Math.random() * height,
      s: rand(1.3, 2.2),
    });
  }
};

const paintBase = () => {
  const sky = ctx.createLinearGradient(0, 0, width * 0.4, height);
  sky.addColorStop(0, "#060b1e");
  sky.addColorStop(0.5, "#04081c");
  sky.addColorStop(1, "#01030c");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = "lighter";

  const halo = ctx.createRadialGradient(
    width * 0.74,
    height * 0.2,
    0,
    width * 0.74,
    height * 0.2,
    Math.max(width, height) * 0.68,
  );
  halo.addColorStop(0, "rgba(28, 58, 122, 0.26)");
  halo.addColorStop(0.55, "rgba(16, 32, 78, 0.1)");
  halo.addColorStop(1, "rgba(6, 10, 26, 0)");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, width, height);

  const pool = ctx.createRadialGradient(
    width * 0.16,
    height * 0.86,
    0,
    width * 0.16,
    height * 0.86,
    Math.max(width, height) * 0.55,
  );
  pool.addColorStop(0, "rgba(40, 22, 86, 0.2)");
  pool.addColorStop(1, "rgba(8, 6, 24, 0)");
  ctx.fillStyle = pool;
  ctx.fillRect(0, 0, width, height);

  for (let b = 0; b < dust.length; b += 1) {
    const alpha = 0.4 + (b / Math.max(1, dust.length - 1)) * 0.4;
    ctx.fillStyle = `rgba(198, 218, 255, ${alpha})`;
    for (const d of dust[b]) ctx.fillRect(d.x, d.y, d.s, d.s);
  }

  ctx.globalCompositeOperation = "source-over";
};

const advance = (t) => {
  for (const n of nodes) {
    const wiggle = noise2D(
      n.x * config.noiseScale + n.seed,
      n.y * config.noiseScale + t * 0.5,
    );

    const angle = n.dir + wiggle * TAU * config.sway;
    n.x += Math.cos(angle) * n.speed;
    n.y += Math.sin(angle) * n.speed;

    const pad = 24;
    if (n.x < -pad) n.x += width + pad * 2;
    else if (n.x > width + pad) n.x -= width + pad * 2;
    if (n.y < -pad) n.y += height + pad * 2;
    else if (n.y > height + pad) n.y -= height + pad * 2;
  }
};

const bucketPaths = [];

const linkNodes = () => {
  const cell = linkDist;
  gridCols = Math.max(1, Math.ceil(width / cell));
  gridRows = Math.max(1, Math.ceil(height / cell));
  const cells = gridCols * gridRows;

  if (grid.length !== cells) grid = new Array(cells);
  for (let i = 0; i < cells; i += 1) {
    if (grid[i]) grid[i].length = 0;
    else grid[i] = [];
  }

  for (const n of nodes) {
    const gx = clamp(Math.floor(n.x / cell), 0, gridCols - 1);
    const gy = clamp(Math.floor(n.y / cell), 0, gridRows - 1);
    grid[gy * gridCols + gx].push(n);
  }

  const buckets = config.linkBuckets;
  for (let i = 0; i < buckets; i += 1) bucketPaths[i] = new Path2D();

  const offsets = [
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];

  for (let gy = 0; gy < gridRows; gy += 1) {
    for (let gx = 0; gx < gridCols; gx += 1) {
      const source = grid[gy * gridCols + gx];
      if (!source.length) continue;

      for (let i = 0; i < source.length; i += 1) {
        const a = source[i];

        for (let j = i + 1; j < source.length; j += 1) tryLink(a, source[j]);

        for (const [dx, dy] of offsets) {
          const ox = gx + dx;
          const oy = gy + dy;
          if (ox < 0 || oy < 0 || ox >= gridCols || oy >= gridRows) continue;
          const target = grid[oy * gridCols + ox];
          for (let j = 0; j < target.length; j += 1) tryLink(a, target[j]);
        }
      }
    }
  }

  ctx.globalCompositeOperation = "lighter";
  ctx.lineWidth = config.linkWidth;

  for (let b = 0; b < buckets; b += 1) {
    const t = (b + 1) / buckets;
    const alpha =
      config.linkAlpha[0] +
      (config.linkAlpha[1] - config.linkAlpha[0]) * Math.pow(t, 1.5);
    ctx.strokeStyle = `rgba(186, 214, 255, ${alpha})`;
    ctx.stroke(bucketPaths[b]);
  }
};

const tryLink = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return;

  // Pairs in the far layer only connect when they are closer together, which
  // keeps the foreground net readable instead of a uniform grey web.
  const span = linkDist * (0.62 + 0.38 * ((a.depth + b.depth) / 2));
  if (dist > span) return;

  const fall = 1 - dist / span;
  const bucket = clamp(
    Math.floor(fall * config.linkBuckets),
    0,
    config.linkBuckets - 1,
  );

  const path = bucketPaths[bucket];
  path.moveTo(a.x, a.y);
  path.lineTo(b.x, b.y);
};

const drawNodes = () => {
  ctx.globalCompositeOperation = "lighter";

  for (const n of nodes) {
    const pulse =
      0.62 +
      0.38 * Math.sin(frame * n.pulseSpeed + n.phase) +
      0.1 * Math.sin(frame * n.pulseSpeed * 2.7 + n.seed);

    const size = n.size * config.starGlow * clamp(pulse, 0.35, 1.35);
    const alpha = clamp(0.3 + n.depth * 0.55 * pulse, 0.28, 0.95);

    ctx.globalAlpha = alpha;
    ctx.drawImage(
      n.flare && pulse > 0.8 ? flareSprite : starSprite,
      n.x - size / 2,
      n.y - size / 2,
      size,
      size,
    );
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
};

const paintVignette = () => {
  const radius = Math.max(width, height) * 0.78;
  const vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    radius * 0.32,
    width / 2,
    height / 2,
    radius,
  );
  vignette.addColorStop(0, "rgba(2, 4, 14, 0)");
  vignette.addColorStop(1, `rgba(2, 4, 14, ${config.vignette})`);
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
};

const drawFrame = () => {
  frame += 1;
  const t = frame * config.timeScale;

  advance(t);
  paintBase();
  linkNodes();
  drawNodes();
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
  ctx.lineCap = "round";

  buildScene();
};

const onResize = () => resize();

onMounted(() => {
  if (!holderRef.value || !canvasRef.value) return;

  ctx = canvasRef.value.getContext("2d", { alpha: false });
  if (!ctx) {
    console.error("ConstellationNet: canvas 2d context unavailable");
    return;
  }

  noise2D = createNoise2D();
  starSprite = makeSprite(false);
  flareSprite = makeSprite(true);

  resize();

  // The net is only interesting once the nodes have separated into clumps and
  // filaments, so let the drift run before the first painted frame.
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
  starSprite = null;
  flareSprite = null;
  nodes = [];
  dust = [];
  grid = [];
  bucketPaths.length = 0;
});
</script>
