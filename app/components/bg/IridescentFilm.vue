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

// Thin-film interference, read as structure rather than as a wash. Three things
// do the work: a fast thickness field (tight colour banding instead of one
// smooth sweep), a slow drainage field shaped into a threshold (whole patches
// run out of film and go black, which gives the sheet its geography), and a
// recurring black order every orderUm of thickness (crisp contour lines between
// the bands). Frequencies are in inverse normalized units: a component at
// frequency f is 2513/f pixels across at a 400px short axis, so the carriers
// below land at 23-50px and the bands fold out an order of magnitude finer.
const config = {
  maxDpr: 1.5,
  thicknessUm: 2.9, // film left in the thickest patches
  bias: 3.2, // weights the field toward the thin, dark end
  thinUm: 0.55, // below this the film has drained to black
  orderUm: 1.1, // thickness between recurring black interference orders
  bandPow: 2.0,
  bandGain: 1.45,
  lineSharpness: 0.24, // half-width of each black contour
  lineFloor: 0.05, // reflectance left inside a black contour
  dryLo: 0.25, // drainage threshold: film is gone below this
  dryHi: 0.62,
  dryFloor: 0.06, // ripple amplitude surviving inside a dry patch
  bump: 0.018, // slope -> normal tilt (scales with the field frequency)
  flow: 0.04,
  rot: 0.035,
  shear: 0.18,
  sampleEps: 0.006,
  fresnelGain: 0.35,
  specPower: 44.0,
  specGain: 1.0,
  exposure: 1.05,
  carrier: [66.0, 80.0, 50.0, 110.0],
  modulator: [12.0, 10.0, 2.2, 2.0],
  drainage: [16.0, 13.0, 19.0, 12.0],
  light: [1.0, 0.97, 0.9],
  deep: [0.01, 0.008, 0.018],
  tint: [0.5, 0.62, 0.9],
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
uniform float u_thickness_um;
uniform float u_bias;
uniform float u_thin_um;
uniform float u_order_um;
uniform float u_band_pow;
uniform float u_band_gain;
uniform float u_line_w;
uniform float u_line_floor;
uniform float u_dry_lo;
uniform float u_dry_hi;
uniform float u_dry_floor;
uniform float u_bump;
uniform float u_flow;
uniform float u_rot;
uniform float u_shear;
uniform float u_eps;
uniform float u_fres_gain;
uniform float u_spec_pow;
uniform float u_spec_gain;
uniform float u_exposure;
uniform vec4 u_carrier;
uniform vec4 u_modulator;
uniform vec4 u_drainage;
uniform vec3 u_light;
uniform vec3 u_deep;
uniform vec3 u_tint;

// Soap-film thickness, 0..1. Built from mutually incommensurate sheared sines
// so the drainage pattern never visibly repeats. The carriers are deliberately
// steep: this is the interference structure itself, and it has to be resolvable
// at thumbnail size, which a two-cycle sweep across the frame never is.
float film(vec2 q, float t) {
  float v = 0.0;
  v += sin(q.x * u_carrier.x + sin(q.y * u_modulator.x + t * 0.31) * u_modulator.z);
  v += sin(q.y * u_carrier.y + sin(q.x * u_modulator.y - t * 0.23) * u_modulator.w);
  v += sin((q.x + q.y) * u_carrier.z + t * 0.17);
  v += 0.75 * sin(length(q) * u_carrier.w - t * 0.42);
  return v / 4.75 * 0.5 + 0.5;
}

// How much film a region has left after draining, an order of magnitude coarser
// than the field above. It is the envelope: patches run out of film entirely
// and the fringes bunch up on the slope into the next dry region.
float drainage(vec2 q, float t) {
  float v = 0.0;
  v += sin(q.x * u_drainage.x + sin(q.y * u_drainage.y - t * 0.09) * 1.4);
  v += sin(q.y * u_drainage.z + t * 0.07);
  v += 0.8 * sin((q.x * 0.8 + q.y * 1.2) * u_drainage.w + t * 0.05);
  return v / 2.8 * 0.5 + 0.5;
}

// Interference of three sampled wavelengths: physically a rainbow, not a
// hue ramp, so the bands keep their saturated magenta/green separation.
vec3 interfere(float um) {
  vec3 lw = vec3(0.65, 0.546, 0.454);
  return 0.5 + 0.5 * cos(6.28318 * (um / lw + vec3(0.0, 0.12, 0.24)));
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
  float t = u_time;

  float rl = length(p) + 1e-5;
  float sa = sin(t * u_rot);
  float ca = cos(t * u_rot);
  vec2 q = vec2(ca * p.x - sa * p.y, sa * p.x + ca * p.y);
  q += vec2(t * u_flow, -t * u_flow * 0.7);
  q += u_pointer * vec2(0.08, 0.06);
  // Lens-like shear: the film stretches toward the frame edges.
  q += p * rl * u_shear;

  float ripple = clamp(film(q, t), 0.0, 1.0);
  float plate = drainage(q, t);

  // Analytic gradient of the thickness field gives the surface normal.
  float e = u_eps;
  float gx = (film(q + vec2(e, 0.0), t) - film(q - vec2(e, 0.0), t)) / (2.0 * e);
  float gy = (film(q + vec2(0.0, e), t) - film(q - vec2(0.0, e), t)) / (2.0 * e);
  vec3 n = normalize(vec3(-gx * u_bump, -gy * u_bump, 1.0));

  vec3 L = normalize(vec3(0.35, 0.55, 0.75));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float diff = 0.4 + 0.7 * max(0.0, dot(n, L));
  float spec = pow(max(0.0, dot(n, H)), u_spec_pow);
  float fres = pow(clamp(1.0 - n.z, 0.0, 1.0), 2.2);

  // Absolute thickness in microns. The drainage threshold is a step, not a
  // taper: a patch either still has film in it or it has run dry, and the
  // ripples only survive where it has not. That is what carves the black
  // boundaries into the sheet instead of one continuous colour sweep.
  float dry = smoothstep(u_dry_lo, u_dry_hi, plate);
  float th = ripple * (u_dry_floor + (1.0 - u_dry_floor) * dry);
  float um = u_thickness_um * pow(th, u_bias);

  // Squaring the interference curve keeps the bands saturated instead of the
  // milky 50% grey floor a raw cosine palette gives you.
  vec3 irid = pow(interfere(um), vec3(u_band_pow));
  // Drainage: where the film has run thin it goes truly black, which is what
  // sells it as glass rather than as a gradient.
  float black = smoothstep(0.0, u_thin_um, um);
  // Higher orders collapse back to black every u_order_um of thickness, so the
  // colour banding is fenced by crisp contour lines instead of blending.
  float fence = smoothstep(0.0, u_line_w,
      abs(fract(um / u_order_um) - 0.5) * 2.0);
  float lit = black * (u_line_floor + (1.0 - u_line_floor) * fence);

  vec3 col = u_deep;
  col += irid * diff * lit * u_band_gain;
  col += u_tint * fres * u_fres_gain * (0.25 + black);
  col += u_light * spec * u_spec_gain * (0.35 + 0.85 * black);

  col = vec3(1.0) - exp(-col * u_exposure);
  col *= 1.0 - smoothstep(0.42, 1.15, rl) * 0.55;

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
      `IridescentFilm: Shader compile error: ${gl.getShaderInfoLog(shader)}`,
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
    "u_thickness_um",
    "u_bias",
    "u_thin_um",
    "u_order_um",
    "u_band_pow",
    "u_band_gain",
    "u_line_w",
    "u_line_floor",
    "u_dry_lo",
    "u_dry_hi",
    "u_dry_floor",
    "u_bump",
    "u_flow",
    "u_rot",
    "u_shear",
    "u_eps",
    "u_fres_gain",
    "u_spec_pow",
    "u_spec_gain",
    "u_exposure",
    "u_carrier",
    "u_modulator",
    "u_drainage",
    "u_light",
    "u_deep",
    "u_tint",
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
  gl.uniform1f(uniformLocations.u_thickness_um, config.thicknessUm);
  gl.uniform1f(uniformLocations.u_bias, config.bias);
  gl.uniform1f(uniformLocations.u_thin_um, config.thinUm);
  gl.uniform1f(uniformLocations.u_order_um, config.orderUm);
  gl.uniform1f(uniformLocations.u_band_pow, config.bandPow);
  gl.uniform1f(uniformLocations.u_band_gain, config.bandGain);
  gl.uniform1f(uniformLocations.u_line_w, config.lineSharpness);
  gl.uniform1f(uniformLocations.u_line_floor, config.lineFloor);
  gl.uniform1f(uniformLocations.u_dry_lo, config.dryLo);
  gl.uniform1f(uniformLocations.u_dry_hi, config.dryHi);
  gl.uniform1f(uniformLocations.u_dry_floor, config.dryFloor);
  gl.uniform1f(uniformLocations.u_bump, config.bump);
  gl.uniform1f(uniformLocations.u_flow, config.flow);
  gl.uniform1f(uniformLocations.u_rot, config.rot);
  gl.uniform1f(uniformLocations.u_shear, config.shear);
  gl.uniform1f(uniformLocations.u_eps, config.sampleEps);
  gl.uniform1f(uniformLocations.u_fres_gain, config.fresnelGain);
  gl.uniform1f(uniformLocations.u_spec_pow, config.specPower);
  gl.uniform1f(uniformLocations.u_spec_gain, config.specGain);
  gl.uniform1f(uniformLocations.u_exposure, config.exposure);
  gl.uniform4fv(uniformLocations.u_carrier, config.carrier);
  gl.uniform4fv(uniformLocations.u_modulator, config.modulator);
  gl.uniform4fv(uniformLocations.u_drainage, config.drainage);
  gl.uniform3fv(uniformLocations.u_light, config.light);
  gl.uniform3fv(uniformLocations.u_deep, config.deep);
  gl.uniform3fv(uniformLocations.u_tint, config.tint);

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
    console.error("IridescentFilm: WebGL not supported");
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
      `IridescentFilm: Program link error: ${gl.getProgramInfoLog(program)}`,
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
