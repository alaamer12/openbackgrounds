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
  seed: 20260926,
  sheets: 5,
  strandsPerSheet: 26,
  segments: 48,
  length: 8.6,
  sheetGapY: 0.62,
  sheetGapZ: 0.72,
  spreadY: 1.25,
  spreadZ: 0.55,
  meander: 0.3,
  // Waves are shared across a sheet, which is what makes the field read as
  // cloth rather than as spaghetti.
  waveFrequency: 1.9,
  flowSpeed: 0.16,
  amplitude: 0.44,
  // Amplitude grows downstream so the strands look pinned at one end.
  pinHold: 0.22,
  sheetLift: 0.26,
  yawAmp: 0.16,
  yawRate: 0.049,
  pitchAmp: 0.07,
  pitchRate: 0.033,
  focal: 1.9,
  distance: 3.6,
  refAspect: 1.6,
  depthNear: 2.4,
  depthFar: 6.0,
  // Low per-strand alpha: the sheets build their luminance from overlap, so
  // this has to stay translucent for the cloth to read.
  alpha: 0.4,
  pinFade: 0.06,
  tailFade: 0.86,
  blue: [0.16, 0.4, 1.0],
  magenta: [0.94, 0.24, 0.9],
  sheen: [0.3, 0.86, 1.0],
  ground: [0.014, 0.008, 0.024],
};

const FLOATS_PER_VERTEX = 7;

// Only the resting shape of each strand is on the CPU; every oscillation, the
// iridescence sweep and the perspective divide are vertex-shader work driven
// by u_time.
const SILK_VERT = `
  precision highp float;

  attribute vec3 a_pos;
  attribute vec4 a_data;

  uniform float u_time;
  uniform vec2 u_focal;
  uniform vec4 u_flow;
  uniform vec4 u_sway;
  uniform vec3 u_camera;
  uniform vec2 u_edge;
  uniform vec2 u_depth;
  uniform vec3 u_blue;
  uniform vec3 u_magenta;
  uniform vec3 u_sheen;

  varying vec3 v_color;
  varying float v_alpha;

  mat3 rotY(float a) {
    float c = cos(a);
    float s = sin(a);
    return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
  }

  mat3 rotX(float a) {
    float c = cos(a);
    float s = sin(a);
    return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
  }

  void main() {
    float uu = a_data.x;
    float vv = a_data.y;
    float phase = a_data.w;

    float travel = uu * u_flow.x - u_time * u_flow.y;
    float gain = u_flow.z * (u_flow.w + pow(uu, 1.4));

    vec3 p = a_pos;
    p.y += gain * sin(travel * 6.2831 + phase);
    p.z += gain * 0.8 * sin(travel * 4.1 + phase * 1.7 + vv * 1.9);
    p.z += gain * 0.4 * sin(travel * 9.7 - u_time * 0.7 + vv * 3.1);
    p.y += gain * 0.3 * sin(travel * 15.3 + u_time * 1.3 + vv * 5.0 - phase);
    p.x += gain * 0.22 * cos(travel * 6.2831 + phase);
    p.y +=
      u_camera.y * sin(uu * 2.2 + u_time * 0.11 + phase * 0.5) *
      (0.4 + 0.6 * vv);

    float yaw = u_sway.x * sin(u_time * u_sway.y + a_pos.z * 0.2);
    float pitch = u_sway.z * sin(u_time * u_sway.w + 1.4);
    vec3 q = rotX(pitch) * rotY(yaw) * p;

    float w = max(q.z + u_camera.x, 0.05);
    gl_Position = vec4(q.xy * u_focal / w, 0.0, w);

    float irid =
      0.5 + 0.5 * sin(uu * 3.4 + vv * 2.4 + u_time * 0.12 + phase * 0.3);
    vec3 col = mix(u_blue, u_magenta, irid);
    col +=
      u_sheen *
      pow(0.5 + 0.5 * sin(uu * 6.2 - u_time * 0.23 + vv * 1.1), 5.0) *
      0.55;

    float fade = pow(1.0 - smoothstep(u_depth.x, u_depth.y, w), 1.2);
    float fold = 0.4 + 0.6 * sin(vv * 3.14159);
    float ends = smoothstep(0.0, u_edge.x, uu) *
      (1.0 - smoothstep(u_edge.y, 1.0, uu));

    v_color = col;
    v_alpha = clamp(u_camera.z * fold * fade * ends, 0.0, 1.0);
  }
`;

const SILK_FRAG = `
  precision mediump float;

  varying vec3 v_color;
  varying float v_alpha;

  void main() {
    gl_FragColor = vec4(v_color, v_alpha);
  }
`;

let gl = null;
let program = null;
let buffer = null;
let vertexData = null;
let vertexCount = 0;
let frameId = null;
let startTime = 0;

const attribs = {};
const uniforms = {};

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
    console.error("SilkStrands: WebGL context unavailable");
    return;
  }

  buildStrands();

  buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);
  vertexData = null;

  program = createProgram(SILK_VERT, SILK_FRAG);
  if (!program) return;

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
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);

    buffer = null;
    program = null;

    gl.getExtension("WEBGL_lose_context")?.loseContext();
    gl = null;
  }
});

