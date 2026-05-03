// R3F scene. Orbs in a ring (top level) zoom out as the user enters
// one; the entered orb's sub-orbs fade in above the orchestrator panel.
// A camera-attached cloud overlay parts in a circular clearing in agent
// view; the camera drifts subtly with the mouse in ring view.
//
// One ref `viewT` (0 = ring, 1 = agent) drives every animation: ring
// orb scale, sub-orb visibility, cloud opening, parallax dampening,
// summoner visibility. See ../../orb-shell.html for the prototype.

import { useFrame, useThree, Canvas } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { MutableRefObject, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { Orb } from './api';
import { orbVert, orbFrag } from './orbShader';

// ---------------------------------------------------------------------------
// shared types
// ---------------------------------------------------------------------------

export interface ScreenPos {
  x: number;
  y: number;
}

export interface MousePos {
  /** NDC: x in [-1, 1] (right positive), y in [-1, 1] (up positive). */
  x: number;
  y: number;
}

interface SceneProps {
  orbs: Orb[];
  currentOrbId: string | null;
  /** True while we're zoomed into an orb. Drives viewT toward 1. */
  inAgentView: boolean;
  mouseRef: MutableRefObject<MousePos>;
  /** Shared from App. ViewTLerp writes here every frame; SuborbWindow
   *  (and other DOM overlays) read from it to fade in/out with the
   *  ring-↔-agent transition. */
  viewTRef: MutableRefObject<number>;
  /** Shared from App. OrbMesh writes its current screen position here
   *  every frame. Keys are orb ids. SuborbWindow reads its root's
   *  position from here to position itself in the top-left of the
   *  root orb in ring view. */
  orbScreenPosRef: MutableRefObject<Map<string, ScreenPos>>;
  /** Click on a normal orb. screenPos is the orb's pixel position so
   *  the panel can grow out of it. */
  onSelect: (orb: Orb, screenPos: ScreenPos) => void;
  /** Click on the center summoner. Spawns a new root orb. */
  onSummon: () => void;
  /** User clicked to delete an orb (right-click). */
  onDelete: (id: string) => void;
}

type OrbRole = 'root' | 'sub-of-current' | 'hidden';

// ---------------------------------------------------------------------------
// math
// ---------------------------------------------------------------------------

const ORB_RADIUS = 0.55;
// Ring radius for the main-menu orb layout. We cap the radius at
// RING_MAX_R: as N grows past 6 we stop pushing orbs further out and
// instead let the chord between them shrink (still enough room since
// ORB_RADIUS=0.55 means diameter 1.1, well under the chord even at N=12).
const RING_BASE_R = 2.8;
const RING_MAX_R = 3.0;
const RING_BASE_CHORD = 2 * RING_BASE_R * Math.sin(Math.PI / 6);
// Suborbs sit just above the orchestrator panel — close enough that
// they feel attached to the chat, far enough not to overlap.
const SUB_ORB_ROW_Y = 2.3;
const SUB_ORB_SPACING = 1.55;
const SUB_ORB_SCALE = 1.0;

/** Ring radius for n orbs. Capped at RING_MAX_R so the ring stays
 *  on-screen even as N grows past 6 — beyond the cap the chord between
 *  adjacent orbs shrinks instead of the radius growing. */
function ringRadius(n: number): number {
  const computed = RING_BASE_CHORD / (2 * Math.sin(Math.PI / Math.max(n, 2)));
  return Math.min(computed, RING_MAX_R);
}

/** Position of orb i out of n on the ring. i=0 is at the top; subsequent
 *  orbs go clockwise. For odd n we get a triangle/pentagon pointing up
 *  (one orb at top), not down. */
function ringPos(i: number, n: number): [number, number, number] {
  const a = Math.PI / 2 - (i / n) * Math.PI * 2;
  const r = ringRadius(n);
  return [Math.cos(a) * r, Math.sin(a) * r, 0];
}

function slotPos(slot: number): [number, number, number] {
  return [slot * SUB_ORB_SPACING, SUB_ORB_ROW_Y, 0.5];
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const PURPLE = new THREE.Color(0xa78bfa);
const WHITE = new THREE.Color(0xffffff);
const RED = new THREE.Color(0xff6b6b);

function targetColor(orb: Orb): THREE.Color {
  if (orb.status === 'working') return PURPLE;
  if (orb.status === 'failed') return RED;
  return WHITE;
}

/** Visibility target [0, 1] given an orb's role and the current viewT. */
function visibilityFor(role: OrbRole, viewT: number): number {
  if (role === 'root') return 1 - smoothstep(0.05, 0.6, viewT);
  if (role === 'sub-of-current') return smoothstep(0.4, 0.95, viewT);
  return 0;
}

// ---------------------------------------------------------------------------
// view-state lerper
// ---------------------------------------------------------------------------

function ViewTLerp({
  inAgentView,
  viewT,
  exposedViewT,
}: {
  inAgentView: boolean;
  viewT: MutableRefObject<number>;
  /** App-owned mirror so DOM overlays outside the Canvas can read viewT. */
  exposedViewT?: MutableRefObject<number>;
}) {
  useFrame((_, dt) => {
    const target = inAgentView ? 1 : 0;
    const rate = inAgentView ? 4 : 9;
    viewT.current += (target - viewT.current) * Math.min(1, dt * rate);
    if (exposedViewT) exposedViewT.current = viewT.current;
  });
  return null;
}

// ---------------------------------------------------------------------------
// camera parallax
// ---------------------------------------------------------------------------

function CameraParallax({
  viewT,
  mouseRef,
}: {
  viewT: MutableRefObject<number>;
  mouseRef: MutableRefObject<MousePos>;
}) {
  const { camera } = useThree();
  useFrame(() => {
    const parallaxMod = 1 - viewT.current;
    const tx = mouseRef.current.x * 0.25 * parallaxMod;
    const ty = mouseRef.current.y * 0.15 * parallaxMod;
    camera.position.x += (tx - camera.position.x) * 0.02;
    camera.position.y += (ty - camera.position.y) * 0.02;
    camera.lookAt(0, 0, 0);
  });
  return null;
}

// ---------------------------------------------------------------------------
// cloud overlay
// ---------------------------------------------------------------------------

const cloudVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const cloudFrag = /* glsl */ `
  uniform float uTime;
  uniform vec2 uRes;
  uniform float uViewState;
  varying vec2 vUv;

  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1, 0));
    float c = hash21(i + vec2(0, 1));
    float d = hash21(i + vec2(1, 1));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 5; i++) {
      v += a * vnoise(p);
      p = rot * p * 2.0;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = vUv;
    uv.x *= uRes.x / uRes.y;
    vec2 p = uv * 2.4;
    float c1 = fbm(p + vec2(uTime * 0.025, uTime * 0.012));
    float c2 = fbm(p * 1.7 + vec2(-uTime * 0.018, uTime * 0.030));
    float c3 = fbm(p * 4.5 - vec2(uTime * 0.04, uTime * 0.015));
    float density = c1 * 0.6 + c2 * 0.3 + c3 * 0.1;
    density = pow(density, 1.4);
    float wisp = smoothstep(0.55, 0.95, c2) * 0.22;
    float alpha = clamp(density * 1.15, 0.0, 0.94);
    float edge = smoothstep(1.0, 0.55, length(vUv - 0.5));
    alpha *= mix(0.85, 1.0, edge);
    float d = length(vUv - vec2(0.5, 0.55));
    float centerMask = 1.0 - smoothstep(0.18, 0.65, d);
    alpha *= mix(1.0, max(0.06, 1.0 - centerMask * 0.95), uViewState);
    gl_FragColor = vec4(vec3(wisp), alpha);
  }
`;

function CloudOverlay({ viewT }: { viewT: MutableRefObject<number> }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const { camera, size } = useThree();

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uViewState: { value: 0 },
    }),
    [],
  );

  useFrame((state) => {
    const m = meshRef.current;
    const mat = matRef.current;
    if (!m || !mat) return;

    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    m.position.copy(camera.position).addScaledVector(forward, 2);
    m.quaternion.copy(camera.quaternion);

    mat.uniforms.uTime.value = state.clock.elapsedTime;
    mat.uniforms.uRes.value.set(size.width, size.height);
    mat.uniforms.uViewState.value = smoothstep(0.05, 0.85, viewT.current);
  });

  return (
    <mesh ref={meshRef} renderOrder={999}>
      <planeGeometry args={[20, 20]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={cloudVert}
        fragmentShader={cloudFrag}
        uniforms={uniforms}
        transparent
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// summoner — wavy white orb at origin. Click to spawn a new root orb.
// Shares the orb fragment shader (same fresnel + haze), but adds a
// vertex-displacement pass driven by FBM-ish noise so the surface
// breathes/wobbles like a slow flame.
// ---------------------------------------------------------------------------

const summonerVert = /* glsl */ `
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vLocal;
  uniform float uTime;
  uniform float uExcite;

  float hashV(vec3 p) {
    p = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }
  float noiseV(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hashV(i + vec3(0,0,0)), hashV(i + vec3(1,0,0)), f.x),
          mix(hashV(i + vec3(0,1,0)), hashV(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hashV(i + vec3(0,0,1)), hashV(i + vec3(1,0,1)), f.x),
          mix(hashV(i + vec3(0,1,1)), hashV(i + vec3(1,1,1)), f.x), f.y),
      f.z
    );
  }

  void main() {
    float t = uTime * 1.4;
    float n1 = noiseV(position * 2.0 + vec3(t, t * 1.3, t * 0.7));
    float n2 = noiseV(position * 4.5 - vec3(t * 1.7, t, t * 0.9));
    float n3 = noiseV(position * 9.0 + vec3(t * 2.1, t * 1.6, t));
    float disp = ((n1 * 0.55 + n2 * 0.30 + n3 * 0.15) - 0.5) * (0.55 + uExcite * 0.4);
    vec3 pos = position + normal * disp;
    vLocal = pos;
    vN = normalize(normalMatrix * normal);
    vec4 wp = modelMatrix * vec4(pos, 1.0);
    vView = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

interface SummonerProps {
  viewT: MutableRefObject<number>;
  onSummon: () => void;
}

function Summoner({ viewT, onSummon }: SummonerProps) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const groupRef = useRef<THREE.Group>(null);
  const visScale = useRef(0);
  const exciteRef = useRef(0); // bumps on click for a "pop"
  // Manual time accumulator — independent of performance.now()/clock
  // resets so the noise animation never freezes after a phase change.
  const timeRef = useRef(0);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uIntensity: { value: 1.4 },
      uColor: { value: new THREE.Color(0xffffff) },
      // uChaos always lit — produces the sharp strobing edge highlights
      // that read as the crystalline bright lines from the reference.
      uChaos: { value: 1.0 },
      uExcite: { value: 0 },
    }),
    [],
  );

  useFrame((_, dt) => {
    if (!groupRef.current || !matRef.current) return;
    timeRef.current += dt;
    const t = timeRef.current;

    const u = matRef.current.uniforms;
    u.uTime.value = t;
    u.uIntensity.value = 1.0 + 0.25 * Math.sin(t * 2.2) + 0.15 * Math.sin(t * 4.7) + exciteRef.current * 1.4;
    u.uChaos.value = 1.0 + exciteRef.current * 0.5;
    u.uExcite.value = exciteRef.current;
    exciteRef.current += (0 - exciteRef.current) * Math.min(1, dt * 3);

    // visible only in ring view, slight vertical stretch for flame feel
    const baseScale = 1 - smoothstep(0.05, 0.6, viewT.current);
    visScale.current += (baseScale - visScale.current) * Math.min(1, dt * 7);
    const s = Math.max(0, visScale.current);
    groupRef.current.scale.set(s, s * 1.15, s);
  });

  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          exciteRef.current = 1.0;
          onSummon();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = '';
        }}
      >
        <sphereGeometry args={[ORB_RADIUS * 1.3, 96, 96]} />
        <shaderMaterial
          ref={matRef}
          vertexShader={summonerVert}
          fragmentShader={orbFrag}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// per-orb mesh
// ---------------------------------------------------------------------------

interface OrbMeshProps {
  orb: Orb;
  position: [number, number, number];
  role: OrbRole;
  viewT: MutableRefObject<number>;
  /** App-owned map; OrbMesh writes its current screen position here so
   *  DOM overlays (suborb windows) can find a root orb's pixel pos. */
  orbScreenPosRef: MutableRefObject<Map<string, ScreenPos>>;
  onSelect: (orb: Orb, screenPos: ScreenPos) => void;
  onDelete: (id: string) => void;
}

function OrbMesh({
  orb,
  position,
  role,
  viewT,
  orbScreenPosRef,
  onSelect,
  onDelete,
}: OrbMeshProps) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const groupRef = useRef<THREE.Group>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const targetPos = useRef(new THREE.Vector3(...position));
  const phase = useMemo(() => Math.random() * Math.PI * 2, []);
  const visScale = useRef(0);
  const { camera, size } = useThree();

  // clean up the screen-pos map entry on unmount so stale ids don't
  // leak (would otherwise confuse DOM overlays anchored to this orb)
  useEffect(() => {
    const id = orb.id;
    return () => {
      orbScreenPosRef.current.delete(id);
    };
  }, [orb.id, orbScreenPosRef]);

  // keep the target in sync as `position` changes (ring repositions when
  // N changes; sub-orbs slot row when current orb changes)
  targetPos.current.set(position[0], position[1], position[2]);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uIntensity: { value: 1.0 },
      uColor: { value: new THREE.Color(0xffffff) },
      uChaos: { value: 0.0 },
    }),
    [],
  );

  useFrame((_state, dt) => {
    if (!groupRef.current || !matRef.current) return;
    const t = performance.now() / 1000;

    // bob + lerp toward target position. Initial group.position is (0,0,0)
    // (set in JSX below) so newly-spawned orbs animate out from origin
    // toward their ring slot.
    const bx = Math.sin(t * 0.5 + phase) * 0.05;
    const by = Math.cos(t * 0.6 + phase) * 0.07;
    const k = Math.min(1, dt * 4);
    const p = groupRef.current.position;
    p.x += (targetPos.current.x + bx - p.x) * k;
    p.y += (targetPos.current.y + by - p.y) * k;
    p.z += (targetPos.current.z - p.z) * k;

    // shader uniforms
    const u = matRef.current.uniforms;
    u.uTime.value = t;
    u.uColor.value.lerp(targetColor(orb), Math.min(1, dt * 5));

    let targetChaos = 0;
    let baseI = 1.0;
    if (orb.status === 'working') {
      targetChaos = 1.0;
      const shimmer = 1.2 + 0.4 * Math.sin(t * 3.1 + phase);
      const spike = Math.pow(Math.random(), 7) * 4.0;
      baseI = shimmer + spike;
    } else if (orb.status === 'failed') {
      targetChaos = 0.4;
      baseI = 0.9;
    } else {
      baseI = 1.0 + Math.sin(t + phase) * 0.1;
    }
    u.uChaos.value += (targetChaos - u.uChaos.value) * Math.min(1, dt * 4);
    u.uIntensity.value += (baseI - u.uIntensity.value) * 0.18;

    // visibility — read viewT live every frame, lerp visScale toward
    // the role-derived target. Faster lerp when growing (returning to
    // ring view) than when shrinking, so coming back feels snappy.
    // Suborbs render larger via SUB_ORB_SCALE so they're noticeable
    // above the orchestrator panel.
    const target = visibilityFor(role, viewT.current);
    const rate = target > visScale.current ? 12 : 7;
    visScale.current += (target - visScale.current) * Math.min(1, dt * rate);
    const sizeMult = role === 'sub-of-current' ? SUB_ORB_SCALE : 1.0;
    groupRef.current.scale.setScalar(Math.max(0, visScale.current * sizeMult));

    // Publish current screen position so DOM overlays can anchor to
    // this orb (e.g. pinned suborb windows position themselves at the
    // top-left of their root orb's screen pos).
    const v = groupRef.current.position.clone().project(camera);
    const sx = (v.x + 1) * 0.5 * size.width;
    const sy = (-v.y + 1) * 0.5 * size.height;
    orbScreenPosRef.current.set(orb.id, { x: sx, y: sy });

    // drive label opacity from visScale so DOM labels don't outlive
    // their (now invisible) orb (drei <Html> portals to the DOM, so
    // scaling the parent group does NOT scale the label).
    if (labelRef.current) {
      labelRef.current.style.opacity = String(visScale.current);
    }
  });

  const labelClass = orb.status === 'working' ? 'orb-label working' : 'orb-label';

  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          if (!groupRef.current) return;
          const v = groupRef.current.position.clone().project(camera);
          const sx = (v.x + 1) * 0.5 * size.width;
          const sy = (-v.y + 1) * 0.5 * size.height;
          onSelect(orb, { x: sx, y: sy });
        }}
        onContextMenu={(e) => {
          // right-click → delete
          e.stopPropagation();
          (e.nativeEvent as MouseEvent).preventDefault?.();
          onDelete(orb.id);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          document.body.style.cursor = '';
        }}
      >
        <sphereGeometry args={[ORB_RADIUS, 64, 64]} />
        <shaderMaterial
          ref={matRef}
          vertexShader={orbVert}
          fragmentShader={orbFrag}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <Html center distanceFactor={9} position={[0, 0, 0]} pointerEvents="none">
        <div className="orb-label-stack" ref={labelRef}>
          {orb.display_name && (
            <div className={labelClass}>{orb.display_name}</div>
          )}
        </div>
      </Html>
    </group>
  );
}

// ---------------------------------------------------------------------------
// scene composition
// ---------------------------------------------------------------------------

function ScenePosLayout({
  orbs,
  currentOrbId,
  viewT,
  orbScreenPosRef,
  onSelect,
  onSummon,
  onDelete,
}: {
  orbs: Orb[];
  currentOrbId: string | null;
  viewT: MutableRefObject<number>;
  orbScreenPosRef: MutableRefObject<Map<string, ScreenPos>>;
  onSelect: (orb: Orb, screenPos: ScreenPos) => void;
  onSummon: () => void;
  onDelete: (id: string) => void;
}) {
  const roots = orbs.filter((o) => o.parent_id === null);
  const subOrbs = currentOrbId
    ? orbs.filter((o) => o.parent_id === currentOrbId)
    : [];

  return (
    <>
      <Summoner viewT={viewT} onSummon={onSummon} />
      {roots.map((o, i) => (
        <OrbMesh
          key={o.id}
          orb={o}
          position={ringPos(i, Math.max(roots.length, 1))}
          role="root"
          viewT={viewT}
          orbScreenPosRef={orbScreenPosRef}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
      {subOrbs.map((o, i) => {
        const order = [0, -1, 1, -2, 2, -3, 3, -4, 4];
        const slot = order[i] ?? i - 4;
        return (
          <OrbMesh
            key={o.id}
            orb={o}
            position={slotPos(slot)}
            role="sub-of-current"
            viewT={viewT}
            orbScreenPosRef={orbScreenPosRef}
            onSelect={onSelect}
            onDelete={onDelete}
          />
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// public scene
// ---------------------------------------------------------------------------

export function Scene({
  orbs,
  currentOrbId,
  inAgentView,
  mouseRef,
  viewTRef,
  orbScreenPosRef,
  onSelect,
  onSummon,
  onDelete,
}: SceneProps) {
  // Internal viewT ref written each frame by ViewTLerp; mirrored to
  // App's viewTRef so DOM overlays outside the Canvas can read it.
  const viewT = useRef(0);

  return (
    <Canvas
      gl={{ antialias: true, alpha: false }}
      camera={{ position: [0, 0, 9], fov: 45, near: 0.1, far: 100 }}
      style={{ position: 'fixed', inset: 0, background: '#000' }}
    >
      <ViewTLerp inAgentView={inAgentView} viewT={viewT} exposedViewT={viewTRef} />
      <CameraParallax viewT={viewT} mouseRef={mouseRef} />
      <CloudOverlay viewT={viewT} />
      <ScenePosLayout
        orbs={orbs}
        currentOrbId={currentOrbId}
        viewT={viewT}
        orbScreenPosRef={orbScreenPosRef}
        onSelect={onSelect}
        onSummon={onSummon}
        onDelete={onDelete}
      />
    </Canvas>
  );
}
