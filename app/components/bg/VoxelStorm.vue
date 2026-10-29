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
  // Deterministic layout: the scene is seeded so a captured thumbnail and the
  // live background describe the same storm.
  seed: 90210,
  voxels: 1900,
  embers: 260,
  maxDpr: 1.75,

  radiusMin: 1.0,
  radiusMax: 7.6,
  columnHeight: 13.5,
  swirl: 2.15,
  lift: 1.05,
  // Shear between the floor and the crown, in turns. Kept low so the arms wind
  // up slowly instead of braiding into a rope.
  twist: 0.16,
  // Radius multiplier at the base; the crown is the complement, which is what
  // makes the column read as a funnel rather than a cylinder.
  flare: 0.42,
  cubeSize: 0.17,
  hotShare: 0.09,

  fogNear: 13.0,
  fogFar: 34.0,

  cameraX: 0.0,
  cameraY: 3.4,
  cameraZ: 15.5,
};

// These scenes write gl_FragColor from a hand-written fragment shader, so three
// never runs its colourspace pass on the result. Palette entries therefore have
// to be uploaded as raw display-space values, which is what the three-argument
// Color constructor does; `new THREE.Color("#rrggbb")` would be converted to
// linear first and would come out too dark.
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
let vortex = null;
let voxelMesh = null;
let emberMesh = null;
let coreGlow = null;
let frameId = null;

const voxelUniforms = {
  uTime: { value: 0 },
  uSwirl: { value: config.swirl },
  uLift: { value: config.lift },
  uTwist: { value: config.twist },
  uFlare: { value: config.flare },
  uHeight: { value: config.columnHeight },
  uRadiusMin: { value: config.radiusMin },
  uRadiusMax: { value: config.radiusMax },
  uSize: { value: config.cubeSize },
  uFogNear: { value: config.fogNear },
  uFogFar: { value: config.fogFar },
  uEmber: { value: rgb("#ffa347") },
  uEmberGain: { value: 1.15 },
};

const emberUniforms = {
  uTime: { value: 0 },
  uHeight: { value: config.columnHeight },
  uSwirl: { value: config.swirl },
  uSize: { value: 0.65 },
  uDpr: { value: 1 },
  uFogNear: { value: 6 },
  uFogFar: { value: 30 },
  uColor: { value: rgb("#ffb45e") },
};

const coreUniforms = {
  uTime: { value: 0 },
  uInner: { value: rgb("#ff8a2b") },
  uOuter: { value: rgb("#2a4c78") },
};

const voxelVertexShader = `
  attribute vec4 aSeed;
  attribute vec4 aTint;

  uniform float uTime;
  uniform float uSwirl;
  uniform float uLift;
  uniform float uTwist;
  uniform float uFlare;
  uniform float uHeight;
  uniform float uRadiusMin;
  uniform float uRadiusMax;
  uniform float uSize;
  uniform float uFogNear;
  uniform float uFogFar;

  varying vec4 vTint;
  varying float vLight;
  varying float vRim;
  varying float vFade;

  // Rodrigues rotation around an arbitrary axis. Cheaper than a matrix per
  // cube, and it rotates the normal with the body so the facets keep catching.
  vec3 turn(vec3 value, vec3 axis, float angle) {
    vec3 a = normalize(axis);
    float c = cos(angle);
    float s = sin(angle);
    return value * c + cross(a, value) * s + a * dot(a, value) * (1.0 - c);
  }

  void main() {
    float t = uTime;

    float rn = aSeed.x;
    float radius = uRadiusMin + rn * (uRadiusMax - uRadiusMin);

    // The eye of the storm climbs fastest, which is what drags embers up the
    // middle while the outer shell lags behind.
    float climb = uLift * (0.45 + 0.7 * (1.0 - rn));
    float y = mod(aSeed.z * uHeight + t * climb, uHeight) - uHeight * 0.5;

    float hf = (y + uHeight * 0.5) / uHeight;
    float flare = mix(uFlare, 1.28 - uFlare * 0.28, pow(hf, 0.85));
    float r = radius * flare;

    // Differential rotation: small radii overtake large ones, so a random
    // scatter shears into spiral arms for free.
    float omega = uSwirl / (0.8 + r * 0.5);
    float theta = aSeed.y + t * omega + hf * uTwist * 6.28318;

    vec3 centre = vec3(cos(theta) * r, y, sin(theta) * r);

    float pulse = 0.74 + 0.32 * sin(t * 1.3 + aSeed.w * 26.0);
    float size = uSize * (0.45 + rn * 1.1) * pulse;
    vec3 axis = vec3(sin(aSeed.w * 12.0), 1.25, cos(aSeed.w * 7.0));
    float angle = t * (0.55 + omega * 0.45) + aSeed.w * 6.28318;

    vec3 local = turn(position * size, axis, angle);
    vec3 rolled = turn(normal, axis, angle);

    vec4 world = modelMatrix * vec4(centre + local, 1.0);
    vec4 view = viewMatrix * world;
    vec3 viewNormal = normalize(normalMatrix * rolled);

    // Two fixed directions in view space stand in for a key and a bounce, so
    // the cubes are shaded without adding lights to the scene.
    vec3 viewDir = normalize(-view.xyz);
    vec3 key = normalize(vec3(0.28, 0.72, 0.63));
    vec3 fill = normalize(vec3(-0.55, -0.4, 0.35));
    vLight = 0.12
      + max(dot(viewNormal, key), 0.0) * 0.92
      + max(dot(viewNormal, fill), 0.0) * 0.22;
    vRim = pow(1.0 - max(dot(viewNormal, viewDir), 0.0), 3.0);
    vFade = 1.0 - smoothstep(uFogNear, uFogFar, -view.z);
    vTint = aTint;

    gl_Position = projectionMatrix * view;
  }
`;