function buildStrands() {
  const random = makeRandom(config.seed);
  const noise2D = createNoise2D(makeRandom(config.seed + 313));
  const rows = [];

  for (let sheet = 0; sheet < config.sheets; sheet += 1) {
    const sheetBlend = config.sheets > 1 ? sheet / (config.sheets - 1) : 0.5;
    const baseZ = (sheetBlend - 0.5) * (config.sheets - 1) * config.sheetGapZ;
    const baseY = (sheetBlend - 0.5) * (config.sheets - 1) * config.sheetGapY;
    const sheetPhase = sheet * 1.71;

    for (let s = 0; s < config.strandsPerSheet; s += 1) {
      const span = Math.max(1, config.strandsPerSheet - 1);
      const v = s / span;
      const crossY = (v - 0.5) * config.spreadY;
      const crossZ = (v - 0.5) * config.spreadZ;
      const seed = random();

      const points = [];
      for (let k = 0; k < config.segments; k += 1) {
        const uu = k / (config.segments - 1);
        // Shared low index scale keeps neighbouring strands in a sheet warping
        // together, with just enough drift to look hand-laid.
        points.push({
          uu,
          v,
          seed,
          sheetPhase,
          x: (uu - 0.5) * config.length,
          y:
            baseY +
            crossY +
            noise2D(uu * 1.7 + sheet * 3.1, s * 0.06) * config.meander,
          z:
            baseZ +
            crossZ +
            noise2D(uu * 1.4 + 11.0 + sheet * 2.3, s * 0.06 + 5.0) *
              config.meander *
              0.8,
        });
      }

      for (let k = 0; k < points.length - 1; k += 1) {
        rows.push(points[k]);
        rows.push(points[k + 1]);
      }
    }
  }

  vertexCount = rows.length;
  vertexData = new Float32Array(vertexCount * FLOATS_PER_VERTEX);

  let ptr = 0;
  for (const row of rows) {
    vertexData[ptr++] = row.x;
    vertexData[ptr++] = row.y;
    vertexData[ptr++] = row.z;
    vertexData[ptr++] = row.uu;
    vertexData[ptr++] = row.v;
    vertexData[ptr++] = row.seed;
    vertexData[ptr++] = row.sheetPhase;
  }
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
  if (!gl || !program) return;

  const time = (now - startTime) * 0.001;
  const aspect =
    gl.drawingBufferHeight === 0
      ? 1
      : gl.drawingBufferWidth / gl.drawingBufferHeight;
  const focal = config.focal * Math.min(1, aspect / config.refAspect);

  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);

  gl.uniform1f(uniforms.u_time, time);
  gl.uniform2f(uniforms.u_focal, focal / aspect, focal);
  gl.uniform4f(
    uniforms.u_flow,
    config.waveFrequency,
    config.flowSpeed,
    config.amplitude,
    config.pinHold,
  );
  gl.uniform4f(
    uniforms.u_sway,
    config.yawAmp,
    config.yawRate,
    config.pitchAmp,
    config.pitchRate,
  );
  gl.uniform3f(
    uniforms.u_camera,
    config.distance,
    config.sheetLift,
    config.alpha,
  );
  gl.uniform2f(uniforms.u_edge, config.pinFade, config.tailFade);
  gl.uniform2f(uniforms.u_depth, config.depthNear, config.depthFar);
  gl.uniform3fv(uniforms.u_blue, config.blue);
  gl.uniform3fv(uniforms.u_magenta, config.magenta);
  gl.uniform3fv(uniforms.u_sheen, config.sheen);

  gl.drawArrays(gl.LINES, 0, vertexCount);

  fpsMeter.tick();
  frameId = requestAnimationFrame(render);
}

function createProgram(vertexSource, fragmentSource) {
  const vertex = compileShader(gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) return null;

  const created = gl.createProgram();
  gl.attachShader(created, vertex);
  gl.attachShader(created, fragment);
  gl.linkProgram(created);

  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(created, gl.LINK_STATUS)) {
    console.error(
      "SilkStrands: Program link error",
      gl.getProgramInfoLog(created),
    );
    gl.deleteProgram(created);
    return null;
  }

  gl.useProgram(created);

  attribs.a_pos = gl.getAttribLocation(created, "a_pos");
  attribs.a_data = gl.getAttribLocation(created, "a_data");

  for (const name of [
    "u_time",
    "u_focal",
    "u_flow",
    "u_sway",
    "u_camera",
    "u_edge",
    "u_depth",
    "u_blue",
    "u_magenta",
    "u_sheen",
  ]) {
    uniforms[name] = gl.getUniformLocation(created, name);
  }

  const stride = FLOATS_PER_VERTEX * 4;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(attribs.a_pos);
  gl.vertexAttribPointer(attribs.a_pos, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(attribs.a_data);
  gl.vertexAttribPointer(attribs.a_data, 4, gl.FLOAT, false, stride, 12);

  return created;
}

function compileShader(type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(
      `SilkStrands: Shader compile error (${type === gl.VERTEX_SHADER ? "vertex" : "fragment"})`,
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
