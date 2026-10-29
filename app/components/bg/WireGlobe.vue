<template>
  <div ref="holderRef" class="absolute inset-0 pointer-events-none">
    <canvas ref="canvasRef" class="block w-full h-full" />
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import * as THREE from "three";

const holderRef = ref(null);
const canvasRef = ref(null);

const fpsMeter = useFpsMeter();

const config = {
  seed: 4242,
  maxDpr: 1.75,

  radius: 2.35,
  parallels: 9,
  parallelSteps: 72,
  meridians: 18,
  meridianSteps: 48,

  arcs: 24,
  arcSteps: 56,
  arcTail: 15.0,
  arcBase: 0.055,

  ringSegments: 128,
  ringRadius: 3.15,
  ringDashes: 30,

  stars: 240,

  spin: 0.1,
  tilt: -0.34,
  cameraZ: 8.2,
};

const TAU = Math.PI * 2;

// Hand-written fragment shaders never run three's colourspace pass, so the
// palette is uploaded as raw display-space channels.
const rgb = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return new THREE.Color(
    ((value >> 16) & 0xff) / 0xff,
    ((value >> 8) & 0xff) / 0xff,
    (value & 0xff) / 0xff,
  );
};

const makeRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
};

let renderer = null;
let scene = null;
let camera = null;
let globe = null;
let graticule = null;
let arcs = null;
let nodes = null;
let ring = null;
let halo = null;
let stars = null;
let frameId = null;

const shared = {
  uTime: { value: 0 },
  uCold: { value: rgb("#37e0ff") },
  uDeep: { value: rgb("#0a5f80") },
  uWarm: { value: rgb("#ffb056") },
};

const gridUniforms = {
  ...shared,
  uGridColor: { value: rgb("#3ad7f2") },
  uGridDim: { value: rgb("#0d4a63") },
  uOpacity: { value: 0.5 },
};

const arcUniforms = {
  ...shared,
  uTail: { value: config.arcTail },
  uBase: { value: config.arcBase },
};

const nodeUniforms = {
  ...shared,
  uSize: { value: 1.0 },
  uDpr: { value: 1 },
};

const ringUniforms = {
  ...shared,
  uDashes: { value: config.ringDashes },
  uDashSpeed: { value: 0.07 },
};

const haloUniforms = {
  ...shared,
  uInner: { value: rgb("#0d5f74") },
  uOuter: { value: rgb("#03141c") },
};

const starUniforms = {
  ...shared,
  uSize: { value: 0.7 },
  uDpr: { value: 1 },
};

const facingVertexHead = `
  varying float vFacing;

  // Depth cue for free: a wire sphere reads as a sphere only when the far side
  // of the shell is dimmer than the near side.
  void facing(vec3 objectDir, vec3 world, vec3 origin) {
    vec3 normal = normalize(mat3(modelMatrix) * objectDir);
    vFacing = smoothstep(-0.5, 0.55, dot(normal, normalize(origin - world)));
  }
`;

const gridVertexShader = `
  ${facingVertexHead}

  uniform float uTime;

  varying float vShimmer;

  void main() {
    vec3 objectDir = normalize(position);
    vec4 world = modelMatrix * vec4(position, 1.0);
    facing(objectDir, world.xyz, cameraPosition);

    vShimmer = 0.55 + 0.45 * sin(objectDir.y * 7.0 - uTime * 0.35);

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const gridFragmentShader = `
  uniform vec3 uGridColor;
  uniform vec3 uGridDim;
  uniform float uOpacity;

  varying float vFacing;
  varying float vShimmer;

  void main() {
    vec3 colour = mix(uGridDim, uGridColor, vFacing * vShimmer);
    float alpha = uOpacity * (0.1 + vFacing * 0.9);
    gl_FragColor = vec4(colour, alpha);
  }
