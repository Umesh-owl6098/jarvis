'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useRef, useMemo, useEffect } from 'react';
import * as THREE from 'three';
import { type VisualState, visualStateColors } from './types';

/* ============================================================
   JARVIS intelligence core.

   Nucleus assembly (outside → in):
     · fresnel energy shell        transparent, additive rim
     · geometric cage              two counter-rotating wireframes
     · plasma body                 shader: fbm noise + white-hot filaments
     · seed                        small high-energy centre, pulses

   Environment:
     starfield · holographic platform + tick ring · lat/long shell
     three segmented orbit systems · instanced data nodes + links
     GPU particle streams · energy arcs · vertical axis · scan ring

   Geometry/materials build once. Per-frame work is refs and uniform
   writes only — no React state, no allocation in the loop.
   ============================================================ */

export type SceneQuality = 'high' | 'medium' | 'low';

interface Props {
  state: VisualState;
  quality: SceneQuality;
  reducedMotion: boolean;
}

const PARTICLES: Record<SceneQuality, number> = { high: 2600, medium: 1500, low: 650 };
const STARS: Record<SceneQuality, number> = { high: 1400, medium: 800, low: 380 };

/* ---------- state → motion contract ---------- */
interface Behaviour {
  spin: number;
  orbit: number;
  flow: number;
  scan: number;
  arcs: number;
  breathe: number;
  dist: number;
  turbulence: number;
}

const BEHAVIOUR: Record<VisualState['agentState'], Behaviour> = {
  idle:      { spin: 0.30, orbit: 0.35, flow:  1, scan: 0.10, arcs: 0.42, breathe: 0.030, dist: 7.4, turbulence: 0.30 },
  observing: { spin: 0.55, orbit: 0.70, flow:  1, scan: 1.00, arcs: 0.45, breathe: 0.045, dist: 7.0, turbulence: 0.55 },
  planning:  { spin: 1.35, orbit: 1.60, flow: -1, scan: 0.30, arcs: 0.85, breathe: 0.070, dist: 6.4, turbulence: 1.30 },
  acting:    { spin: 1.05, orbit: 1.20, flow:  1, scan: 0.65, arcs: 1.00, breathe: 0.095, dist: 6.1, turbulence: 1.05 },
  retrying:  { spin: 0.70, orbit: 0.55, flow: -1, scan: 0.45, arcs: 0.70, breathe: 0.120, dist: 6.8, turbulence: 1.60 },
  stopping:  { spin: 0.18, orbit: 0.16, flow: -1, scan: 0.15, arcs: 0.30, breathe: 0.055, dist: 6.6, turbulence: 0.70 },
  stopped:   { spin: 0.04, orbit: 0.04, flow:  1, scan: 0.00, arcs: 0.05, breathe: 0.012, dist: 7.8, turbulence: 0.05 },
  completed: { spin: 0.35, orbit: 0.45, flow:  1, scan: 0.20, arcs: 0.55, breathe: 0.050, dist: 7.0, turbulence: 0.35 },
  failed:    { spin: 0.22, orbit: 0.20, flow:  1, scan: 0.10, arcs: 0.35, breathe: 0.085, dist: 7.2, turbulence: 1.10 },
};

/* ---------- geometry builders ---------- */

