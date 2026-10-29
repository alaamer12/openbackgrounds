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

// Survey-chart isolines over a drifting heightfield. Everything here is tuned
// for legibility at thumbnail size: a coarse level interval so the lines nest
// into rings around peaks and valleys, a fine enough sampling grid that those
// rings come out curved, and a hillshade/band fill quiet enough to stay out of
// the way of the ink.
const config = {
  maxDpr: 1.5,
  // Sampling cells for the whole surface: the grid gets finer on big viewports
  // and stays chunky on thumbnails, so the relief reads at both sizes. Small
  // enough that each isoline facet is invisible under a 2.9px index stroke.
  cells: 5200,
  minCell: 9,
  maxCell: 16,
  levels: 5,
  freq: 0.82, // noise wavelengths across the shorter canvas axis
  octave: 0.2,
  morph: 0.00022,
  creep: 0.05, // px per frame the terrain slides upward
  shadeStep: 1.2, // relief shading is a whisper; at 5.5 it was the static
  shadeGain: 14,
  lineWidth: 1.2,
  indexEvery: 2,
  indexWidth: 2.9,
  lineAlpha: 0.2,
  indexAlpha: 0.95,
  glowWidth: 5.0,
  glowAlpha: 0.05,
  bandAlpha: 0.24,
  lineSat: 34,
  lineLight: 54,
  indexHue: 42,
  indexSat: 62,
  indexLight: 82,
  warmup: 6,
};

// Hypsometric ramp: abyssal petrol through sea green and moss up to dry sand.
const STOPS = [
  { t: 0, h: 199, s: 62, l: 8 },
  { t: 0.22, h: 187, s: 58, l: 18 },
  { t: 0.42, h: 171, s: 48, l: 29 },
  { t: 0.58, h: 118, s: 32, l: 37 },
  { t: 0.73, h: 66, s: 40, l: 50 },
  { t: 0.87, h: 43, s: 55, l: 65 },
  { t: 1, h: 38, s: 68, l: 79 },
];

const TAU = Math.PI * 2;

let ctx = null;
let noise3D = null;
let heights = null;
let bandPaths = [];
let levelPaths = [];
let palette = [];
let lineColor = [];
let indexColor = [];
let frameId = null;
let frame = 0;
let width = 0;
let height = 0;
let cell = 16;
let cols = 2;
let rows = 2;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const sampleStops = (t) => {
  const value = clamp(t, 0, 1);
  for (let i = 1; i < STOPS.length; i += 1) {
    const a = STOPS[i - 1];
    const b = STOPS[i];
    if (value <= b.t || i === STOPS.length - 1) {
      const span = Math.max(0.0001, b.t - a.t);
      const k = clamp((value - a.t) / span, 0, 1);
      return {
        h: a.h + (b.h - a.h) * k,
        s: a.s + (b.s - a.s) * k,
        l: a.l + (b.l - a.l) * k,
      };
    }
  }
  return { h: STOPS[0].h, s: STOPS[0].s, l: STOPS[0].l };
};

const buildPalette = () => {
  const bands = config.levels + 1;

  palette = [];
  lineColor = [];
  indexColor = [];

  for (let b = 0; b < bands; b += 1) {
    const colour = sampleStops(b / config.levels);
    const shades = [];
    for (let s = 0; s < 3; s += 1) {
      const light = clamp(colour.l + (s - 1) * config.shadeStep, 3, 92);
      shades.push(
        `hsl(${colour.h.toFixed(1)}, ${colour.s.toFixed(1)}%, ${light.toFixed(1)}%)`,
      );
    }
    palette.push(shades);
    // Minor contours keep only a hint of the hypsometric hue: at 96% saturation
    // a whole sheet of them reads as coloured static. The index contours are the
    // ones doing the survey-chart talking, so they get the warm buff ink.
    lineColor.push(
      `hsl(${(colour.h + 6).toFixed(1)}, ${config.lineSat}%, ${clamp(
        colour.l + 30,
        34,
        config.lineLight,
      ).toFixed(1)}%)`,
    );
    indexColor.push(
      `hsl(${(config.indexHue + (b / bands) * 14).toFixed(1)}, ${config.indexSat}%, ${config.indexLight}%)`,
    );
  }
};

