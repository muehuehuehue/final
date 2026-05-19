/**
 * AvatarScene.tsx
 *
 * 3D Avatar powered by React Three Fiber.
 * Features:
 *  - ElevenLabs lip-sync via pre-computed PCM amplitude curve
 *  - Head rotation from MediaPipe face landmarks
 *  - Right-hand finger-curl mimicry from MediaPipe hand landmarks
 *  - Idle breathing + random blink
 *  - Bloom + Vignette + Chromatic Aberration post-processing
 *  - Cinematic lighting (purple/blue key-fill scheme)
 *
 * Avatar GLB requirements (Ready Player Me or compatible):
 *  - Morph targets: jawOpen | mouthOpen | viseme_aa  (for lip sync)
 *  - Morph targets: eyeBlinkLeft | eyeBlink_L        (for blink)
 *  - Bone named "Head" (for head rotation)
 *  - Standard RPM hand bones for finger mimicry (optional, degrades gracefully)
 */

import { useEffect, useRef, Suspense } from 'react';
import type { RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF, Environment, ContactShadows } from '@react-three/drei';
import { EffectComposer, Bloom, Vignette, ChromaticAberration } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import * as THREE from 'three';
import type { LipSyncData, HandState, HeadPose } from '../App';

// ─── Types ────────────────────────────────────────────────────────────────────
interface SceneProps {
  lipSyncRef: RefObject<LipSyncData>;
  handsRef:   RefObject<HandState>;
  headRef:    RefObject<HeadPose>;
  isSpeaking: boolean;
}

// Ready-Player-Me finger bone definitions (right hand)
// Each entry maps a bone name to its MediaPipe landmark indices
const RPM_FINGERS_R = [
  { bone: 'RightHandIndex1',  tip: 8,  mid: 7,  base: 6  },
  { bone: 'RightHandMiddle1', tip: 12, mid: 11, base: 10 },
  { bone: 'RightHandRing1',   tip: 16, mid: 15, base: 14 },
  { bone: 'RightHandPinky1',  tip: 20, mid: 19, base: 18 },
];
const RPM_FINGERS_L = RPM_FINGERS_R.map(f => ({
  ...f, bone: f.bone.replace('Right', 'Left'),
}));

// ─── Scene wrapper (lights + effects) ────────────────────────────────────────
export default function AvatarScene(props: SceneProps) {
  return (
    <>
      {/* Environment & lights */}
      <Environment preset="night" />
      <ambientLight intensity={0.25} />

      {/* Key light — warm purple from front-left */}
      <directionalLight
        position={[2.5, 4, 4]}
        intensity={1.8}
        color="#c084fc"
        castShadow
      />
      {/* Fill light — cool blue from right */}
      <directionalLight
        position={[-3, 2, -1]}
        intensity={0.6}
        color="#60a5fa"
      />
      {/* Rim light — bottom bounce for dramatic look */}
      <pointLight position={[0, -1, 1.5]} intensity={1.2} color="#a855f7" distance={6} />
      {/* Top specular spot */}
      <spotLight
        position={[0, 6, 3]}
        intensity={0.8}
        angle={0.4}
        penumbra={0.8}
        color="#e9d5ff"
      />

      {/* Contact shadow */}
      <ContactShadows
        position={[0, -2.2, 0]}
        opacity={0.35}
        scale={8}
        blur={2.5}
        far={4}
        color="#6d28d9"
      />

      {/* Avatar model */}
      <Suspense fallback={null}>
        <AvatarModel {...props} />
      </Suspense>

      {/* Post-processing */}
      <EffectComposer>
        <Bloom
          intensity={0.9}
          luminanceThreshold={0.55}
          luminanceSmoothing={0.85}
          mipmapBlur
        />
        <Vignette
          offset={0.28}
          darkness={0.65}
          blendFunction={BlendFunction.NORMAL}
        />
        <ChromaticAberration
          offset={new THREE.Vector2(0.0006, 0.0006)}
          blendFunction={BlendFunction.NORMAL}
          radialModulation={false}
          modulationOffset={0}
        />
      </EffectComposer>
    </>
  );
}

