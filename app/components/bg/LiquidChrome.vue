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
  blend: 0.62,
  gloss: 1.0,
  bound: 2.35,
  tint: [0.82, 0.87, 1.0],
  blue: [0.1, 0.38, 1.0],
  warm: [1.0, 0.7, 0.32],
  deep: [0.014, 0.017, 0.03],
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
uniform float u_blend;
uniform float u_gloss;
uniform float u_bound;
uniform vec3 u_tint;
uniform vec3 u_blue;
uniform vec3 u_warm;
uniform vec3 u_deep;

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Five metaballs fused with a polynomial smooth min: the surface flows
// between them instead of showing intersecting spheres.
float map(vec3 p) {
  float t = u_time * 0.3;
  float ry = t * 0.21 + u_pointer.x * 0.5;
  float rx = sin(t * 0.17) * 0.3 - u_pointer.y * 0.35;
  float cy = cos(ry);
  float sy = sin(ry);
  p = vec3(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);
  float cx = cos(rx);
  float sx = sin(rx);
  p = vec3(p.x, cx * p.y - sx * p.z, sx * p.y + cx * p.z);

  float d = 1e5;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float a = t * (0.42 + fi * 0.06) + fi * 1.9;
    vec3 c = vec3(
        cos(a + fi * 0.7) * (0.72 + 0.12 * fi),
        sin(a * 1.13 + fi) * (0.4 + 0.09 * fi),
        sin(a * 0.83 + fi * 2.1) * (0.55 + 0.11 * fi));
    float r = 0.44 + 0.14 * sin(fi * 2.3 + t * 0.7);
    d = smin(d, length(p - c) - r, u_blend);
  }
  return d;
}

float raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return -1.0;
  return -b - sqrt(h);
}

// Squared-decay spike. abs() first because pow() of a negative base is
// undefined in GLSL, and the falloff must be symmetric about the band centre.
float spike(float x, float w) {
  float e = min(abs(x) / w, 4.0);
  return exp(-e * e);
}

// Banded studio environment, sampled by reflection direction. Bands are
// tight powers so the metal reads as mirror, not as plastic.
vec3 envMap(vec3 d) {
  float y = d.y;
  float az = atan(d.z, d.x);

  vec3 c = u_deep * 1.4;
  c += u_tint * spike(y, 0.07) * 1.0;
  c += vec3(0.8, 0.86, 1.0) * spike(y - 0.6, 0.16)
      * (0.35 + 0.55 * clamp(0.5 + 0.5 * d.x, 0.0, 1.0));
  c += u_tint * pow(clamp(0.5 + 0.5 * sin(y * 15.0 + 1.2), 0.0, 1.0), 14.0) * 0.6;
  c += u_blue * pow(max(0.0, sin(az * 3.0 + 1.1)), 16.0) * 1.35;
  c += u_warm * pow(max(0.0, sin(az * 2.0 - 2.3)), 20.0) * 1.15;
  c += u_blue * clamp(-y, 0.0, 1.0) * 0.18;
  return c;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
  float t = u_time;

  vec3 ro = vec3(0.0, 0.0, 3.1);
  vec3 rd = normalize(vec3(p, -1.5));

  vec3 col = u_deep * (0.5 + 0.9 * (1.0 - length(p) * 0.7));
  col += u_blue * spike(length(p) - 0.02, 0.75) * 0.1;

  float tb = raySphere(ro, rd, u_bound);

  if (tb > 0.0) {
    float dist = max(tb, 0.0);
    float hitT = -1.0;
    int steps = 0;

    for (int i = 0; i < 34; i++) {
      steps = i;
      vec3 pos = ro + rd * dist;
      float d = map(pos);
      if (d < 0.0025 * dist) {
        hitT = dist;
        break;
      }
      dist += d * 0.92;
      if (dist > 7.0) break;
    }

    if (hitT > 0.0) {
      vec3 pos = ro + rd * hitT;
      float e = 0.0025;
      vec2 k = vec2(1.0, -1.0);
      vec3 n = normalize(
          k.xyy * map(pos + k.xyy * e) +
          k.yyx * map(pos + k.yyx * e) +
          k.yxy * map(pos + k.yxy * e) +
          k.xxx * map(pos + k.xxx * e));

      vec3 r = reflect(rd, n);
      float fres = pow(clamp(1.0 + dot(rd, n), 0.0, 1.0), 3.6);

      vec3 L = normalize(vec3(0.45, 0.72, 0.55));
      vec3 h = normalize(L - rd);
      float glint = pow(max(0.0, dot(n, h)), 90.0);

      vec3 metal = envMap(r) * (0.35 + 1.1 * fres) * u_gloss;
      metal += u_warm * glint * 1.6;
      metal += u_tint * glint * glint * 1.2;
      // Cavity darkening from how long the ray spent inside the field.
      metal *= 1.0 - min(float(steps) / 34.0, 1.0) * 0.45;
      metal = mix(metal, u_deep, clamp((hitT - tb) * 0.14, 0.0, 1.0) * 0.5);

      col = max(col, metal);
    }
  }

  col = vec3(1.0) - exp(-col * 1.5);
  col *= 1.0 - smoothstep(0.45, 1.2, length(p)) * 0.5;

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
      `LiquidChrome: Shader compile error: ${gl.getShaderInfoLog(shader)}`,
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
    "u_blend",
    "u_gloss",
    "u_bound",
    "u_tint",
    "u_blue",
    "u_warm",
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
  gl.uniform1f(uniformLocations.u_blend, config.blend);
  gl.uniform1f(uniformLocations.u_gloss, config.gloss);
  gl.uniform1f(uniformLocations.u_bound, config.bound);
  gl.uniform3fv(uniformLocations.u_tint, config.tint);
  gl.uniform3fv(uniformLocations.u_blue, config.blue);
  gl.uniform3fv(uniformLocations.u_warm, config.warm);
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
    console.error("LiquidChrome: WebGL not supported");
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
      `LiquidChrome: Program link error: ${gl.getProgramInfoLog(program)}`,
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
