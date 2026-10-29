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

// This projection is `q.xy * focal / w` with clip-space w also set to `w`, so
// the perspective divide lands twice: a feature's on-screen radius is
// `R * focal / (z + distance)^2`. Framing therefore keys off the ratio
// `rMax * focal / distance^2`, which is the fraction of the shorter viewport
// axis the disc diameter covers. It is 0.67 here, and because both 640x400 and
// 1920x1080 are at or wider than `refAspect` the landscape clamp is inactive,
// so that coverage is identical at both sizes.
const config = {
  maxDpr: 1.5,
  seed: 20260923,
  arms: 3,
  armStars: 7000,
  bulgeStars: 2400,
  hazeStars: 1500,
  coreHazeStars: 200,
  // Sky stars are authored in view space, so they need a spread wide enough to
  // land outside the disc's own rim or the frame corners stay empty.
  skyStars: 1500,
  rMin: 0.14,
  rMax: 2.5,
  // Radians of azimuth per e-fold of radius: the logarithmic arm pitch.
  // 2.25 across log(rMax / rMin) is about one full turn, which keeps the three
  // arms from winding on top of each other through the inner radii.
  wind: 2.25,
  armWidth: 0.042,
  thickness: 0.03,
  // Rigid pattern rotation, plus a bounded differential term so the inner arms
  // visibly overtake the outer ones and then settle instead of winding away
  // into a smear.
  patternSpin: 0.035,
  shear: 0.5,
  shearRamp: 0.045,
  wobble: 0.5,
  // Near face-on. The disc's depth spread is rMax * sin(tilt), and this
  // projection's inverse-square divide magnifies the near rim by
  // (d / (d - depth))^2, so a steep tilt throws the near arm off frame while
  // crushing the far one. 0.34 keeps the near rim at 0.89 of the half-height.
  tilt: 0.34,
  distance: 5.2,
  focal: 7.2,
  refAspect: 1.6,
  strength: 0.85,
  ground: [0.004, 0.005, 0.013],
};

const TAU = Math.PI * 2;
const FLOATS_PER_VERTEX = 8;

// Positions live in polar form so the vertex shader can rotate, shear and
// project every star per frame without a single byte leaving system memory.
const GALAXY_VERT = `
  precision highp float;

  attribute vec4 a_polar;
  attribute vec4 a_meta;

  uniform float u_time;
  uniform vec2 u_resolution;
  uniform vec2 u_focal;
  uniform vec4 u_motion;
  uniform vec3 u_look;

  varying vec3 v_color;
  varying float v_alpha;
  varying float v_soft;

  void main() {
    float sky = a_polar.w;
    float r = a_polar.x;

    float ramp = 1.0 - exp(-u_time * u_motion.z);
    float shear =
      u_motion.y * ramp * max(0.0, 1.0 / (0.3 + r) - 0.62);
    float wob =
      u_look.y * sin(u_time * (0.35 + 1.3 / (0.3 + r)) + a_meta.x * 6.2831);

    float ang = a_polar.y + u_time * u_motion.x + shear + wob * 0.05;
    float rad = r * (1.0 + wob * 0.02);

    vec3 p = vec3(cos(ang) * rad, sin(ang) * rad, a_polar.z);

    float tilt = u_look.x + 0.06 * sin(u_time * 0.024);
    float ct = cos(tilt);
    float st = sin(tilt);
    vec3 q = vec3(p.x, p.y * ct - p.z * st, p.y * st + p.z * ct);

    float yaw = 0.12 * sin(u_time * 0.017);
    float cy = cos(yaw);
    float sy = sin(yaw);
    q = vec3(q.x * cy + q.z * sy, q.y, -q.x * sy + q.z * cy);

    q = mix(q, a_polar.xyz, sky);

    float w = max(q.z + u_motion.w, 0.05);
    gl_Position = vec4(q.xy * u_focal / w, 0.0, w);

    float rt = clamp(r / u_look.z, 0.0, 1.0);

    vec3 col =
      mix(vec3(1.0, 0.74, 0.38), vec3(1.0, 0.96, 0.88), smoothstep(0.0, 0.2, rt));
    col = mix(col, vec3(0.42, 0.63, 1.0), smoothstep(0.15, 0.9, rt));

    float hii =
      step(0.93, fract(a_meta.x * 7.31)) *
      smoothstep(0.28, 0.55, rt) *
      (1.0 - sky);
    col = mix(col, vec3(1.0, 0.4, 0.7), hii * 0.85);
    col = mix(vec3(0.78, 0.85, 1.0), col, 1.0 - sky);

    float depthFade =
      1.0 - 0.28 * clamp((w - u_motion.w) / 1.6 + 0.5, 0.0, 1.0);
    float twinkle = 0.7 + 0.3 * sin(u_time * 1.9 + a_meta.x * 47.0);

    v_color = col;
    v_soft = mix(a_meta.z, 0.0, sky);
    v_alpha =
      clamp(a_meta.w * depthFade * mix(1.0, twinkle, sky), 0.0, 1.0);

    gl_PointSize =
      clamp(a_meta.y * u_focal.y * u_resolution.y * 0.5 / w, 1.0, 150.0);
  }
`;

