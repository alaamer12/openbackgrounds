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
  zoom: 1.35,
  cRadius: 0.7885,
  cSpeed: 0.045,
  cWobble: 0.028,
  deScale: 26.0,
  teal: [0.1, 0.78, 0.82],
  magenta: [0.95, 0.12, 0.6],
  hot: [1.0, 0.95, 1.0],
  deep: [0.015, 0.008, 0.03],
};

const VERT = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform vec2 u_pointer;
uniform float u_zoom;
uniform float u_c_radius;
uniform float u_c_speed;
uniform float u_c_wobble;
uniform float u_de_scale;
uniform vec3 u_teal;
uniform vec3 u_magenta;
uniform vec3 u_hot;
uniform vec3 u_deep;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
  float t = u_time;

  p += u_pointer * 0.035;

  float ca = t * 0.02;
  float cs = cos(ca);
  float sn = sin(ca);
  p = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y);
  p *= u_zoom * (1.0 + 0.07 * sin(t * 0.11));

  // The complex parameter walks a closed, slightly wobbled circle, so the
  // topology never stops morphing but always returns.
  float a = t * u_c_speed;
  vec2 c = u_c_radius * vec2(cos(a), sin(a))
      + u_c_wobble * vec2(cos(3.0 * a + 1.0), sin(2.0 * a));

  vec2 z = p;
  vec2 d = vec2(1.0, 0.0);
  float iter = 0.0;
  float escaped = 0.0;

  for (int k = 0; k < 40; k++) {
    if (dot(z, z) > 256.0) {
      escaped = 1.0;
      break;
    }
    d = vec2(z.x * d.x - z.y * d.y, z.x * d.y + z.y * d.x) * 2.0
        + vec2(1.0, 0.0);
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    iter += 1.0;
  }

  float de = 3.0;
  float mu = 0.0;
  if (escaped > 0.5) {
    float lz = length(z);
    float ld = max(length(d), 1e-5);
    de = min(lz * log(lz) / ld, 3.0);
    mu = iter + 1.0 - log(log(lz) / 0.6931) / 0.6931;
  }

  float glow = 1.0 / (1.0 + de * u_de_scale);

  // Interference bands read as depth contour rings around the set.
  float film = 0.5 + 0.5 * sin(mu * 0.85 + log(1.0 + de * 260.0) * 2.6 - t * 0.3);

  float neb = 0.5 + 0.5 * sin(p.x * 1.6 + sin(p.y * 2.2 + t * 0.05) * 1.5);
  float dust = pow(hash21(floor(p * 95.0)), 60.0);

  vec3 col = u_deep * (0.6 + 0.8 * neb);
  col = mix(col, u_teal, clamp(film, 0.0, 1.0) * (0.16 + glow * 0.95));
  col = mix(col, u_magenta, clamp(1.0 - film, 0.0, 1.0) * (0.12 + glow * 1.05));
  col += u_hot * pow(glow, 5.0) * 1.5;
  col += u_teal * glow * glow * 0.35;
  col += vec3(0.9, 0.92, 1.0) * dust * 0.9;

  col = vec3(1.0) - exp(-col * 1.35);
  col *= 1.0 - smoothstep(0.45, 1.2, length(p)) * 0.55;

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
      `FractalDrift: Shader compile error: ${gl.getShaderInfoLog(shader)}`,
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
    "u_zoom",
    "u_c_radius",
    "u_c_speed",
    "u_c_wobble",
    "u_de_scale",
    "u_teal",
    "u_magenta",
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
  gl.uniform1f(uniformLocations.u_zoom, config.zoom);
  gl.uniform1f(uniformLocations.u_c_radius, config.cRadius);
  gl.uniform1f(uniformLocations.u_c_speed, config.cSpeed);
  gl.uniform1f(uniformLocations.u_c_wobble, config.cWobble);
  gl.uniform1f(uniformLocations.u_de_scale, config.deScale);
  gl.uniform3fv(uniformLocations.u_teal, config.teal);
  gl.uniform3fv(uniformLocations.u_magenta, config.magenta);
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
    console.error("FractalDrift: WebGL not supported");
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
      `FractalDrift: Program link error: ${gl.getProgramInfoLog(program)}`,
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
