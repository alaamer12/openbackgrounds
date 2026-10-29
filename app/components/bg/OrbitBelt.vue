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

// Framing key: this projection writes `q.xy * focal / w` with clip-space w set
// to the same `w`, so the divide lands twice and a body's on-screen radius is
// `r * focal / (z + distance)^2`. Coverage of the shorter viewport axis is
// therefore `rMax * focal / distance^2`, which is 0.65 here. Both 640x400 and
// 1920x1080 sit at or above `refAspect`, so the landscape clamp never engages
// and the system is framed identically at both sizes.
const config = {
  maxDpr: 1.5,
  seed: 20260925,
  belts: 13,
  headsPerBelt: 64,
  trailSamples: 7,
  dust: 1200,
  corona: 26,
  rMin: 0.95,
  rMax: 3.3,
  // Belt planes are now gathered around one common disc instead of being
  // scattered over the whole sphere. Random orientations turned the system into
  // a shell of crossing rings; a small inclination spread keeps them
  // concentric so each ring and its trail can be followed end to end, and it
  // shrinks the depth spread that this projection's inverse-square divide
  // otherwise magnifies off frame.
  inclMax: 0.16,
  // Keplerian: omega = kepler / r^1.5, so the inner belts visibly outrun the
  // outer ones.
  kepler: 0.42,
  // World-space length of a trail. The angular sweep is derived per belt, so
  // every trail reads the same physical length however far out it orbits.
  trailArc: 0.26,
  band: 0.11,
  // Node drift is what lets the planes braid; held low enough that the belts
  // are still recognisably concentric a minute into the loop.
  precessMin: 0.004,
  precessMax: 0.02,
  spin: 0.035,
  tilt: 0.42,
  focal: 12.6,
  distance: 8.0,
  refAspect: 1.6,
  depthNear: 5.9,
  depthFar: 10.3,
  trailStrength: 1.0,
  headStrength: 1.2,
  // Warm-to-cool ramp keyed on orbit radius.
  palWarm: [1.0, 0.58, 0.2],
  palMid: [1.0, 0.92, 0.7],
  palCool: [0.34, 0.62, 1.0],
  ground: [0.01, 0.006, 0.006],
};

const TAU = Math.PI * 2;
const FLOATS_PER_VERTEX = 14;

// One static buffer holds trail vertices first and head points second, so the
// two draw calls can share it with a single attribute setup. Everything that
// moves is derived from u_time in here.
const BELT_VERT = `
  precision highp float;

  attribute vec3 a_u;
  attribute vec3 a_v;
  attribute vec4 a_orbit;
  attribute vec4 a_shape;

  uniform float u_time;
  uniform vec2 u_resolution;
  uniform vec2 u_focal;
  uniform vec4 u_motion;
  uniform vec4 u_look;
  uniform vec2 u_depth;
  uniform vec3 u_warm;
  uniform vec3 u_mid;
  uniform vec3 u_cool;

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
    float r0 = a_orbit.x;
    float radius = r0 * (1.0 + (a_shape.x - 0.5) * u_motion.y);

    // Step back along the orbit: the tail is where this body was.
    float ang =
      a_orbit.y + u_time * a_orbit.z -
      a_shape.z * u_motion.x / max(r0, 0.12);

    // Each belt's plane nods about the world axis, gyroscope-like.
    mat3 node = rotY(u_time * a_orbit.w);
    vec3 u = node * a_u;
    vec3 v = node * a_v;

    vec3 p = (u * cos(ang) + v * sin(ang)) * radius;
    vec3 q = rotX(u_look.x) * rotY(u_time * u_motion.z) * p;

    float w = max(q.z + u_look.y, 0.05);
    gl_Position = vec4(q.xy * u_focal / w, 0.0, w);

    float rt =
      clamp((r0 - u_look.z) / max(u_look.w - u_look.z, 0.001), 0.0, 1.0);

    vec3 col = mix(u_warm, u_mid, smoothstep(0.0, 0.42, rt));
    col = mix(col, u_cool, smoothstep(0.36, 1.0, rt));

    float fade = pow(1.0 - smoothstep(u_depth.x, u_depth.y, w), 1.3);
    float trail = pow(1.0 - a_shape.z, 1.7);
    float glint = 0.85 + 0.3 * sin(u_time * 2.1 + a_shape.x * 31.0);

    v_color = col * glint;
    v_alpha = clamp(a_shape.w * fade * trail, 0.0, 1.0);

    gl_PointSize = clamp(
      a_shape.y * u_focal.y * u_resolution.y * 0.5 / max(w, 0.2),
      1.0,
      64.0
    );
  }
`;

