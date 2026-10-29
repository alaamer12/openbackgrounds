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
  discRadius: 0.2,
  angularFreq: 4.4,
  radialFreq: 1.7,
  flow: 0.13,
  filamentSharpness: 4.6,
  fade: 1.15,
  gold: [1.0, 0.78, 0.3],
  orange: [1.0, 0.32, 0.05],
  hot: [1.0, 0.95, 0.8],
  deep: [0.02, 0.008, 0.004],
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
uniform float u_disc;
uniform float u_ang;
uniform float u_rad;
uniform float u_flow;
uniform float u_sharp;
uniform float u_fade;
uniform vec3 u_gold;
uniform vec3 u_orange;
uniform vec3 u_hot;
uniform vec3 u_deep;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.103, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float vnoise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);

  float a = hash31(i);
  float b = hash31(i + vec3(1.0, 0.0, 0.0));
  float c = hash31(i + vec3(0.0, 1.0, 0.0));
  float d = hash31(i + vec3(1.0, 1.0, 0.0));
  float e = hash31(i + vec3(0.0, 0.0, 1.0));
  float g = hash31(i + vec3(1.0, 0.0, 1.0));
  float h = hash31(i + vec3(0.0, 1.0, 1.0));
  float k = hash31(i + vec3(1.0, 1.0, 1.0));

  return mix(
      mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
      mix(mix(e, g, f.x), mix(h, k, f.x), f.y),
      f.z);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
  float t = u_time;

  p += u_pointer * 0.03;

  float r = length(p) + 1e-5;
  vec2 dir = p / r;

  // Sampling on the unit direction (not atan) keeps the filaments seam-free,
  // and the long correlation along the radius axis stretches them into
  // threads instead of blobs.
  float flow = t * u_flow;
  float n = vnoise3(vec3(dir * u_ang, r * u_rad - flow));
  n += 0.55 * vnoise3(vec3(dir * u_ang * 2.4 + 7.3, r * u_rad * 2.0 - flow * 1.7));
  n /= 1.55;

  float fil = pow(max(0.0, n), u_sharp) * 2.4;
  fil *= 0.72 + 0.42 * sin(t * 2.1 + n * 28.0);

  // Looping field: a second, slower set of arcs that swell and pinch.
  float loop = 0.55 + 0.45 * sin(r * 9.0 - t * 0.5 + dir.x * 2.0 + dir.y * 3.0);
  fil *= 0.55 + 0.9 * loop;

  float atten = exp(-max(0.0, r - u_disc) * u_fade);
  float limb = exp(-pow(min(abs(r - u_disc) / 0.014, 5.0), 2.0));
  float halo = exp(-pow(min(max(0.0, r - u_disc) / 0.42, 5.0), 2.0)) * 0.28;

  vec2 sc = floor(p * 150.0);
  float star = pow(max(0.0, 1.0 - length(fract(p * 150.0) - 0.5) * 11.0), 7.0);
  star *= step(0.972, hash21(sc));

  float cover = 1.0 - (1.0 - smoothstep(u_disc * 0.95, u_disc * 1.02, r)) * 0.998;

  vec3 col = u_deep + vec3(0.6, 0.7, 1.0) * star * cover;
  col += u_orange * (fil * 0.55 + halo) * atten * cover;
  col += u_gold * fil * atten * cover;
  col += u_hot * fil * fil * 0.55 * atten * cover;
  col += u_hot * limb * 0.85;
  col += mix(u_orange, u_gold, 0.5) * halo * 1.4 * cover;

  col = vec3(1.0) - exp(-col * 1.5);
  col *= 1.0 - smoothstep(0.5, 1.25, r) * 0.55;

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
      `SolarCorona: Shader compile error: ${gl.getShaderInfoLog(shader)}`,
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
    "u_disc",
    "u_ang",
    "u_rad",
    "u_flow",
    "u_sharp",
    "u_fade",
    "u_gold",
    "u_orange",
    "u_hot",
    "u_deep",
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
  gl.uniform1f(uniformLocations.u_disc, config.discRadius);
  gl.uniform1f(uniformLocations.u_ang, config.angularFreq);
  gl.uniform1f(uniformLocations.u_rad, config.radialFreq);
  gl.uniform1f(uniformLocations.u_flow, config.flow);
  gl.uniform1f(uniformLocations.u_sharp, config.filamentSharpness);
  gl.uniform1f(uniformLocations.u_fade, config.fade);
  gl.uniform3fv(uniformLocations.u_gold, config.gold);
  gl.uniform3fv(uniformLocations.u_orange, config.orange);
  gl.uniform3fv(uniformLocations.u_hot, config.hot);
  gl.uniform3fv(uniformLocations.u_deep, config.deep);

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
    console.error("SolarCorona: WebGL not supported");
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
      `SolarCorona: Program link error: ${gl.getProgramInfoLog(program)}`,
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