const buildScene = () => {
  const area = Math.max(1, width * height);
  cell = clamp(Math.sqrt(area / config.cells), config.minCell, config.maxCell);

  cols = Math.ceil(width / cell) + 1;
  rows = Math.ceil(height / cell) + 1;
  heights = new Float32Array(cols * rows);

  const bands = config.levels + 1;
  bandPaths = [];
  for (let b = 0; b < bands; b += 1)
    for (let s = 0; s < 3; s += 1) bandPaths.push(new Path2D());

  levelPaths = [];
  for (let l = 0; l < config.levels; l += 1) levelPaths.push(new Path2D());
};

const sampleHeights = (time, creep) => {
  const short = Math.max(1, Math.min(width, height));
  const scale = (TAU * config.freq) / short;

  for (let j = 0; j < rows; j += 1) {
    const ny = (j * cell - creep) * scale;
    for (let i = 0; i < cols; i += 1) {
      const nx = i * cell * scale;
      let n = noise3D(nx, ny, time);
      n +=
        config.octave * noise3D(nx * 2.17 + 31.4, ny * 2.17 + 12.7, time * 1.6);
      heights[j * cols + i] = clamp(0.5 + n * 0.34, 0, 1);
    }
  }
};

const fillBands = () => {
  for (let p = 0; p < bandPaths.length; p += 1) bandPaths[p] = new Path2D();

  const bands = config.levels + 1;
  const gain = config.shadeGain / Math.max(1, cell);
  const lx = -0.58;
  const ly = -0.81;

  for (let j = 0; j < rows - 1; j += 1) {
    const top = j * cols;
    const bottom = top + cols;
    const y = j * cell;

    for (let i = 0; i < cols - 1; i += 1) {
      const tl = heights[top + i];
      const tr = heights[top + i + 1];
      const bl = heights[bottom + i];
      const br = heights[bottom + i + 1];

      const mean = (tl + tr + bl + br) * 0.25;
      const band = clamp(Math.floor(mean * bands), 0, bands - 1);

      const dhdx = (tr + br - tl - bl) * 0.5 * gain;
      const dhdy = (bl + br - tl - tr) * 0.5 * gain;
      const shade = clamp(
        Math.floor((0.5 + (dhdx * lx + dhdy * ly) * 0.5) * 3),
        0,
        2,
      );

      const path = bandPaths[band * 3 + shade];
      // Snapped to whole pixels so neighbouring cells tile with neither the
      // overlap (which double-blends and prints a grid) nor a sub-pixel seam.
      const x0 = Math.round(i * cell);
      const x1 = Math.round((i + 1) * cell);
      const y0 = Math.round(y);
      const y1 = Math.round(y + cell);
      path.rect(x0, y0, x1 - x0, y1 - y0);
    }
  }

  ctx.globalAlpha = config.bandAlpha;
  for (let b = 0; b < bandPaths.length; b += 1) {
    ctx.fillStyle = palette[Math.floor(b / 3)][b % 3];
    ctx.fill(bandPaths[b]);
  }
  ctx.globalAlpha = 1;
};

// Interpolation fraction along a cell edge. The zero-guard has to preserve the
// sign: `Math.max(1e-6, b - a)` silently replaces every *descending* edge with
// +1e-6, so (value - a) / 1e-6 reaches hundreds of thousands of pixels and each
// descending crossing draws a straight line flung across the whole canvas. That
// is what made the sheet read as near-parallel static instead of topography.
const edgeFraction = (a, b, value) => {
  const delta = b - a;
  if (Math.abs(delta) < 1e-6) return 0;
  return clamp((value - a) / delta, 0, 1);
};

const edgeX = (a, b, value, x) => x + edgeFraction(a, b, value) * cell;
const edgeY = (a, b, value, y) => y + edgeFraction(a, b, value) * cell;

