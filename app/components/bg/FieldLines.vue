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

// Framing key: the projection writes `q.xy * focal / w` and clip-space w divides
// by `w` a second time, so a feature's on-screen radius is
// `r * focal / (z + distance)^2` and the composition is set by
// `lMax * focal / distance^2`. That product is 0.62 of the shorter viewport axis
// here: the outermost shell reaches 0.76 down and 0.88 across (as a fraction of
// frame height), while the dipole poles sit at 0.22, well inside frame. Both
// 640x400 and 1920x1080 are at or above `refAspect`, so the landscape clamp is
// inactive and the apparatus is framed the same at either size.
const config = {
  maxDpr: 1.5,
  seed: 20260927,
  // Radius of the body the dipole sits in, in world units.
  core: 1.0,
  shells: 7,
  lMin: 1.35,
  lMax: 4.8,
  longitudes: 12,
  arcSamples: 52,
  meridians: 5,
  parallels: 4,
  graticuleSamples: 44,
  charges: 1500,
  ovalCharges: 340,
  dust: 800,
  // A charge swings between its two mirror points. The sine eases it to a crawl
  // at both ends, which is what pools them into bright auroral ovals.
  swingMin: 0.1,
  swingMax: 0.34,
  // Slow azimuthal carry of the whole charge population, like an E cross B
  // drift on an instrument readout.
  driftRate: 0.03,
  spin: 0.07,
  tilt: 0.36,
  tiltSwell: 0.05,
  focal: 15.6,
  distance: 11.0,
  refAspect: 1.6,
  // Follows the camera out: the shells span distance +/- lMax, and keeping the
  // window on that band preserves the old rule that the near half of the
  // apparatus is at full strength and the back of it fades to nothing.
  depthNear: 8.4,
  depthFar: 16.6,
  // Arcs used to lie ten deep in a smudge the size of a coin; at this scale a
  // pixel is crossed by one or two, so each line carries its own brightness.
  arcBrightness: 0.55,
  graticuleBrightness: 0.14,
  pulseRate: 0.7,
  chargeStrength: 1.25,
  dustAlpha: 0.4,
  arc: [0.14, 0.66, 0.58],
  hot: [0.45, 1.0, 0.82],
  pole: [0.88, 1.0, 0.95],
  ground: [0.002, 0.011, 0.013],
};

const TAU = Math.PI * 2;
const LINE_FLOATS = 7;
const CHARGE_FLOATS = 11;

// Both passes share one view transform, so the helpers are concatenated into
// each vertex shader instead of being retyped.
const GLSL_ROT = `
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

  vec3 toCamera(vec3 p, vec4 view, float t) {
    float tilt = view.x + view.y * sin(t * 0.05);
    return rotX(tilt) * rotY(t * view.z) * p;
  }
`;

// Static dipole arcs. r = L * sin^2(theta) is the field-line surface of a
// magnetic dipole, truncated where the line re-enters the sphere.
const FIELD_VERT = `
  precision highp float;

  attribute vec3 a_pos;
  attribute vec4 a_data;

  uniform float u_time;
  uniform vec2 u_focal;
  uniform vec4 u_view;
  uniform vec4 u_look;
  uniform vec2 u_depth;
  uniform vec3 u_arc;

  varying vec3 v_color;
  varying float v_alpha;

  ${GLSL_ROT}

  void main() {
    vec3 q = toCamera(a_pos, u_view, u_time);

    float w = max(q.z + u_view.w, 0.05);
    gl_Position = vec4(q.xy * u_focal / w, 0.0, w);

    float guide = step(0.5, a_data.w);
    float sweep =
      0.5 + 0.5 * sin(a_data.y * 3.2 - u_time * u_look.z + a_data.x * 2.4);
    float fade = pow(1.0 - smoothstep(u_depth.x, u_depth.y, w), 1.5);

    v_color = mix(u_arc, u_arc * 0.6 + vec3(0.03, 0.14, 0.13), guide);
    v_alpha = clamp(
      fade *
        mix(u_look.x, u_look.y, guide) *
        mix(0.35 + sweep, 1.0, guide),
      0.0,
      1.0
    );
  }
`;

