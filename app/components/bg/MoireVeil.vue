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

// Screen-space moire, tuned to sit *behind* copy: the ground is deep navy and
// only the genuine coincidence points of the two ring grids light up. Line
// pitch and gains are what keep this off the screen-door artefact side of the
// effect: the two grids stay individually resolvable hairlines instead of
// fusing into a bright field.
const config = {
  maxDpr: 1.5,
  ringFreq: 46.0, // rings per half-frame: ~9px pitch at a 400px short axis
  spokes: 22.0,
  thickPx: 0.72,
  detune: 0.032,
  speed: 0.075,
  nodeGain: 1.5, // coincidence nodes: the only feature allowed to be bright
  ringGain: 0.085, // each grid on its own: a faint filament, not a lit line
  spokeGain: 0.04,
  coreGain: 0.16,
  exposure: 1.15,
  pale: [0.62, 0.93, 1.0],
  navyLow: [0.006, 0.014, 0.04],
  navyHigh: [0.0025, 0.007, 0.022],
};

const VERT = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAG = `
precision mediump float;

uniform vec2 u_resolution;
uniform float u_time;
uniform vec2 u_pointer;
uniform float u_ring_freq;
uniform float u_spokes;
uniform float u_thick;
uniform float u_detune;
uniform float u_speed;
uniform float u_node_gain;
uniform float u_ring_gain;
uniform float u_spoke_gain;
uniform float u_core_gain;
uniform float u_exposure;
uniform vec3 u_pale;
uniform vec3 u_navy_lo;
uniform vec3 u_navy_hi;

float lineGauss(float d, float w) {
  float e = min(d / w, 5.0);
  return exp(-e * e);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
  float t = u_time;

  p += u_pointer * 0.025;

  float r = length(p) + 1e-5;
  float w = u_thick / min(u_resolution.x, u_resolution.y);

  // Two concentric grids whose centres orbit at slightly different rates.
  // Intersecting them leaves bright nodes only where both sets of rings
  // coincide, which is exactly the moire lattice.
  vec2 c1 = vec2(cos(t * u_speed), sin(t * u_speed * 1.27)) * 0.14;
  vec2 c2 = vec2(cos(t * u_speed * 0.83 + 2.1), sin(t * u_speed * 0.71 + 1.05))
      * 0.17;

  float s1 = length(p - c1) * u_ring_freq;
  float detune = 1.0 + u_detune * sin(t * u_speed * 1.6);
  float s2 = length(p - c2) * u_ring_freq * detune;

  float d1 = abs(fract(s1) - 0.5) / u_ring_freq;
  float d2 = abs(fract(s2) - 0.5) / (u_ring_freq * detune);

  float l1 = lineGauss(d1, w);
  float l2 = lineGauss(d2, w);
  // Product, not geometric mean: a node needs both rings under the same pixel,
  // so the lattice is a sparse field of dots rather than a lit mesh.
  float nodes = l1 * l2;

  // A third, very faint radial grid: the spoke/ring beat adds a slow shimmer.
  float ang = atan(p.y, p.x) + t * u_speed * 0.4;
  float ss = ang * u_spokes / 6.28318;
  float ds = abs(fract(ss) - 0.5) * 6.28318 / u_spokes * r;
  float l3 = lineGauss(ds, w * 1.2);

  float env = 1.0 - smoothstep(0.18, 0.95, r);
  float field = nodes * u_node_gain * env + (l1 + l2) * u_ring_gain * env
      + l3 * u_spoke_gain * env;

  float up = clamp(p.y * 0.7 + 0.5, 0.0, 1.0);
  vec3 col = mix(u_navy_lo, u_navy_hi, up * up);
  // Cool the outer fringes toward steel, keep the nodes pale cyan rather than
  // white so copy on top of them still has something to push against.
  vec3 lineCol = mix(vec3(0.78, 0.9, 1.0), u_pale, clamp(r * 2.0, 0.0, 1.0));
  col += lineCol * field;
  col += u_pale * nodes * nodes * u_core_gain * env;

  col = vec3(1.0) - exp(-col * u_exposure);
  col *= 1.0 - smoothstep(0.55, 1.2, r) * 0.5;

  gl_FragColor = vec4(col, 1.0);
}
`;

let gl = null;
let program = null;
let buffer = null;
let frameId = null;
let startTime = 0;
const pointer = { x: 0, y: 0 };