const voxelFragmentShader = `
  uniform vec3 uEmber;
  uniform float uEmberGain;

  varying vec4 vTint;
  varying float vLight;
  varying float vRim;
  varying float vFade;

  void main() {
    vec3 colour = vTint.rgb * vLight;
    colour += vTint.rgb * vRim * 0.55;

    // Hot cubes carry their own emission rather than just reflecting the key,
    // which is the only place the storm is allowed to be warm.
    colour += uEmber * vTint.a * (0.35 + vRim * 1.4) * uEmberGain;

    float alpha = vFade * (0.5 + 0.5 * min(vLight, 1.0));
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(colour * vFade, alpha);
  }
`;

const emberVertexShader = `
  attribute float aSeed;

  uniform float uTime;
  uniform float uHeight;
  uniform float uSwirl;
  uniform float uSize;
  uniform float uDpr;
  uniform float uFogNear;
  uniform float uFogFar;

  varying float vGlow;
  varying float vFade;

  void main() {
    float t = uTime;
    float radius = position.x;
    float climb = uHeight * (0.13 + aSeed * 0.11);
    float y = mod(position.y + t * climb, uHeight) - uHeight * 0.5;

    // Sparks converge as they rise, so the eye reads as a narrow chimney of
    // heat inside the wider cube storm.
    float hf = clamp((y + uHeight * 0.5) / uHeight, 0.0, 1.0);
    float r = radius * (1.0 - 0.45 * hf);
    float theta = position.z + t * uSwirl * (1.4 + aSeed) / (0.8 + r * 0.5);

    vec3 point = vec3(cos(theta) * r, y, sin(theta) * r);
    point.x += sin(t * 1.7 + aSeed * 21.0) * 0.14;
    point.z += cos(t * 1.4 + aSeed * 17.0) * 0.14;

    vec4 view = viewMatrix * modelMatrix * vec4(point, 1.0);
    vFade = 1.0 - smoothstep(uFogNear, uFogFar, -view.z);
    vGlow = 0.45 + 0.55 * sin(t * (2.2 + aSeed * 2.0) + aSeed * 39.0);

    gl_PointSize = clamp(
      uSize * uDpr * (120.0 / max(-view.z, 0.8)),
      1.0,
      13.0
    );
    gl_Position = projectionMatrix * view;
  }
`;

const emberFragmentShader = `
  uniform vec3 uColor;

  varying float vGlow;
  varying float vFade;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float disc = smoothstep(0.5, 0.03, d);
    float alpha = disc * vFade * clamp(vGlow, 0.0, 1.0) * 0.7;
    if (alpha <= 0.002) discard;

    gl_FragColor = vec4(uColor * (0.55 + vGlow * 0.9), alpha);
  }
`;

const coreVertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const coreFragmentShader = `
  uniform vec3 uInner;
  uniform vec3 uOuter;
  uniform float uTime;

  varying vec2 vUv;

  void main() {
    float x = abs(vUv.x - 0.5) * 2.0;
    float column = exp(-x * x * 14.0);
    float vertical =
      smoothstep(0.0, 0.32, vUv.y) * smoothstep(1.0, 0.62, vUv.y);
    float breathe = 0.72 + 0.28 * sin(uTime * 0.5);

    vec3 colour = mix(uOuter, uInner, column * column);
    gl_FragColor = vec4(colour, column * vertical * breathe * 0.22);
  }
`;

