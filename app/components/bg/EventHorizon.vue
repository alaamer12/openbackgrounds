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
  shadow: 0.155,
  bend: 0.055,
  diskRadius: 0.34,
  diskWidth: 0.12,
  tilt: 0.19,
  spin: 0.55,
  starScale: 14.0,
  hot: [1.0, 0.86, 0.55],
  mid: [0.85, 0.32, 0.06],
  deep: [0.014, 0.01, 0.02],
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
uniform float u_shadow;
uniform float u_bend;
uniform float u_disk_r;
uniform float u_disk_w;
uniform float u_tilt;
uniform float u_spin;
uniform float u_star_scale;
uniform vec3 u_hot;
uniform vec3 u_mid;
uniform vec3 u_deep;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float gauss(float x, float c, float w) {
  float d = (x - c) / w;
  return exp(-d * d);
}

float starField(vec2 u) {
  vec2 c = floor(u);
  vec2 f = fract(u) - 0.5;
  float h = hash21(c);
  vec2 o = vec2(hash21(c + 13.71), hash21(c + 71.13)) - 0.5;
  float d = length(f - o * 0.72);
  float m = pow(max(0.0, 1.0 - d * 11.0), 9.0);
  return m * step(0.86, h) * (0.5 + 0.5 * hash21(c + 3.37));
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
  float t = u_time;

  p += u_pointer * vec2(0.02, 0.014);

  float r = length(p) + 1e-5;
  vec2 dir = p / r;

  // Gravitational deflection: an inverse-square push on the sampling
  // coordinates, so everything behind the hole wraps around the shadow.
  float bend = u_bend / (r * r + 0.045);
  vec2 q = p + dir * bend * 0.22;

  float inShadow = 1.0 - smoothstep(u_shadow * 0.9, u_shadow * 1.16, r);

  // Starfield smeared radially: three taps pulled toward the centre.
  float smear = clamp(bend * 3.0, 0.0, 0.5);
  vec2 qs = q * u_star_scale;
  float st = starField(qs);
  st = max(st, starField(qs - dir * smear * 0.55) * 0.7);
  st = max(st, starField(qs - dir * smear * 1.15) * 0.45);
  vec3 starCol = mix(vec3(0.5, 0.62, 0.9), vec3(1.0, 0.95, 0.86),
      hash21(floor(qs) + 5.1)) * st;

  float ang = atan(p.y, p.x);
  float swirl = ang * 2.0 + u_spin * t * (0.6 + 1.4 / (r + 0.35));

  vec2 dq = vec2(q.x, q.y / u_tilt);
  float dr = length(dq);
  float band = gauss(dr, u_disk_r, u_disk_w);
  float grain = 0.7 + 0.42 * sin(swirl * 3.0 + dr * 16.0 - t * 0.9);
  float doppler = 0.42 + 0.9 * pow(0.5 + 0.5 * cos(ang), 1.2);
  float disk = band * grain * doppler;

  // Lensed far side of the disk, plus the thin photon ring on the horizon.
  float arc = gauss(r, u_shadow * 1.55, 0.03)
      * (0.62 + 0.5 * sin(swirl * 5.0 - t * 1.4));
  float photon = gauss(r, u_shadow * 1.03, 0.009);
  float halo = gauss(r, u_shadow * 2.6, 0.2) * 0.3;

  float heat = disk * 1.15 + arc * 0.85 + photon * 1.7 + halo;
  heat *= 1.0 - inShadow;

  vec3 col = u_deep + starCol * (1.0 - inShadow) * 0.85;
  col += u_mid * heat * 0.85;
  col += u_hot * heat * heat * 0.6;
  col += vec3(1.0, 0.97, 0.92) * photon * photon * 0.75 * (1.0 - inShadow);

  col = vec3(1.0) - exp(-col * 1.25);
  col *= 1.0 - inShadow * 0.995;
  col *= 1.0 - smoothstep(0.55, 1.25, r) * 0.55;

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
      `EventHorizon: Shader compile error: ${gl.getShaderInfoLog(shader)}`,
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
    "u_shadow",
    "u_bend",
    "u_disk_r",
    "u_disk_w",
    "u_tilt",
    "u_spin",
    "u_star_scale",
    "u_hot",
    "u_mid",
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
  gl.uniform1f(uniformLocations.u_shadow, config.shadow);
  gl.uniform1f(uniformLocations.u_bend, config.bend);
  gl.uniform1f(uniformLocations.u_disk_r, config.diskRadius);
  gl.uniform1f(uniformLocations.u_disk_w, config.diskWidth);
  gl.uniform1f(uniformLocations.u_tilt, config.tilt);
  gl.uniform1f(uniformLocations.u_spin, config.spin);
  gl.uniform1f(uniformLocations.u_star_scale, config.starScale);
  gl.uniform3fv(uniformLocations.u_hot, config.hot);
  gl.uniform3fv(uniformLocations.u_mid, config.mid);
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
    console.error("EventHorizon: WebGL not supported");
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
      `EventHorizon: Program link error: ${gl.getProgramInfoLog(program)}`,
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
