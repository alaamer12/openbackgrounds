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
  camHeight: 0.35,
  scroll: 0.55,
  rowFreq: 7.0,
  colFreq: 6.0,
  lineThick: 0.0034,
  sunRadius: 0.2,
  bandFreq: 7.0,
  pulseFreq: 1.6,
  rowColor: [1.0, 0.16, 0.72],
  colColor: [0.1, 0.9, 1.0],
  skyTop: [0.012, 0.01, 0.06],
  skyLow: [0.14, 0.03, 0.28],
  haze: [1.0, 0.42, 0.16],
  sunTop: [1.0, 0.92, 0.36],
  sunBottom: [1.0, 0.12, 0.55],
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
uniform float u_cam_h;
uniform float u_scroll;
uniform float u_row_freq;
uniform float u_col_freq;
uniform float u_line_thick;
uniform float u_sun_r;
uniform float u_band_freq;
uniform float u_pulse_freq;
uniform vec3 u_row_col;
uniform vec3 u_col_col;
uniform vec3 u_sky_top;
uniform vec3 u_sky_low;
uniform vec3 u_haze;
uniform vec3 u_sun_top;
uniform vec3 u_sun_bot;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Analytic gaussian line: the world-space distance is divided by the exact
// screen-space derivative, so lines stay one pixel wide at any depth without
// needing the derivatives extension.
float lineGlow(float d, float w) {
  float e = min(d / w, 6.0);
  return exp(-e * e);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
  float t = u_time;

  float horizon = 0.035 - u_pointer.y * 0.025;
  p.x += u_pointer.x * 0.04;

  float up = clamp((p.y - horizon) / 0.85, 0.0, 1.0);
  vec3 col = mix(u_sky_low, u_sky_top, pow(up, 0.75));

  // Faint stars, only well above the haze.
  vec2 suv = (p - vec2(0.0, horizon)) * 170.0;
  vec2 sg = floor(suv);
  float hs = hash21(sg);
  vec2 jit = (vec2(hash21(sg + 13.7), hash21(sg + 71.3)) - 0.5) * 0.6;
  float star = pow(max(0.0, 1.0 - length(fract(suv) - 0.5 - jit) * 10.0), 6.0);
  star *= step(0.955, hs) * up * up;
  col += vec3(0.7, 0.8, 1.0) * star * (0.6 + 0.4 * sin(t * 2.0 + hs * 40.0));

  // Banded setting sun with a wide bloom.
  vec2 sc = vec2(0.0, horizon + 0.235);
  float sd = length(p - sc);
  float depth = clamp((sc.y - p.y) / (u_sun_r * 2.0), 0.0, 1.0);
  float sun = 1.0 - smoothstep(u_sun_r * 0.985, u_sun_r * 1.015, sd);
  float b = abs(fract(pow(depth, 1.35) * u_band_freq) - 0.5) * 2.0;
  float cut = smoothstep(0.12, 0.55, b);
  sun *= mix(1.0, cut, smoothstep(0.05, 0.6, depth));
  col = mix(col, mix(u_sun_top, u_sun_bot, pow(depth, 0.7)), sun);
  float bloom = exp(-pow(min(max(0.0, sd - u_sun_r) / 0.17, 4.0), 2.0));
  col += mix(u_sun_top, u_sun_bot, 0.4) * bloom * 0.5;
  col += u_haze * exp(-pow(min(abs(p.y - horizon) / 0.03, 5.0), 2.0)) * 0.55;

  // Receding grid: rows along the ground plane, columns toward the vanishing
  // point, both derived from one perspective divide.
  float y = max(horizon - p.y, 0.0018);
  float zz = u_cam_h / y;
  float s = (zz + t * u_scroll) * u_row_freq;
  float dsdy = u_cam_h * u_row_freq / (y * y);
  float rowLine = lineGlow(abs(fract(s) - 0.5) / dsdy, u_line_thick);
  float xw = p.x * u_cam_h / y * u_col_freq;
  float dvdX = u_cam_h * u_col_freq / y;
  float colLine = lineGlow(abs(fract(xw) - 0.5) / dvdX, u_line_thick);

  float pulse = pow(0.5 + 0.5 * sin(zz * u_pulse_freq + t * u_scroll * 3.4), 5.0);
  float fog = smoothstep(0.0, 0.055, y);
  float ground = step(p.y, horizon);

  vec3 grid = (u_row_col * rowLine * (0.55 + 1.5 * pulse) + u_col_col * colLine)
      * fog * ground;
  vec3 darkGround = vec3(0.015, 0.006, 0.04);
  col = mix(col, darkGround, ground * 0.86);
  col += grid;
  // Wet-looking column of sun-light down the middle of the plane.
  col += u_sun_top * exp(-pow(min(abs(p.x) / 0.15, 5.0), 2.0))
      * exp(-y * 2.6) * ground * 0.30;

  col = vec3(1.0) - exp(-col * 1.5);
  col *= 0.95 + 0.05 * sin(gl_FragCoord.y * 3.14159);
  col *= 1.0 - smoothstep(0.5, 1.25, length(p - vec2(0.0, horizon * 0.3))) * 0.45;

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
      `NeonHorizon: Shader compile error: ${gl.getShaderInfoLog(shader)}`,
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
    "u_cam_h",
    "u_scroll",
    "u_row_freq",
    "u_col_freq",
    "u_line_thick",
    "u_sun_r",
    "u_band_freq",
    "u_pulse_freq",
    "u_row_col",
    "u_col_col",
    "u_sky_top",
    "u_sky_low",
    "u_haze",
    "u_sun_top",
    "u_sun_bot",
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
  gl.uniform1f(uniformLocations.u_cam_h, config.camHeight);
  gl.uniform1f(uniformLocations.u_scroll, config.scroll);
  gl.uniform1f(uniformLocations.u_row_freq, config.rowFreq);
  gl.uniform1f(uniformLocations.u_col_freq, config.colFreq);
  gl.uniform1f(uniformLocations.u_line_thick, config.lineThick);
  gl.uniform1f(uniformLocations.u_sun_r, config.sunRadius);
  gl.uniform1f(uniformLocations.u_band_freq, config.bandFreq);
  gl.uniform1f(uniformLocations.u_pulse_freq, config.pulseFreq);
  gl.uniform3fv(uniformLocations.u_row_col, config.rowColor);
  gl.uniform3fv(uniformLocations.u_col_col, config.colColor);
  gl.uniform3fv(uniformLocations.u_sky_top, config.skyTop);
  gl.uniform3fv(uniformLocations.u_sky_low, config.skyLow);
  gl.uniform3fv(uniformLocations.u_haze, config.haze);
  gl.uniform3fv(uniformLocations.u_sun_top, config.sunTop);
  gl.uniform3fv(uniformLocations.u_sun_bot, config.sunBottom);

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
    console.error("NeonHorizon: WebGL not supported");
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
      `NeonHorizon: Program link error: ${gl.getProgramInfoLog(program)}`,
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
