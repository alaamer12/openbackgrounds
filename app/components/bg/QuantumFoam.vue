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
  fieldScale: 1.75,
  shellWidth: 0.1,
  absorb: 1.5,
  glow: 1.5,
  fog: 0.42,
  violet: [0.42, 0.22, 0.95],
  cyan: [0.2, 0.92, 1.0],
  deep: [0.012, 0.014, 0.035],
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
uniform float u_field_scale;
uniform float u_shell_width;
uniform float u_absorb;
uniform float u_glow;
uniform float u_fog;
uniform vec3 u_violet;
uniform vec3 u_cyan;
uniform vec3 u_deep;

float hash31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.103, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3(vec3 x) {
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

// Iso-surface of a slow 3D field, read as the membrane of a bubble.
float fieldAt(vec3 pos, float t) {
  vec3 q = pos * u_field_scale + vec3(0.0, 0.0, t * 0.22);
  q += vec3(sin(t * 0.13), cos(t * 0.11), sin(t * 0.09)) * 0.6;
  float f = noise3(q);
  f += 0.055 * sin(q.x * 11.0 + q.y * 8.0 - q.z * 9.0 + t * 0.8);
  return f;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
  float t = u_time;

  p += u_pointer * 0.05;

  vec3 ro = vec3(0.0, 0.0, -1.1);
  vec3 rd = normalize(vec3(p, 1.0));

  // Rotate the eye instead of the field so the bubbles parallax coherently.
  float ay = t * 0.07 + u_pointer.x * 0.15;
  float ax = sin(t * 0.05) * 0.28 - u_pointer.y * 0.12;
  float cy = cos(ay);
  float sy = sin(ay);
  rd = vec3(cy * rd.x + sy * rd.z, rd.y, -sy * rd.x + cy * rd.z);
  float cx = cos(ax);
  float sx = sin(ax);
  rd = vec3(rd.x, cx * rd.y - sx * rd.z, sx * rd.y + cx * rd.z);

  vec3 acc = vec3(0.0);
  float trans = 1.0;
  float fPrev = fieldAt(ro, t);
  const float ds = 0.13;

  for (int i = 0; i < 34; i++) {
    float tt = 0.1 + float(i) * ds;
    vec3 pos = ro + rd * tt;

    float f = fieldAt(pos, t);
    float df = f - fPrev;
    fPrev = f;

    float edge = abs(f - 0.5);
    float shell = pow(max(0.0, 1.0 - edge / u_shell_width), 2.0);
    float gas = smoothstep(0.5, 0.95, f) * 0.16;

    // The signed derivative along the ray fakes "which way the film faces".
    float facing = clamp(0.5 + df * 6.0, 0.0, 1.0);
    float depthFade = exp(-tt * u_fog);

    vec3 tint = mix(u_violet, u_cyan, facing * facing);
    acc += trans * (tint * shell * 1.5 + u_violet * gas) * depthFade * ds * u_glow;

    float dens = shell * 1.4 + gas;
    trans *= max(0.0, 1.0 - dens * ds * u_absorb);

    if (trans < 0.02) break;
  }

  vec3 col = acc + u_deep * trans * 0.6;
  col = vec3(1.0) - exp(-col * 1.6);
  col *= 1.0 - smoothstep(0.5, 1.3, length(p)) * 0.5;

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
      `QuantumFoam: Shader compile error: ${gl.getShaderInfoLog(shader)}`,
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
    "u_field_scale",
    "u_shell_width",
    "u_absorb",
    "u_glow",
    "u_fog",
    "u_violet",
    "u_cyan",
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
  gl.uniform1f(uniformLocations.u_field_scale, config.fieldScale);
  gl.uniform1f(uniformLocations.u_shell_width, config.shellWidth);
  gl.uniform1f(uniformLocations.u_absorb, config.absorb);
  gl.uniform1f(uniformLocations.u_glow, config.glow);
  gl.uniform1f(uniformLocations.u_fog, config.fog);
  gl.uniform3fv(uniformLocations.u_violet, config.violet);
  gl.uniform3fv(uniformLocations.u_cyan, config.cyan);
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
    console.error("QuantumFoam: WebGL not supported");
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
      `QuantumFoam: Program link error: ${gl.getProgramInfoLog(program)}`,
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