const traceContours = () => {
  for (let l = 0; l < config.levels; l += 1) levelPaths[l] = new Path2D();

  for (let j = 0; j < rows - 1; j += 1) {
    const top = j * cols;
    const bottom = top + cols;
    const y = j * cell;

    for (let i = 0; i < cols - 1; i += 1) {
      const cx = i * cell;

      for (let l = 0; l < config.levels; l += 1) {
        const value = (l + 1) / (config.levels + 1);

        const tl = heights[top + i];
        const tr = heights[top + i + 1];
        const bl = heights[bottom + i];
        const br = heights[bottom + i + 1];

        let code = 0;
        if (tl > value) code |= 8;
        if (tr > value) code |= 4;
        if (br > value) code |= 2;
        if (bl > value) code |= 1;
        if (code === 0 || code === 15) continue;

        const path = levelPaths[l];
        const topX = edgeX(tl, tr, value, cx);
        const rightY = edgeY(tr, br, value, y);
        const bottomX = edgeX(bl, br, value, cx);
        const leftY = edgeY(tl, bl, value, y);

        switch (code) {
          case 1:
          case 14:
            path.moveTo(cx, leftY);
            path.lineTo(bottomX, y + cell);
            break;
          case 2:
          case 13:
            path.moveTo(bottomX, y + cell);
            path.lineTo(cx + cell, rightY);
            break;
          case 3:
          case 12:
            path.moveTo(cx, leftY);
            path.lineTo(cx + cell, rightY);
            break;
          case 4:
          case 11:
            path.moveTo(topX, y);
            path.lineTo(cx + cell, rightY);
            break;
          case 6:
          case 9:
            path.moveTo(topX, y);
            path.lineTo(bottomX, y + cell);
            break;
          case 7:
          case 8:
            path.moveTo(topX, y);
            path.lineTo(cx, leftY);
            break;
          case 5:
            path.moveTo(topX, y);
            path.lineTo(cx, leftY);
            path.moveTo(bottomX, y + cell);
            path.lineTo(cx + cell, rightY);
            break;
          case 10:
            path.moveTo(topX, y);
            path.lineTo(cx + cell, rightY);
            path.moveTo(cx, leftY);
            path.lineTo(bottomX, y + cell);
            break;
          default:
            break;
        }
      }
    }
  }

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Minor contours first, index contours over them: the bold lines have to win
  // wherever the two touch or the sheet stops reading as a chart. The halo is an
  // index-only luxury; a hundred feet of it is what made the last pass mush.
  for (let l = 0; l < config.levels; l += 1) {
    if ((l + 1) % config.indexEvery === 0) continue;

    ctx.globalAlpha = config.lineAlpha;
    ctx.strokeStyle = lineColor[l];
    ctx.lineWidth = config.lineWidth;
    ctx.stroke(levelPaths[l]);
  }

  for (let l = 0; l < config.levels; l += 1) {
    if ((l + 1) % config.indexEvery !== 0) continue;

    ctx.globalAlpha = config.glowAlpha;
    ctx.strokeStyle = indexColor[l];
    ctx.lineWidth = config.glowWidth;
    ctx.stroke(levelPaths[l]);

    ctx.globalAlpha = config.indexAlpha;
    ctx.lineWidth = config.indexWidth;
    ctx.stroke(levelPaths[l]);
  }

  ctx.globalAlpha = 1;
};

const paintDepth = () => {
  // Aerial perspective: the far corner sinks into the ground while the near
  // relief stays saturated, which stops the flat bands reading as a swatch.
  ctx.globalCompositeOperation = "multiply";
  const depth = ctx.createLinearGradient(0, 0, width * 0.45, height);
  depth.addColorStop(0, "rgba(196, 206, 218, 0.42)");
  depth.addColorStop(0.5, "rgba(120, 134, 152, 0.6)");
  depth.addColorStop(1, "rgba(48, 54, 70, 0.82)");
  ctx.fillStyle = depth;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = "source-over";
};

const paintVignette = () => {
  const radius = Math.max(width, height) * 0.8;
  const vignette = ctx.createRadialGradient(
    width * 0.42,
    height * 0.44,
    radius * 0.26,
    width * 0.42,
    height * 0.44,
    radius,
  );
  vignette.addColorStop(0, "rgba(2, 6, 10, 0)");
  vignette.addColorStop(1, "rgba(2, 6, 10, 0.52)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
};

const drawFrame = () => {
  frame += 1;

  const time = frame * config.morph;
  const creep = frame * config.creep;

  ctx.fillStyle = "#020409";
  ctx.fillRect(0, 0, width, height);

  sampleHeights(time, creep);
  fillBands();
  paintDepth();
  traceContours();
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
    console.error("ContourMap: canvas 2d context unavailable");
    return;
  }

  noise3D = createNoise3D();

  buildPalette();
  resize();

  // Every frame is recomputed from scratch, so a handful of primed frames is
  // enough to land on a non-degenerate part of the noise volume.
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
  heights = null;
  bandPaths = [];
  levelPaths = [];
  palette = [];
  lineColor = [];
  indexColor = [];
});
</script>
