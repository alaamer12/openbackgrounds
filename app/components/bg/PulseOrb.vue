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
  maxDpr: 1.75,

  radius: 1.92,
  // three's polyhedra are non-indexed, so this is 20 * (detail + 1)^2 faces
  // times three vertices: about 13.5k, and every one of them runs four noise
  // taps. A subdivision or two either way and the silhouette goes lumpy or the
  // displacement starts costing more than the rest of the scene put together.
  detail: 14,
  shellDetail: 8,
  coreDetail: 5,
  shellScale: 1.42,
  coreScale: 0.6,

  frequency: 1.35,
  amplitude: 0.42,
  detailWeight: 0.32,
  detailFrequency: 3.1,
  speed: 0.17,
  pulseSpeed: 0.42,
  swell: 0.1,

  rimPower: 2.6,
  rimGain: 1.5,
  ridgeLevel: 0.12,
  ridgeWidth: 0.1,

  motes: 120,
  moteRadius: 3.1,

  cameraZ: 7.3,
};

// Hand-written fragment shaders bypass three's colourspace pass, so palette
// values are uploaded as raw display-space channels via the three-argument
// Color constructor.
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
let orb = null;
let membrane = null;
let innerCore = null;
let atmosphere = null;
let motes = null;
let aura = null;
let frameId = null;

const orbUniforms = {
  uTime: { value: 0 },
  uRadius: { value: config.radius },
  uFrequency: { value: config.frequency },
  uDetailFrequency: { value: config.detailFrequency },
  uDetailWeight: { value: config.detailWeight },
  uAmplitude: { value: config.amplitude },
  uSpeed: { value: config.speed },
  uPulseSpeed: { value: config.pulseSpeed },
  uSwell: { value: config.swell },
  uRimPower: { value: config.rimPower },
  uRimGain: { value: config.rimGain },
  uRidgeLevel: { value: config.ridgeLevel },
  uRidgeWidth: { value: config.ridgeWidth },
  uBodyDeep: { value: rgb("#22063f") },
  uBodyLit: { value: rgb("#7d2bc4") },
  uRim: { value: rgb("#4cf5df") },
  uCore: { value: rgb("#c46bff") },
  uKey: { value: new THREE.Vector3(0.45, 0.72, 0.66) },
  uBounce: { value: new THREE.Vector3(-0.6, -0.35, 0.2) },
};

const atmosphereUniforms = {
  uTime: orbUniforms.uTime,
  uGlow: { value: rgb("#5fe8ff") },
  uDeep: { value: rgb("#3a1170") },
  uPower: { value: 3.4 },
  uGain: { value: 0.62 },
};

const coreUniforms = {
  uTime: orbUniforms.uTime,
  uHot: { value: rgb("#e9c8ff") },
  uCold: { value: rgb("#5a17a8") },
};

const moteUniforms = {
  uTime: orbUniforms.uTime,
  uSpeed: { value: 0.12 },
  uSize: { value: 1.0 },
  uDpr: { value: 1 },
  uTint: { value: rgb("#69f0e2") },
};

const auraUniforms = {
  uTime: orbUniforms.uTime,
  uInner: { value: rgb("#3d0f66") },
  uOuter: { value: rgb("#0b0220") },
};

// Ashima's textureless 3D simplex noise. Only the vertex shader pays for it,
// and only four times per vertex.
const simplexNoise = `
  vec3 mod289(vec3 value) {
    return value - floor(value * (1.0 / 289.0)) * 289.0;
  }

  vec4 mod289(vec4 value) {
    return value - floor(value * (1.0 / 289.0)) * 289.0;
  }

  vec4 permute(vec4 value) {
    return mod289(((value * 34.0) + 1.0) * value);
  }

  vec4 taylorInvSqrt(vec4 value) {
    return 1.79284291400159 - 0.85373472095314 * value;
  }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289(i);
    vec4 p = permute(permute(permute(
        i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 xPlane = floor(j * ns.z);
    vec4 yPlane = floor(j - 7.0 * xPlane);

    vec4 x = xPlane * ns.x + ns.yyyy;
    vec4 y = yPlane * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(
      vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3))
    );
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(
      dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;

    return 42.0 * dot(m * m, vec4(
      dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }
`;