// Charges ride those arcs. Theta is a sine of time, so every particle slows
// down at both mirror points and the poles light up without extra geometry.
const CHARGE_VERT = `
  precision highp float;

  attribute vec4 a_orbit;
  attribute vec4 a_meta;
  attribute vec3 a_dust;

  uniform float u_time;
  uniform vec2 u_resolution;
  uniform vec2 u_focal;
  uniform vec4 u_view;
  uniform vec4 u_look;
  uniform vec2 u_depth;
  uniform float u_core;
  uniform vec3 u_hot;
  uniform vec3 u_pole;

  varying vec3 v_color;
  varying float v_alpha;

  ${GLSL_ROT}

  void main() {
    float dust = a_meta.w;
    float L = max(a_orbit.x, 0.12);
    float foot = asin(sqrt(clamp(u_core / L, 0.0, 1.0)));
    float swing = sin(u_time * a_orbit.z + a_orbit.w);
    float theta = 1.5707963 + (1.5707963 - foot) * swing;
    float phi = a_orbit.y + u_time * u_look.x * (0.4 + a_meta.x);

    float st = sin(theta);
    float rr = L * st * st;

    vec3 p = vec3(rr * st * cos(phi), rr * cos(theta), rr * st * sin(phi));

    // Dust is authored directly in view space so it stays a still medium
    // behind the apparatus.
    vec3 q = mix(toCamera(p, u_view, u_time), a_dust, dust);

    float w = max(q.z + u_view.w, 0.05);
    gl_Position = vec4(q.xy * u_focal / w, 0.0, w);

    float pool = smoothstep(0.5, 1.0, abs(swing));
    float fade = pow(1.0 - smoothstep(u_depth.x, u_depth.y, w), 1.35);
    float twinkle = 0.55 + 0.45 * sin(u_time * 2.1 + a_meta.x * 41.0);

    float bright = a_meta.y * fade * (0.45 + 0.95 * pool);
    float haze = a_meta.y * fade * twinkle * u_look.y;

    v_color = mix(u_hot, u_pole, pool);
    v_alpha = clamp(mix(bright, haze, dust), 0.0, 1.0);

    gl_PointSize = clamp(
      a_meta.z * u_focal.y * u_resolution.y * 0.5 / max(w, 0.4),
      1.0,
      90.0
    );
  }
`;

const LINE_FRAG = `
  precision mediump float;

  varying vec3 v_color;
  varying float v_alpha;

  void main() {
    gl_FragColor = vec4(v_color, v_alpha);
  }
`;

const CHARGE_FRAG = `
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
    float halo = pow(k, 2.2);
    float core = pow(k, 12.0);

    vec3 col = v_color + vec3(0.9, 1.0, 0.95) * core;
    gl_FragColor = vec4(col, v_alpha * u_strength * (0.12 + 0.88 * halo));
  }
`;

let gl = null;
let lineProgram = null;
let chargeProgram = null;
let lineBuffer = null;
let chargeBuffer = null;
let lineData = null;
let chargeData = null;
let lineCount = 0;
let chargeCount = 0;
let frameId = null;
let startTime = 0;

const lineLoc = { attribs: {}, uniforms: {} };
const chargeLoc = { attribs: {}, uniforms: {} };

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
    console.error("FieldLines: WebGL context unavailable");
    return;
  }

  buildField();
  buildCharges();

  lineBuffer = createStaticBuffer(lineData);
  chargeBuffer = createStaticBuffer(chargeData);
  lineData = null;
  chargeData = null;

  lineProgram = createProgram(FIELD_VERT, LINE_FRAG, lineLoc, [
    "a_pos",
    "a_data",
  ]);
  chargeProgram = createProgram(CHARGE_VERT, CHARGE_FRAG, chargeLoc, [
    "a_orbit",
    "a_meta",
    "a_dust",
  ]);
  if (!lineProgram || !chargeProgram) return;

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
    if (chargeBuffer) gl.deleteBuffer(chargeBuffer);
    if (lineProgram) gl.deleteProgram(lineProgram);
    if (chargeProgram) gl.deleteProgram(chargeProgram);

    lineBuffer = null;
    chargeBuffer = null;
    lineProgram = null;
    chargeProgram = null;

    gl.getExtension("WEBGL_lose_context")?.loseContext();
    gl = null;
  }
});

function fieldPoint(arm, radius, theta) {
  const st = Math.sin(theta);
  return [
    radius * st * Math.cos(arm),
    radius * Math.cos(theta),
    radius * st * Math.sin(arm),
  ];
}

