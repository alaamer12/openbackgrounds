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
  terrainScale: 0.19,
  height: 4.1,
  cameraHeight: 2.75,
  far: 120.0,
  speed: 1.05,
  fog: 0.012,
  sun: [0.35, 0.055, 0.93],
  rock: [0.055, 0.05, 0.085],
  snow: [0.85, 0.72, 0.78],
  lit: [0.5, 0.26, 0.2],
  haze: [0.85, 0.36, 0.18],
  skyHigh: [0.02, 0.015, 0.07],
  skyLow: [0.42, 0.12, 0.14],
  sunDisc: [1.0, 0.82, 0.45],
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
uniform float u_scale;
uniform float u_height;
uniform float u_cam_y;
uniform float u_far;
uniform float u_speed;
uniform float u_fog;
uniform vec3 u_sun_dir;
uniform vec3 u_rock;
uniform vec3 u_snow;
uniform vec3 u_lit;
uniform vec3 u_haze;
uniform vec3 u_sky_hi;
uniform vec3 u_sky_lo;
uniform vec3 u_sun_disc;

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

// Ridged octaves: 1 - |2n - 1| keeps the sharp peaks that plain fbm rounds
// off, which is what makes a range read as a range.
float terrain(vec2 xz) {
  vec2 x = xz * u_scale + vec2(3.7, 1.9);
  float v = 0.0;
  float a = 0.6;
  for (int i = 0; i < 3; i++) {
    float n = 1.0 - abs(vnoise(x) * 2.0 - 1.0);
    v += a * n * n;
    x = x * 2.11 + vec2(3.1, 7.7);
    a *= 0.5;
  }
  return clamp(v / 1.05, 0.0, 1.0) * u_height;
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
  float t = u_time;

  vec3 ro = vec3(sin(t * 0.035) * 3.0 + u_pointer.x * 1.2,
      u_cam_y + u_pointer.y * 0.35,
      t * u_speed);
  vec3 rd = normalize(vec3(p.x, p.y - 0.055, 1.0));

  vec3 L = normalize(u_sun_dir);

  float up = clamp((rd.y + 0.055) * 1.7, 0.0, 1.0);
  vec3 col = mix(u_sky_lo, u_sky_hi, pow(up, 0.6));

  // Low sun: both vectors are unit, so their difference length is a clean
  // proxy for the angle between the ray and the sun.
  float sd = length(L - rd);
  col += u_sun_disc * exp(-pow(min(sd / 0.06, 4.0), 2.0)) * 0.85;
  col += mix(u_haze, u_sun_disc, 0.35)
      * exp(-pow(min(sd / 0.34, 4.0), 2.0)) * 0.4;
  // Horizon mist band.
  col = mix(col, u_haze, exp(-abs(rd.y) * 24.0) * 0.4);

  // March in world depth instead of ray distance: perspective compresses the
  // far ridges, so exponential z steps spend samples exactly where they are
  // needed and the whole range resolves inside 44 samples.
  float z = 0.0;
  float zStep = 0.45;
  float zPrev = 0.0;
  float hit = -1.0;
  float hitH = 0.0;

  for (int i = 0; i < 44; i++) {
    zPrev = z;
    z += zStep;
    zStep *= 1.115;

    float tt = z / max(rd.z, 1e-4);
    if (tt > u_far) break;

    vec3 pos = ro + rd * tt;
    if (pos.y > u_height + 0.05) break;

    if (pos.y < terrain(pos.xz)) {
      hit = z;
      break;
    }
  }

  if (hit > 0.0) {
    float zLo = zPrev;
    float zHi = hit;
    for (int k = 0; k < 5; k++) {
      float zm = 0.5 * (zLo + zHi);
      vec3 pm = ro + rd * (zm / max(rd.z, 1e-4));
      if (pm.y < terrain(pm.xz)) zHi = zm;
      else zLo = zm;
    }

    float tt = 0.5 * (zLo + zHi) / max(rd.z, 1e-4);
    vec3 pos = ro + rd * tt;
    hitH = pos.y;

    float e = 0.05 + 0.006 * tt;
    vec3 n = normalize(vec3(
        terrain(pos.xz - vec2(e, 0.0)) - terrain(pos.xz + vec2(e, 0.0)),
        2.0 * e,
        terrain(pos.xz - vec2(0.0, e)) - terrain(pos.xz + vec2(0.0, e))));

    float slope = max(0.0, dot(n, L));
    float face = clamp(n.y, 0.0, 1.0);

    vec3 surf = u_rock * (0.35 + 1.1 * face);
    surf += u_lit * pow(slope, 3.0) * 0.85;
    surf += u_sun_disc * pow(slope, 26.0) * 0.5;
    float snow = smoothstep(u_height * 0.52, u_height * 0.86, hitH)
        * smoothstep(0.45, 0.8, n.y);
    surf = mix(surf, u_snow * (0.45 + 0.9 * slope), snow * 0.8);

    float fog = 1.0 - exp(-tt * u_fog);
    col = mix(surf, mix(u_haze, u_sky_lo, 0.45), fog);
  }

  col = vec3(1.0) - exp(-col * 1.35);
  col *= 1.0 - smoothstep(0.5, 1.3, length(p)) * 0.4;

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
      `EndlessRange: Shader compile error: ${gl.getShaderInfoLog(shader)}`,
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
    "u_height",
    "u_cam_y",
    "u_far",
    "u_speed",
    "u_fog",
    "u_sun_dir",
    "u_rock",
    "u_snow",
    "u_lit",
    "u_haze",
    "u_sky_hi",
    "u_sky_lo",
    "u_sun_disc",
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
  gl.uniform1f(uniformLocations.u_scale, config.terrainScale);
  gl.uniform1f(uniformLocations.u_height, config.height);
  gl.uniform1f(uniformLocations.u_cam_y, config.cameraHeight);
  gl.uniform1f(uniformLocations.u_far, config.far);
  gl.uniform1f(uniformLocations.u_speed, config.speed);
  gl.uniform1f(uniformLocations.u_fog, config.fog);
  gl.uniform3f(
    uniformLocations.u_sun_dir,
    config.sun[0],
    config.sun[1],
    config.sun[2],
  );
  gl.uniform3fv(uniformLocations.u_rock, config.rock);
  gl.uniform3fv(uniformLocations.u_snow, config.snow);
  gl.uniform3fv(uniformLocations.u_lit, config.lit);
  gl.uniform3fv(uniformLocations.u_haze, config.haze);
  gl.uniform3fv(uniformLocations.u_sky_hi, config.skyHigh);
  gl.uniform3fv(uniformLocations.u_sky_lo, config.skyLow);
  gl.uniform3fv(uniformLocations.u_sun_disc, config.sunDisc);

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
    console.error("EndlessRange: WebGL not supported");
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
      `EndlessRange: Program link error: ${gl.getProgramInfoLog(program)}`,
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