function latLongGeometry(radius: number, lats: number, longs: number, seg: number) {
  const pts: number[] = [];
  for (let i = 1; i < lats; i++) {
    const phi = (i / lats) * Math.PI;
    const y = radius * Math.cos(phi);
    const r = radius * Math.sin(phi);
    for (let j = 0; j < seg; j++) {
      const a0 = (j / seg) * Math.PI * 2;
      const a1 = ((j + 1) / seg) * Math.PI * 2;
      pts.push(Math.cos(a0) * r, y, Math.sin(a0) * r, Math.cos(a1) * r, y, Math.sin(a1) * r);
    }
  }
  for (let i = 0; i < longs; i++) {
    const th = (i / longs) * Math.PI;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    for (let j = 0; j < seg; j++) {
      const a0 = (j / seg) * Math.PI * 2;
      const a1 = ((j + 1) / seg) * Math.PI * 2;
      const x0 = Math.cos(a0) * radius;
      const y0 = Math.sin(a0) * radius;
      const x1 = Math.cos(a1) * radius;
      const y1 = Math.sin(a1) * radius;
      pts.push(x0 * ct, y0, x0 * st, x1 * ct, y1, x1 * st);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/** Ring built from discrete arc segments with gaps — reads as engineered, not drawn. */
function segmentedRingGeometry(radius: number, segments: number, fill: number, res: number) {
  const pts: number[] = [];
  for (let s = 0; s < segments; s++) {
    const base = (s / segments) * Math.PI * 2;
    const span = (Math.PI * 2 / segments) * fill;
    for (let j = 0; j < res; j++) {
      const a0 = base + (j / res) * span;
      const a1 = base + ((j + 1) / res) * span;
      pts.push(Math.cos(a0) * radius, Math.sin(a0) * radius, 0, Math.cos(a1) * radius, Math.sin(a1) * radius, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/** Concentric rings + spokes + graduated tick marks, laid flat in XZ. */
function platformGeometry(inner: number, outer: number, rings: number, spokes: number, seg: number) {
  const pts: number[] = [];
  for (let k = 0; k < rings; k++) {
    const r = inner + (outer - inner) * (k / (rings - 1));
    for (let j = 0; j < seg; j++) {
      const a0 = (j / seg) * Math.PI * 2;
      const a1 = ((j + 1) / seg) * Math.PI * 2;
      pts.push(Math.cos(a0) * r, 0, Math.sin(a0) * r, Math.cos(a1) * r, 0, Math.sin(a1) * r);
    }
  }
  for (let s = 0; s < spokes; s++) {
    const a = (s / spokes) * Math.PI * 2;
    const from = s % 4 === 0 ? inner * 0.62 : inner;
    pts.push(Math.cos(a) * from, 0, Math.sin(a) * from, Math.cos(a) * outer, 0, Math.sin(a) * outer);
  }
  // graduated ticks on the outer edge
  const ticks = 96;
  for (let t = 0; t < ticks; t++) {
    const a = (t / ticks) * Math.PI * 2;
    const len = t % 8 === 0 ? 0.3 : t % 2 === 0 ? 0.16 : 0.08;
    pts.push(
      Math.cos(a) * outer, 0, Math.sin(a) * outer,
      Math.cos(a) * (outer + len), 0, Math.sin(a) * (outer + len)
    );
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

function arcGeometry(radius: number, rng: () => number) {
  const pick = () =>
    new THREE.Vector3().setFromSphericalCoords(radius, Math.acos(2 * rng() - 1), rng() * Math.PI * 2);
  const a = pick();
  let b = pick();
  let guard = 0;
  while (a.dot(b) / (radius * radius) < 0.1 && guard++ < 12) b = pick();
  const mid = a.clone().add(b).multiplyScalar(0.5).normalize().multiplyScalar(radius * (1.3 + rng() * 0.3));
  return new THREE.BufferGeometry().setFromPoints(new THREE.QuadraticBezierCurve3(a, mid, b).getPoints(40));
}

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- shaders ---------- */

const FRESNEL_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRESNEL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uPower;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), uPower);
  gl_FragColor = vec4(uColor * f * uIntensity, f * 0.85);
}`;

/** Plasma body: animated fbm drives emissive filaments with white-hot cores. */
const PLASMA_VERT = /* glsl */ `
varying vec3 vPos;
varying vec3 vN;
varying vec3 vV;
void main() {
  vPos = position;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const PLASMA_FRAG = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform float uTurbulence;
uniform vec3 uColor;
uniform vec3 uHot;
varying vec3 vPos;
varying vec3 vN;
varying vec3 vV;

float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}

float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec3 q = vPos * 2.2;
  float t = uTime * (0.38 + uTurbulence * 0.55);

  // Ridged noise gives vein-like filaments; plain fbm only gives lunar clouds.
  float n1 = fbm(q + vec3(0.0, t, 0.0));
  float veins = pow(1.0 - abs(2.0 * n1 - 1.0), 4.0);

  float n2 = fbm(q * 2.1 - vec3(t * 0.6, 0.0, t * 0.3));
  float detail = pow(1.0 - abs(2.0 * n2 - 1.0), 6.0);

  // Broad, soft internal flow — high-frequency mottling reads as rock, not energy.
  float e = clamp(veins * 1.1 + detail * 0.35, 0.0, 1.2);
  e = smoothstep(0.12, 0.92, e);
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.4);

  // Output stays near 1.0 on purpose — ACES hue-shifts over-driven cyan toward
  // orange, so brightness is bought with bloom, not with raw radiance.
  vec3 col = uColor * 0.04;             // near-dark body, reads as contained
  col += uColor * e * 0.95;             // cyan energy veins
  col += uHot * pow(e, 4.0) * 0.16;     // white-hot only at the vein cores
  col += uColor * fres * 0.55;          // containment rim
  gl_FragColor = vec4(col * uIntensity, 1.0);
}`;

const PARTICLE_VERT = /* glsl */ `
uniform float uTime;
uniform float uFlow;
uniform float uCore;
uniform float uSize;
uniform float uDpr;
uniform float uSwirl;
attribute vec3 aDir;
attribute float aRadius;
attribute float aSpeed;
attribute float aPhase;
varying float vFade;
mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c,0.0,-s, 0.0,1.0,0.0, s,0.0,c); }
void main() {
  float t = fract(aPhase + uTime * aSpeed * uFlow);
  float r = mix(uCore, aRadius, t);
  vec3 p = rotY(uTime * uSwirl * (0.3 + aSpeed) + t * 1.9) * (aDir * r);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vFade = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.7, 1.0, t));
  gl_PointSize = clamp(uSize * uDpr * (46.0 / max(-mv.z, 0.001)), 0.8, 5.0);
}`;

const PARTICLE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  if (d > 0.5) discard;
  gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, d) * vFade * uOpacity);
}`;

