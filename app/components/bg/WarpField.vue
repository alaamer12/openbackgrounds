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
  seed: 20260922,
  // Each star costs one point sprite plus one line segment. Everything about
  // its motion is derived from u_time in the vertex shader.
  stars: 2600,
  // Depth travel in tubes per second: a star crosses the volume in 1 / speed.
  speed: 0.2,
  near: 0.42,
  far: 3.6,
  // Radius of the cylinder stars are seeded into, in world units.
  spread: 1.75,
  focal: 1.18,
  // Streak length along the view axis. Screen length falls out of the
  // perspective divide as 1 / z^2, so the fastest stars stretch the most.
  streak: 0.2,
  lineStrength: 0.52,
  headStrength: 0.9,
  // World-space radius of a head sprite.
  headSize: 0.022,
  // NDC radius of the cleared hole around the vanishing point.
  hole: 0.05,
  driftX: 0.075,
  driftY: 0.06,
  driftRateX: 0.055,
  driftRateY: 0.038,
  rollRate: 0.02,
  rollSwell: 0.28,
  ground: [0.004, 0.007, 0.018],
};

const FLOATS_PER_VERTEX = 5;

// Shared by both passes. highp is required: the depth phase is a fract() of
// elapsed time and would quantise badly in mediump.
const WARP_VERT = `
  precision highp float;

  attribute vec3 a_star;
  attribute vec2 a_data;

  uniform float u_time;
  uniform vec2 u_resolution;
  uniform vec2 u_focal;
  uniform vec4 u_flow;
  uniform vec3 u_drift;
  uniform vec2 u_look;

  varying vec3 v_color;
  varying float v_alpha;

  void main() {
    float span = u_flow.z - u_flow.y;
    float phase = fract(a_star.z - u_time * u_flow.x);
    float z = u_flow.y + phase * span + a_data.y * u_flow.w;

    float cr = cos(u_drift.z);
    float sr = sin(u_drift.z);
    vec2 xy = vec2(
      a_star.x * cr - a_star.y * sr,
      a_star.x * sr + a_star.y * cr
    );
    xy -= u_drift.xy;

    float w = max(z, 0.001);
    vec2 ndc = xy * u_focal / w;
    gl_Position = vec4(ndc, 0.0, w);

    float depthT = clamp((z - u_flow.y) / span, 0.0, 1.0);
    float radius = length(ndc);

    vec3 deep = vec3(0.12, 0.3, 0.88);
    vec3 hot = vec3(0.9, 0.96, 1.0);
    vec3 col = mix(hot, deep, pow(depthT, 0.7));
    col = mix(col, vec3(1.0, 0.74, 0.5), step(0.958, a_data.x) * 0.8);

    float emerge = smoothstep(u_look.x, u_look.x * 4.0, radius);
    float sparkle = 0.45 + 0.85 * fract(a_data.x * 7.13);

    v_color = col;
    v_alpha = clamp((1.0 - depthT * 0.9) * emerge * sparkle, 0.0, 1.0);

    float world = u_look.y * (0.62 + fract(a_data.x * 3.71));
    gl_PointSize = clamp(
      world * u_focal.y * u_resolution.y * 0.5 / max(w, 0.3),
      1.0,
      30.0
    );
  }
`;

const STREAK_FRAG = `
  precision mediump float;

  varying vec3 v_color;
  varying float v_alpha;

  uniform float u_strength;

  void main() {
    gl_FragColor = vec4(v_color, v_alpha * u_strength);
  }
`;

const HEAD_FRAG = `
  precision mediump float;

  varying vec3 v_color;
  varying float v_alpha;

  uniform float u_strength;

  void main() {
    float d = distance(gl_PointCoord, vec2(0.5));
    if (d > 0.5) {
      discard;
    }

    float k = 1.0 - d * 2.0;
    float halo = pow(k, 2.4);
    float core = pow(k, 9.0);

    vec3 col = v_color + vec3(0.82, 0.9, 1.0) * core;
    gl_FragColor = vec4(col, v_alpha * u_strength * (0.2 + 0.8 * halo));
  }
`;

let gl = null;
let streakProgram = null;
let headProgram = null;
let lineBuffer = null;
let headBuffer = null;
let lineData = null;
let headData = null;
let lineCount = 0;
let headCount = 0;
let frameId = null;
let startTime = 0;

const streakLoc = { attribs: {}, uniforms: {} };
const headLoc = { attribs: {}, uniforms: {} };

const flowUniform = new Float32Array([
  config.speed,
  config.near,
  config.far,
  config.streak,
]);

onMounted(() => {
  if (!holderRef.value || !canvasRef.value) return;

  gl =
    canvasRef.value.getContext("webgl", {
      alpha: false,
      antialias: true,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    }) || canvasRef.value.getContext("experimental-webgl");

  if (!gl) {
    console.error("WarpField: WebGL context unavailable");
    return;
  }

  buildStars();

  streakProgram = createProgram(WARP_VERT, STREAK_FRAG, streakLoc);
  headProgram = createProgram(WARP_VERT, HEAD_FRAG, headLoc);
  if (!streakProgram || !headProgram) return;

  lineBuffer = createStaticBuffer(lineData);
  headBuffer = createStaticBuffer(headData);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(false);
  gl.clearColor(config.ground[0], config.ground[1], config.ground[2], 1);

  resize();
  window.addEventListener("resize", onResize, { passive: true });

  fpsMeter.start();
  startTime = performance.now();
  frameId = requestAnimationFrame(render);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);

  if (frameId !== null) {
    cancelAnimationFrame(frameId);
    frameId = null;
  }

  fpsMeter.stop();

  if (gl) {
    if (lineBuffer) gl.deleteBuffer(lineBuffer);
    if (headBuffer) gl.deleteBuffer(headBuffer);
    if (streakProgram) gl.deleteProgram(streakProgram);
    if (headProgram) gl.deleteProgram(headProgram);

    lineBuffer = null;
    headBuffer = null;
    streakProgram = null;
    headProgram = null;
    lineData = null;
    headData = null;

    // The gallery carries far more scenes than the ~16 live WebGL contexts a
    // browser allows, so the context has to be handed back explicitly.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    gl = null;
  }
});