const membraneVertexShader = `
  ${simplexNoise}

  uniform float uTime;
  uniform float uRadius;
  uniform float uFrequency;
  uniform float uDetailFrequency;
  uniform float uDetailWeight;
  uniform float uAmplitude;
  uniform float uSpeed;
  uniform float uPulseSpeed;
  uniform float uSwell;

  varying vec3 vWorld;
  varying vec3 vWorldNormal;
  varying float vDisp;

  float baseAt(vec3 dir, float t) {
    return snoise(
      dir * uFrequency + vec3(0.0, t * uSpeed, t * uSpeed * 0.45)
    );
  }

  float ridgeAt(vec3 dir, float t) {
    return snoise(
      dir * uDetailFrequency - vec3(t * uSpeed * 1.25, 0.0, t * uSpeed * 0.4)
    );
  }

  void main() {
    float t = uTime;
    vec3 dir = normalize(position);

    float breathe = 0.74 + 0.26 * sin(t * uPulseSpeed);
    float amp = uAmplitude * breathe;

    float base = baseAt(dir, t);
    float height =
      (base + ridgeAt(dir, t) * uDetailWeight) * amp +
      sin(t * 0.63) * uSwell;

    vec3 displaced = dir * (uRadius + height);

    // The normal is recovered by probing the dominant octave along two
    // tangents: cheap, and it is the low frequency lumps that tilt the rim.
    vec3 helper = abs(dir.y) < 0.95
      ? vec3(0.0, 1.0, 0.0)
      : vec3(1.0, 0.0, 0.0);
    vec3 tangentA = normalize(cross(dir, helper));
    vec3 tangentB = cross(dir, tangentA);

    float eps = 0.06;
    float slopeA = baseAt(normalize(dir + tangentA * eps), t) - base;
    float slopeB = baseAt(normalize(dir + tangentB * eps), t) - base;
    vec3 gradient = (tangentA * slopeA + tangentB * slopeB) / eps;

    // For a radially displaced sphere the surface normal is the radius minus
    // the tangential gradient, scaled by the radius it wraps.
    vec3 objectNormal = normalize(dir - gradient * amp / uRadius);

    vec4 world = modelMatrix * vec4(displaced, 1.0);
    vWorld = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
    vDisp = height / max(uAmplitude, 0.0001);

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const membraneFragmentShader = `
  uniform vec3 uBodyDeep;
  uniform vec3 uBodyLit;
  uniform vec3 uRim;
  uniform vec3 uCore;
  uniform vec3 uKey;
  uniform vec3 uBounce;
  uniform float uRimPower;
  uniform float uRimGain;
  uniform float uRidgeLevel;
  uniform float uRidgeWidth;

  varying vec3 vWorld;
  varying vec3 vWorldNormal;
  varying float vDisp;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 view = normalize(cameraPosition - vWorld);
    float facing = clamp(dot(normal, view), 0.0, 1.0);
    float fresnel = pow(1.0 - facing, uRimPower);

    float key = max(dot(normal, normalize(uKey)), 0.0);
    float bounce = max(dot(normal, normalize(uBounce)), 0.0);

    vec3 body = mix(
      uBodyDeep, uBodyLit, clamp(vDisp * 0.55 + 0.5, 0.0, 1.0));

    // Ridges where the field crosses a level read as stress in a stretching
    // film, and they only survive where the surface is already edge-on.
    float ridge = smoothstep(
      uRidgeWidth, 0.0, abs(clamp(vDisp, -1.0, 1.0) - uRidgeLevel));

    vec3 colour = body * (0.2 + key * 0.8 + bounce * 0.2);
    colour += uRim * fresnel * uRimGain;
    colour += uRim * ridge * (0.3 + fresnel * 0.5);
    colour += uCore * pow(facing, 4.0) * 0.22;

    float alpha = mix(0.82, 1.0, fresnel);
    gl_FragColor = vec4(colour, alpha);
  }
