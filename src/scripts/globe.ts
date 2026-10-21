import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
  DirectionalLight,
  Group,
  MathUtils,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from "three";
import cloudsLargeUrl from "~/assets/globe/earth-clouds-large.avif?url";
import cloudsSmallUrl from "~/assets/globe/earth-clouds-small.avif?url";
import dayLargeUrl from "~/assets/globe/earth-day-large.avif?url";
import daySmallUrl from "~/assets/globe/earth-day-small.avif?url";
import nightLargeUrl from "~/assets/globe/earth-night-large.avif?url";
import nightSmallUrl from "~/assets/globe/earth-night-small.avif?url";

const TEXTURES = {
  large: { day: dayLargeUrl, night: nightLargeUrl, clouds: cloudsLargeUrl },
  small: { day: daySmallUrl, night: nightSmallUrl, clouds: cloudsSmallUrl },
};
// Canvas width in device pixels above which the 2048px textures are sharper than the 1024px ones.
const LARGE_TEXTURE_MIN_WIDTH = 600;
const MAX_PIXEL_RATIO = 2;

// Share of the canvas height the disk fills in earth-nasa.png, so the swap from the static image is seamless.
const DISK_SCALE = 0.61;
const FOV = 30;
const AXIAL_TILT = MathUtils.degToRad(23.4);
const ORBIT_SPEED = 0.06; // radians per second
const CLOUD_DRIFT = 0.008; // radians per second, on top of the orbit
const SWAY_PERIOD = 40; // seconds for one camera inclination sway
const SWAY_INCLINATION = 0.25;
const MS_PER_DAY = 86_400_000;

const earthVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Lambert-lit day side, city lights fading in past the terminator.
const earthFragment = /* glsl */ `
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform vec3 sunDirection;
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    float sun = dot(normalize(vNormal), sunDirection);
    vec3 day = texture2D(dayMap, vUv).rgb * (max(sun, 0.0) + 0.06);
    // Squaring crushes the texture's blue land tint while keeping city lights bright.
    vec3 lights = texture2D(nightMap, vUv).rgb;
    vec3 night = lights * lights * 2.5 + vec3(0.004, 0.006, 0.012);
    gl_FragColor = vec4(mix(night, day, smoothstep(-0.12, 0.18, sun)), 1.0);
    #include <colorspace_fragment>
  }
`;

const atmosphereVertex = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Back faces of the shell: 0 at its outer rim, brightest where it meets the planet's limb.
const atmosphereFragment = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    float limb = clamp(-vNormal.z / 0.45, 0.0, 1.0);
    float intensity = pow(limb, 3.0) * 0.9;
    gl_FragColor = vec4(vec3(0.35, 0.6, 1.0) * intensity, intensity);
  }
`;

// Direction from Earth's center to a surface point, in the sphere's local space
// (three.js maps the equirectangular seam to -x, so longitude 0 sits on +x).
function surfaceDirection(latitude: number, longitude: number, target: Vector3) {
  return target.set(
    Math.cos(latitude) * Math.cos(longitude),
    Math.sin(latitude),
    -Math.cos(latitude) * Math.sin(longitude),
  );
}

// Subsolar point to within a degree or so, ignoring the equation of time.
function subsolarPoint(date: Date) {
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = (date.getTime() - startOfYear) / MS_PER_DAY;
  const declination = -AXIAL_TILT * Math.cos(((dayOfYear + 10) / 365.25) * Math.PI * 2);
  const utcHours = (date.getTime() % MS_PER_DAY) / 3_600_000;
  const longitude = MathUtils.degToRad((12 - utcHours) * 15);
  return { latitude: declination, longitude };
}

export async function mountGlobe(canvas: HTMLCanvasElement, onReady: () => void) {
  const renderer = new WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  const pixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
  renderer.setPixelRatio(pixelRatio);

  const urls =
    canvas.clientWidth * pixelRatio > LARGE_TEXTURE_MIN_WIDTH ? TEXTURES.large : TEXTURES.small;
  const loader = new TextureLoader();
  const [day, night, clouds] = await Promise.all([
    loader.loadAsync(urls.day),
    loader.loadAsync(urls.night),
    loader.loadAsync(urls.clouds),
  ]);
  const anisotropy = renderer.capabilities.getMaxAnisotropy();
  for (const texture of [day, night]) {
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = anisotropy;
  }

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 100);
  const angularRadius = Math.atan(DISK_SCALE * Math.tan(MathUtils.degToRad(FOV / 2)));
  const distance = 1 / Math.sin(angularRadius);

  const sunDirection = new Vector3();
  const sun = new DirectionalLight(0xffffff, 3);
  scene.add(new AmbientLight(0xffffff, 0.03));

  const geometry = new SphereGeometry(1, 64, 64);
  const earth = new Mesh(
    geometry,
    new ShaderMaterial({
      vertexShader: earthVertex,
      fragmentShader: earthFragment,
      uniforms: {
        dayMap: { value: day },
        nightMap: { value: night },
        sunDirection: { value: new Vector3() },
      },
    }),
  );

  const cloudLayer = new Mesh(
    geometry,
    new MeshLambertMaterial({ alphaMap: clouds, transparent: true, depthWrite: false }),
  );
  cloudLayer.scale.setScalar(1.006);

  // Earth and Sun turn together, so spinning this group is the camera orbiting a planet lit as it is right now.
  const orbit = new Group();
  orbit.add(earth, cloudLayer, sun);

  const tilted = new Group();
  tilted.rotation.z = AXIAL_TILT;
  tilted.add(orbit);

  const atmosphere = new Mesh(
    geometry,
    new ShaderMaterial({
      vertexShader: atmosphereVertex,
      fragmentShader: atmosphereFragment,
      blending: AdditiveBlending,
      side: BackSide,
      transparent: true,
      depthWrite: false,
    }),
  );
  atmosphere.scale.setScalar(1.12);
  scene.add(tilted, atmosphere);

  // Open over the visitor's longitude, estimated from their UTC offset, so their own day or night faces them.
  const visitorLongitude = MathUtils.degToRad(-new Date().getTimezoneOffset() / 4);
  orbit.rotation.y = -Math.PI / 2 - visitorLongitude;

  const updateSun = () => {
    const { latitude, longitude } = subsolarPoint(new Date());
    surfaceDirection(latitude, longitude, sunDirection);
    sun.position.copy(sunDirection).multiplyScalar(10);
    tilted.updateMatrixWorld();
    earth.material.uniforms.sunDirection.value
      .copy(sunDirection)
      .transformDirection(earth.matrixWorld);
  };

  const resize = () => {
    const { clientWidth: width, clientHeight: height } = canvas;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  let elapsed = 0;
  let last = performance.now();

  const render = (now: number) => {
    // Clamp so returning to the tab doesn't jump the rotation.
    const delta = Math.min((now - last) / 1000, 0.1);
    last = now;
    elapsed += delta;

    orbit.rotation.y += ORBIT_SPEED * delta;
    cloudLayer.rotation.y += CLOUD_DRIFT * delta;
    updateSun();

    const sway = Math.sin((elapsed / SWAY_PERIOD) * Math.PI * 2) * SWAY_INCLINATION;
    camera.position.set(0, Math.sin(sway) * distance, Math.cos(sway) * distance);
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  };

  render(last);
  requestAnimationFrame(onReady);

  new IntersectionObserver(([entry]) => {
    last = performance.now();
    renderer.setAnimationLoop(entry.isIntersecting ? render : null);
  }).observe(canvas);
}