const compile = (type, source) => {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(
      `MoireVeil: Shader compile error: ${gl.getShaderInfoLog(shader)}`,
    );
    gl.deleteShader(shader);
    return null;
  }

  return shader;
};

const uniformLocations = {};

const bindUniforms = () => {
  const names = [
    "u_resolution",
    "u_time",
    "u_pointer",
    "u_ring_freq",
    "u_spokes",
    "u_thick",
    "u_detune",
    "u_speed",
    "u_node_gain",
    "u_ring_gain",
    "u_spoke_gain",
    "u_core_gain",
    "u_exposure",
    "u_pale",
    "u_navy_lo",
    "u_navy_hi",
  ];

  for (const name of names) {
    uniformLocations[name] = gl.getUniformLocation(program, name);
  }
};

const resize = () => {
  if (!holderRef.value || !canvasRef.value || !gl) return;

  const dpr = Math.min(window.devicePixelRatio || 1, config.maxDpr);
  const width = Math.max(
    1,
    Math.floor(holderRef.value.offsetWidth * dpr) ||
      Math.floor(innerWidth * dpr),
  );
  const height = Math.max(
    1,
    Math.floor(holderRef.value.offsetHeight * dpr) ||
      Math.floor(innerHeight * dpr),
  );

  canvasRef.value.width = width;
  canvasRef.value.height = height;
  canvasRef.value.style.width = `${holderRef.value.offsetWidth}px`;
  canvasRef.value.style.height = `${holderRef.value.offsetHeight}px`;
  gl.viewport(0, 0, width, height);
};

const render = () => {
  if (!gl || !program) return;

  fpsMeter.tick();

  const time = (performance.now() - startTime) / 1000;

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

  const loc = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  gl.uniform2f(
    uniformLocations.u_resolution,
    gl.drawingBufferWidth,
    gl.drawingBufferHeight,
  );
  gl.uniform1f(uniformLocations.u_time, time);
  gl.uniform2f(uniformLocations.u_pointer, pointer.x, pointer.y);
  gl.uniform1f(uniformLocations.u_ring_freq, config.ringFreq);
  gl.uniform1f(uniformLocations.u_spokes, config.spokes);
  gl.uniform1f(uniformLocations.u_thick, config.thickPx);
  gl.uniform1f(uniformLocations.u_detune, config.detune);
  gl.uniform1f(uniformLocations.u_speed, config.speed);
  gl.uniform1f(uniformLocations.u_node_gain, config.nodeGain);
  gl.uniform1f(uniformLocations.u_ring_gain, config.ringGain);
  gl.uniform1f(uniformLocations.u_spoke_gain, config.spokeGain);
  gl.uniform1f(uniformLocations.u_core_gain, config.coreGain);
  gl.uniform1f(uniformLocations.u_exposure, config.exposure);
  gl.uniform3fv(uniformLocations.u_pale, config.pale);
  gl.uniform3fv(uniformLocations.u_navy_lo, config.navyLow);
  gl.uniform3fv(uniformLocations.u_navy_hi, config.navyHigh);

  gl.drawArrays(gl.TRIANGLES, 0, 3);

  frameId = requestAnimationFrame(render);
};

const onPointerMove = (event) => {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = (event.clientY / window.innerHeight) * 2 - 1;
};

const onResize = () => resize();

onMounted(() => {
  if (!holderRef.value || !canvasRef.value) return;

  gl =
    canvasRef.value.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: "high-performance",
    }) || canvasRef.value.getContext("experimental-webgl");

  if (!gl) {
    console.error("MoireVeil: WebGL not supported");
    return;
  }

  const vert = compile(gl.VERTEX_SHADER, VERT);
  const frag = compile(gl.FRAGMENT_SHADER, FRAG);

  if (!vert || !frag) return;

  program = gl.createProgram();
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);

  gl.deleteShader(vert);
  gl.deleteShader(frag);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(
      `MoireVeil: Program link error: ${gl.getProgramInfoLog(program)}`,
    );
    return;
  }

  bindUniforms();

  buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  // One oversized triangle: fewer vertices than a quad and no index buffer.
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );

  resize();
  window.addEventListener("resize", onResize, { passive: true });
  window.addEventListener("pointermove", onPointerMove, { passive: true });

  fpsMeter.start();
  startTime = performance.now();
  frameId = requestAnimationFrame(render);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
  window.removeEventListener("pointermove", onPointerMove);

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

    // Browsers cap live WebGL contexts near 16, and the gallery now has far
    // more scenes than that, so the context must be handed back explicitly.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    gl = null;
  }
});
</script>