`;

const atmosphereVertexShader = `
  varying vec3 vWorld;
  varying vec3 vWorldNormal;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const atmosphereFragmentShader = `
  uniform vec3 uGlow;
  uniform vec3 uDeep;
  uniform float uPower;
  uniform float uGain;
  uniform float uTime;

  varying vec3 vWorld;
  varying vec3 vWorldNormal;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 view = normalize(cameraPosition - vWorld);
    // Back faces only: the limb is where the shell is visible at all, because
    // the membrane in front of it writes depth.
    float limb = pow(1.0 - abs(dot(normal, view)), uPower);
    float breathe = 0.85 + 0.15 * sin(uTime * 0.42);

    vec3 colour = mix(uDeep, uGlow, limb);
    gl_FragColor = vec4(colour, limb * uGain * breathe);
  }
`;

const coreVertexShader = `
  varying vec3 vWorld;
  varying vec3 vWorldNormal;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const coreFragmentShader = `
  uniform vec3 uHot;
  uniform vec3 uCold;
  uniform float uTime;

  varying vec3 vWorld;
  varying vec3 vWorldNormal;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 view = normalize(cameraPosition - vWorld);
    float centre = pow(clamp(dot(normal, view), 0.0, 1.0), 1.6);
    float beat = 0.72 + 0.28 * sin(uTime * 0.83);

    vec3 colour = mix(uCold, uHot, centre * centre);
    gl_FragColor = vec4(colour * beat, centre * 0.55);
  }
`;

const moteVertexShader = `
  attribute vec3 aOrbit;

  uniform float uTime;
  uniform float uSpeed;
  uniform float uSize;
  uniform float uDpr;

  varying float vGlow;

  void main() {
    float angle = aOrbit.x + uTime * uSpeed * (0.6 + aOrbit.z * 0.9);
    float radius = aOrbit.y;
    float bob = sin(uTime * 0.5 + aOrbit.x * 3.0) * 0.45;

    vec3 point = vec3(
      cos(angle) * radius,
      bob + sin(aOrbit.x * 5.0) * 0.5,
      sin(angle) * radius
    );

    vec4 view = viewMatrix * modelMatrix * vec4(point, 1.0);
    vGlow = 0.35 + 0.65 * sin(uTime * 1.1 + aOrbit.x * 7.0);
    gl_PointSize = clamp(
      uSize * uDpr * (10.0 + aOrbit.z * 16.0) / max(-view.z, 1.0),
      1.0,
      9.0
    );
    gl_Position = projectionMatrix * view;
  }
`;

const moteFragmentShader = `
  uniform vec3 uTint;

  varying float vGlow;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float disc = smoothstep(0.5, 0.04, d);
    float alpha = disc * clamp(vGlow, 0.0, 1.0) * 0.6;
    if (alpha <= 0.002) discard;

    gl_FragColor = vec4(uTint * (0.5 + vGlow), alpha);
  }
`;

const auraVertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const auraFragmentShader = `
  uniform vec3 uInner;
  uniform vec3 uOuter;
  uniform float uTime;

  varying vec2 vUv;

  void main() {
    float d = distance(vUv, vec2(0.5)) * 2.0;
    float falloff = smoothstep(1.0, 0.0, d);
    float breathe = 0.8 + 0.2 * sin(uTime * 0.31);

    vec3 colour = mix(uOuter, uInner, falloff);
    gl_FragColor = vec4(colour, falloff * falloff * 0.45 * breathe);
  }
