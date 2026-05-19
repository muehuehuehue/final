import React, { useRef, useState, useCallback, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { motion, AnimatePresence } from 'framer-motion';
import { gsap } from 'gsap';
import {
  FaceLandmarker, HandLandmarker, FilesetResolver,
  DrawingUtils, FaceLandmarkerResult, HandLandmarkerResult,
} from '@mediapipe/tasks-vision';
import {
  Mic, MicOff, Camera, CameraOff, Send, Activity,
  Sparkles, Zap, Volume2, ChevronRight,
} from 'lucide-react';
 interface ImportMetaEnv {
  readonly VITE_GROQ_API_KEY?: string;
  readonly VITE_ELEVENLABS_API_KEY?: string;
  readonly VITE_ELEVENLABS_VOICE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMeta;
}
declare global {
  interface Window {
    webkitSpeechRecognition: any;
    SpeechRecognition: any;
  }
}
// ─── Types ────────────────────────────────────────────────────────────────────
export interface Landmark { x: number; y: number; z: number; }
export interface LipSyncData { curve: number[]; startTime: number; active: boolean; }
export interface HandState { left: Landmark[] | null; right: Landmark[] | null; }
export interface HeadPose { rotX: number; rotY: number; rotZ: number; }
interface Message { id: string; role: 'user' | 'assistant'; content: string; ts: number; }

interface AvatarSceneProps {
  lipSyncRef: React.RefObject<LipSyncData>;
  handsRef: React.RefObject<HandState>;
  headRef: React.RefObject<HeadPose>;
  isSpeaking: boolean;
}

import { useLoader } from '@react-three/fiber';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMUtils, VRMLoaderPlugin } from '@pixiv/three-vrm';

function AvatarScene({ headRef, lipSyncRef }: AvatarSceneProps) {
  const vrmRef = useRef<any>(null);

  const gltf = useLoader(
    GLTFLoader,
    '/public/avatar.vrm',
    (loader: any) => {
      loader.register((parser: any) => {
        return new VRMLoaderPlugin(parser);
      });
    }
  );

  useEffect(() => {
    const vrm = gltf.userData.vrm;

    if (!vrm) return;

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.removeUnnecessaryJoints(gltf.scene);

    vrm.scene.rotation.y = Math.PI;
    vrm.scene.position.y = -1.1;

    vrmRef.current = vrm;
  }, [gltf]);

  useFrame((state, delta) => {
    const vrm = vrmRef.current;

    if (!vrm) return;

    vrm.update(delta);

    // HEAD MOVEMENT
    const neck = vrm.humanoid?.getNormalizedBoneNode('neck');
    const spine = vrm.humanoid?.getNormalizedBoneNode('spine');

    if (neck && headRef.current) {
      neck.rotation.x = headRef.current.rotX;
      neck.rotation.y = headRef.current.rotY;
      neck.rotation.z = headRef.current.rotZ;
    }

    if (spine && headRef.current) {
      spine.rotation.y = headRef.current.rotY * 0.3;
    }

    // IDLE BREATHING
    vrm.scene.position.y =
      -1.1 + Math.sin(state.clock.elapsedTime * 2) * 0.02;

    // LIP SYNC
    const expressionManager = vrm.expressionManager;

    if (expressionManager) {
      const lip = lipSyncRef.current;

      if (lip.active) {
        const elapsed =
          performance.now() / 1000 - lip.startTime;

        const frame = Math.floor(elapsed * 60);

        const value = lip.curve[frame] ?? 0;

        // try multiple visemes
        expressionManager.setValue('aa', value);
        expressionManager.setValue('oh', value * 0.5);
      } else {
        expressionManager.setValue('aa', 0);
        expressionManager.setValue('oh', 0);
      }
    }
  });

  if (!vrmRef.current) return null;

  return <primitive object={vrmRef.current.scene} />;
}
// ─── API Config ───────────────────────────────────────────────────────────────
// Paste your keys in .env.local:
//   VITE_GROQ_API_KEY=gsk_…
//   VITE_ELEVENLABS_API_KEY=sk_…
//   VITE_ELEVENLABS_VOICE_ID=91NkGjnnbyDfe6W3HV6M  (or your voice ID)
const GROQ_KEY    = (import.meta as any).env.VITE_GROQ_API_KEY       ?? '';
const ELEVEN_KEY  = (import.meta as any).env.VITE_ELEVENLABS_API_KEY  ?? '';
console.log('ELEVEN KEY:', ELEVEN_KEY);
const ELEVEN_VID = import.meta.env.VITE_ELEVENLABS_VOICE_ID;

