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
  density: 1500,
  speed: 2.6,
  noiseScale: 0.0009,
  drift: 0.0022,
  fade: 0.035,
  lineWidth: 1.25,
  baseAlpha: 0.62,
  life: [90, 220],
  hueRange: [186, 322],
  // Noise returns -1..1. Kept low so one noise cell does not sweep the whole
  // compass: high values make particles loop in place and the frame turns to
  // tangled wire instead of long silk strokes.
  turns: 0.35,
  warmup: 200,
};

const TAU = Math.PI * 2;

let ctx = null;
let noise2D = null;
let particles = [];
let frameId = null;
let frame = 0;
let width = 0;
let height = 0;

const rand = (min, max) => min + Math.random() * (max - min);

const spawn = (particle) => {
  particle.x = Math.random() * width;
  particle.y = Math.random() * height;
  particle.age = 0;
  particle.life = rand(config.life[0], config.life[1]);
  particle.hue = rand(config.hueRange[0], config.hueRange[1]);
  particle.weight = rand(0.7, 1.35);
  return particle;
};

const buildParticles = () => {
  const count = Math.max(
    220,
    Math.min(2600, Math.round((width * height) / config.density)),
  );

  particles = [];
  for (let i = 0; i < count; i += 1) particles.push(spawn({}));
};

const paintBase = () => {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#04070f");
  gradient.addColorStop(0.5, "#080313");
  gradient.addColorStop(1, "#03050c");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
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
  buildParticles();
};

const drawFrame = () => {
  frame += 1;

  // Sliding the field itself, rather than sampling a third noise axis, keeps
  // the strokes coherent while still letting the whole pattern breathe.
  const offset = frame * config.drift;

  ctx.fillStyle = `rgba(3, 5, 12, ${config.fade})`;
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = "lighter";
  ctx.lineWidth = config.lineWidth;

  for (const p of particles) {
    const angle =
      noise2D(p.x * config.noiseScale + offset, p.y * config.noiseScale) *
      TAU *
      config.turns;

    const px = p.x;
    const py = p.y;
    p.x += Math.cos(angle) * config.speed * p.weight;
    p.y += Math.sin(angle) * config.speed * p.weight;
    p.age += 1;

    // Fade in and out so strokes end softly instead of stopping on a hard dot.
    const lifeT = p.age / p.life;
    const alpha =
      Math.sin(Math.min(1, lifeT) * Math.PI) * config.baseAlpha * p.weight;

    if (alpha > 0.012) {
      ctx.strokeStyle = `hsla(${p.hue}, 84%, ${60 + lifeT * 14}%, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }

    if (
      p.age > p.life ||
      p.x < -30 ||
      p.x > width + 30 ||
      p.y < -30 ||
      p.y > height + 30
    ) {
      spawn(p);
    }
  }

  ctx.globalCompositeOperation = "source-over";
};

const step = () => {
  fpsMeter.tick();
  drawFrame();
  frameId = requestAnimationFrame(step);
};

const onResize = () => resize();

onMounted(() => {
  if (!holderRef.value || !canvasRef.value) return;

  ctx = canvasRef.value.getContext("2d", { alpha: false });
  if (!ctx) {
    console.error("FlowField: canvas 2d context unavailable");
    return;
  }

  noise2D = createNoise2D();

  resize();

  // Trails accumulate over seconds, so prime the canvas instead of opening on
  // a near-empty black frame.
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
  particles = [];
});
</script>
