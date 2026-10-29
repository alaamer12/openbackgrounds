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
  gridFreq: 1.15,
  ringFreq: 1.9,
  spokes: 20.0,
  scanSpeed: 0.22,
  linePx: 1.6,
  holo: [0.34, 0.95, 1.0],
  deep: [0.008, 0.016, 0.026],
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
uniform float u_grid;
uniform float u_ring;
uniform float u_spokes;
uniform float u_scan_speed;
uniform float u_line_px;
uniform vec3 u_holo;
uniform vec3 u_deep;

// Rational spike instead of exp(): this is evaluated three times per pixel
// for the chromatic split, so the falloff has to be cheap.
float lineG(float d, float w) {
  float e = min(abs(d) / max(w, 1e-5), 3.0);
  float e2 = e * e;
  return 1.0 / (1.0 + e2 * e2 * 6.0);
}

// Four stacked horizontal planes, each intersected by the view ray and drawn
// as a polar/radar grid. Line width is derived from the ray distance, which
// is what puts them in perspective.
float planes(vec2 q, float t, float zoom) {
  float px = 1.0 / min(u_resolution.x, u_resolution.y);
  vec3 rd = normalize(vec3(q.x * zoom, q.y * zoom * 0.8 - 0.12, 1.4));
  vec3 ro = vec3(sin(t * 0.11) * 0.22,
      1.1 + u_pointer.y * 0.18,
      -2.4 - u_pointer.x * 0.1);

  float acc = 0.0;

  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float py = 0.02 + fi * 0.32 + 0.04 * sin(t * 0.45 + fi * 1.9);

    if (rd.y < -0.002) {
      float rt = (py - ro.y) / rd.y;

      if (rt > 0.15 && rt < 11.0) {
        vec3 w = ro + rd * rt;
        float pw = px * rt * u_line_px;

        float dx = abs(fract(w.x * u_grid) - 0.5) / u_grid;
        float dz = abs(fract(w.z * u_grid) - 0.5) / u_grid;

        float rr = length(vec2(w.x, w.z * 0.85));
        float dr = abs(fract(rr * u_ring) - 0.5) / u_ring;

        float aa = atan(w.z, w.x) * u_spokes / 6.28318;
        float ds = abs(fract(aa) - 0.5) * 6.28318 / u_spokes * rr;

        float g = max(lineG(dx, pw), lineG(dz, pw));
        g = max(g, lineG(dr, pw * 0.85) * 0.8);
        g = max(g, lineG(ds, pw * 1.4) * 0.28);

        // Frame edge of the plane, so each sheet has a hard boundary.
        float edge = max(abs(w.x), abs(w.z * 0.85)) - 2.6;
        g += lineG(edge, pw * 1.2) * 0.5;

        float atten = exp(-max(0.0, rt - 1.0) * 0.34);
        float shimmer = 0.55 + 0.5 * sin(t * 0.7 + fi * 2.1);
        acc += g * atten * shimmer;
      }
    }
  }

  return acc;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
  float t = u_time;

  p += u_pointer * vec2(0.02, 0.015);

  float iR = planes(p, t, 1.006);
  float iG = planes(p, t, 1.0);
  float iB = planes(p, t, 0.994);

  // Bright bar sweeping up the stack, then a slower ghost sweep.
  float scanY = fract(t * u_scan_speed) * 1.7 - 0.85;
  float se = min(abs(p.y - scanY) / 0.045, 4.0);
  float scan = exp(-se * se);
  float se2 = min(abs(p.y - (fract(t * u_scan_speed * 0.37) * 1.7 - 0.85)) / 0.12, 4.0);
  float scan2 = exp(-se2 * se2) * 0.3;

  float sweep = 1.0 + scan * 2.4 + scan2;

  vec3 col = u_deep;
  col.r += iR * 0.52 * sweep;
  col.g += iG * 1.0 * sweep;
  col.b += iB * 1.06 * sweep;
  col += u_holo * (scan * 0.10 + scan2 * 0.05);

  // Projection haze rising from the emitter under the stack.
  float haze = max(0.0, 0.55 - p.y) * exp(-pow(min(abs(p.x) / 0.5, 4.0), 2.0));
  col += u_holo * haze * 0.1;

  float flick = 0.93 + 0.05 * sin(t * 41.0) + 0.04 * sin(t * 12.7 + 1.3);
  col *= flick;
  col *= 0.92 + 0.08 * sin(gl_FragCoord.y * 3.14159);

  col = vec3(1.0) - exp(-col * 1.8);
  col *= 1.0 - smoothstep(0.4, 1.15, length(p)) * 0.6;

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
      `HologramScan: Shader compile error: ${gl.getShaderInfoLog(shader)}`,
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
    "u_grid",
    "u_ring",
    "u_spokes",
    "u_scan_speed",
    "u_line_px",
    "u_holo",
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
  gl.uniform1f(uniformLocations.u_grid, config.gridFreq);
  gl.uniform1f(uniformLocations.u_ring, config.ringFreq);
  gl.uniform1f(uniformLocations.u_spokes, config.spokes);
  gl.uniform1f(uniformLocations.u_scan_speed, config.scanSpeed);
  gl.uniform1f(uniformLocations.u_line_px, config.linePx);
  gl.uniform3fv(uniformLocations.u_holo, config.holo);
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
    console.error("HologramScan: WebGL not supported");
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
      `HologramScan: Program link error: ${gl.getProgramInfoLog(program)}`,
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
