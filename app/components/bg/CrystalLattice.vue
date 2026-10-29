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

// Framing key: the projection writes `q.xy * focal / w` and then lets clip-space
// w divide by `w` again, so a node's on-screen radius is
// `r * focal / (z + distance)^2`. What matters for composition is therefore the
// ratio `half * focal / distance^2` — 0.44 for a face-on cube here, rising to
// 0.77 of the shorter viewport axis when a body diagonal swings into the image
// plane, which is the state it is in for most of its tumble. Both 640x400 and
// 1920x1080 are at or above `refAspect`, so the landscape clamp is inactive and
// the cube is framed identically at either size.
const config = {
  maxDpr: 1.5,
  nodes: 9,
  half: 1.28,
  focal: 17.0,
  distance: 7.0,
  refAspect: 1.6,
  // A plane phonon along the body diagonal ripples the whole lattice like a
  // struck bell, with no position ever touched on the CPU.
  waveSpeed: 1.15,
  waveAmp: 0.055,
  waveFrequency: 2.35,
  shearAmount: 0.45,
  breathAmount: 0.035,
  breathRate: 0.29,
  tilt: 0.44,
  tiltSwell: 0.12,
  spin: 0.11,
  roll: 0.035,
  // Struts used to pile ten deep into a knot the size of a coin; at this scale
  // a given pixel is crossed by two or three, so the per-line alpha carries the
  // load that overlap used to do.
  lineStrength: 1.0,
  nodeStrength: 1.0,
  // World-space node radius, divided out by the ~6.7x growth in focal length so
  // nodes keep their old pixel footprint and the scene costs the same to shade.
  nodeSize: 0.0085,
  hullBoost: 1.85,
  // Re-windowed onto the new camera: the cube occupies depth
  // distance +/- half*sqrt(3), i.e. 4.8 to 9.2 here, matching the old rule that
  // the back face fades out and the front face is at full strength.
  depthNear: 5.0,
  depthFar: 9.4,
  tintX: [0.22, 0.88, 1.0],
  tintY: [0.34, 0.56, 1.0],
  tintZ: [0.68, 0.36, 1.0],
  ground: [0.008, 0.01, 0.024],
};

const FLOATS_PER_VERTEX = 5;

// a_data.x selects the tinting axis (0, 1, 2) or a node (3); a_data.y flags
// the twelve framed edges of the bounding cube.
const LATTICE_VERT = `
  precision highp float;

  attribute vec3 a_pos;
  attribute vec2 a_data;

  uniform float u_time;
  uniform vec2 u_resolution;
  uniform vec2 u_focal;
  uniform vec3 u_wave;
  uniform vec2 u_breath;
  uniform vec3 u_orient;
  uniform vec3 u_camera;
  uniform vec2 u_look;
  uniform vec2 u_depth;
  uniform vec3 u_tintA;
  uniform vec3 u_tintB;
  uniform vec3 u_tintC;

  varying vec3 v_color;
  varying float v_alpha;

  mat3 rotX(float a) {
    float c = cos(a);
    float s = sin(a);
    return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
  }

  mat3 rotY(float a) {
    float c = cos(a);
    float s = sin(a);
    return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
  }

  mat3 rotZ(float a) {
    float c = cos(a);
    float s = sin(a);
    return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0);
  }

  void main() {
    vec3 axis = normalize(vec3(1.0, 1.0, 1.0));
    vec3 shear = normalize(vec3(-1.0, 1.0, 0.0));

    float phase = dot(a_pos, axis) * u_wave.z + u_time * u_wave.x;

    vec3 p = a_pos;
    p += axis * sin(phase) * u_wave.y;
    p += shear * cos(phase * 0.73 + 1.1) * u_wave.y * u_look.x;
    p *= 1.0 + u_breath.x * sin(u_time * u_breath.y);

    mat3 orient =
      rotX(u_orient.x + u_orient.y * sin(u_time * 0.21)) *
      rotY(u_time * u_orient.z) *
      rotZ(u_time * u_camera.x);
    vec3 q = orient * p;

    float w = max(q.z + u_camera.y, 0.05);
    gl_Position = vec4(q.xy * u_focal / w, 0.0, w);

    float fade = pow(1.0 - smoothstep(u_depth.x, u_depth.y, w), 1.45);
    float node = step(2.5, a_data.x);
    float excite = 0.5 + 0.5 * sin(phase);

    vec3 col = mix(u_tintA, u_tintB, step(0.5, a_data.x));
    col = mix(col, u_tintC, step(1.5, a_data.x));
    col = mix(col, u_tintA * 0.45 + u_tintC * 0.75, node);

    float hull = a_data.y * u_look.y;

    v_color = col * (0.7 + 0.55 * excite * node);
    v_alpha = clamp(
      fade * mix(0.95, 0.5 + 0.75 * excite, node) * mix(1.0, 1.3, hull),
      0.0,
      1.0
    );

    float world = mix(0.004, u_camera.z * (0.5 + 0.68 * excite), node);
    gl_PointSize = clamp(
      world * u_focal.y * u_resolution.y * 0.5 / max(w, 0.4),
      1.0,
      44.0
    );
  }
`;