function buildField() {
  const rows = [];

  const push = (position, L, theta, kind) => {
    rows.push({ position, data: [L, theta, 0, kind] });
  };

  for (let s = 0; s < config.shells; s += 1) {
    const blend = config.shells > 1 ? s / (config.shells - 1) : 0;
    const L = config.lMin + (config.lMax - config.lMin) * blend;
    const foot = Math.asin(Math.sqrt(config.core / L));

    for (let a = 0; a < config.longitudes; a += 1) {
      const arm = (a / config.longitudes) * TAU;
      let previous = null;

      for (let i = 0; i < config.arcSamples; i += 1) {
        const t = i / (config.arcSamples - 1);
        const theta = foot + (Math.PI - 2 * foot) * t;
        const radius = L * Math.pow(Math.sin(theta), 2);
        const position = fieldPoint(arm, radius, theta);

        if (previous) {
          push(previous.position, L, previous.theta, 0);
          push(position, L, theta, 0);
        }

        previous = { position, theta };
      }
    }
  }

  // A faint graticule so the source body reads as a sphere, not a dot.
  for (let m = 0; m < config.meridians; m += 1) {
    const arm = (m / config.meridians) * Math.PI;
    let previous = null;

    for (let i = 0; i <= config.graticuleSamples; i += 1) {
      const theta = (i / config.graticuleSamples) * Math.PI;
      const position = fieldPoint(arm, config.core, theta);

      if (previous) {
        push(previous, config.core, theta, 1);
        push(position, config.core, theta, 1);
      }

      previous = position;
    }
  }

  for (let p = 0; p < config.parallels; p += 1) {
    const theta = ((p + 1) / (config.parallels + 1)) * Math.PI;
    const ring = config.core * Math.sin(theta);
    let previous = null;

    for (let i = 0; i <= config.graticuleSamples; i += 1) {
      const arm = (i / config.graticuleSamples) * TAU;
      const position = [
        ring * Math.cos(arm),
        config.core * Math.cos(theta),
        ring * Math.sin(arm),
      ];

      if (previous) {
        push(previous, config.core, theta, 1);
        push(position, config.core, theta, 1);
      }

      previous = position;
    }
  }

  // The dipole axis: the one straight thing in the diagram.
  push([0, -config.core * 1.7, 0], config.core, 0, 2);
  push([0, config.core * 1.7, 0], config.core, 0, 2);

  lineCount = rows.length;
  lineData = new Float32Array(lineCount * LINE_FLOATS);

  let ptr = 0;
  for (const row of rows) {
    lineData[ptr++] = row.position[0];
    lineData[ptr++] = row.position[1];
    lineData[ptr++] = row.position[2];
    lineData[ptr++] = row.data[0];
    lineData[ptr++] = row.data[1];
    lineData[ptr++] = row.data[2];
    lineData[ptr++] = row.data[3];
  }
}