`;

function buildMembrane() {
  const geometry = new THREE.IcosahedronGeometry(config.radius, config.detail);

  membrane = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: orbUniforms,
      vertexShader: membraneVertexShader,
      fragmentShader: membraneFragmentShader,
      transparent: true,
      depthWrite: true,
      side: THREE.FrontSide,
    }),
  );
  membrane.renderOrder = 2;
  orb.add(membrane);
}

function buildInnerCore() {
  const geometry = new THREE.IcosahedronGeometry(
    config.radius * config.coreScale,
    config.coreDetail,
  );

  innerCore = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: coreUniforms,
      vertexShader: coreVertexShader,
      fragmentShader: coreFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  innerCore.renderOrder = 1;
  orb.add(innerCore);
}

function buildAtmosphere() {
  // Cleared of the tallest bulge the membrane can reach, so the shell is never
  // swallowed by the body it is glowing around.
  const geometry = new THREE.IcosahedronGeometry(
    config.radius * config.shellScale,
    config.shellDetail,
  );

  atmosphere = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: atmosphereUniforms,
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    }),
  );
  atmosphere.renderOrder = 3;
  orb.add(atmosphere);
}

function buildMotes() {
  const random = makeRandom(31337);
  const count = config.motes;
  const positions = new Float32Array(count * 3);
  const orbits = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    const angle = random() * Math.PI * 2;
    const radius = config.moteRadius * (0.55 + random() * 0.75);
    const spread = random();

    // The position is a placeholder: the vertex shader rebuilds it every frame
    // from the orbit triple, so it never has to be touched again.
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = 0;
    positions[i * 3 + 2] = Math.sin(angle) * radius;

    orbits[i * 3] = angle;
    orbits[i * 3 + 1] = radius;
    orbits[i * 3 + 2] = spread;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aOrbit", new THREE.BufferAttribute(orbits, 3));

  motes = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: moteUniforms,
      vertexShader: moteVertexShader,
      fragmentShader: moteFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  motes.frustumCulled = false;
  motes.renderOrder = 4;
  orb.add(motes);
}

function buildAura() {
  const geometry = new THREE.PlaneGeometry(15, 15, 1, 1);

  aura = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: auraUniforms,
      vertexShader: auraVertexShader,
      fragmentShader: auraFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  aura.renderOrder = -1;
  scene.add(aura);
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
  camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 60);
  camera.position.set(0, 0, config.cameraZ);
  camera.lookAt(0, 0, 0);

  orb = new THREE.Group();
  // Cant the whole body so the orbit band of motes reads as an ellipse instead
  // of a line straight across the middle of the frame.
  orb.rotation.z = 0.36;
  scene.add(orb);

  buildInnerCore();
  buildMembrane();
  buildAtmosphere();
  buildMotes();
  buildAura();
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
  // Keep the orb inside the short edge of the frame at any shape.
  camera.fov = width / height < 1.1 ? 56 : 42;
  camera.updateProjectionMatrix();

  moteUniforms.uDpr.value = dpr;
}

const clock = new THREE.Clock();

function tick() {
  const elapsed = clock.getElapsedTime();

  orbUniforms.uTime.value = elapsed;

  if (orb) {
    orb.rotation.y = elapsed * 0.075;
    orb.rotation.x = Math.sin(elapsed * 0.045) * 0.22;
  }

  if (motes) {
    motes.rotation.x = 1.2 + Math.sin(elapsed * 0.05) * 0.1;
  }

  if (camera) {
    // A slow dolly so the rim keeps moving relative to the body.
    camera.position.x = Math.sin(elapsed * 0.055) * 0.42;
    camera.position.y = Math.sin(elapsed * 0.08) * 0.3;
    camera.position.z = config.cameraZ + Math.sin(elapsed * 0.11) * 0.4;
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
  orb = null;
  membrane = null;
  innerCore = null;
  atmosphere = null;
  motes = null;
  aura = null;
});
</script>