const LINE_FRAG = `
  precision mediump float;

  varying vec3 v_color;
  varying float v_alpha;

  uniform float u_strength;

  void main() {
    gl_FragColor = vec4(v_color, v_alpha * u_strength);
  }
`;

const NODE_FRAG = `
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
    float halo = pow(k, 2.1);
    float core = pow(k, 11.0);

    vec3 col = v_color + vec3(0.88, 0.97, 1.0) * core;
    gl_FragColor = vec4(col, v_alpha * u_strength * (0.12 + 0.88 * halo));
  }
`;

let gl = null;
let lineProgram = null;
let nodeProgram = null;
let edgeBuffer = null;
let nodeBuffer = null;
let edgeData = null;
let nodeData = null;
let edgeCount = 0;
let nodeCount = 0;
let frameId = null;
let startTime = 0;

const lineLoc = { attribs: {}, uniforms: {} };
const nodeLoc = { attribs: {}, uniforms: {} };

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
    console.error("CrystalLattice: WebGL context unavailable");
    return;
  }

  buildLattice();

  edgeBuffer = createStaticBuffer(edgeData);
  nodeBuffer = createStaticBuffer(nodeData);

  lineProgram = createProgram(LATTICE_VERT, LINE_FRAG, lineLoc);
  nodeProgram = createProgram(LATTICE_VERT, NODE_FRAG, nodeLoc);
  if (!lineProgram || !nodeProgram) return;

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
    if (edgeBuffer) gl.deleteBuffer(edgeBuffer);
    if (nodeBuffer) gl.deleteBuffer(nodeBuffer);
    if (lineProgram) gl.deleteProgram(lineProgram);
    if (nodeProgram) gl.deleteProgram(nodeProgram);

    edgeBuffer = null;
    nodeBuffer = null;
    lineProgram = null;
    nodeProgram = null;
    edgeData = null;
    nodeData = null;

    gl.getExtension("WEBGL_lose_context")?.loseContext();
    gl = null;
  }
});

function buildLattice() {
  const n = config.nodes;
  const step = (config.half * 2) / (n - 1);
  const edges = [];
  const nodes = [];

  const at = (i, j, k) => [
    -config.half + i * step,
    -config.half + j * step,
    -config.half + k * step,
  ];

  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      for (let k = 0; k < n; k += 1) {
        const extreme = [
          i === 0 || i === n - 1,
          j === 0 || j === n - 1,
          k === 0 || k === n - 1,
        ];

        nodes.push({
          position: at(i, j, k),
          kind: 3,
          hull: extreme[0] || extreme[1] || extreme[2] ? 0.4 : 1,
        });

        const neighbours = [
          [i + 1, j, k, 0],
          [i, j + 1, k, 1],
          [i, j, k + 1, 2],
        ];

        for (let a = 0; a < neighbours.length; a += 1) {
          const oi = neighbours[a][0];
          const oj = neighbours[a][1];
          const ok = neighbours[a][2];

          if (oi >= n || oj >= n || ok >= n) continue;

          // A strut is "framed" when it lies on one of the twelve edges of the
          // outer cube, i.e. both indices it does not advance are extreme.
          const framed =
            (a === 0 && extreme[1] && extreme[2]) ||
            (a === 1 && extreme[0] && extreme[2]) ||
            (a === 2 && extreme[0] && extreme[1]);

          edges.push({ position: at(i, j, k), kind: a, hull: framed ? 1 : 0 });
          edges.push({
            position: at(oi, oj, ok),
            kind: a,
            hull: framed ? 1 : 0,
          });
        }
      }
    }
  }

  edgeCount = edges.length;
  nodeCount = nodes.length;
  edgeData = new Float32Array(edgeCount * FLOATS_PER_VERTEX);
  nodeData = new Float32Array(nodeCount * FLOATS_PER_VERTEX);

  let ptr = 0;
  for (const edge of edges) {
    edgeData[ptr++] = edge.position[0];
    edgeData[ptr++] = edge.position[1];
    edgeData[ptr++] = edge.position[2];
    edgeData[ptr++] = edge.kind;
    edgeData[ptr++] = edge.hull;
  }

  ptr = 0;
  for (const node of nodes) {
    nodeData[ptr++] = node.position[0];
    nodeData[ptr++] = node.position[1];
    nodeData[ptr++] = node.position[2];
    nodeData[ptr++] = node.kind;
    nodeData[ptr++] = node.hull;
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
  if (!gl || !lineProgram || !nodeProgram) return;

  const time = (now - startTime) * 0.001;
  const aspect =
    gl.drawingBufferHeight === 0
      ? 1
      : gl.drawingBufferWidth / gl.drawingBufferHeight;
  const focal = config.focal * Math.min(1, aspect / config.refAspect);

  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(lineProgram);
  setUniforms(lineLoc, time, aspect, focal, config.lineStrength);
  applyAttribs(lineLoc, edgeBuffer);
  gl.drawArrays(gl.LINES, 0, edgeCount);

  gl.useProgram(nodeProgram);
  setUniforms(nodeLoc, time, aspect, focal, config.nodeStrength);
  applyAttribs(nodeLoc, nodeBuffer);
  gl.drawArrays(gl.POINTS, 0, nodeCount);

  fpsMeter.tick();
  frameId = requestAnimationFrame(render);
}

