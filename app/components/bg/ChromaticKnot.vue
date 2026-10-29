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

  radius: 1.5,
  tube: 0.42,
  // (tubularSegments + 1) * (radialSegments + 1) vertices, so this stays near
  // 4k; the knot has to be smooth or the specular breaks up into staircases.
  tubularSegments: 168,
  radialSegments: 24,
  windings: 2,
  loop: 3,

  film: 1.35,
  specular: 96.0,
  // The halo is pushed out along the surface normal rather than scaled, so the
  // glow band is the same thickness everywhere around the tube.
  auraInflate: 0.12,
  auraGain: 0.5,

  motes: 80,
  moteShell: 4.6,

  cameraZ: 7.4,
};

// The knot's shaders write gl_FragColor themselves, so three never converts the
// output: palette entries are uploaded as raw display-space channels.
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
let rig = null;
let knot = null;
let aura = null;
let motes = null;
let backlight = null;
let frameId = null;

const knotUniforms = {
  uTime: { value: 0 },
  uFilm: { value: config.film },
  uSpecular: { value: config.specular },
  // Cosine palette a + b * cos(2pi * (c * t + d)). Grey centre, just-under-half
  // amplitude so the slick never crushes to black or blows to white, and phase
  // offsets that put red ahead of green ahead of blue, which is the oil-slick
  // banding order rather than a clean rainbow.
  uPaletteA: { value: rgb("#7a7580") },
  uPaletteB: { value: rgb("#756e78") },
  uPaletteC: { value: rgb("#ffffff") },
  uPaletteD: { value: rgb("#0047a8") },
  uLightA: { value: new THREE.Vector3(0.6, 0.9, 0.8) },
  uLightB: { value: new THREE.Vector3(-0.85, -0.2, 0.4) },
  uSpecWarm: { value: rgb("#fff6e6") },
  uSpecCold: { value: rgb("#8ec8ff") },
};

const auraUniforms = {
  uTime: knotUniforms.uTime,
  uFilm: { value: config.film },
  uInflate: { value: config.auraInflate },
  uPaletteA: knotUniforms.uPaletteA,
  uPaletteB: knotUniforms.uPaletteB,
  uPaletteC: knotUniforms.uPaletteC,
  uPaletteD: knotUniforms.uPaletteD,
  uGain: { value: config.auraGain },
};

const moteUniforms = {
  uTime: knotUniforms.uTime,
  uSize: { value: 1.1 },
  uDpr: { value: 1 },
  uPaletteA: knotUniforms.uPaletteA,
  uPaletteB: knotUniforms.uPaletteB,
  uPaletteC: knotUniforms.uPaletteC,
  uPaletteD: knotUniforms.uPaletteD,
};

const backlightUniforms = {
  uTime: knotUniforms.uTime,
  uInner: { value: rgb("#2b1046") },
  uOuter: { value: rgb("#050109") },
};

const paletteChunk = `
  uniform vec3 uPaletteA;
  uniform vec3 uPaletteB;
  uniform vec3 uPaletteC;
  uniform vec3 uPaletteD;

  vec3 slick(float t) {
    return uPaletteA
      + uPaletteB * cos(6.28318530718 * (uPaletteC * t + uPaletteD));
  }
`;

const knotVertexShader = `
  varying vec3 vWorld;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const knotFragmentShader = `
  ${paletteChunk}

  uniform float uTime;
  uniform float uFilm;
  uniform float uSpecular;
  uniform vec3 uLightA;
  uniform vec3 uLightB;
  uniform vec3 uSpecWarm;
  uniform vec3 uSpecCold;

  varying vec3 vWorld;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 view = normalize(cameraPosition - vWorld);
    float facing = clamp(dot(normal, view), 0.0, 1.0);
    float fresnel = pow(1.0 - facing, 3.0);

    // Thin-film stand-in: hue comes from how edge-on the surface is, walked
    // along the tube so the slick keeps flowing over the body.
    float film =
      fresnel * uFilm + vUv.x * 0.6 + vUv.y * 0.16 + uTime * 0.025;
    vec3 colour = slick(film);

    vec3 lightA = normalize(uLightA);
    vec3 lightB = normalize(uLightB);
    float diffuse =
      max(dot(normal, lightA), 0.0) * 0.9 +
      max(dot(normal, lightB), 0.0) * 0.32;

    // Two Blinn lobes at different exponents: one tight and white, one broad
    // and cold. That pair is what reads as a wet, hard surface.
    vec3 halfA = normalize(lightA + view);
    vec3 halfB = normalize(lightB + view);
    float specA = pow(max(dot(normal, halfA), 0.0), uSpecular);
    float specB =
      pow(max(dot(normal, halfB), 0.0), uSpecular * 0.35) * 0.5;

    vec3 shaded = colour * (0.1 + diffuse);
    shaded += colour * fresnel * 1.2;
    shaded += uSpecWarm * specA * 1.7;
    shaded += uSpecCold * specB * 0.75;

    gl_FragColor = vec4(shaded, 1.0);
  }
`;

const auraVertexShader = `
  uniform float uInflate;

  varying vec3 vWorld;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position + normal * uInflate, 1.0);
    vWorld = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const auraFragmentShader = `
  ${paletteChunk}

  uniform float uTime;
  uniform float uFilm;
  uniform float uGain;

  varying vec3 vWorld;
  varying vec3 vWorldNormal;
  varying vec2 vUv;

  void main() {
    vec3 normal = normalize(vWorldNormal);
    vec3 view = normalize(cameraPosition - vWorld);
    // Back faces only, so everything but the limb is hidden behind the body:
    // this is the bloom the missing postprocessing pass would have given.
    float limb = pow(1.0 - abs(dot(normal, view)), 2.2);
    float film =
      limb * uFilm + vUv.x * 0.6 + vUv.y * 0.16 + uTime * 0.025 + 0.12;

    gl_FragColor = vec4(slick(film), limb * uGain);
  }
`;