const RING_RADII = [1.92, 2.26, 2.62];
const RING_TILTS: [number, number, number][] = [
  [Math.PI / 2.35, 0, 0.22],
  [Math.PI / 1.75, 0.4, -0.5],
  [Math.PI / 2.9, -0.35, 0.75],
];
const NODES_PER_RING = 8;

/* ============================================================ */

export function JarvisCore3D({ state, quality, reducedMotion }: Props) {
  const { camera, size } = useThree();

  const coreGroup = useRef<THREE.Group>(null);
  const shellRef = useRef<THREE.LineSegments>(null);
  const orbits = [useRef<THREE.Group>(null), useRef<THREE.Group>(null), useRef<THREE.Group>(null)];
  const cageA = useRef<THREE.LineSegments>(null);
  const cageB = useRef<THREE.LineSegments>(null);
  const plasmaRef = useRef<THREE.Mesh>(null);
  const seedRef = useRef<THREE.Mesh>(null);
  const platformRef = useRef<THREE.LineSegments>(null);
  const starsRef = useRef<THREE.Points>(null);
  const scanRef = useRef<THREE.Mesh>(null);
  const arcsRef = useRef<THREE.Group>(null);
  const axisRef = useRef<THREE.Mesh>(null);

  const pointer = useRef({ x: 0, y: 0 });
  const behaviour = useRef({ ...BEHAVIOUR.idle });
  const colorNow = useRef(new THREE.Color(visualStateColors.idle.glow));
  const intensityNow = useRef(visualStateColors.idle.intensity);
  const burst = useRef(0);

  const particleCount = PARTICLES[quality];
  const starCount = STARS[quality];

  const gfx = useMemo(() => {
    const rng = mulberry(20260820);
    const accent = new THREE.Color(visualStateColors.idle.glow);

    /* ---- nucleus assembly ---- */
    const plasmaGeo = new THREE.SphereGeometry(0.5, 48, 48);
    const plasmaMat = new THREE.ShaderMaterial({
      vertexShader: PLASMA_VERT,
      fragmentShader: PLASMA_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 1 },
        uTurbulence: { value: 0.3 },
        uColor: { value: accent.clone() },
        uHot: { value: new THREE.Color(0xbdf4ff) },
      },
    });

    const seedGeo = new THREE.OctahedronGeometry(0.15, 0);
    const seedMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xeafdff),
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false, // innermost core reads through the plasma body
    });

    const cageAGeo = new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.78, 1));
    const cageBGeo = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.66, 0));
    const cageAMat = new THREE.LineBasicMaterial({
      color: accent.clone(), transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const cageBMat = new THREE.LineBasicMaterial({
      color: accent.clone(), transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });

    const shellGeo = new THREE.SphereGeometry(0.94, 48, 48);
    const shellMat = new THREE.ShaderMaterial({
      vertexShader: FRESNEL_VERT,
      fragmentShader: FRESNEL_FRAG,
      uniforms: {
        uColor: { value: accent.clone() },
        uIntensity: { value: 1.5 },
        uPower: { value: 3.2 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    /* ---- vertical energy axis ---- */
    const axisGeo = new THREE.CylinderGeometry(0.007, 0.007, 3.4, 6, 1, true);
    const axisMat = new THREE.MeshBasicMaterial({
      color: accent.clone(), transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });

    /* ---- environment ---- */
    const latLongGeo = latLongGeometry(1.62, 7, 10, 64);
    const latLongMat = new THREE.LineBasicMaterial({
      color: accent.clone(), transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });

    // segmented orbit rings
    const ringGeos = [
      segmentedRingGeometry(RING_RADII[0], 18, 0.62, 6),
      segmentedRingGeometry(RING_RADII[1], 26, 0.5, 5),
      segmentedRingGeometry(RING_RADII[2], 34, 0.42, 4),
    ];
    const ringMats = ringGeos.map((_, i) =>
      new THREE.LineBasicMaterial({
        color: accent.clone(), transparent: true, opacity: 0.85 - i * 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );

    // solid scanning arc riding each ring
    const riderGeos = RING_RADII.map((r, i) =>
      new THREE.TorusGeometry(r, 0.02 - i * 0.004, 8, 72, Math.PI * (0.4 - i * 0.09))
    );
    const riderMats = riderGeos.map((_, i) =>
      new THREE.MeshBasicMaterial({
        color: accent.clone(), transparent: true, opacity: 0.95 - i * 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );

    // instanced data nodes + link lines, one set per ring
    const nodeGeo = new THREE.OctahedronGeometry(0.055, 0);
    const nodeMats = RING_RADII.map(() =>
      new THREE.MeshBasicMaterial({
        color: accent.clone(), transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    const nodeAngles = RING_RADII.map((_, ring) =>
      Array.from({ length: NODES_PER_RING }, (_, i) => (i / NODES_PER_RING) * Math.PI * 2 + rng() * 0.35)
    );
    const linkGeos = RING_RADII.map((r, ring) => {
      const pts: number[] = [];
      const angles = nodeAngles[ring];
      for (let i = 0; i < angles.length; i++) {
        const a = angles[i];
        const b = angles[(i + 1) % angles.length];
        // chord between adjacent nodes — reads as a data link, not a ring
        pts.push(Math.cos(a) * r, Math.sin(a) * r, 0, Math.cos(b) * r, Math.sin(b) * r, 0);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      return g;
    });
    const linkMats = RING_RADII.map(() =>
      new THREE.LineBasicMaterial({
        color: accent.clone(), transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );

    /* ---- particles ---- */
    const pGeo = new THREE.BufferGeometry();
    const dirs = new Float32Array(particleCount * 3);
    const radii = new Float32Array(particleCount);
    const speeds = new Float32Array(particleCount);
    const phases = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; i++) {
      const u = 2 * rng() - 1;
      const th = rng() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      dirs[i * 3] = s * Math.cos(th);
      dirs[i * 3 + 1] = u * 0.62;
      dirs[i * 3 + 2] = s * Math.sin(th);
      radii[i] = 3.4 + rng() * 6.2;
      speeds[i] = 0.045 + rng() * 0.11;
      phases[i] = rng();
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3));
    pGeo.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
    pGeo.setAttribute('aRadius', new THREE.BufferAttribute(radii, 1));
    pGeo.setAttribute('aSpeed', new THREE.BufferAttribute(speeds, 1));
    pGeo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    pGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
    const pMat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: {
        uTime: { value: 0 }, uFlow: { value: 1 }, uCore: { value: 1.85 },
        uSize: { value: 0.6 }, uDpr: { value: 1 }, uSwirl: { value: 0.25 },
        uColor: { value: accent.clone() }, uOpacity: { value: 0.28 },
      },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });

    const platGeo = platformGeometry(1.6, 4.2, 5, 36, 96);
    const platMat = new THREE.LineBasicMaterial({
      color: accent.clone(), transparent: true, opacity: 0.15,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });

    const arcGeos = Array.from({ length: 7 }, () => arcGeometry(1.7, rng));
    const arcMats = arcGeos.map(() =>
      new THREE.LineBasicMaterial({
        color: accent.clone(), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    const arcLines = arcGeos.map((g, i) => new THREE.Line(g, arcMats[i]));

    const scanGeo = new THREE.RingGeometry(1.05, 1.72, 96);
    const scanMat = new THREE.MeshBasicMaterial({
      color: accent.clone(), transparent: true, opacity: 0,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
    });

    const starGeo = new THREE.BufferGeometry();
    const sp = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3().setFromSphericalCoords(
        16 + rng() * 22, Math.acos(2 * rng() - 1), rng() * Math.PI * 2
      );
      sp[i * 3] = v.x; sp[i * 3 + 1] = v.y; sp[i * 3 + 2] = v.z;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0xbfeaf7, size: 0.032, sizeAttenuation: true,
      transparent: true, opacity: 0.42, depthWrite: false,
    });

    return {
      plasmaGeo, plasmaMat, seedGeo, seedMat,
      cageAGeo, cageBGeo, cageAMat, cageBMat,
      shellGeo, shellMat, axisGeo, axisMat,
      latLongGeo, latLongMat,
      ringGeos, ringMats, riderGeos, riderMats,
      nodeGeo, nodeMats, nodeAngles, linkGeos, linkMats,
      pGeo, pMat, platGeo, platMat,
      arcGeos, arcMats, arcLines, scanGeo, scanMat, starGeo, starMat,
    };
  }, [particleCount, starCount]);

  /* every material that follows the state colour */
  const tinted = useMemo(
    () => [
      gfx.cageAMat, gfx.cageBMat, gfx.axisMat, gfx.latLongMat,
      ...gfx.ringMats, ...gfx.riderMats, ...gfx.nodeMats, ...gfx.linkMats,
      gfx.platMat, ...gfx.arcMats, gfx.scanMat,
    ],
    [gfx]
  );

  /* instanced node transforms — set once, animated by the parent group */
  const nodeMeshes = [
    useRef<THREE.InstancedMesh>(null),
    useRef<THREE.InstancedMesh>(null),
    useRef<THREE.InstancedMesh>(null),
  ];
  useEffect(() => {
    const m = new THREE.Matrix4();
    nodeMeshes.forEach((ref, ring) => {
      const im = ref.current;
      if (!im) return;
      gfx.nodeAngles[ring].forEach((a, i) => {
        m.makeTranslation(Math.cos(a) * RING_RADII[ring], Math.sin(a) * RING_RADII[ring], 0);
        im.setMatrixAt(i, m);
      });
      im.instanceMatrix.needsUpdate = true;
    });
  }, [gfx]);

  useEffect(() => {
    return () => {
      const all: (THREE.BufferGeometry | THREE.Material)[] = [
        gfx.plasmaGeo, gfx.plasmaMat, gfx.seedGeo, gfx.seedMat,
        gfx.cageAGeo, gfx.cageBGeo, gfx.cageAMat, gfx.cageBMat,
        gfx.shellGeo, gfx.shellMat, gfx.axisGeo, gfx.axisMat,
        gfx.latLongGeo, gfx.latLongMat,
        ...gfx.ringGeos, ...gfx.ringMats, ...gfx.riderGeos, ...gfx.riderMats,
        gfx.nodeGeo, ...gfx.nodeMats, ...gfx.linkGeos, ...gfx.linkMats,
        gfx.pGeo, gfx.pMat, gfx.platGeo, gfx.platMat,
        ...gfx.arcGeos, ...gfx.arcMats, gfx.scanGeo, gfx.scanMat,
        gfx.starGeo, gfx.starMat,
      ];
      all.forEach((o) => o.dispose());
    };
  }, [gfx]);

  useEffect(() => {
    if (reducedMotion) return;
    const onMove = (e: PointerEvent) => {
      pointer.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [reducedMotion]);

  useEffect(() => { burst.current = 1; }, [state.agentState]);
  // A confirmed command gets its own short pulse.
  useEffect(() => {
    if (state.voice === 'accepted') burst.current = 1;
  }, [state.voice]);

  useEffect(() => {
    gfx.pMat.uniforms.uDpr.value = Math.min(window.devicePixelRatio || 1, 2);
  }, [gfx, size.width, size.height]);

  /* ---------- frame loop ---------- */
  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    const base = BEHAVIOUR[state.agentState];

    // While the agent is idle the core answers to the microphone instead:
    // listening breathes and scans, hearing/processing pulls energy inward.
    // Any real agent state overrides this entirely.
    const v = state.voice;
    const target =
      state.agentState === 'idle' && v && v !== 'idle'
        ? v === 'listening'
          ? { ...base, breathe: 0.055, scan: 0.55, arcs: 0.5, orbit: 0.5, turbulence: 0.5 }
          : v === 'hearing'
            ? { ...base, breathe: 0.085, scan: 0.8, arcs: 0.7, orbit: 0.75, turbulence: 0.9 }
            : v === 'processing'
              ? { ...base, flow: -1, breathe: 0.07, arcs: 0.85, orbit: 1.1, turbulence: 1.2 }
              : v === 'accepted'
                ? { ...base, breathe: 0.11, arcs: 1.0, orbit: 0.9, turbulence: 0.8 }
                : base
        : base;

    const b = behaviour.current;
    const k = 1 - Math.exp(-dt * 2.4);

    b.spin += (target.spin - b.spin) * k;
    b.orbit += (target.orbit - b.orbit) * k;
    b.scan += (target.scan - b.scan) * k;
    b.arcs += (target.arcs - b.arcs) * k;
    b.breathe += (target.breathe - b.breathe) * k;
    b.dist += (target.dist - b.dist) * k;
    b.turbulence += (target.turbulence - b.turbulence) * k;
    b.flow = target.flow;

    const tint = visualStateColors[state.agentState];
    colorNow.current.lerp(new THREE.Color(tint.glow), k);
    intensityNow.current += (tint.intensity - intensityNow.current) * k;

    burst.current = Math.max(0, burst.current - dt * 1.6);
    const flare = burst.current * burst.current;

    const t = performance.now() * 0.001;
    const m = reducedMotion ? 0 : 1;

    tinted.forEach((mat) => {
      const c = (mat as THREE.Material & { color?: THREE.Color }).color;
      if (c) c.copy(colorNow.current);
    });

    /* nucleus */
    const pu = gfx.plasmaMat.uniforms;
    pu.uTime.value = t * m;
    pu.uColor.value.copy(colorNow.current);
    pu.uTurbulence.value = b.turbulence;
    pu.uIntensity.value = 0.5 + intensityNow.current * 0.55 + flare * 0.35;

    gfx.shellMat.uniforms.uColor.value.copy(colorNow.current);
    gfx.shellMat.uniforms.uIntensity.value = 0.32 + intensityNow.current * 0.45 + flare * 0.4;
    gfx.pMat.uniforms.uColor.value.copy(colorNow.current);

    if (plasmaRef.current) {
      const s = 1 + Math.sin(t * 1.7) * b.breathe * m + flare * 0.16;
      plasmaRef.current.scale.setScalar(s);
      plasmaRef.current.rotation.y += dt * b.spin * 0.22 * m;
    }
    if (seedRef.current) {
      const p = 0.85 + Math.sin(t * 4.1) * 0.22 * m;
      seedRef.current.scale.setScalar(p + flare * 0.5);
      seedRef.current.rotation.x += dt * 1.4 * m;
      seedRef.current.rotation.y += dt * 1.9 * m;
      gfx.seedMat.opacity = 0.3 + intensityNow.current * 0.25;
    }
    // cage halves counter-rotate on different axes
    if (cageA.current) {
      cageA.current.rotation.y += dt * b.spin * 0.55 * m;
      cageA.current.rotation.x += dt * b.spin * 0.2 * m;
    }
    if (cageB.current) {
      cageB.current.rotation.y -= dt * b.spin * 0.85 * m;
      cageB.current.rotation.z += dt * b.spin * 0.35 * m;
    }
    gfx.cageAMat.opacity = 0.35 + intensityNow.current * 0.35;
    gfx.cageBMat.opacity = 0.24 + intensityNow.current * 0.3;

    /* particles */
    const qu = gfx.pMat.uniforms;
    qu.uTime.value = t * m;
    qu.uFlow.value = b.flow;
    qu.uSwirl.value = 0.18 + b.orbit * 0.22;
    qu.uOpacity.value = 0.16 + intensityNow.current * 0.3;
    qu.uSize.value = 0.5 + intensityNow.current * 0.4;

    if (shellRef.current) {
      shellRef.current.rotation.y -= dt * b.spin * 0.16 * m;
      shellRef.current.rotation.z += dt * b.spin * 0.05 * m;
      gfx.latLongMat.opacity = 0.16 + intensityNow.current * 0.24;
    }

    if (orbits[0].current) orbits[0].current!.rotation.z += dt * b.orbit * 0.42 * m;
    if (orbits[1].current) {
      orbits[1].current!.rotation.z -= dt * b.orbit * 0.3 * m;
      orbits[1].current!.rotation.x += dt * b.orbit * 0.06 * m;
    }
    if (orbits[2].current) orbits[2].current!.rotation.z += dt * b.orbit * 0.19 * m;

    if (platformRef.current) {
      platformRef.current.rotation.y -= dt * b.orbit * 0.09 * m;
      gfx.platMat.opacity = 0.12 + intensityNow.current * 0.16;
    }
    if (axisRef.current) gfx.axisMat.opacity = (0.06 + intensityNow.current * 0.14) * (0.6 + 0.4 * Math.sin(t * 1.3) * m);
    if (starsRef.current) starsRef.current.rotation.y += dt * 0.005 * m;

    if (scanRef.current) {
      const sweep = (t * 0.34) % 1;
      scanRef.current.position.y = -1.8 + sweep * 3.6;
      const edge = Math.sin(sweep * Math.PI);
      gfx.scanMat.opacity = b.scan * edge * 0.5 * (m || 0.35);
      scanRef.current.scale.setScalar(0.9 + edge * 0.45);
    }

    if (arcsRef.current) {
      gfx.arcMats.forEach((mat, i) => {
        mat.opacity = Math.max(0, Math.sin(t * (0.7 + i * 0.23) + i * 2.1)) * b.arcs * 0.95;
      });
      arcsRef.current.rotation.y += dt * b.spin * 0.1 * m;
    }

    if (coreGroup.current) {
      coreGroup.current.rotation.y += dt * b.spin * 0.06 * m;
      coreGroup.current.position.y = Math.sin(t * 0.5) * 0.05 * m;
    }

    const railPx = size.width >= 1440 ? 640 : size.width >= 1024 ? 576 : 0;
    const centre = Math.max(size.width - railPx, 260);
    const fit = Math.min(Math.max(1000 / centre, 1.0), 1.45);

    const px = pointer.current.x * 0.5 * m;
    const py = pointer.current.y * 0.3 * m;
    camera.position.x += (px - camera.position.x) * (1 - Math.exp(-dt * 2));
    camera.position.y += (-py + 0.35 - camera.position.y) * (1 - Math.exp(-dt * 2));
    camera.position.z += (b.dist * fit - camera.position.z) * (1 - Math.exp(-dt * 1.6));
    camera.lookAt(0, -0.3, 0);
  });

  return (
    <>
      <fog attach="fog" args={[0x04070d, 9, 30]} />

      <points ref={starsRef} geometry={gfx.starGeo} material={gfx.starMat} frustumCulled={false} />
      <lineSegments ref={platformRef} geometry={gfx.platGeo} material={gfx.platMat} position={[0, -2.6, 0]} />
      <mesh ref={axisRef} geometry={gfx.axisGeo} material={gfx.axisMat} />

      <group ref={coreGroup}>
        <lineSegments ref={shellRef} geometry={gfx.latLongGeo} material={gfx.latLongMat} />

        {/* nucleus: plasma body → cage → fresnel shell → seed */}
        <mesh ref={plasmaRef} geometry={gfx.plasmaGeo} material={gfx.plasmaMat} />
        <lineSegments ref={cageA} geometry={gfx.cageAGeo} material={gfx.cageAMat} />
        <lineSegments ref={cageB} geometry={gfx.cageBGeo} material={gfx.cageBMat} />
        <mesh geometry={gfx.shellGeo} material={gfx.shellMat} />
        <mesh ref={seedRef} geometry={gfx.seedGeo} material={gfx.seedMat} renderOrder={3} />

        {/* orbit systems: segmented ring + rider arc + instanced nodes + links */}
        {orbits.map((ref, i) => (
          <group key={i} rotation={RING_TILTS[i]}>
            <group ref={ref}>
              <lineSegments geometry={gfx.ringGeos[i]} material={gfx.ringMats[i]} />
              <lineSegments geometry={gfx.linkGeos[i]} material={gfx.linkMats[i]} />
              <instancedMesh
                ref={nodeMeshes[i]}
                args={[gfx.nodeGeo, gfx.nodeMats[i], NODES_PER_RING]}
              />
              <mesh geometry={gfx.riderGeos[i]} material={gfx.riderMats[i]} />
            </group>
          </group>
        ))}

        <group ref={arcsRef}>
          {gfx.arcLines.map((line, i) => (
            <primitive key={i} object={line} />
          ))}
        </group>

        <mesh ref={scanRef} geometry={gfx.scanGeo} material={gfx.scanMat} rotation={[-Math.PI / 2, 0, 0]} />
      </group>

      <points geometry={gfx.pGeo} material={gfx.pMat} frustumCulled={false} />

      <ambientLight intensity={0.28} color={0x1d4664} />
      <pointLight position={[0, 0, 0]} intensity={2.2} distance={7} color={0x35e0ff} />
      <pointLight position={[3.4, 3.2, 3.6]} intensity={16} distance={20} color={0x63c8f0} />
      <pointLight position={[-5, -2, -3]} intensity={5} distance={18} color={0x0d5f8a} />
    </>
  );
}
