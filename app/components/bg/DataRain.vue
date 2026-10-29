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
  // Column pitch is absolute, so a small canvas gets fewer, chunkier columns
  // and a wide viewport gets a denser downpour: the rain always fills the
  // frame instead of beading out or turning into dust.
  layers: [
    {
      cell: 31,
      font: 21,
      speed: [0.95, 2.15],
      tail: [8, 14],
      alpha: 1,
      hue: 152,
      glow: 3.2,
    },
    {
      cell: 21,
      font: 13.5,
      speed: [0.6, 1.4],
      tail: [5, 10],
      alpha: 0.66,
      hue: 165,
      glow: 2.4,
    },
    {
      cell: 14,
      font: 9.5,
      speed: [0.35, 0.9],
      tail: [3, 7],
      alpha: 0.42,
      hue: 178,
      glow: 0,
    },
  ],
  bodyLight: 56,
  headLight: 93,
  rowPitch: 1.14,
  tailCurve: 1.5,
  flicker: 0.05,
  burnChance: 0.0038,
  burnFrames: 56,
  sweepWidth: 200,
  sweepGain: 0.55,
  sweepSpeed: 0.7,
  warmup: 70,
};

const FONT =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace';

// Alphanumeric plus a few greek glyphs: reads as telemetry rather than the
// katakana rain people expect, and stays legible at 9px.
const GLYPHS = (
  "0123456789" +
  "ABCDEFGHKLMNPRSTUVXZ" +
  "#%&*+-<=>[]|/:" +
  "\u03bb\u03a3\u0394\u03a9\u03a6\u03a8\u03c0\u03be\u03bc\u03b8"
).split("");

let ctx = null;
let layers = [];
let frameId = null;
let frame = 0;
let width = 0;
let height = 0;

const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const randGlyph = () => Math.floor(Math.random() * GLYPHS.length);

let probe = null;

// Monospace advance width measured once per size; falling back to the classic
// 0.6 em ratio keeps the layout sane if a browser refuses to measure.
const measureAdvance = (font) => {
  if (!probe) {
    const canvas = document.createElement("canvas");
    probe = canvas.getContext("2d");
  }
  if (probe) {
    probe.font = `${font}px ${FONT}`;
    const measured = probe.measureText("M").width;
    if (measured > 1) return Math.ceil(measured);
  }
  return Math.max(2, Math.ceil(font * 0.62));
};

// Glyphs are blitted out of a pre-rendered strip: a few thousand fillText
// calls per frame would own the budget, drawImage does not come close.
const buildAtlas = (font, light, hue, advance, tileHeight) => {
  const canvas = document.createElement("canvas");
  canvas.width = advance * GLYPHS.length;
  canvas.height = tileHeight;

  const s = canvas.getContext("2d");
  if (!s) return canvas;

  s.font = `${font}px ${FONT}`;
  s.textAlign = "center";
  s.textBaseline = "middle";
  s.fillStyle = `hsl(${hue}, 94%, ${light}%)`;

  for (let i = 0; i < GLYPHS.length; i += 1) {
    s.fillText(GLYPHS[i], i * advance + advance / 2, tileHeight / 2);
  }

  return canvas;
};

const buildGlow = (hue) => {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const s = canvas.getContext("2d");
  if (!s) return canvas;

  const glow = s.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, `hsla(${hue}, 100%, 88%, 0.9)`);
  glow.addColorStop(0.18, `hsla(${hue}, 100%, 70%, 0.4)`);
  glow.addColorStop(0.5, `hsla(${hue}, 100%, 50%, 0.11)`);
  glow.addColorStop(1, `hsla(${hue}, 100%, 44%, 0)`);
  s.fillStyle = glow;
  s.fillRect(0, 0, size, size);

  return canvas;
};

const placeColumn = (column, layer, seeded) => {
  column.tail = Math.round(rand(layer.tail[0], layer.tail[1]));
  column.glyphs = new Int16Array(column.tail + 3);
  for (let i = 0; i < column.glyphs.length; i += 1)
    column.glyphs[i] = randGlyph();

  column.speed = rand(layer.speed[0], layer.speed[1]);
  column.gain = rand(0.7, 1.25);
  column.ptr = Math.floor(Math.random() * column.glyphs.length);
  column.burn = 0;

  if (seeded) {
    column.head = rand(-column.tail * layer.pitch, height * 0.94);
  } else {
    column.head = rand(-column.tail * layer.pitch * 2, -layer.pitch);
  }
  column.row = Math.floor(column.head / layer.pitch);

  return column;
};

const buildScene = () => {
  layers = config.layers.map((settings) => {
    const pitch = Math.max(4, settings.font * config.rowPitch);
    const advance = measureAdvance(settings.font);
    const tileHeight = Math.ceil(pitch * 1.5);

    const layer = {
      cell: settings.cell,
      font: settings.font,
      alpha: settings.alpha,
      hue: settings.hue,
      tail: settings.tail,
      speed: settings.speed,
      glow: settings.glow,
      pitch,
      advance,
      tileHeight,
      body: buildAtlas(
        settings.font,
        config.bodyLight,
        settings.hue,
        advance,
        tileHeight,
      ),
      hot: buildAtlas(
        settings.font,
        config.headLight,
        settings.hue - 10,
        advance,
        tileHeight,
      ),
      glowSprite: settings.glow > 0 ? buildGlow(settings.hue) : null,
      columns: [],
    };

    const count = Math.ceil(width / layer.cell) + 1;
    for (let i = 0; i < count; i += 1) {
      layer.columns.push(
        placeColumn({ x: i * layer.cell + layer.cell * 0.5 }, layer, true),
      );
    }

    return layer;
  });
};

