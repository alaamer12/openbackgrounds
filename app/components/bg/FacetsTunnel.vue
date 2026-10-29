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
  seed: 8821,

  sides: 9,
  rings: 30,
  segmentLength: 2.5,
  radius: 3.4,
  // Fraction of the radius each corner may move in or out, which is what turns
  // a plain cylinder into a stack of irregular polygonal facets.
  jitter: 0.3,
  twist: 0.052,
  bend: 0.75,

  speed: 3.1,
  dust: 240,
  dustSpeed: 1.28,

  falloff: 0.008,
  gain: 1.7,
  ambient: 0.07,
  fogNear: 32.0,
  fogFar: 72.0,

  lampSpeed: 0.42,
  lampCycle: 0.055,
  lampRadius: 1.7,
};

// Shaders here write gl_FragColor directly, so three's colourspace pass never
// runs: the palette is uploaded as raw display-space channels.
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

const span = config.rings * config.segmentLength;

let renderer = null;
let scene = null;
let camera = null;
let tunnel = null;
let dust = null;
let beacon = null;
let frameId = null;

const tunnelUniforms = {
  uTime: { value: 0 },
  uTravel: { value: 0 },
  uSpan: { value: span },
  uSegmentLength: { value: config.segmentLength },
  uTwist: { value: config.twist },
  uBend: { value: config.bend },
  uLamp: { value: new THREE.Vector3(0, 0, -6) },
  uFillColor: { value: rgb("#4e6f9c") },
  uLampA: { value: rgb("#ff2f7f") },
  uLampB: { value: rgb("#22e0ff") },
  uLampC: { value: rgb("#ffab2e") },
  uLampPhase: { value: 0 },
  uAmbient: { value: config.ambient },
  uFalloff: { value: config.falloff },
  uGain: { value: config.gain },
  uFogNear: { value: config.fogNear },
  uFogFar: { value: config.fogFar },
};

const dustUniforms = {
  uTime: tunnelUniforms.uTime,
  uTravel: tunnelUniforms.uTravel,
  uSpan: { value: span },
  uRadius: { value: config.radius },
  uSpeed: { value: config.dustSpeed },
  uTwist: { value: config.twist },
  uSize: { value: 1.0 },
  uDpr: { value: 1 },
  uLampPhase: tunnelUniforms.uLampPhase,
  uLampA: tunnelUniforms.uLampA,
  uLampB: tunnelUniforms.uLampB,
  uLampC: tunnelUniforms.uLampC,
};

const beaconUniforms = {
  uTime: tunnelUniforms.uTime,
  uLampPhase: tunnelUniforms.uLampPhase,
  uLampA: tunnelUniforms.uLampA,
  uLampB: tunnelUniforms.uLampB,
  uLampC: tunnelUniforms.uLampC,
};

const lobeChunk = `
  uniform float uLampPhase;
  uniform vec3 uLampA;
  uniform vec3 uLampB;
  uniform vec3 uLampC;

  // Three lobes a third of a cycle apart, blended with a triangle window. The
  // window is a partition of unity, so the blended colour keeps the palette's
  // own brightness instead of needing a renormalise.
  float lobe(float value, float center) {
    float d = abs(value - center);
    d = min(d, 3.0 - d);
    return max(0.0, 1.0 - d);
  }

  vec3 lampColor() {
    float w = fract(uLampPhase) * 3.0;
    float a = lobe(w, 0.0);
    float b = lobe(w, 1.0);
    float c = lobe(w, 2.0);

    return (uLampA * a + uLampB * b + uLampC * c) / max(a + b + c, 0.4);
  }
`;

const tunnelVertexShader = `
  attribute float aZ;
  attribute vec3 aTint;

  uniform float uTime;
  uniform float uTravel;
  uniform float uSpan;
  uniform float uSegmentLength;
  uniform float uTwist;
  uniform float uBend;
  uniform float uFogNear;
  uniform float uFogFar;

  varying vec3 vWorld;
  varying vec3 vWorldNormal;
  varying vec3 vTint;
  varying float vFade;

  vec2 turn(vec2 value, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec2(value.x * c - value.y * s, value.x * s + value.y * c);
  }

  void main() {
    // Recycle: the ring walks forward with the travel and wraps back to the far
    // end the moment it slips behind the eye, so the tube is endless.
    float base = mod(aZ + uTravel, uSpan) - uSpan + uSegmentLength;
    float depth = base + position.z;

    vec4 rolled = instanceMatrix * vec4(position, 1.0);

    // The axis itself wanders, which stops the flight from reading as a
    // perfectly straight pipe.
    vec2 axis = vec2(
      sin(depth * 0.042 + uTime * 0.05),
      cos(depth * 0.031 - uTime * 0.04)
    ) * uBend;

    vec3 point = vec3(turn(rolled.xy, depth * uTwist) + axis, depth);

    vec3 rolledNormal = mat3(instanceMatrix) * normal;
    vec3 turned = vec3(turn(rolledNormal.xy, depth * uTwist), rolledNormal.z);

    vec4 world = modelMatrix * vec4(point, 1.0);
    vec4 view = viewMatrix * world;

    vWorld = world.xyz;
    vWorldNormal = normalize(turned);
    vTint = aTint;

    // Two-sided falloff: rings dissolve into dark as they drop away, and the
    // wall passing right beside the eye is faded out too, so the frame never
    // fills with an unlit slab at the edges.
    float ahead = -view.z;
    vFade =
      (1.0 - smoothstep(uFogNear, uFogFar, ahead)) * smoothstep(0.5, 7.0, ahead);

    gl_Position = projectionMatrix * view;
  }
`;