const GALAXY_FRAG = `
  precision mediump float;

  varying vec3 v_color;
  varying float v_alpha;
  varying float v_soft;

  uniform float u_strength;

  void main() {
    float d = distance(gl_PointCoord, vec2(0.5));
    if (d > 0.5) {
      discard;
    }

    float k = 1.0 - d * 2.0;
    float halo = pow(k, 3.2 - 2.0 * v_soft);
    float core = pow(k, 8.0) * (1.0 - v_soft);

    vec3 col = v_color + vec3(1.0, 0.97, 0.92) * core * 0.85;
    gl_FragColor = vec4(col, v_alpha * u_strength * halo);
  }
`;

let gl = null;
let program = null;
let buffer = null;
let vertexData = null;
let starCount = 0;
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
    console.error("GalaxySpiral: WebGL context unavailable");
    return;
  }

  buildGalaxy();

  buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);

  program = createProgram(GALAXY_VERT, GALAXY_FRAG);
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
    vertexData = null;

    gl.getExtension("WEBGL_lose_context")?.loseContext();
    gl = null;
  }
});

function buildGalaxy() {
  const random = makeRandom(config.seed);
  const noise2D = createNoise2D(makeRandom(config.seed + 991));
  const rows = [];

  const gauss = () => {
    const u = Math.max(1e-6, random());
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  };

  const armAngle = (radius) => config.wind * Math.log(radius / config.rMin);

  // Major arms. Simplex noise along the arm modulates density so the star
  // forming regions clump instead of spreading evenly.
  for (let i = 0; i < config.armStars; i += 1) {
    const arm = i % config.arms;
    const t = random();
    const radius =
      config.rMin + (config.rMax - config.rMin) * Math.pow(t, 0.58);
    const clump = 0.45 + 0.55 * (0.5 + 0.5 * noise2D(radius * 4.6, arm * 12.0));

    // Was 0.35 + clump * 0.72, which kept only ~13% of the arm population. Once
    // the disc covers ~7x the screen area that leaves the ridges too thinly
    // populated to read as arms; ~50% survival keeps them continuous.
    if (random() > 0.05 + clump * 0.62) continue;

    const scatter = (gauss() * config.armWidth) / (0.22 + radius);
    const angle = armAngle(radius) + (arm * TAU) / config.arms + scatter;
    const height =
      gauss() * config.thickness * (1.0 + 0.9 * Math.exp(-radius * 2.6));

    const giant = random() > 0.955;
    rows.push({
      radius,
      angle,
      height,
      seed: random(),
      // Sprite sizes are world-space, so they are divided out by the same ~2.13
      // that the focal length grew: the arms land on more pixels without each
      // star covering more of them.
      size: giant ? 0.0132 + random() * 0.0094 : 0.0061 + random() * 0.0052,
      soft: 0,
      // Kept deliberately dim per star: additive blending sums the arm
      // population into the glow, so over-bright stars would blow the disc out.
      bright: (giant ? 0.72 : 0.44) * (0.4 + clump * 0.7),
    });
  }

  // Central bulge: dense, warm and slightly puffed.
  for (let i = 0; i < config.bulgeStars; i += 1) {
    const radius = 0.36 * Math.pow(random(), 1.9);
    rows.push({
      radius,
      angle: random() * TAU,
      height: gauss() * 0.06 * (1.0 - radius * 1.2),
      seed: random(),
      size: 0.0052 + random() * 0.0038,
      soft: 0,
      bright: 0.1 + random() * 0.1,
    });
  }

  // Diffuse arm-following haze, drawn as large low-alpha sprites so additive
  // blending builds the galactic glow.
  for (let i = 0; i < config.hazeStars; i += 1) {
    const arm = i % config.arms;
    const radius =
      config.rMin + (config.rMax - config.rMin) * Math.pow(random(), 0.75);
    const angle =
      armAngle(radius) +
      (arm * TAU) / config.arms +
      gauss() * 0.06 * (0.4 + radius);

    rows.push({
      radius,
      angle,
      height: gauss() * config.thickness * 2.4,
      seed: random(),
      size: 0.042 + random() * 0.061,
      soft: 1,
      // The veil sits under ~13 sprites instead of the ~100 it piled up at the
      // old framing, so this is a third of the former value: enough to glow,
      // light enough that the arm ridges stay the brightest thing on frame.
      bright: 0.02 + random() * 0.026,
    });
  }

  for (let i = 0; i < config.coreHazeStars; i += 1) {
    rows.push({
      radius: 0.34 * Math.pow(random(), 1.6),
      angle: random() * TAU,
      height: gauss() * 0.05,
      seed: random(),
      size: 0.061 + random() * 0.094,
      soft: 1,
      bright: 0.02 + random() * 0.026,
    });
  }

  // Unrelated background field, stored already in view space so it stays put
  // while the galaxy turns.
  for (let i = 0; i < config.skyStars; i += 1) {
    rows.push({
      sky: true,
      x: (random() * 2 - 1) * 5.2,
      y: (random() * 2 - 1) * 3.4,
      z: -0.9 + random() * 1.8,
      seed: random(),
      size: 0.0028 + random() * 0.0038,
      soft: 0,
      bright: 0.12 + random() * 0.4,
    });
  }

  starCount = rows.length;
  vertexData = new Float32Array(starCount * FLOATS_PER_VERTEX);

  let ptr = 0;
  for (const row of rows) {
    if (row.sky) {
      vertexData[ptr++] = row.x;
      vertexData[ptr++] = row.y;
      vertexData[ptr++] = row.z;
      vertexData[ptr++] = 1;
    } else {
      vertexData[ptr++] = row.radius;
      vertexData[ptr++] = row.angle;
      vertexData[ptr++] = row.height;
      vertexData[ptr++] = 0;
    }

    vertexData[ptr++] = row.seed;
    vertexData[ptr++] = row.size;
    vertexData[ptr++] = row.soft;
    vertexData[ptr++] = row.bright;
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

  // Shrink the focal length on narrow surfaces so the disc keeps clearing the
  // frame instead of cropping its arms.
  const focal = config.focal * Math.min(1, aspect / config.refAspect);

  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);

  gl.uniform1f(uniforms.u_time, time);
  gl.uniform2f(
    uniforms.u_resolution,
    gl.drawingBufferWidth,
    gl.drawingBufferHeight,
  );
  gl.uniform2f(uniforms.u_focal, focal / aspect, focal);
  gl.uniform4f(
    uniforms.u_motion,
    config.patternSpin,
    config.shear,
    config.shearRamp,
    config.distance,
  );
  gl.uniform3f(uniforms.u_look, config.tilt, config.wobble, config.rMax);
  gl.uniform1f(uniforms.u_strength, config.strength);

  gl.drawArrays(gl.POINTS, 0, starCount);

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
      "GalaxySpiral: Program link error",
      gl.getProgramInfoLog(created),
    );
    gl.deleteProgram(created);
    return null;
  }

  gl.useProgram(created);

  attribs.a_polar = gl.getAttribLocation(created, "a_polar");
  attribs.a_meta = gl.getAttribLocation(created, "a_meta");

  for (const name of [
    "u_time",
    "u_resolution",
    "u_focal",
    "u_motion",
    "u_look",
    "u_strength",
  ]) {
    uniforms[name] = gl.getUniformLocation(created, name);
  }

  const stride = FLOATS_PER_VERTEX * 4;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(attribs.a_polar);
  gl.vertexAttribPointer(attribs.a_polar, 4, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(attribs.a_meta);
  gl.vertexAttribPointer(attribs.a_meta, 4, gl.FLOAT, false, stride, 16);

  return created;
}

function compileShader(type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(
      `GalaxySpiral: Shader compile error (${type === gl.VERTEX_SHADER ? "vertex" : "fragment"})`,
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