const advanceColumns = () => {
  for (const layer of layers) {
    for (const column of layer.columns) {
      column.head += column.speed;

      const row = Math.floor(column.head / layer.pitch);
      if (row !== column.row) {
        const steps = clamp(row - column.row, 0, column.glyphs.length - 1);
        for (let s = 0; s < steps; s += 1) {
          column.ptr = (column.ptr + 1) % column.glyphs.length;
          column.glyphs[column.ptr] = randGlyph();
        }
        column.row = row;

        // Older glyphs occasionally rewrite themselves, which is what sells
        // the read-out as live data instead of a scrolling screenshot.
        if (Math.random() < config.flicker) {
          const back =
            column.tail - 2 - Math.floor(Math.random() * column.tail);
          column.glyphs[
            (column.ptr + back + column.glyphs.length) % column.glyphs.length
          ] = randGlyph();
        }
      }

      if (column.burn > 0) column.burn -= 1;
      else if (Math.random() < config.burnChance)
        column.burn = config.burnFrames;

      if (column.head - column.tail * layer.pitch > height) {
        placeColumn(column, layer, false);
      }
    }
  }
};

const paintBase = () => {
  const ground = ctx.createLinearGradient(0, 0, 0, height);
  ground.addColorStop(0, "#02090a");
  ground.addColorStop(0.4, "#01060a");
  ground.addColorStop(1, "#000204");
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = "lighter";
  const source = ctx.createLinearGradient(0, 0, 0, height * 0.34);
  source.addColorStop(0, "rgba(20, 118, 100, 0.26)");
  source.addColorStop(1, "rgba(8, 54, 50, 0)");
  ctx.fillStyle = source;
  ctx.fillRect(0, 0, width, height * 0.34);
  ctx.globalCompositeOperation = "source-over";
};

const drawColumns = () => {
  const span = width + config.sweepWidth * 4;
  const sweepX = ((frame * config.sweepSpeed) % span) - config.sweepWidth * 2;
  const sigma = config.sweepWidth * 0.9;
  const twoSigma2 = 2 * sigma * sigma;

  ctx.globalCompositeOperation = "lighter";

  for (const layer of layers) {
    const half = layer.advance / 2;

    for (const column of layer.columns) {
      const dx = column.x - sweepX;
      const sweep = 1 + config.sweepGain * Math.exp(-(dx * dx) / twoSigma2);
      const burn = column.burn > 0 ? column.burn / config.burnFrames : 0;
      const base = column.gain * layer.alpha * sweep;

      const startY = Math.floor(column.head / layer.pitch) * layer.pitch;

      if (layer.glow > 0) {
        const glowSize = layer.font * layer.glow * (1 + burn * 1.2);
        ctx.globalAlpha = clamp(
          0.42 * layer.alpha * (1 + burn * 1.8) * sweep,
          0.05,
          0.9,
        );
        ctx.drawImage(
          layer.glowSprite,
          column.x - glowSize / 2,
          startY - glowSize / 2,
          glowSize,
          glowSize,
        );
      }

      for (let k = 0; k <= column.tail; k += 1) {
        const y = startY - k * layer.pitch;
        if (y < -layer.tileHeight || y > height + layer.tileHeight) continue;

        const index =
          (column.ptr - k + column.glyphs.length * 2) % column.glyphs.length;
        const offset = column.glyphs[index] * layer.advance;
        const source =
          k === 0 ? layer.hot : k === 1 && burn > 0.25 ? layer.hot : layer.body;

        const fade = Math.pow(1 - k / (column.tail + 1), config.tailCurve);
        const alpha =
          k === 0
            ? clamp(base * (0.95 + burn * 0.5), 0.25, 1)
            : clamp(base * fade * (k === 1 ? 1.35 : 1), 0.03, 0.92);

        ctx.globalAlpha = alpha;
        ctx.drawImage(
          source,
          offset,
          0,
          layer.advance,
          layer.tileHeight,
          column.x - half,
          y - layer.tileHeight / 2,
          layer.advance,
          layer.tileHeight,
        );
      }
    }
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
};

const paintVignette = () => {
  const radius = Math.max(width, height) * 0.82;
  const vignette = ctx.createRadialGradient(
    width * 0.5,
    height * 0.45,
    radius * 0.3,
    width * 0.5,
    height * 0.45,
    radius,
  );
  vignette.addColorStop(0, "rgba(0, 3, 4, 0)");
  vignette.addColorStop(1, "rgba(0, 3, 4, 0.6)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
};

const drawFrame = () => {
  frame += 1;
  advanceColumns();
  paintBase();
  drawColumns();
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
  ctx.imageSmoothingQuality = "high";

  buildScene();
};

const onResize = () => resize();

onMounted(() => {
  if (!holderRef.value || !canvasRef.value) return;

  ctx = canvasRef.value.getContext("2d", { alpha: false });
  if (!ctx) {
    console.error("DataRain: canvas 2d context unavailable");
    return;
  }

  resize();

  // Columns are seeded down the whole frame, but priming puts the luminous
  // sweep on screen and lets the ignition timers desynchronise first.
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
  layers = [];
});
</script>
