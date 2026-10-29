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
  cells: 7.5,
  edgeWidth: 1.6,
  haloWidth: 7.0,
  pulseFreq: 1.15,
  pulseSpeed: 0.55,
  edgeColor: [0.16, 0.56, 1.0],
  nodeColor: [0.65, 0.95, 1.0],
  cellColor: [0.05, 0.16, 0.4],
  deep: [0.006, 0.012, 0.028],
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
uniform float u_cells;
uniform float u_edge_w;
uniform float u_halo_w;
uniform float u_pulse_freq;
uniform float u_pulse_speed;
uniform vec3 u_edge_col;
uniform vec3 u_node_col;
uniform vec3 u_cell_col;
uniform vec3 u_deep;

vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
  float t = u_time;

  vec2 q = p * u_cells + u_pointer * 0.35;
  // Whole lattice creeps, so the cells slide rather than boil.
  q += vec2(t * 0.12, -t * 0.07);

  vec2 ip = floor(q);
  vec2 f = fract(q);

  // Line width is derived from the pixel footprint, so the traces stay one
  // or two pixels wide at any cell density.
  float wpx = u_cells / min(u_resolution.x, u_resolution.y);

  float f1 = 8.0;
  float f2 = 8.0;
  vec2 s1 = vec2(0.0);
  vec2 s2 = vec2(0.0);

  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 c = ip + o;
      vec2 r = hash22(c);
      vec2 s = o + 0.5 + 0.38 * sin(t * 0.33 + 6.2831 * r.yx);
      float d = length(f - s);

      if (d < f1) {
        f2 = f1;
        s2 = s1;
        f1 = d;
        s1 = s;
      } else if (d < f2) {
        f2 = d;
        s2 = s;
      }
    }
  }

  float edge = (f2 - f1) * 0.5;
  float trace = exp(-pow(edge / (wpx * u_edge_w), 2.0));
  trace = min(trace, 1.0);
  float halo = exp(-edge / (wpx * u_halo_w)) * 0.22;

  // Position projected on the cell bisector is the run-length along the trace,
  // which is what lets a pulse travel down it instead of just blinking.
  vec2 seg = s2 - s1;
  float segLen = length(seg) + 1e-5;
  vec2 alongDir = vec2(-seg.y, seg.x) / segLen;
  float along = dot(f - (s1 + s2) * 0.5, alongDir);
  float eSeed = hash22(s1 + s2 * 3.71).x;
  float phase = along * u_pulse_freq - t * u_pulse_speed * (0.7 + 0.7 * eSeed);
  float pulse = pow(0.5 + 0.5 * sin(phase * 6.2831), 14.0) * step(0.3, eSeed);

  float nodeSeed = hash22(ip + s1 + 4.31).y;
  float node = exp(-pow(f1 / (wpx * 3.2), 2.0)) * step(0.88, nodeSeed)
      * (0.55 + 0.45 * sin(t * 3.1 + nodeSeed * 20.0));

  // A few cells carry a pad outline, reading as chips on a board.
  float pad = 0.0;
  if (nodeSeed > 0.55) {
    vec2 centre = s1 - vec2(0.0);
    vec2 dd = abs(f - centre) - vec2(0.2);
    float box = max(dd.x, dd.y);
    pad = exp(-pow(abs(box) / (wpx * 1.3), 2.0)) * 0.55;
  }

  float bevel = max(0.0, 1.0 - f1 * 1.8) * 0.12;

  vec3 col = u_deep;
  col += u_cell_col * (nodeSeed * 0.35 + 0.2) * (bevel + 0.12);
  col += u_edge_col * (trace * (0.55 + 2.6 * pulse) + pad + halo);
  col += u_node_col * (node * 1.8 + pulse * trace * 1.4);
  col += u_cell_col * bevel * 2.0;

  col = vec3(1.0) - exp(-col * 1.7);
  col *= 1.0 - smoothstep(0.4, 1.15, length(p)) * 0.65;

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
      `VoronoiCircuit: Shader compile error: ${gl.getShaderInfoLog(shader)}`,
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
    "u_cells",
    "u_edge_w",
    "u_halo_w",
    "u_pulse_freq",
    "u_pulse_speed",
    "u_edge_col",
    "u_node_col",
    "u_cell_col",
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
  gl.uniform1f(uniformLocations.u_cells, config.cells);
  gl.uniform1f(uniformLocations.u_edge_w, config.edgeWidth);
  gl.uniform1f(uniformLocations.u_halo_w, config.haloWidth);
  gl.uniform1f(uniformLocations.u_pulse_freq, config.pulseFreq);
  gl.uniform1f(uniformLocations.u_pulse_speed, config.pulseSpeed);
  gl.uniform3fv(uniformLocations.u_edge_col, config.edgeColor);
  gl.uniform3fv(uniformLocations.u_node_col, config.nodeColor);
  gl.uniform3fv(uniformLocations.u_cell_col, config.cellColor);
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
    console.error("VoronoiCircuit: WebGL not supported");
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
      `VoronoiCircuit: Program link error: ${gl.getProgramInfoLog(program)}`,
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