const tunnelFragmentShader = `
  ${lobeChunk}

  uniform vec3 uLamp;
  uniform vec3 uFillColor;
  uniform float uAmbient;
  uniform float uFalloff;
  uniform float uGain;

  varying vec3 vWorld;
  varying vec3 vWorldNormal;
  varying vec3 vTint;
  varying float vFade;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 view = normalize(cameraPosition - vWorld);

    vec3 toLamp = uLamp - vWorld;
    float lampDistance = length(toLamp);
    float lambert =
      max(dot(normal, toLamp / max(lampDistance, 0.001)), 0.0);
    float reach = 1.0 / (1.0 + lampDistance * lampDistance * uFalloff);

    // A camera buried inside a bore has no useful fill light: the facets that
    // square up to the lens are the walls framing the shot, so those get a cold
    // wash instead of dropping to black.
    float straightOn = abs(dot(normal, view));

    // Facets flash because the lamp both dives down the tube and orbits inside
    // it, so the lit polygon changes with every ring that passes.
    vec3 colour = vTint * (uAmbient + lampColor() * lambert * reach * uGain);
    colour += vTint * uFillColor * pow(straightOn, 3.0) * 0.45;
    colour *= 0.72 + 0.28 * straightOn;

    float alpha = vFade * (0.35 + 0.65 * min(vFade, 1.0));
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(colour * vFade, alpha);
  }
`;

const dustVertexShader = `
  attribute float aSeed;

  uniform float uTime;
  uniform float uTravel;
  uniform float uSpan;
  uniform float uRadius;
  uniform float uSpeed;
  uniform float uTwist;
  uniform float uSize;
  uniform float uDpr;

  varying float vGlow;
  varying float vFade;

  void main() {
    float angle = aSeed * 6.28318 + uTravel * uTwist * 0.35;
    float band = fract(aSeed * 7.13);
    float radius = mix(0.2, 1.05, band) * uRadius;
    float depth =
      mod(fract(aSeed * 3.71) * uSpan + uTravel * uSpeed, uSpan) - uSpan;

    vec3 point = vec3(cos(angle) * radius, sin(angle) * radius, depth);

    vec4 view = viewMatrix * modelMatrix * vec4(point, 1.0);
    vGlow = 0.25 + 0.75 * (0.5 + 0.5 * sin(uTime * 1.7 + aSeed * 31.0));
    vFade = 1.0 - smoothstep(6.0, 42.0, -view.z);

    gl_PointSize = clamp(
      uSize * uDpr * (14.0 + band * 26.0) / max(-view.z, 0.8),
      1.0,
      6.0
    );
    gl_Position = projectionMatrix * view;
  }
`;

const dustFragmentShader = `
  ${lobeChunk}

  varying float vGlow;
  varying float vFade;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float disc = smoothstep(0.5, 0.04, d);
    float alpha = disc * vFade * clamp(vGlow, 0.0, 1.0) * 0.55;
    if (alpha <= 0.002) discard;

    gl_FragColor = vec4(lampColor() * (0.5 + vGlow), alpha);
  }
`;

const beaconVertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const beaconFragmentShader = `
  ${lobeChunk}

  uniform float uTime;

  varying vec2 vUv;

  void main() {
    float d = distance(vUv, vec2(0.5)) * 2.0;
    float core = smoothstep(1.0, 0.0, d);
    float pulse = 0.7 + 0.3 * sin(uTime * 0.9);

    vec3 colour = lampColor();
    gl_FragColor = vec4(colour, core * core * core * 0.5 * pulse);
  }
`;