const TRAIL_FRAG = `
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
    float halo = pow(k, 2.6);
    float core = pow(k, 10.0);

    vec3 col = v_color + vec3(1.0, 0.94, 0.86) * core * 0.8;
    gl_FragColor = vec4(col, v_alpha * u_strength * (0.16 + 0.84 * halo));
  }
`;

let gl = null;
let trailProgram = null;
let headProgram = null;
let buffer = null;
let vertexData = null;
let trailCount = 0;
let pointCount = 0;
let frameId = null;
let startTime = 0;

const trailLoc = { attribs: {}, uniforms: {} };
const headLoc = { attribs: {}, uniforms: {} };

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
    console.error("OrbitBelt: WebGL context unavailable");
    return;
  }

  buildBelts();

  buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);
  vertexData = null;

  trailProgram = createProgram(BELT_VERT, TRAIL_FRAG, trailLoc);
  headProgram = createProgram(BELT_VERT, HEAD_FRAG, headLoc);
  if (!trailProgram || !headProgram) return;

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
    if (trailProgram) gl.deleteProgram(trailProgram);
    if (headProgram) gl.deleteProgram(headProgram);

    buffer = null;
    trailProgram = null;
    headProgram = null;

    gl.getExtension("WEBGL_lose_context")?.loseContext();
    gl = null;
  }
});

function buildBelts() {
  const random = makeRandom(config.seed);
  const last = Math.max(1, config.trailSamples - 1);
  const heads = [];
  const loose = [];

  for (let b = 0; b < config.belts; b += 1) {
    const blend = config.belts > 1 ? b / (config.belts - 1) : 0;
    const radius = config.rMin + (config.rMax - config.rMin) * blend;
    const omega = config.kepler / Math.pow(radius, 1.5);
    const precess =
      (config.precessMin + random() * (config.precessMax - config.precessMin)) *
      (random() > 0.5 ? 1 : -1);
    const [u, v] = beltBasis(random);

    for (let h = 0; h < config.headsPerBelt; h += 1) {
      heads.push({
        u,
        v,
        radius,
        phase: (h / config.headsPerBelt) * TAU + (random() - 0.5) * 0.35,
        omega,
        precess,
        seed: random(),
        // World-space sprite sizes divide out by the 5.86 growth in focal
        // length (offset by the camera pull-back), so each head covers the same
        // number of pixels as before and the fragment cost stays flat while the
        // system spreads across frame.
        size: 0.0078 + random() * 0.0073,
        bright: 0.55 + random() * 0.45,
      });
    }
  }

  // Free debris filling the gaps between the belts.
  for (let i = 0; i < config.dust; i += 1) {
    const radius =
      config.rMin * 0.7 +
      Math.pow(random(), 0.8) * (config.rMax - config.rMin * 0.7);
    const du = randomUnit(random);
    loose.push({
      u: du,
      v: perpendicular(du, randomUnit(random)),
      radius,
      phase: random() * TAU,
      omega: config.kepler / Math.pow(radius, 1.5),
      precess: 0,
      seed: random(),
      size: 0.0017 + random() * 0.0027,
      bright: 0.1 + random() * 0.3,
    });
  }

  // Soft central star built from overlapping additive sprites.
  for (let i = 0; i < config.corona; i += 1) {
    loose.push({
      u: [1, 0, 0],
      v: [0, 0, 1],
      radius: 0.06,
      phase: random() * TAU,
      omega: 0,
      precess: 0,
      seed: random(),
      size: 0.0244 + random() * 0.0414,
      bright: 0.05 + random() * 0.05,
    });
  }

  const rows = [];

  for (const head of heads) {
    for (let s = 0; s < config.trailSamples - 1; s += 1) {
      rows.push({ ...head, trailT: s / last });
      rows.push({ ...head, trailT: (s + 1) / last });
    }
  }

  trailCount = rows.length;

  for (const head of heads) rows.push({ ...head, trailT: 0 });
  for (const item of loose) rows.push({ ...item, trailT: 0 });
  pointCount = rows.length - trailCount;

  vertexData = new Float32Array(rows.length * FLOATS_PER_VERTEX);
  let ptr = 0;
  for (const row of rows) {
    vertexData[ptr++] = row.u[0];
    vertexData[ptr++] = row.u[1];
    vertexData[ptr++] = row.u[2];
    vertexData[ptr++] = row.v[0];
    vertexData[ptr++] = row.v[1];
    vertexData[ptr++] = row.v[2];
    vertexData[ptr++] = row.radius;
    vertexData[ptr++] = row.phase;
    vertexData[ptr++] = row.omega;
    vertexData[ptr++] = row.precess;
    vertexData[ptr++] = row.seed;
    vertexData[ptr++] = row.size;
    vertexData[ptr++] = row.trailT;
    vertexData[ptr++] = row.bright;
  }
}