function buildVoxels() {
  const random = makeRandom(config.seed);
  const count = config.voxels;

  const seeds = new Float32Array(count * 4);
  const tints = new Float32Array(count * 4);
  const deep = rgb("#1d3a5c");
  const mid = rgb("#4a7db0");
  const bright = rgb("#9ad2f5");
  const amber = rgb("#ff9940");
  const tint = new THREE.Color();

  for (let i = 0; i < count; i += 1) {
    // sqrt bias fills the shell evenly in area rather than clustering cubes on
    // the axis, where there is barely any room for them.
    const rn = Math.sqrt(random());
    const offset = i * 4;

    seeds[offset] = rn;
    seeds[offset + 1] = random() * Math.PI * 2;
    seeds[offset + 2] = random();
    seeds[offset + 3] = random();

    const mix = Math.pow(random(), 1.5);
    if (mix < 0.42) {
      tint.copy(deep).lerp(mid, mix / 0.42);
    } else {
      tint.copy(mid).lerp(bright, (mix - 0.42) / 0.58);
    }

    const hot = random() < config.hotShare ? 1 : 0;
    if (hot) tint.copy(amber);

    tints[offset] = tint.r;
    tints[offset + 1] = tint.g;
    tints[offset + 2] = tint.b;
    tints[offset + 3] = hot;
  }

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
  geometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(tints, 4));

  const material = new THREE.ShaderMaterial({
    uniforms: voxelUniforms,
    vertexShader: voxelVertexShader,
    fragmentShader: voxelFragmentShader,
    transparent: true,
    depthWrite: true,
    side: THREE.FrontSide,
  });

  voxelMesh = new THREE.InstancedMesh(geometry, material, count);
  // Every cube is placed by the vertex shader, so the geometry's own bounding
  // volume says nothing about where the instance actually is.
  voxelMesh.frustumCulled = false;
  vortex.add(voxelMesh);
}

function buildEmbers() {
  const random = makeRandom(config.seed + 41);
  const count = config.embers;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = 0.25 + Math.pow(random(), 0.7) * 2.6;
    positions[i * 3 + 1] = random() * config.columnHeight;
    positions[i * 3 + 2] = random() * Math.PI * 2;
    seeds[i] = random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: emberUniforms,
    vertexShader: emberVertexShader,
    fragmentShader: emberFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });

  emberMesh = new THREE.Points(geometry, material);
  emberMesh.frustumCulled = false;
  emberMesh.renderOrder = 4;
  vortex.add(emberMesh);
}

function buildCoreGlow() {
  const geometry = new THREE.PlaneGeometry(7.5, config.columnHeight, 1, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: coreUniforms,
    vertexShader: coreVertexShader,
    fragmentShader: coreFragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });

  // The only cheap bloom in the scene: an untested additive column sitting in
  // the eye of the storm, billboarded at the camera every frame.
  coreGlow = new THREE.Mesh(geometry, material);
  coreGlow.position.y = 0.4;
  coreGlow.renderOrder = 5;
  scene.add(coreGlow);
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
  camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 90);
  camera.position.set(config.cameraX, config.cameraY, config.cameraZ);
  camera.lookAt(0, 0.4, 0);

  vortex = new THREE.Group();
  scene.add(vortex);

  buildVoxels();
  buildEmbers();
  buildCoreGlow();
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
  camera.updateProjectionMatrix();

  emberUniforms.uDpr.value = dpr;
}

const clock = new THREE.Clock();

function tick() {
  const elapsed = clock.getElapsedTime();

  voxelUniforms.uTime.value = elapsed;
  emberUniforms.uTime.value = elapsed;
  coreUniforms.uTime.value = elapsed;

  if (vortex) {
    vortex.rotation.y = elapsed * 0.05;
  }

  if (coreGlow && camera) {
    coreGlow.lookAt(camera.position.x, coreGlow.position.y, camera.position.z);
  }

  if (camera) {
    camera.position.x = Math.sin(elapsed * 0.09) * 1.5;
    camera.position.y = config.cameraY + Math.sin(elapsed * 0.13) * 0.5;
    camera.lookAt(0, 0.4 + Math.sin(elapsed * 0.11) * 0.3, 0);
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

  // Nothing else holds a context here, but the gallery runs far more scenes
  // than a browser allows live contexts, so the GL handle has to go back.
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
  vortex = null;
  voxelMesh = null;
  emberMesh = null;
  coreGlow = null;
});
</script>