`;

const arcVertexShader = `
  ${facingVertexHead}

  attribute float aParam;
  attribute float aPhase;
  attribute float aSpeed;

  uniform float uTime;
  uniform float uTail;

  varying float vGlow;
  varying float vLand;

  void main() {
    vec3 objectDir = normalize(position);
    vec4 world = modelMatrix * vec4(position, 1.0);
    facing(objectDir, world.xyz, cameraPosition);

    // A comet head walks from 0 to 1 along the great circle; the exponential
    // behind it is the trail, the tighter one ahead is barely a hint.
    float head = fract(uTime * aSpeed + aPhase);
    float d = head - aParam;
    float lit = d >= 0.0 ? exp(-d * uTail) : exp(d * uTail * 2.5) * 0.08;

    vGlow = lit;
    vLand = smoothstep(0.06, 0.0, aParam) + smoothstep(0.94, 1.0, aParam);

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const arcFragmentShader = `
  uniform vec3 uCold;
  uniform vec3 uWarm;
  uniform float uBase;

  varying float vFacing;
  varying float vGlow;
  varying float vLand;

  void main() {
    vec3 colour = mix(uCold, uWarm, clamp(vLand, 0.0, 1.0) * 0.9);
    colour += uCold * vGlow * 1.2;
    colour += vec3(0.55, 0.9, 1.0) * vGlow * vGlow * 1.5;

    float alpha = (uBase + vGlow * 0.95) * (0.18 + vFacing * 0.82);
    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

const nodeVertexShader = `
  attribute float aPhase;
  attribute float aSpeed;

  uniform float uTime;
  uniform float uSize;
  uniform float uDpr;

  varying float vFlash;

  void main() {
    float cycle = fract(uTime * aSpeed + aPhase);

    // Ends flare as the packet leaves and again as it lands, which is what
    // makes the traffic read as point to point rather than a loop.
    vFlash = max(exp(-cycle * 9.0), exp(-(1.0 - cycle) * 12.0));

    vec4 view = viewMatrix * modelMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(
      uSize * uDpr * (26.0 + vFlash * 46.0) / max(-view.z, 1.0),
      1.0,
      24.0
    );
    gl_Position = projectionMatrix * view;
  }
`;

const nodeFragmentShader = `
  uniform vec3 uWarm;
  uniform vec3 uCold;

  varying float vFlash;

  void main() {
    vec2 offset = gl_PointCoord - vec2(0.5);
    float d = length(offset);
    float core = smoothstep(0.5, 0.06, d);
    float bloom = exp(-d * d * 9.0);
    float alpha = core * (0.35 + vFlash * 0.65);
    if (alpha <= 0.002) discard;

    vec3 colour = mix(uWarm, uCold, 0.18) * (0.8 + vFlash * 1.4);
    colour += bloom * 0.35 * vFlash;
    gl_FragColor = vec4(colour, alpha);
  }
`;

const ringVertexShader = `
  ${facingVertexHead}

  attribute float aParam;

  uniform float uTime;
  uniform float uDashes;
  uniform float uDashSpeed;

  varying float vDash;

  void main() {
    vec3 objectDir = normalize(position);
    vec4 world = modelMatrix * vec4(position, 1.0);
    facing(objectDir, world.xyz, cameraPosition);

    // Marching dashes: the parameter is walked backwards through the modulo, so
    // the pattern crawls round the ring instead of strobing in place.
    float walk = fract(aParam * uDashes - uTime * uDashSpeed * uDashes * 0.1);
    vDash = smoothstep(0.62, 0.4, walk) * smoothstep(0.0, 0.14, walk);

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const ringFragmentShader = `
  uniform vec3 uWarm;
  uniform vec3 uCold;

  varying float vFacing;
  varying float vDash;

  void main() {
    vec3 colour = mix(uCold * 0.5, uWarm, vDash);
    float alpha = 0.05 + vDash * 0.55;
    alpha *= 0.35 + vFacing * 0.65;
    gl_FragColor = vec4(colour, alpha);
  }
`;

const haloVertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const haloFragmentShader = `
  uniform vec3 uInner;
  uniform vec3 uOuter;
  uniform float uTime;

  varying vec2 vUv;

  void main() {
    float d = distance(vUv, vec2(0.5)) * 2.0;
    float falloff = smoothstep(1.0, 0.05, d);
    float breathe = 0.82 + 0.18 * sin(uTime * 0.27);

    vec3 colour = mix(uOuter, uInner, falloff);
    gl_FragColor = vec4(colour, falloff * falloff * 0.5 * breathe);
  }
`;

const starVertexShader = `
  attribute float aSeed;

  uniform float uTime;
  uniform float uSize;
  uniform float uDpr;

  varying float vTwinkle;

  void main() {
    vec4 view = viewMatrix * modelMatrix * vec4(position, 1.0);
    float wave = 0.5 + 0.5 * sin(uTime * (0.3 + aSeed) + aSeed * 30.0);
    vTwinkle = 0.35 + 0.65 * wave * wave;

    gl_PointSize = clamp(
      uSize * uDpr * (1.0 + aSeed * 1.6) * 34.0 / max(-view.z, 1.0),
      1.0,
      6.0
    );
    gl_Position = projectionMatrix * view;
  }
`;

const starFragmentShader = `
  uniform vec3 uDeep;

  varying float vTwinkle;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float disc = smoothstep(0.5, 0.05, d);
    gl_FragColor = vec4(uDeep * (0.4 + vTwinkle), disc * vTwinkle * 0.5);
  }
`;

function buildGraticule() {
  const r = config.radius;
  const positions = [];

  const spacing = 150 / (config.parallels - 1);

  for (let i = 0; i < config.parallels; i += 1) {
    const latitude = THREE.MathUtils.degToRad(-75 + i * spacing);
    const ringRadius = Math.cos(latitude) * r;
    const y = Math.sin(latitude) * r;

    for (let s = 0; s < config.parallelSteps; s += 1) {
      const a0 = (s / config.parallelSteps) * TAU;
      const a1 = ((s + 1) / config.parallelSteps) * TAU;
      positions.push(
        Math.cos(a0) * ringRadius,
        y,
        Math.sin(a0) * ringRadius,
        Math.cos(a1) * ringRadius,
        y,
        Math.sin(a1) * ringRadius,
      );
    }
  }

  for (let m = 0; m < config.meridians; m += 1) {
    const longitude = (m / config.meridians) * TAU;
    const cosL = Math.cos(longitude);
    const sinL = Math.sin(longitude);

    for (let s = 0; s < config.meridianSteps; s += 1) {
      const t0 = -Math.PI / 2 + (s / config.meridianSteps) * Math.PI;
      const t1 = -Math.PI / 2 + ((s + 1) / config.meridianSteps) * Math.PI;

      positions.push(
        Math.cos(t0) * cosL * r,
        Math.sin(t0) * r,
        Math.cos(t0) * sinL * r,
        Math.cos(t1) * cosL * r,
        Math.sin(t1) * r,
        Math.cos(t1) * sinL * r,
      );
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );

  graticule = new THREE.LineSegments(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: gridUniforms,
      vertexShader: gridVertexShader,
      fragmentShader: gridFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  graticule.frustumCulled = false;
  globe.add(graticule);
}

function buildArcs() {
  const random = makeRandom(config.seed);
  const r = config.radius;
  const count = config.arcs;
  const steps = config.arcSteps;
  const total = count * steps * 2;

  const positions = new Float32Array(total * 3);
  const params = new Float32Array(total);
  const phases = new Float32Array(total);
  const speeds = new Float32Array(total);
  const nodePositions = new Float32Array(count * 2 * 3);
  const nodePhases = new Float32Array(count * 2);
  const nodeSpeeds = new Float32Array(count * 2);

  const origin = new THREE.Vector3();
  const target = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const point = new THREE.Vector3();

  let vertex = 0;

  for (let i = 0; i < count; i += 1) {
    // A bounded rotation of the first node gives a well-defined great circle
    // without the near-degenerate arcs a pair of free picks produces.
    origin
      .set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1)
      .normalize();
    axis.set(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1).normalize();

    const span = 0.8 + random() * 1.5;
    target.copy(origin).applyAxisAngle(axis, span);

    normal.crossVectors(origin, target).normalize();
    tangent.crossVectors(normal, origin).normalize();

    const phase = random();
    const speed = 0.045 + random() * 0.05;
    const bulge = 0.1 + span * 0.16;

    for (let s = 0; s < steps; s += 1) {
      for (let e = 0; e < 2; e += 1) {
        const t = (s + e) / steps;
        const angle = t * span;

        point
          .copy(origin)
          .multiplyScalar(Math.cos(angle))
          .addScaledVector(tangent, Math.sin(angle));

        const lift = r + bulge * Math.sin(Math.PI * t);
        const offset = vertex * 3;

        positions[offset] = point.x * lift;
        positions[offset + 1] = point.y * lift;
        positions[offset + 2] = point.z * lift;
        params[vertex] = t;
        phases[vertex] = phase;
        speeds[vertex] = speed;
        vertex += 1;
      }
    }

    for (let n = 0; n < 2; n += 1) {
      const source = n === 0 ? origin : target;
      const slot = (i * 2 + n) * 3;

      nodePositions[slot] = source.x * r;
      nodePositions[slot + 1] = source.y * r;
      nodePositions[slot + 2] = source.z * r;
      // Landing on the far node is the same instant as leaving the near one on
      // the next cycle, so both ends share the arc's phase.
      nodePhases[i * 2 + n] = phase;
      nodeSpeeds[i * 2 + n] = speed;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aParam", new THREE.BufferAttribute(params, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("aSpeed", new THREE.BufferAttribute(speeds, 1));

  arcs = new THREE.LineSegments(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: arcUniforms,
      vertexShader: arcVertexShader,
      fragmentShader: arcFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  arcs.frustumCulled = false;
  globe.add(arcs);

  const nodeGeometry = new THREE.BufferGeometry();
  nodeGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(nodePositions, 3),
  );
  nodeGeometry.setAttribute("aPhase", new THREE.BufferAttribute(nodePhases, 1));
  nodeGeometry.setAttribute("aSpeed", new THREE.BufferAttribute(nodeSpeeds, 1));

  nodes = new THREE.Points(
    nodeGeometry,
    new THREE.ShaderMaterial({
      uniforms: nodeUniforms,
      vertexShader: nodeVertexShader,
      fragmentShader: nodeFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  nodes.frustumCulled = false;
  globe.add(nodes);
}

function buildRing() {
  const positions = [];
  const params = [];
  const r = config.ringRadius;

  for (let s = 0; s < config.ringSegments; s += 1) {
    const a0 = (s / config.ringSegments) * TAU;
    const a1 = ((s + 1) / config.ringSegments) * TAU;

    positions.push(Math.cos(a0) * r, 0, Math.sin(a0) * r);
    positions.push(Math.cos(a1) * r, 0, Math.sin(a1) * r);
    params.push(s / config.ringSegments, (s + 1) / config.ringSegments);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("aParam", new THREE.Float32BufferAttribute(params, 1));

  ring = new THREE.LineSegments(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: ringUniforms,
      vertexShader: ringVertexShader,
      fragmentShader: ringFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  ring.frustumCulled = false;
  scene.add(ring);
}

function buildHalo() {
  const geometry = new THREE.PlaneGeometry(13, 13, 1, 1);

  halo = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: haloUniforms,
      vertexShader: haloVertexShader,
      fragmentShader: haloFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  halo.renderOrder = -1;
  scene.add(halo);
}

function buildStars() {
  const random = makeRandom(config.seed + 77);
  const count = config.stars;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    // A hollow shell well behind the globe, so the field never competes with it
    // for the centre of the frame.
    const dir = new THREE.Vector3(
      random() * 2 - 1,
      random() * 2 - 1,
      random() * 2 - 1,
    ).normalize();
    const radius = 16 + random() * 14;

    positions[i * 3] = dir.x * radius;
    positions[i * 3 + 1] = dir.y * radius;
    positions[i * 3 + 2] = dir.z * radius - 8;
    seeds[i] = random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

  stars = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: starUniforms,
      vertexShader: starVertexShader,
      fragmentShader: starFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  stars.frustumCulled = false;
  scene.add(stars);
}

function createScene(holder) {
  const width = holder.offsetWidth || window.innerWidth;
  const height = holder.offsetHeight || window.innerHeight;

  renderer = new THREE.WebGLRenderer({
    canvas: canvasRef.value,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, config.maxDpr));
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(44, width / height, 0.1, 90);
  camera.position.set(0, 0.25, config.cameraZ);
  camera.lookAt(0, 0, 0);

  globe = new THREE.Group();
  scene.add(globe);

  buildGraticule();
  buildArcs();
  buildRing();
  buildHalo();
  buildStars();
}

function handleResize() {
  if (!renderer || !camera || !holderRef.value) return;

  const holder = holderRef.value;
  const width = holder.offsetWidth || window.innerWidth;
  const height = holder.offsetHeight || window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, config.maxDpr);

  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, false);

  camera.aspect = width / height;
  // A globe is round, so it only has to reach the short edge of the frame.
  camera.fov = width / height < 1.1 ? 58 : 44;
  camera.updateProjectionMatrix();

  nodeUniforms.uDpr.value = dpr;
  starUniforms.uDpr.value = dpr;
}

const clock = new THREE.Clock();

function tick() {
  const elapsed = clock.getElapsedTime();

  // Every material spreads this object, so one write drives all of them.
  shared.uTime.value = elapsed;

  if (globe) {
    globe.rotation.y = elapsed * config.spin;
    globe.rotation.x = config.tilt + Math.sin(elapsed * 0.06) * 0.07;
  }

  if (ring) {
    ring.rotation.z = elapsed * 0.035;
    ring.rotation.x = 1.16 + Math.sin(elapsed * 0.05) * 0.12;
  }

  if (halo && camera) {
    halo.position.z = -2.5;
    halo.lookAt(camera.position);
  }

  if (camera) {
    camera.position.x = Math.sin(elapsed * 0.05) * 0.5;
    camera.position.y = 0.25 + Math.sin(elapsed * 0.07) * 0.35;
    camera.lookAt(0, 0, 0);
  }

  if (!renderer || !scene || !camera) return;

  fpsMeter.tick();
  renderer.render(scene, camera);
  frameId = requestAnimationFrame(tick);
}

const onResize = () => handleResize();

onMounted(() => {
  const holder = holderRef.value;
  if (!holder || !canvasRef.value) return;

  createScene(holder);
  handleResize();

  window.addEventListener("resize", onResize, { passive: true });

  fpsMeter.start();
  frameId = requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);

  if (frameId !== null) {
    cancelAnimationFrame(frameId);
    frameId = null;
  }

  fpsMeter.stop();

  if (scene) {
    scene.traverse((object) => {
      if (object.geometry) object.geometry.dispose();

      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];

      materials.forEach((material) => {
        if (!material) return;
        if (material.map) material.map.dispose();
        material.dispose();
      });
    });
  }

  if (renderer) {
    renderer.dispose();
    renderer.forceContextLoss();
    renderer = null;
  }

  scene = null;
  camera = null;
  globe = null;
  graticule = null;
  arcs = null;
  nodes = null;
  ring = null;
  halo = null;
  stars = null;
});
</script>