const SYSTEM_PROMPT =
  `You are NIRVANA, a sleek old female AI assistant rendered as a 3D holographic avatar.
  Respond in 1-2 concise sentences only. Be helpful, generous, savage, knowledgeable, and caring in tone. No markdown, no lists.`;

// ─── Gesture Classification ───────────────────────────────────────────────────
function dist2D(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function classifyGesture(lm: Landmark[]): string {
  if (!lm || lm.length < 21) return 'None';
  const w = lm[0];
  const tTip = lm[4],  tIP   = lm[3];
  const iTip = lm[8],  iMCP  = lm[5];
  const mTip = lm[12], mMCP  = lm[9];
  const rTip = lm[16], rMCP  = lm[13];
  const pTip = lm[20], pMCP  = lm[17];

  const ext = (tip: Landmark, base: Landmark) =>
    dist2D(w, tip) > dist2D(w, base) * 1.30;

  const tExt = dist2D(w, tTip) > dist2D(w, tIP) * 1.15;
  const iExt = ext(iTip, iMCP);
  const mExt = ext(mTip, mMCP);
  const rExt = ext(rTip, rMCP);
  const pExt = ext(pTip, pMCP);

  // ── OK Sign: thumb + index pinch, middle/ring/pinky extended
  if (dist2D(tTip, iTip) < 0.052 && mExt && rExt && pExt) return 'OK Sign';

  // ── Open Palm: all 5 extended AND spread (inter-finger distance check)
  const spread = dist2D(iTip, mTip) > 0.038 && dist2D(mTip, rTip) > 0.038;
  if (tExt && iExt && mExt && rExt && pExt && spread) return 'Open Palm';

  // ── Fist
  if (!iExt && !mExt && !rExt && !pExt) return 'Fist';

  // ── Point
  if (iExt && !mExt && !rExt && !pExt) return 'Point';

  // ── Peace
  if (iExt && mExt && !rExt && !pExt) return 'Peace';

  return 'None';
}

// ─── Head Pose from Face Landmarks ───────────────────────────────────────────
function estimateHeadPose(lm: Landmark[]): HeadPose {
  if (!lm || lm.length < 468) return { rotX: 0, rotY: 0, rotZ: 0 };
  const nose = lm[1];
  const leftEye  = lm[33];
  const rightEye = lm[263];
  const rotY = (nose.x - 0.5) * Math.PI * 0.55;
  const rotX = (nose.y - 0.5) * Math.PI * 0.35;
  const rotZ = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * 0.5;
  return { rotX, rotY, rotZ };
}

// ─── Lip-Sync Curve from PCM ──────────────────────────────────────────────────
async function buildLipSyncCurve(buffer: AudioBuffer): Promise<number[]> {
  const data   = buffer.getChannelData(0);
  const fps    = 60;
  const spf    = Math.floor(buffer.sampleRate / fps);
  const curve: number[] = [];
  for (let i = 0; i < data.length; i += spf) {
    let sum = 0;
    const end = Math.min(i + spf, data.length);
    for (let j = i; j < end; j++) sum += data[j] * data[j];
    curve.push(Math.min(1, Math.sqrt(sum / (end - i)) * 12));
  }
  return curve;
}

// ─── Gesture accent colors ────────────────────────────────────────────────────
const GESTURE_COLOR: Record<string, string> = {
  'OK Sign':   '#10b981',
  'Open Palm': '#3b82f6',
  'Fist':      '#ef4444',
  'Point':     '#f59e0b',
  'Peace':     '#a855f7',
  'None':      'rgba(255,255,255,0.15)',
};

// ─────────────────────────────────────────────────────────────────────────────
export default function App() {

  // ── Refs ──────────────────────────────────────────────────────────────────
  const videoRef      = useRef<HTMLVideoElement>(null);
  const pipRef        = useRef<HTMLCanvasElement>(null);
  const audioCtxRef   = useRef<AudioContext | null>(null);
  const recogRef = useRef<any>(null);
  const headerRef     = useRef<HTMLDivElement>(null);
  const chatEndRef    = useRef<HTMLDivElement>(null);
  const faceLMRef     = useRef<FaceLandmarker | null>(null);
  const handLMRef     = useRef<HandLandmarker | null>(null);
  const rafRef        = useRef<number | null>(null);
  const isCamRef      = useRef(false);
  const smoothHandRef = useRef<Map<string, Landmark[]>>(new Map());
  const isThinkRef    = useRef(false);   // avoid double-sends

  // Shared performance refs (no re-render cost)
  const lipSyncRef = useRef<LipSyncData>({ curve: [], startTime: 0, active: false });
  const handsRef   = useRef<HandState>({ left: null, right: null });
  const headRef    = useRef<HeadPose>({ rotX: 0, rotY: 0, rotZ: 0 });

  // ── State ─────────────────────────────────────────────────────────────────
  const [modelsReady, setModelsReady] = useState(false);
  const [cameraOn, setCameraOn]       = useState(false);
  const [cameraErr, setCameraErr]     = useState<string | null>(null);
  const [gestures, setGestures]       = useState({ left: 'None', right: 'None' });
  const [messages, setMessages]       = useState<Message[]>([]);
  const [input, setInput]             = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking]   = useState(false);
  const [isThinking, setIsThinking]   = useState(false);
  const [chatOpen, setChatOpen]       = useState(true);
  const [convHistory, setConvHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);

  // ── GSAP entrance ─────────────────────────────────────────────────────────
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.from(headerRef.current, {
        y: -50, opacity: 0, duration: 1.4, ease: 'expo.out', delay: 0.1,
      });
      gsap.from('.ambient-orb', {
        scale: 0.7, opacity: 0, duration: 2.5, ease: 'expo.out', delay: 0.4, stagger: 0.2,
      });
    });
    return () => ctx.revert();
  }, []);

  // ── Auto-scroll chat ───────────────────────────────────────────────────────
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isThinking]);

  // ── MediaPipe init ─────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const fs = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm',
        );
        faceLMRef.current = await FaceLandmarker.createFromOptions(fs, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
            delegate: 'GPU',
          },
          outputFaceBlendshapes: false,
          runningMode: 'VIDEO',
          numFaces: 1,
        });
        handLMRef.current = await HandLandmarker.createFromOptions(fs, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.62,
          minHandPresenceConfidence: 0.62,
          minTrackingConfidence: 0.62,
        });
        if (alive) setModelsReady(true);
      } catch (err) {
        console.warn('MediaPipe init error:', err);
        if (alive) setModelsReady(true); // proceed anyway
      }
    })();
    return () => { alive = false; };
  }, []);

  // ── Speech Recognition ─────────────────────────────────────────────────────
  useEffect(() => {
  const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  if (!SR) return;
  const r = new SR();
  r.continuous = false;
  r.interimResults = true;
  r.lang = 'en-US';
  r.onresult = (e: any) => {
    const text = Array.from(e.results as any[])
      .map((res: any) => res[0].transcript)
      .join('');
    setInput(text);
    if (e.results[e.results.length - 1].isFinal && text.trim()) {
      setIsListening(false);
      sendMessage(text.trim());
    }
  };
  r.onend = () => setIsListening(false);
  r.onerror = () => setIsListening(false);
  recogRef.current = r;
}, []);

  // ── Groq API call ──────────────────────────────────────────────────────────
  const callGroq = async (userMsg: string): Promise<string> => {
    if (!GROQ_KEY) {
      return 'Add VITE_GROQ_API_KEY to your .env.local to enable AI responses.';
    }
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...convHistory,
          { role: 'user', content: userMsg },
        ],
        max_tokens: 100,
        temperature: 0.72,
      }),
    });
    if (!resp.ok) throw new Error(`Groq ${resp.status}`);
    const data = await resp.json();
    return (data.choices[0].message.content as string).trim();
  };

  // ── ElevenLabs TTS + lip-sync ──────────────────────────────────────────────
  const speak = useCallback(async (text: string) => {
    if (!ELEVEN_KEY) return;
    setIsSpeaking(true);
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VID}?output_format=mp3_22050_32`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': ELEVEN_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_turbo_v2_5',      // fastest ElevenLabs model
            voice_settings: { stability: 0.48, similarity_boost: 0.78, speed: 1.0 },
          }),
        },
      );
      if (!res.ok) throw new Error('ElevenLabs error');

      const arrayBuffer = await res.arrayBuffer();
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AudioContext();
      }
      const actx = audioCtxRef.current;
      if (actx.state === 'suspended') await actx.resume();

      const audioBuffer = await actx.decodeAudioData(arrayBuffer.slice(0));
      const curve       = await buildLipSyncCurve(audioBuffer);
      const src = actx.createBufferSource();
      src.buffer = audioBuffer;
      
      const gainNode = actx.createGain();
      gainNode.gain.value = 1.5;

      src.connect(gainNode);
      gainNode.connect(actx.destination);

      console.log('Audio context state:', actx.state);
      console.log('Audio duration:', audioBuffer.duration);
      console.log('Speaking:', text);

      // Store start time BEFORE source.start() for accurate sync
      const wallStart = performance.now() / 1000;
      lipSyncRef.current = { curve, startTime: wallStart, active: true };
      src.start(0);
      console.log("Audio Started");

      src.onended = () => {
        lipSyncRef.current.active = false;
        setIsSpeaking(false);
      };
    } catch (err) {
      console.error('TTS error:', err);
      setIsSpeaking(false);
    }
  }, []);

  // ── Send message ───────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean || isThinkRef.current) return;
    isThinkRef.current = true;
    setInput('');

    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', content: clean, ts: Date.now() };
    setMessages(m => [...m, userMsg]);
    setIsThinking(true);

    try {
      const reply     = await callGroq(clean);
      const assistMsg: Message = { id: `a-${Date.now()}`, role: 'assistant', content: reply, ts: Date.now() };
      setMessages(m => [...m, assistMsg]);
      setConvHistory(h => [...h.slice(-8), { role: 'user', content: clean }, { role: 'assistant', content: reply }]);

      gsap.fromTo(`[data-msgid="${assistMsg.id}"]`,
        { x: -16, opacity: 0 },
        { x: 0, opacity: 1, duration: 0.45, ease: 'expo.out' },
      );

      await speak(reply);
    } catch (err) {
      console.error(err);
      setMessages(m => [...m, {
        id: `e-${Date.now()}`, role: 'assistant',
        content: 'Something went wrong. Please try again.',
        ts: Date.now(),
      }]);
    } finally {
      setIsThinking(false);
      isThinkRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speak, convHistory]);

  // ── Camera start/stop ──────────────────────────────────────────────────────
  const startCamera = async () => {
    setCameraErr(null);
    const vid = videoRef.current;
    if (!vid) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
        audio: false,
      });
      vid.srcObject = stream;
      vid.muted     = true;
      await new Promise<void>(res => { vid.onloadedmetadata = () => res(); });
      await vid.play();
      isCamRef.current = true;
      setCameraOn(true);

      if ('requestVideoFrameCallback' in (vid as any)) {
        const v = vid as any;
        const tick = (now: number) => {
          if (isCamRef.current) { runDetection(); v.requestVideoFrameCallback(tick); }
        };
        v.requestVideoFrameCallback(tick);
      } else {
        const tick = () => {
          if (isCamRef.current) { runDetection(); rafRef.current = requestAnimationFrame(tick); }
        };
        rafRef.current = requestAnimationFrame(tick);
      }
    } catch (err: any) {
      const MAP: Record<string, string> = {
        NotAllowedError:       'Camera permission denied.',
        PermissionDeniedError: 'Camera permission denied.',
        NotFoundError:         'No camera detected on this device.',
      };
      setCameraErr(MAP[err.name] ?? `Camera: ${err.message}`);
    }
  };

  const stopCamera = () => {
    const vid = videoRef.current;
    if (vid?.srcObject) {
      (vid.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      vid.srcObject = null;
    }
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    isCamRef.current = false;
    setCameraOn(false);
    handsRef.current = { left: null, right: null };
    smoothHandRef.current.clear();
    setGestures({ left: 'None', right: 'None' });
    const ctx = pipRef.current?.getContext('2d');
    if (ctx && pipRef.current) ctx.clearRect(0, 0, pipRef.current.width, pipRef.current.height);
  };

  // ── MediaPipe detection loop ───────────────────────────────────────────────
  const runDetection = useCallback(() => {
    const vid    = videoRef.current;
    const canvas = pipRef.current;
    if (!isCamRef.current || !vid || !canvas || !faceLMRef.current || !handLMRef.current) return;

    const W = vid.videoWidth, H = vid.videoHeight;
    if (!W || !H) return;

    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const scale = 0.30;
    canvas.width  = Math.floor(W * scale);
    canvas.height = Math.floor(H * scale);
    const cW = canvas.width, cH = canvas.height;
    const now = performance.now();

    // Draw mirrored video
    ctx.save();
    ctx.clearRect(0, 0, cW, cH);
    ctx.translate(cW, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(vid, 0, 0, cW, cH);
    ctx.restore();

    const du = new DrawingUtils(ctx);
    const ng = { left: 'None', right: 'None' };

    // Face
    try {
      const fr: FaceLandmarkerResult = faceLMRef.current.detectForVideo(vid, now);
      if (fr?.faceLandmarks?.[0]) {
        const lm = fr.faceLandmarks[0];
        headRef.current = estimateHeadPose(lm as Landmark[]);
        const pts = lm.map(p => ({ x: p.x * cW, y: p.y * cH, z: p.z, visibility: 1 as any }));
        du.drawConnectors(pts, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, {
          color: 'rgba(168,85,247,0.18)', lineWidth: 0.7,
        });
        du.drawLandmarks(pts.filter((_, i) => i % 12 === 0), {
          color: 'rgba(168,85,247,0.45)', radius: 1,
        });
      }
    } catch { /* model not ready yet */ }

    // Hands
    try {
      const hr: HandLandmarkerResult = handLMRef.current.detectForVideo(vid, now);
      if (hr?.landmarks) {
        hr.landmarks.forEach((lm, idx) => {
          const side = hr.handedness[idx][0].categoryName as 'Left' | 'Right';
          const gesture = classifyGesture(lm as Landmark[]);
          if (side === 'Left') ng.left = gesture; else ng.right = gesture;

          // Exponential smoothing
          const alpha = 0.55;
          const last  = smoothHandRef.current.get(side);
          const sm = (lm as Landmark[]).map((p, i): Landmark => ({
            x: last ? p.x * alpha + last[i].x * (1 - alpha) : p.x,
            y: last ? p.y * alpha + last[i].y * (1 - alpha) : p.y,
            z: last ? (p.z ?? 0) * alpha + (last[i].z ?? 0) * (1 - alpha) : (p.z ?? 0),
          }));
          smoothHandRef.current.set(side, sm);

          if (side === 'Left') handsRef.current.left  = sm;
          else                 handsRef.current.right = sm;

          const px = sm.map(p => ({
            x: (1 - p.x) * cW, y: p.y * cH, z: p.z, visibility: 1 as any,
          }));
          du.drawConnectors(px, HandLandmarker.HAND_CONNECTIONS, { color: '#a855f7', lineWidth: 1.6 });
          du.drawLandmarks(px, { color: '#ffffff', radius: 2.2 });
        });

        const detected = hr.handedness.map(h => h[0].categoryName);
        if (!detected.includes('Left'))  { smoothHandRef.current.delete('Left');  handsRef.current.left  = null; }
        if (!detected.includes('Right')) { smoothHandRef.current.delete('Right'); handsRef.current.right = null; }
      }
    } catch { /* model not ready yet */ }

    // Gesture state update
    setGestures(prev => {
      if (ng.left === prev.left && ng.right === prev.right) return prev;

      // Open Palm on either hand → wave greeting
      if ((ng.right === 'Open Palm' || ng.left === 'Open Palm') &&
          prev.right !== 'Open Palm' && prev.left !== 'Open Palm' &&
          !isThinkRef.current) {
        sendMessage('Hello! What can you do?');
      }

      gsap.fromTo('.gesture-pill',
        { scale: 0.85, opacity: 0 },
        { scale: 1, opacity: 1, duration: 0.4, ease: 'back.out(1.5)', stagger: 0.05 },
      );
      return ng;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendMessage]);

  // ── Voice toggle ───────────────────────────────────────────────────────────
  const toggleListen = () => {
  const r = recogRef.current;
  if (!r) return;
  if (isListening) { r.stop(); setIsListening(false); }
  else {
    // Resume AudioContext if suspended (required for Safari)
    audioCtxRef.current?.state === 'suspended' && audioCtxRef.current.resume();
    r.start();
    setIsListening(true);
  }
};

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="relative min-h-screen overflow-hidden bg-[#020208] text-white font-sans select-none">

      {/* ── Ambient background glows ── */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="ambient-orb absolute -top-32 left-1/2 -translate-x-1/2 w-225 h-125 bg-purple-800/20 rounded-full blur-[130px]" />
        <div className="ambient-orb absolute bottom-0 right-0 w-125 h-125 bg-blue-900/15 rounded-full blur-[110px]" />
        <div className="ambient-orb absolute top-1/2 -left-24 w-87.5 h-87.5 bg-violet-900/12 rounded-full blur-[90px]" />
      </div>

      {/* ── Scanline texture ── */}
      <div className="pointer-events-none absolute inset-0 z-0 bg-[repeating-linear-gradient(transparent,transparent_3px,rgba(120,60,220,0.012)_3px,rgba(120,60,220,0.012)_4px)]" />

      {/* ── Header ── */}
      <header
        ref={headerRef}
        className="relative z-20 flex items-center justify-between px-8 py-4 border-b border-white/4 backdrop-blur-sm"
      >
        <div className="flex items-center gap-3">
          <div className="relative w-9 h-9 rounded-xl bg-purple-500/15 border border-purple-500/25 flex items-center justify-center">
            <Activity className="w-4 h-4 text-purple-400" />
            <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-400 border border-black animate-pulse" />
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-[0.35em] text-white/35 font-medium">Neural Link Active</p>
            <h1 className="text-lg font-black leading-none tracking-tight">
              <span className="bg-linear-to-r from-violet-300 via-purple-300 to-blue-300 bg-clip-text text-transparent">
                NIRVANA
              </span>
              <span className="ml-2 text-sm font-light text-white/40">AI Companion</span>
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className={`text-[10px] font-mono ${modelsReady ? 'text-emerald-400/70' : 'text-amber-400/70'}`}>
            {modelsReady ? '● MODELS READY' : '◌ LOADING…'}
          </span>

          <motion.button
            whileTap={{ scale: 0.93 }}
            onClick={cameraOn ? stopCamera : startCamera}
            disabled={!modelsReady}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold border transition-all disabled:opacity-40 ${
              cameraOn
                ? 'bg-red-500/15 text-red-400 border-red-500/25 hover:bg-red-500/25'
                : 'bg-purple-500/15 text-purple-300 border-purple-500/25 hover:bg-purple-500/25'
            }`}
          >
            {cameraOn ? <CameraOff className="w-3.5 h-3.5" /> : <Camera className="w-3.5 h-3.5" />}
            {cameraOn ? 'Disconnect' : 'Connect Camera'}
          </motion.button>

          <motion.button
            whileTap={{ scale: 0.93 }}
            onClick={() => setChatOpen(o => !o)}
            className="p-2 rounded-xl aria-label='Open Settings' text-white/40 border border-white/8 hover:bg-white/5 hover:text-white/70 transition-all"
          >
            <motion.div animate={{ rotate: chatOpen ? 0 : 180 }}>
              <ChevronRight className="w-4 h-4" />
            </motion.div>
          </motion.button>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="relative z-10 flex h-[calc(100vh-65px)]">

        {/* ─── Avatar Stage ─── */}
        <div className="relative flex-1">
          <Canvas
            camera={{ position: [0, 1.4, 2.2], fov: 35 }}
            gl={{ antialias: true, alpha: true, toneMapping: 3 /* ACESFilmic */ }}
            style={{ background: 'transparent' }}
          >
            <ambientLight intensity={1.2} />
            <directionalLight position={[2, 2, 2]} intensity={2} />
            <pointLight position={[-2, 2, 2]} intensity={1.5} />
            <AvatarScene
              lipSyncRef={lipSyncRef}
              handsRef={handsRef}
              headRef={headRef}
              isSpeaking={isSpeaking}
            />
          </Canvas>

          {/* ─── PiP camera ─── */}
          <div className="absolute top-5 left-5 flex flex-col gap-2">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6 }}
              className="relative w-44 h-30 rounded-2xl overflow-hidden border border-white/10 bg-black/50 shadow-2xl"
              style={{ boxShadow: '0 0 25px rgba(139,92,246,0.12)' }}
            >
              <video ref={videoRef} style={{ display: 'none' }} playsInline />
              <canvas ref={pipRef} className="w-full h-full object-cover" />

              {!cameraOn && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80">
                  <Camera className="w-5 h-5 text-white/25 mb-1" />
                  <span className="text-[9px] text-white/25 uppercase tracking-wider">Offline</span>
                </div>
              )}
              {cameraOn && (
                <div className="absolute top-2 left-2 flex items-center gap-1 bg-black/55 px-2 py-0.5 rounded-md">
                  <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-[9px] font-mono text-white/60 uppercase tracking-wider">LIVE</span>
                </div>
              )}
            </motion.div>

            {/* Gesture pills */}
            <div className="flex flex-col gap-1.5">
              {(['left', 'right'] as const).map(side => (
                <AnimatePresence key={side}>
                  {gestures[side] !== 'None' && (
                    <motion.div
                      initial={{ opacity: 0, x: -12, scale: 0.9 }}
                      animate={{ opacity: 1, x: 0, scale: 1 }}
                      exit={{ opacity: 0, x: -12, scale: 0.9 }}
                      className="gesture-pill flex items-center gap-2 bg-black/55 backdrop-blur-md border border-white/10 px-3 py-1.5 rounded-xl"
                    >
                      <div
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: GESTURE_COLOR[gestures[side]] }}
                      />
                      <span className="text-[10px] font-mono text-white/75">
                        {side.toUpperCase()}: {gestures[side]}
                      </span>
                    </motion.div>
                  )}
                </AnimatePresence>
              ))}
            </div>
          </div>

          {/* ─── Bottom status bar ─── */}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 pointer-events-none">
            <AnimatePresence mode="wait">
              {isSpeaking && (
                <motion.div
                  key="speaking"
                  initial={{ opacity: 0, y: 12, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 12, scale: 0.9 }}
                  className="flex items-center gap-2.5 bg-purple-500/15 backdrop-blur-xl border border-purple-500/25 px-5 py-2.5 rounded-full"
                >
                  <div className="flex gap-0.75 items-end h-4">
                    {[60,100,75,100,55].map((h, i) => (
                      <div
                        key={i}
                        className="w-0.75 bg-purple-400 rounded-full"
                        style={{
                          height: `${h}%`,
                          animation: 'bounce 0.6s ease-in-out infinite alternate',
                          animationDelay: `${i * 0.08}s`,
                        }}
                      />
                    ))}
                  </div>
                  <span className="text-xs text-purple-300 font-medium">Speaking</span>
                  <Volume2 className="w-3.5 h-3.5 text-purple-400" />
                </motion.div>
              )}

              {isThinking && !isSpeaking && (
                <motion.div
                  key="thinking"
                  initial={{ opacity: 0, y: 12, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 12, scale: 0.9 }}
                  className="flex items-center gap-2 bg-blue-500/15 backdrop-blur-xl border border-blue-500/25 px-5 py-2.5 rounded-full"
                >
                  <Zap className="w-3.5 h-3.5 text-blue-400 animate-pulse" />
                  <span className="text-xs text-blue-300 font-medium">Thinking</span>
                  <div className="flex gap-1">
                    {[0, 1, 2].map(i => (
                      <div
                        key={i}
                        className="w-1 h-1 rounded-full bg-blue-400/60 animate-bounce"
                        style={{ animationDelay: `${i * 0.15}s` }}
                      />
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* ─── Chat Panel ─── */}
        <AnimatePresence>
          <motion.aside
              key="chat"
              initial={{ x: 420, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 420, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 280, damping: 28 }}
              className="relative flex flex-col w-88 bg-[#08080f]/70 backdrop-blur-2xl border-l border-white/5"
            >
              {/* Panel header */}
              <div className="px-5 py-4 border-b border-white/5 shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-linear-to-br from-violet-500 to-blue-500 flex items-center justify-center shadow-lg">
                    <Sparkles className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white/90">Conversation</p>
                    <p className="text-[9px] text-white/30 font-mono uppercase tracking-wider">
                      Groq · llama-3.3-70b
                    </p>
                  </div>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10">
                {messages.length === 0 && (
                  <div className="flex flex-col items-center justify-center h-full py-16 text-center">
                    <div className="text-4xl mb-3 opacity-30">✦</div>
                    <p className="text-sm text-white/25">Speak, type, or use a gesture</p>
                    <p className="text-xs text-white/15 mt-1">Open Palm to say hello · OK Sign for status</p>
                  </div>
                )}

                {messages.map(msg => (
                  <div
                    key={msg.id}
                    data-msgid={msg.id}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[88%] px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-violet-600/70 text-white rounded-tr-sm backdrop-blur-md'
                          : 'bg-white/6 text-white/85 border border-white/[0.07] rounded-tl-sm'
                      }`}
                    >
                      {msg.content}
                    </div>
                  </div>
                ))}

                {isThinking && (
                  <div className="flex justify-start">
                    <div className="bg-white/5 border border-white/[0.07] px-4 py-3 rounded-2xl rounded-tl-sm">
                      <div className="flex gap-1.5 items-center">
                        {[0, 1, 2].map(i => (
                          <div
                            key={i}
                            className="w-1.5 h-1.5 rounded-full bg-white/30 animate-bounce"
                            style={{ animationDelay: `${i * 0.13}s` }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Input */}
              <div className="shrink-0 p-4 border-t border-white/5">
                {cameraErr && (
                  <motion.p
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-[11px] text-red-400/80 mb-2 px-1"
                  >
                    ⚠ {cameraErr}
                  </motion.p>
                )}

                <div className="flex items-center gap-2 bg-white/4 border border-white/8 rounded-2xl px-3 py-2.5 focus-within:border-purple-500/40 transition-colors">
                  <motion.button
                    whileTap={{ scale: 0.88 }}
                    onClick={toggleListen}
                    className={`p-1.5 rounded-xl shrink-0 transition-all ${
                      isListening
                        ? 'bg-red-500/25 text-red-400 animate-pulse'
                        : 'text-white/40 hover:text-white/70 hover:bg-white/8'
                    }`}
                  >
                    {isListening
                      ? <MicOff className="w-4 h-4" />
                      : <Mic className="w-4 h-4" />
                    }
                  </motion.button>

                  <input
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage(input);
                      }
                    }}
                    placeholder={isListening ? 'Listening…' : 'Type or speak…'}
                    className="flex-1 bg-transparent text-[13px] text-white/90 placeholder-white/25 outline-none"
                  />

                  <motion.button
                    whileTap={{ scale: 0.88 }}
                    onClick={() => sendMessage(input)}
                    disabled={!input.trim() || isThinking}
                    className="p-1.5 rounded-xl shrink-0 bg-purple-600/25 text-purple-300 hover:bg-purple-600/45 disabled:opacity-25 transition-all"
                  >
                    <Send className="w-4 h-4" />
                  </motion.button>
                </div>

                <p className="text-[9px] text-white/15 font-mono text-center mt-2 uppercase tracking-widest">
                  OK Sign · Open Palm · Voice · Type
                </p>
              </div>
            </motion.aside> 
        </AnimatePresence>
      </main>
    </div>
  );
}