function buildCharges() {
  const random = makeRandom(config.seed);
  const rows = [];

  const add = (L, phi, rate, phase, bright, size, dustPosition) => {
    rows.push({
      orbit: [L, phi, rate, phase],
      meta: [random(), bright, size, dustPosition ? 1 : 0],
      dust: dustPosition || [0, 0, 0],
    });
  };

  for (let i = 0; i < config.charges; i += 1) {
    const L =
      config.lMin + Math.pow(random(), 1.4) * (config.lMax - config.lMin);
    const rate =
      (config.swingMin + random() * (config.swingMax - config.swingMin)) *
      (2.4 / L);

    add(
      L,
      random() * TAU,
      rate,
      random() * TAU,
      0.5 + random() * 0.5,
      // Sprite sizes divide out by the ~6.5x growth in focal length (offset by
      // the camera pull-back), so a charge still covers the same pixels it did
      // and magnifying the apparatus costs no extra fragments.
      0.007 + random() * 0.0085,
    );
  }

  // The oval population hugs the sphere and traces the two footpoint rings.
  for (let i = 0; i < config.ovalCharges; i += 1) {
    add(
      config.core + random() * 0.12,
      random() * TAU,
      0.3 + random() * 0.5,
      random() * TAU,
      0.7 + random() * 0.3,
      0.0046 + random() * 0.0077,
    );
  }

  // Dust is authored in view space, so its spread has to be wide enough to land
  // outside the arcs' rim; at this focal length a unit of world offset covers
  // far fewer pixels than it used to.
  for (let i = 0; i < config.dust; i += 1) {
    add(
      0,
      0,
      0,
      random() * TAU,
      0.14 + random() * 0.24,
      0.0185 + random() * 0.0525,
      [
        (random() * 2 - 1) * 11.5,
        (random() * 2 - 1) * 7.0,
        -1.0 + random() * 2.0,
      ],
    );
  }

  chargeCount = rows.length;
  chargeData = new Float32Array(chargeCount * CHARGE_FLOATS);

  let ptr = 0;
  for (const row of rows) {
    chargeData[ptr++] = row.orbit[0];
    chargeData[ptr++] = row.orbit[1];
    chargeData[ptr++] = row.orbit[2];
    chargeData[ptr++] = row.orbit[3];
    chargeData[ptr++] = row.meta[0];
    chargeData[ptr++] = row.meta[1];
    chargeData[ptr++] = row.meta[2];
    chargeData[ptr++] = row.meta[3];
    chargeData[ptr++] = row.dust[0];
    chargeData[ptr++] = row.dust[1];
    chargeData[ptr++] = row.dust[2];
  }
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
  if (!gl || !lineProgram || !chargeProgram) return;

  const time = (now - startTime) * 0.001;
  const aspect =
    gl.drawingBufferHeight === 0
      ? 1
      : gl.drawingBufferWidth / gl.drawingBufferHeight;
  const focal = config.focal * Math.min(1, aspect / config.refAspect);

  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(lineProgram);
  gl.uniform1f(lineLoc.uniforms.u_time, time);
  gl.uniform2f(lineLoc.uniforms.u_focal, focal / aspect, focal);
  gl.uniform4f(
    lineLoc.uniforms.u_view,
    config.tilt,
    config.tiltSwell,
    config.spin,
    config.distance,
  );
  gl.uniform4f(
    lineLoc.uniforms.u_look,
    config.arcBrightness,
    config.graticuleBrightness,
    config.pulseRate,
    0,
  );
  gl.uniform2f(lineLoc.uniforms.u_depth, config.depthNear, config.depthFar);
  gl.uniform3fv(lineLoc.uniforms.u_arc, config.arc);
  applyAttribs(lineLoc, lineBuffer, LINE_FLOATS, [
    ["a_pos", 3, 0],
    ["a_data", 4, 12],
  ]);
  gl.drawArrays(gl.LINES, 0, lineCount);

  gl.useProgram(chargeProgram);
  gl.uniform1f(chargeLoc.uniforms.u_time, time);
  gl.uniform2f(
    chargeLoc.uniforms.u_resolution,
    gl.drawingBufferWidth,
    gl.drawingBufferHeight,
  );
  gl.uniform2f(chargeLoc.uniforms.u_focal, focal / aspect, focal);
  gl.uniform4f(
    chargeLoc.uniforms.u_view,
    config.tilt,
    config.tiltSwell,
    config.spin,
    config.distance,
  );
  gl.uniform4f(
    chargeLoc.uniforms.u_look,
    config.driftRate,
    config.dustAlpha,
    0,
    0,
  );
  gl.uniform2f(chargeLoc.uniforms.u_depth, config.depthNear, config.depthFar);
  gl.uniform1f(chargeLoc.uniforms.u_core, config.core);
  gl.uniform1f(chargeLoc.uniforms.u_strength, config.chargeStrength);
  gl.uniform3fv(chargeLoc.uniforms.u_hot, config.hot);
  gl.uniform3fv(chargeLoc.uniforms.u_pole, config.pole);
  applyAttribs(chargeLoc, chargeBuffer, CHARGE_FLOATS, [
    ["a_orbit", 4, 0],
    ["a_meta", 4, 16],
    ["a_dust", 3, 32],
  ]);
  gl.drawArrays(gl.POINTS, 0, chargeCount);

  fpsMeter.tick();
  frameId = requestAnimationFrame(render);
}

function applyAttribs(loc, buffer, floats, binds) {
  const stride = floats * 4;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

  for (const [name, size, offset] of binds) {
    const location = loc.attribs[name];
    if (location < 0) continue;
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
  }
}

function createProgram(vertexSource, fragmentSource, target, attributeNames) {
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
      "FieldLines: Program link error",
      gl.getProgramInfoLog(created),
    );
    gl.deleteProgram(created);
    return null;
  }

  gl.useProgram(created);

  for (const name of attributeNames) {
    target.attribs[name] = gl.getAttribLocation(created, name);
  }

  for (const name of [
    "u_time",
    "u_resolution",
    "u_focal",
    "u_view",
    "u_look",
    "u_depth",
    "u_core",
    "u_arc",
    "u_hot",
    "u_pole",
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
      `FieldLines: Shader compile error (${type === gl.VERTEX_SHADER ? "vertex" : "fragment"})`,
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