function buildStars() {
  const random = makeRandom(config.seed);
  const { stars } = config;

  lineData = new Float32Array(stars * 2 * FLOATS_PER_VERTEX);
  headData = new Float32Array(stars * FLOATS_PER_VERTEX);

  let ptr = 0;
  let headPtr = 0;

  for (let i = 0; i < stars; i += 1) {
    const angle = random() * Math.PI * 2;
    const radius = config.spread * Math.pow(random(), 0.62);
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    const depth = random();
    const seed = random();

    for (let tail = 0; tail < 2; tail += 1) {
      lineData[ptr++] = x;
      lineData[ptr++] = y;
      lineData[ptr++] = depth;
      lineData[ptr++] = seed;
      lineData[ptr++] = tail;
    }

    headData[headPtr++] = x;
    headData[headPtr++] = y;
    headData[headPtr++] = depth;
    headData[headPtr++] = seed;
    headData[headPtr++] = 0;
  }

  lineCount = stars * 2;
  headCount = stars;
}

function createStaticBuffer(data) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return buffer;
}

function resize() {
  if (!holderRef.value || !canvasRef.value || !gl) return;

  const dpr = Math.min(window.devicePixelRatio || 1, config.maxDpr);
  const width = Math.max(1, holderRef.value.offsetWidth || window.innerWidth);
  const height = Math.max(
    1,
    holderRef.value.offsetHeight || window.innerHeight,
  );

  canvasRef.value.width = Math.floor(width * dpr);
  canvasRef.value.height = Math.floor(height * dpr);
  canvasRef.value.style.width = `${width}px`;
  canvasRef.value.style.height = `${height}px`;

  gl.viewport(0, 0, canvasRef.value.width, canvasRef.value.height);
}

function render(now) {
  if (!gl || !streakProgram || !headProgram) return;

  const time = (now - startTime) * 0.001;

  const driftX =
    Math.sin(time * config.driftRateX) * config.driftX +
    Math.sin(time * config.driftRateX * 0.41 + 1.7) * config.driftX * 0.45;
  const driftY =
    Math.cos(time * config.driftRateY) * config.driftY +
    Math.sin(time * config.driftRateY * 0.63 + 0.4) * config.driftY * 0.45;
  const roll =
    time * config.rollRate + Math.sin(time * 0.041) * config.rollSwell;

  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(streakProgram);
  setCommonUniforms(streakLoc, time, driftX, driftY, roll);
  gl.uniform1f(streakLoc.uniforms.u_strength, config.lineStrength);
  applyAttribs(streakLoc, lineBuffer);
  gl.drawArrays(gl.LINES, 0, lineCount);

  gl.useProgram(headProgram);
  setCommonUniforms(headLoc, time, driftX, driftY, roll);
  gl.uniform1f(headLoc.uniforms.u_strength, config.headStrength);
  applyAttribs(headLoc, headBuffer);
  gl.drawArrays(gl.POINTS, 0, headCount);

  fpsMeter.tick();
  frameId = requestAnimationFrame(render);
}

function setCommonUniforms(loc, time, driftX, driftY, roll) {
  const aspect =
    gl.drawingBufferHeight === 0
      ? 1
      : gl.drawingBufferWidth / gl.drawingBufferHeight;

  gl.uniform1f(loc.uniforms.u_time, time);
  gl.uniform2f(
    loc.uniforms.u_resolution,
    gl.drawingBufferWidth,
    gl.drawingBufferHeight,
  );
  gl.uniform2f(loc.uniforms.u_focal, config.focal / aspect, config.focal);
  gl.uniform4fv(loc.uniforms.u_flow, flowUniform);
  gl.uniform3f(loc.uniforms.u_drift, driftX, driftY, roll);
  gl.uniform2f(loc.uniforms.u_look, config.hole, config.headSize);
}

function applyAttribs(loc, buffer) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const stride = FLOATS_PER_VERTEX * 4;

  if (loc.attribs.a_star >= 0) {
    gl.enableVertexAttribArray(loc.attribs.a_star);
    gl.vertexAttribPointer(loc.attribs.a_star, 3, gl.FLOAT, false, stride, 0);
  }

  if (loc.attribs.a_data >= 0) {
    gl.enableVertexAttribArray(loc.attribs.a_data);
    gl.vertexAttribPointer(loc.attribs.a_data, 2, gl.FLOAT, false, stride, 12);
  }
}

function createProgram(vertexSource, fragmentSource, target) {
  const vertex = compileShader(gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);

  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(
      "WarpField: Program link error",
      gl.getProgramInfoLog(program),
    );
    gl.deleteProgram(program);
    return null;
  }

  target.attribs.a_star = gl.getAttribLocation(program, "a_star");
  target.attribs.a_data = gl.getAttribLocation(program, "a_data");

  const names = [
    "u_time",
    "u_resolution",
    "u_focal",
    "u_flow",
    "u_drift",
    "u_look",
    "u_strength",
  ];
  for (const name of names) {
    target.uniforms[name] = gl.getUniformLocation(program, name);
  }

  return program;
}

function compileShader(type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(
      `WarpField: Shader compile error (${type === gl.VERTEX_SHADER ? "vertex" : "fragment"})`,
      gl.getShaderInfoLog(shader),
    );
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function onResize() {
  resize();
}
</script>