const moteVertexShader = `
  attribute vec3 aDrift;

  uniform float uTime;
  uniform float uSize;
  uniform float uDpr;

  varying float vSeed;
  varying float vTwinkle;

  void main() {
    float t = uTime;
    vec3 point = position;

    point += vec3(
      sin(t * aDrift.x + aDrift.z * 9.0),
      cos(t * aDrift.y + aDrift.z * 5.0),
      sin(t * aDrift.y * 0.7 + aDrift.z * 3.0)
    ) * 0.5;

    vec4 view = viewMatrix * modelMatrix * vec4(point, 1.0);
    vSeed = aDrift.z;
    vTwinkle = 0.3 + 0.7 * pow(0.5 + 0.5 * sin(t * 1.3 + aDrift.z * 24.0), 2.0);
    gl_PointSize = clamp(
      uSize * uDpr * (6.0 + aDrift.z * 12.0) / max(-view.z, 1.0),
      1.0,
      7.0
    );
    gl_Position = projectionMatrix * view;
  }
`;

const moteFragmentShader = `
  ${paletteChunk}

  uniform float uTime;

  varying float vSeed;
  varying float vTwinkle;

  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float disc = smoothstep(0.5, 0.05, d);
    float alpha = disc * vTwinkle * 0.5;
    if (alpha <= 0.002) discard;

    vec3 colour = slick(vSeed * 2.0 + uTime * 0.04);
    gl_FragColor = vec4(colour * (0.4 + vTwinkle), alpha);
  }
`;

const backlightVertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const backlightFragmentShader = `
  uniform vec3 uInner;
  uniform vec3 uOuter;
  uniform float uTime;

  varying vec2 vUv;

  void main() {
    float d = distance(vUv, vec2(0.5)) * 2.0;
    float falloff = smoothstep(1.05, 0.0, d);
    float breathe = 0.86 + 0.14 * sin(uTime * 0.23);

    vec3 colour = mix(uOuter, uInner, falloff);
    gl_FragColor = vec4(colour, falloff * falloff * 0.6 * breathe);
  }
`;

function buildKnot() {
  const geometry = new THREE.TorusKnotGeometry(
    config.radius,
    config.tube,
    config.tubularSegments,
    config.radialSegments,
    config.windings,
    config.loop,
  );

  knot = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: knotUniforms,
      vertexShader: knotVertexShader,
      fragmentShader: knotFragmentShader,
      side: THREE.FrontSide,
    }),
  );
  rig.add(knot);

  // The halo reuses the same buffer, inflated along its normals in the vertex
  // shader. Disposing the shared geometry twice on teardown is a no-op inside
  // three, so there is only one buffer to give back.
  aura = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: auraUniforms,
      vertexShader: auraVertexShader,
      fragmentShader: auraFragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
    }),
  );
  aura.renderOrder = 2;
  rig.add(aura);
}

function buildMotes() {
  const random = makeRandom(777);
  const count = config.motes;
  const positions = new Float32Array(count * 3);
  const drifts = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    const dir = new THREE.Vector3(
      random() * 2 - 1,
      random() * 2 - 1,
      random() * 2 - 1,
    ).normalize();
    const shell = config.moteShell * (0.45 + random() * 0.7);

    positions[i * 3] = dir.x * shell;
    positions[i * 3 + 1] = dir.y * shell;
    positions[i * 3 + 2] = dir.z * shell - 1.2;

    drifts[i * 3] = 0.06 + random() * 0.14;
    drifts[i * 3 + 1] = 0.05 + random() * 0.12;
    drifts[i * 3 + 2] = random();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aDrift", new THREE.BufferAttribute(drifts, 3));

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
  motes.renderOrder = 3;
  scene.add(motes);
}

function buildBacklight() {
  const geometry = new THREE.PlaneGeometry(17, 17, 1, 1);

  backlight = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: backlightUniforms,
      vertexShader: backlightVertexShader,
      fragmentShader: backlightFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  backlight.position.z = -4.5;
  backlight.renderOrder = -1;
  scene.add(backlight);
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
  camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 60);
  camera.position.set(0, 0, config.cameraZ);
  camera.lookAt(0, 0, 0);

  rig = new THREE.Group();
  scene.add(rig);

  buildKnot();
  buildMotes();
  buildBacklight();
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
  // The knot is widest along its own diagonal, so a narrow frame needs the
  // extra field to keep it off the edges.
  camera.fov = width / height < 1.1 ? 54 : 40;
  camera.updateProjectionMatrix();

  moteUniforms.uDpr.value = dpr;
}

const clock = new THREE.Clock();

function tick() {
  const elapsed = clock.getElapsedTime();

  knotUniforms.uTime.value = elapsed;

  if (rig) {
    // Three axes at unrelated rates so the body never returns to a pose it has
    // already shown.
    rig.rotation.x = elapsed * 0.13;
    rig.rotation.y = elapsed * 0.19;
    rig.rotation.z = Math.sin(elapsed * 0.07) * 0.55;
  }

  if (motes) {
    motes.rotation.y = -elapsed * 0.02;
  }

  if (camera) {
    camera.position.x = Math.sin(elapsed * 0.06) * 0.5;
    camera.position.y = Math.sin(elapsed * 0.085) * 0.38;
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
  rig = null;
  knot = null;
  aura = null;
  motes = null;
  backlight = null;
});
</script>
