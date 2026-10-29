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
  scale: 2.4,
  warp: 1.5,
  crackCore: 26.0,
  crackGlow: 8.5,
  detail: 2.7,
  flow: 0.055,
  crust: [0.055, 0.05, 0.062],
  crustLit: [0.42, 0.13, 0.04],
  magma: [1.0, 0.3, 0.02],
  ember: [1.0, 0.86, 0.34],
  deep: [0.01, 0.006, 0.008],
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
uniform float u_scale;
uniform float u_warp;
uniform float u_core;
uniform float u_glow;
uniform float u_detail;
uniform float u_flow;
uniform vec3 u_crust;
uniform vec3 u_crust_lit;
uniform vec3 u_magma;
uniform vec3 u_ember;
uniform vec3 u_deep;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 x) {
  float v = 0.0;
  float a = 0.55;
  for (int i = 0; i < 2; i++) {
    v += a * vnoise(x);
    x = x * 2.1 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

// Signed, doubly-warped field: its zero set is the crack network, so the
// seams branch and close on themselves like cooled crust instead of echoing
// level sets of raw noise.
float crust(vec2 x, float t) {
  vec2 w = vec2(
      fbm(x + vec2(1.3, 4.7) + vec2(t * 0.6, -t * 0.4)),
      fbm(x * 1.13 + vec2(8.2, 0.7) - vec2(t * 0.5, t * 0.3)));
  return fbm(x + u_warp * w + vec2(t * u_flow, -t * u_flow * 0.6)) * 2.15 - 1.0;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
  float t = u_time;

  vec2 c = p * u_scale + u_pointer * 0.25;
  c += vec2(sin(t * 0.05), cos(t * 0.042)) * 0.35;

  float f = crust(c, t);
  float af = abs(f);

  float heat = exp(-af * u_glow);
  float core = exp(-af * u_core);
  float crack = heat * heat * 0.6 + core;

  // Hairline cracks in a second, finer network.
  float f2 = crust(c * u_detail + vec2(13.0, 4.0), t * 0.4);
  crack += exp(-abs(f2) * 55.0) * 0.32;

  // Pressure wave: veins swell and dim on a slow crawl across the plate.
  float breath = 0.62 + 0.42 * sin(c.x * 0.8 + c.y * 0.45 - t * 0.4);
  crack *= 0.55 + breath;

  float grain = hash21(floor(p * 260.0));
  float speck = 0.8 + 0.35 * grain;

  vec3 col = u_deep + u_crust * speck * (0.35 + 1.6 * heat);
  col += u_magma * crack * 0.9;
  col += u_ember * crack * crack * 1.1;
  col += u_crust_lit * heat * heat * 0.55;

  col = vec3(1.0) - exp(-col * 1.6);
  col *= 1.0 - smoothstep(0.35, 1.1, length(p)) * 0.6;

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
      `MagmaVeins: Shader compile error: ${gl.getShaderInfoLog(shader)}`,
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
    "u_scale",
    "u_warp",
    "u_core",
    "u_glow",
    "u_detail",
    "u_flow",
    "u_crust",
    "u_crust_lit",
    "u_magma",
    "u_ember",
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
  gl.uniform1f(uniformLocations.u_scale, config.scale);
  gl.uniform1f(uniformLocations.u_warp, config.warp);
  gl.uniform1f(uniformLocations.u_core, config.crackCore);
  gl.uniform1f(uniformLocations.u_glow, config.crackGlow);
  gl.uniform1f(uniformLocations.u_detail, config.detail);
  gl.uniform1f(uniformLocations.u_flow, config.flow);
  gl.uniform3fv(uniformLocations.u_crust, config.crust);
  gl.uniform3fv(uniformLocations.u_crust_lit, config.crustLit);
  gl.uniform3fv(uniformLocations.u_magma, config.magma);
  gl.uniform3fv(uniformLocations.u_ember, config.ember);
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
    console.error("MagmaVeins: WebGL not supported");
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
      `MagmaVeins: Program link error: ${gl.getProgramInfoLog(program)}`,
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