function randomUnit(random) {
  const z = random() * 2 - 1;
  const theta = random() * TAU;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(theta), r * Math.sin(theta), z];
}

// Grammidt step: keep the second ring basis vector truly perpendicular to the
// first so the belts stay circular.
function perpendicular(u, w) {
  const dot = u[0] * w[0] + u[1] * w[1] + u[2] * w[2];
  const v = [w[0] - u[0] * dot, w[1] - u[1] * dot, w[2] - u[2] * dot];
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

// One belt: an orthonormal pair spanning a plane whose normal sits within
// inclMax of the world z axis. Building the basis from the normal instead of
// from two random directions is what keeps the thirteen rings concentric, and
// the x axis reference never degenerates while the normal stays near z.
function beltBasis(random) {
  const azimuth = random() * TAU;
  const incl = (random() * 2 - 1) * config.inclMax;
  const si = Math.sin(incl);
  const n = [si * Math.cos(azimuth), si * Math.sin(azimuth), Math.cos(incl)];

  const u = [0, -n[2], n[1]];
  const uLen = Math.hypot(u[1], u[2]) || 1;
  u[1] /= uLen;
  u[2] /= uLen;

  const v = [
    n[1] * u[2] - n[2] * u[1],
    n[2] * u[0] - n[0] * u[2],
    n[0] * u[1] - n[1] * u[0],
  ];

  return [u, v];
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
  if (!gl || !trailProgram || !headProgram) return;

  const time = (now - startTime) * 0.001;
  const aspect =
    gl.drawingBufferHeight === 0
      ? 1
      : gl.drawingBufferWidth / gl.drawingBufferHeight;
  const focal = config.focal * Math.min(1, aspect / config.refAspect);

  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(trailProgram);
  setUniforms(trailLoc, time, aspect, focal, config.trailStrength);
  applyAttribs(trailLoc);
  gl.drawArrays(gl.LINES, 0, trailCount);

  gl.useProgram(headProgram);
  setUniforms(headLoc, time, aspect, focal, config.headStrength);
  applyAttribs(headLoc);
  gl.drawArrays(gl.POINTS, trailCount, pointCount);

  fpsMeter.tick();
  frameId = requestAnimationFrame(render);
}

function setUniforms(loc, time, aspect, focal, strength) {
  gl.uniform1f(loc.uniforms.u_time, time);
  gl.uniform2f(
    loc.uniforms.u_resolution,
    gl.drawingBufferWidth,
    gl.drawingBufferHeight,
  );
  gl.uniform2f(loc.uniforms.u_focal, focal / aspect, focal);
  gl.uniform4f(
    loc.uniforms.u_motion,
    config.trailArc,
    config.band,
    config.spin,
    config.kepler,
  );
  gl.uniform4f(
    loc.uniforms.u_look,
    config.tilt,
    config.distance,
    config.rMin,
    config.rMax,
  );
  gl.uniform2f(loc.uniforms.u_depth, config.depthNear, config.depthFar);
  gl.uniform3fv(loc.uniforms.u_warm, config.palWarm);
  gl.uniform3fv(loc.uniforms.u_mid, config.palMid);
  gl.uniform3fv(loc.uniforms.u_cool, config.palCool);
  gl.uniform1f(loc.uniforms.u_strength, strength);
}

function applyAttribs(loc) {
  const stride = FLOATS_PER_VERTEX * 4;
  const binds = [
    ["a_u", 3, 0],
    ["a_v", 3, 12],
    ["a_orbit", 4, 24],
    ["a_shape", 4, 40],
  ];

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

  for (const [name, size, offset] of binds) {
    const location = loc.attribs[name];
    if (location < 0) continue;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
  }
}

function createProgram(vertexSource, fragmentSource, target) {
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
      "OrbitBelt: Program link error",
      gl.getProgramInfoLog(created),
    );
    gl.deleteProgram(created);
    return null;
  }

  gl.useProgram(created);

  for (const name of ["a_u", "a_v", "a_orbit", "a_shape"]) {
    target.attribs[name] = gl.getAttribLocation(created, name);
  }

  for (const name of [
    "u_time",
    "u_resolution",
    "u_focal",
    "u_motion",
    "u_look",
    "u_depth",
    "u_warm",
    "u_mid",
    "u_cool",
    "u_strength",
  ]) {
    target.uniforms[name] = gl.getUniformLocation(created, name);
  }

  return created;
}

function compileShader(type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(
      `OrbitBelt: Shader compile error (${type === gl.VERTEX_SHADER ? "vertex" : "fragment"})`,
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