function setUniforms(loc, time, aspect, focal, strength) {
  gl.uniform1f(loc.uniforms.u_time, time);
  gl.uniform2f(
    loc.uniforms.u_resolution,
    gl.drawingBufferWidth,
    gl.drawingBufferHeight,
  );
  gl.uniform2f(loc.uniforms.u_focal, focal / aspect, focal);
  gl.uniform3f(
    loc.uniforms.u_wave,
    config.waveSpeed,
    config.waveAmp,
    config.waveFrequency,
  );
  gl.uniform2f(loc.uniforms.u_breath, config.breathAmount, config.breathRate);
  gl.uniform3f(
    loc.uniforms.u_orient,
    config.tilt,
    config.tiltSwell,
    config.spin,
  );
  gl.uniform2f(loc.uniforms.u_depth, config.depthNear, config.depthFar);
  gl.uniform3f(
    loc.uniforms.u_camera,
    config.roll,
    config.distance,
    config.nodeSize,
  );
  gl.uniform2f(loc.uniforms.u_look, config.shearAmount, config.hullBoost);
  gl.uniform3fv(loc.uniforms.u_tintA, config.tintX);
  gl.uniform3fv(loc.uniforms.u_tintB, config.tintY);
  gl.uniform3fv(loc.uniforms.u_tintC, config.tintZ);
  gl.uniform1f(loc.uniforms.u_strength, strength);
}

function applyAttribs(loc, buffer) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const stride = FLOATS_PER_VERTEX * 4;

  if (loc.attribs.a_pos >= 0) {
    gl.enableVertexAttribArray(loc.attribs.a_pos);
    gl.vertexAttribPointer(loc.attribs.a_pos, 3, gl.FLOAT, false, stride, 0);
  }

  if (loc.attribs.a_data >= 0) {
    gl.enableVertexAttribArray(loc.attribs.a_data);
    gl.vertexAttribPointer(loc.attribs.a_data, 2, gl.FLOAT, false, stride, 12);
  }
}

function createProgram(vertexSource, fragmentSource, target) {
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
      "CrystalLattice: Program link error",
      gl.getProgramInfoLog(created),
    );
    gl.deleteProgram(created);
    return null;
  }

  gl.useProgram(created);

  target.attribs.a_pos = gl.getAttribLocation(created, "a_pos");
  target.attribs.a_data = gl.getAttribLocation(created, "a_data");

  for (const name of [
    "u_time",
    "u_resolution",
    "u_focal",
    "u_wave",
    "u_breath",
    "u_orient",
    "u_camera",
    "u_look",
    "u_depth",
    "u_tintA",
    "u_tintB",
    "u_tintC",
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
      `CrystalLattice: Shader compile error (${type === gl.VERTEX_SHADER ? "vertex" : "fragment"})`,
      gl.getShaderInfoLog(shader),
    );
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

function onResize() {
  resize();
}
</script>