function buildTunnel() {
  const random = makeRandom(config.seed);
  const sides = config.sides;
  const length = config.segmentLength;
  const corners = [];

  for (let s = 0; s < sides; s += 1) {
    corners.push({
      angle: (s / sides) * Math.PI * 2,
      radius: config.radius * (1 + (random() - 0.5) * config.jitter),
    });
  }

  const cornerAt = (index, z) => {
    const corner = corners[index % sides];
    return new THREE.Vector3(
      Math.cos(corner.angle) * corner.radius,
      Math.sin(corner.angle) * corner.radius,
      z,
    );
  };

  const positions = [];
  const normals = [];

  const faceNormal = (a, b, c) =>
    new THREE.Vector3()
      .crossVectors(b.clone().sub(a), c.clone().sub(a))
      .normalize();

  const pushFace = (a, b, c, normal) => {
    [a, b, c].forEach((point) => {
      positions.push(point.x, point.y, point.z);
      normals.push(normal.x, normal.y, normal.z);
    });
  };

  for (let s = 0; s < sides; s += 1) {
    const near = cornerAt(s, 0);
    const far = cornerAt(s + 1, 0);
    const nearNext = cornerAt(s, length);
    const farNext = cornerAt(s + 1, length);

    // Wound so the front face is the inside of the tube. One normal is shared
    // by both triangles of the quad, which is what keeps the polygon flat.
    const normal = faceNormal(near, nearNext, far);
    pushFace(near, nearNext, far, normal);
    pushFace(nearNext, farNext, far, normal);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));

  const depths = new Float32Array(config.rings);
  const tints = new Float32Array(config.rings * 3);
  const slate = rgb("#6d7f96");

  for (let i = 0; i < config.rings; i += 1) {
    depths[i] = i * length;

    // The walls stay neutral: every colour in the scene comes off the lamp, so
    // the only variation here is how much of it each ring has to reflect.
    const weight = 0.55 + random() * 0.45;
    const tint = slate.clone().multiplyScalar(weight);
    tints[i * 3] = tint.r;
    tints[i * 3 + 1] = tint.g;
    tints[i * 3 + 2] = tint.b;
  }

  geometry.setAttribute("aZ", new THREE.InstancedBufferAttribute(depths, 1));
  geometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(tints, 3));

  const material = new THREE.ShaderMaterial({
    uniforms: tunnelUniforms,
    vertexShader: tunnelVertexShader,
    fragmentShader: tunnelFragmentShader,
    transparent: true,
    depthWrite: true,
    side: THREE.FrontSide,
  });

  tunnel = new THREE.InstancedMesh(geometry, material, config.rings);

  const matrix = new THREE.Matrix4();
  for (let i = 0; i < config.rings; i += 1) {
    // The only thing baked into the instance matrix is a roll about the axis.
    // Every ring is the same prism at a different angle, which is what makes
    // the wall step through the facets as it passes.
    matrix.makeRotationZ(random() * Math.PI * 2);
    tunnel.setMatrixAt(i, matrix);
  }
  tunnel.instanceMatrix.needsUpdate = true;
  tunnel.frustumCulled = false;
  scene.add(tunnel);
}

function buildDust() {
  const random = makeRandom(config.seed + 991);
  const count = config.dust;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    seeds[i] = random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

  dust = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: dustUniforms,
      vertexShader: dustVertexShader,
      fragmentShader: dustFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  dust.frustumCulled = false;
  dust.renderOrder = 3;
  scene.add(dust);
}

function buildBeacon() {
  const geometry = new THREE.PlaneGeometry(22, 22, 1, 1);

  beacon = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: beaconUniforms,
      vertexShader: beaconVertexShader,
      fragmentShader: beaconFragmentShader,
      transparent: true,
      depthWrite: false,
      // Drawn before the walls and never depth tested, so the glow sits at the
      // bottom of the bore and the fading far rings let it through.
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  beacon.position.set(0, 0, -span * 0.92);
  beacon.renderOrder = -1;
  scene.add(beacon);
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
  camera = new THREE.PerspectiveCamera(76, width / height, 0.1, 140);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -12);

  buildTunnel();
  buildDust();
  buildBeacon();
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

  dustUniforms.uDpr.value = dpr;
}

const clock = new THREE.Clock();
const lamp = new THREE.Vector3();
const gaze = new THREE.Vector3();

function tick() {
  const elapsed = clock.getElapsedTime();
  const travel = elapsed * config.speed;

  tunnelUniforms.uTravel.value = travel;
  tunnelUniforms.uTime.value = elapsed;
  tunnelUniforms.uLampPhase.value = elapsed * config.lampCycle;

  // The lamp both dives down the tube and orbits the axis, so no two rings are
  // lit the same way as they come past.
  const lampDepth = -2.4 - ((travel * 1.06) % (span * 0.52));
  lamp.set(
    Math.cos(elapsed * config.lampSpeed) * config.lampRadius,
    Math.sin(elapsed * config.lampSpeed * 0.77) * config.lampRadius,
    lampDepth,
  );
  tunnelUniforms.uLamp.value.copy(lamp);

  if (camera) {
    // The eye drifts inside the bore and rolls a few degrees off level, which
    // is what sells the flight rather than a flat dolly down a pipe.
    camera.position.set(
      Math.sin(elapsed * 0.13) * 0.72,
      Math.cos(elapsed * 0.11) * 0.58,
      0,
    );
    const roll = Math.sin(elapsed * 0.07) * 0.42;
    camera.up.set(Math.sin(roll), Math.cos(roll), 0);
    gaze.set(
      Math.sin(elapsed * 0.07) * 1.2,
      Math.cos(elapsed * 0.05) * 0.9,
      -12,
    );
    camera.lookAt(gaze);
  }

  if (beacon) {
    beacon.position.x =
      Math.sin(beacon.position.z * 0.042 + elapsed * 0.05) * config.bend;
    beacon.position.y =
      Math.cos(beacon.position.z * 0.031 - elapsed * 0.04) * config.bend;
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
  tunnel = null;
  dust = null;
  beacon = null;
});
</script>