// ─── Avatar model ─────────────────────────────────────────────────────────────
function AvatarModel({ lipSyncRef, handsRef, headRef, isSpeaking }: SceneProps) {
  const { scene } = useGLTF('/models/avatar.glb');

  // Bone references
  const headBone  = useRef<THREE.Bone | null>(null);
  const spineBone = useRef<THREE.Bone | null>(null);
  const rHandBone = useRef<THREE.Bone | null>(null);
  const lHandBone = useRef<THREE.Bone | null>(null);
  const rFingers  = useRef<Record<string, THREE.Bone>>({});
  const lFingers  = useRef<Record<string, THREE.Bone>>({});

  // Mesh references for morph targets
  const jawMesh  = useRef<THREE.SkinnedMesh | null>(null);
  const eyeMesh  = useRef<THREE.SkinnedMesh | null>(null);

  // Smoothed animation values
  const sJaw    = useRef(0);
  const sHeadY  = useRef(0);
  const sHeadX  = useRef(0);
  const sHeadZ  = useRef(0);

  // Timers
  const blinkTimer = useRef(4 + Math.random() * 3);

  // ── Walk the scene graph once to cache refs ──────────────────────────────
  useEffect(() => {
    scene.traverse((obj) => {
      if ((obj as THREE.Bone).isBone) {
        const n = obj.name;
        if (/^head$/i.test(n))                                   headBone.current = obj as THREE.Bone;
        if (/spine\b|spine1\b|spine2\b/i.test(n) && !spineBone.current)
                                                                 spineBone.current = obj as THREE.Bone;
        if (/righthand$/i.test(n))                               rHandBone.current = obj as THREE.Bone;
        if (/lefthand$/i.test(n))                                lHandBone.current = obj as THREE.Bone;

        RPM_FINGERS_R.forEach(f => { if (n.includes(f.bone)) rFingers.current[f.bone] = obj as THREE.Bone; });
        RPM_FINGERS_L.forEach(f => { if (n.includes(f.bone)) lFingers.current[f.bone] = obj as THREE.Bone; });
      }

      if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
        const sm = obj as THREE.SkinnedMesh;
        if (sm.morphTargetDictionary) {
          const m = sm.morphTargetDictionary;
          if ('jawOpen' in m || 'mouthOpen' in m || 'viseme_aa' in m || 'mouthSmileLeft' in m) {
            if (!jawMesh.current) jawMesh.current = sm;
          }
          if ('eyeBlinkLeft' in m || 'eyeBlink_L' in m) {
            if (!eyeMesh.current) eyeMesh.current = sm;
          }
        }
      }
    });
  }, [scene]);

  // ── Per-frame update ─────────────────────────────────────────────────────
  useFrame(({ clock }, delta) => {
    const t = clock.getElapsedTime();

    // ──────────────────────────────────────────────────────────────────
    // 1. LIP SYNC
    // ──────────────────────────────────────────────────────────────────
    let targetJaw = 0;
    const ls = lipSyncRef.current;
    if (ls.active && ls.curve.length > 0) {
      const elapsed  = performance.now() / 1000 - ls.startTime;
      const frameIdx = Math.floor(elapsed * 60); // curve baked at 60fps
      if (frameIdx >= 0 && frameIdx < ls.curve.length) {
        targetJaw = ls.curve[frameIdx];
      } else if (frameIdx >= ls.curve.length) {
        ls.active = false;
      }
    }

    // Smooth jaw open
    sJaw.current += (targetJaw - sJaw.current) * 0.28;

    if (jawMesh.current) {
      const d   = jawMesh.current.morphTargetDictionary!;
      const inf = jawMesh.current.morphTargetInfluences!;
      const key = (
        'jawOpen'    in d ? 'jawOpen'    :
        'mouthOpen'  in d ? 'mouthOpen'  :
        'viseme_aa'  in d ? 'viseme_aa'  : null
      );
      if (key !== null) inf[d[key]] = sJaw.current;
    }

    // ──────────────────────────────────────────────────────────────────
    // 2. BLINK
    // ──────────────────────────────────────────────────────────────────
    blinkTimer.current -= delta;
    if (blinkTimer.current <= 0 && eyeMesh.current) {
      blinkTimer.current = 3 + Math.random() * 4;
      triggerBlink(eyeMesh.current);
    }

    // ──────────────────────────────────────────────────────────────────
    // 3. HEAD ROTATION from face landmarks
    // ──────────────────────────────────────────────────────────────────
    if (headBone.current) {
      const { rotX, rotY, rotZ } = headRef.current;

      sHeadY.current += (rotY * 0.6 - sHeadY.current) * 0.07;
      sHeadX.current += (rotX * 0.4 - sHeadX.current) * 0.07;
      sHeadZ.current += (rotZ * 0.3 - sHeadZ.current) * 0.07;

      headBone.current.rotation.y = sHeadY.current + Math.sin(t * 0.25) * 0.008;
      headBone.current.rotation.x = sHeadX.current + Math.cos(t * 0.18) * 0.005;
      headBone.current.rotation.z = sHeadZ.current;
    }

    // ──────────────────────────────────────────────────────────────────
    // 4. BREATHING (spine sway)
    // ──────────────────────────────────────────────────────────────────
    if (spineBone.current) {
      spineBone.current.rotation.x = Math.sin(t * 0.38) * 0.009;
      spineBone.current.rotation.z = Math.sin(t * 0.28) * 0.005;
    }

    // ──────────────────────────────────────────────────────────────────
    // 5. RIGHT HAND MIMICRY
    // ──────────────────────────────────────────────────────────────────
    const rLm = handsRef.current.right;
    if (rLm && rHandBone.current) {
      // Wrist roll
      const wrist = rLm[0], indexMCP = rLm[5], pinkyMCP = rLm[17];
      const rollAngle = Math.atan2(
        pinkyMCP.y - indexMCP.y,
        pinkyMCP.x - indexMCP.x,
      );
      rHandBone.current.rotation.z +=
        (-rollAngle * 0.7 - rHandBone.current.rotation.z) * 0.18;

      // Finger curls
      RPM_FINGERS_R.forEach(({ bone, tip, mid, base }) => {
        const b = rFingers.current[bone];
        if (!b) return;
        const curl = calcFingerCurl(rLm[base], rLm[mid], rLm[tip]);
        b.rotation.z += (curl * 1.4 - b.rotation.z) * 0.22;
      });
    } else if (rHandBone.current) {
      // Return to rest
      rHandBone.current.rotation.z += (0 - rHandBone.current.rotation.z) * 0.06;
    }

    // ──────────────────────────────────────────────────────────────────
    // 6. LEFT HAND MIMICRY
    // ──────────────────────────────────────────────────────────────────
    const lLm = handsRef.current.left;
    if (lLm && lHandBone.current) {
      const rollAngle = Math.atan2(
        lLm[17].y - lLm[5].y,
        lLm[17].x - lLm[5].x,
      );
      lHandBone.current.rotation.z +=
        (rollAngle * 0.7 - lHandBone.current.rotation.z) * 0.18;

      RPM_FINGERS_L.forEach(({ bone, tip, mid, base }) => {
        const b = lFingers.current[bone];
        if (!b) return;
        const curl = calcFingerCurl(lLm[base], lLm[mid], lLm[tip]);
        b.rotation.z += (curl * 1.4 - b.rotation.z) * 0.22;
      });
    } else if (lHandBone.current) {
      lHandBone.current.rotation.z += (0 - lHandBone.current.rotation.z) * 0.06;
    }

    // ──────────────────────────────────────────────────────────────────
    // 7. SUBTLE HOVER FLOAT
    // ──────────────────────────────────────────────────────────────────
    scene.position.y = Math.sin(t * 0.45) * 0.025 - 2.8;
  });

  return (
    <primitive
      object={scene}
      scale={2.8}
      position={[0, -2.8, 0]}
      rotation={[0, 0, 0]}
    />
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Calculate finger curl (0 = fully extended, 1 = fully curled) */
function calcFingerCurl(
  base: { x: number; y: number },
  mid:  { x: number; y: number },
  tip:  { x: number; y: number },
): number {
  const v1 = { x: mid.x - base.x, y: mid.y - base.y };
  const v2 = { x: tip.x - mid.x,  y: tip.y - mid.y  };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const l1  = Math.hypot(v1.x, v1.y);
  const l2  = Math.hypot(v2.x, v2.y);
  if (l1 < 0.0001 || l2 < 0.0001) return 0;
  const angle = Math.acos(Math.max(-1, Math.min(1, dot / (l1 * l2))));
  return 1 - angle / Math.PI; // 0=straight, 1=curled
}

/** Animate a single blink via morph targets */
function triggerBlink(mesh: THREE.SkinnedMesh) {
  const d   = mesh.morphTargetDictionary!;
  const inf = mesh.morphTargetInfluences!;
  const lKey = 'eyeBlinkLeft'  in d ? 'eyeBlinkLeft'  : 'eyeBlink_L' in d ? 'eyeBlink_L' : null;
  const rKey = 'eyeBlinkRight' in d ? 'eyeBlinkRight' : 'eyeBlink_R' in d ? 'eyeBlink_R' : null;
  if (!lKey && !rKey) return;

  let progress = 0;
  const id = setInterval(() => {
    progress += 0.1;
    const val = progress < 0.5 ? progress * 2 : Math.max(0, (1 - progress) * 2);
    if (lKey) inf[d[lKey]] = val;
    if (rKey) inf[d[rKey]] = val;
    if (progress >= 1) clearInterval(id);
  }, 16);
}