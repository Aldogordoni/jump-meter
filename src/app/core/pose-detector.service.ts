import { Injectable } from '@angular/core';
import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { coarseLocate, DetectionError, FlightEstimate, FootSample, refineFlight } from './flight-detect';
import { seekToFrame } from './video-frames';

const REMOTE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';

// MediaPipe pose landmark indices
const L_HIP = 23, R_HIP = 24, L_ANKLE = 27, R_ANKLE = 28;
const FOOT_POINTS = [29, 30, 31, 32]; // heels and toes

export interface DetectProgress {
  stage: 'loading' | 'scanning' | 'refining';
  done: number;
  total: number;
}

export interface DetectResult extends FlightEstimate {
  trace: FootSample[];
}

@Injectable({ providedIn: 'root' })
export class PoseDetectorService {
  private landmarker?: Promise<PoseLandmarker>;

  private load(): Promise<PoseLandmarker> {
    this.landmarker ??= (async () => {
      const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
      const wasm = await FilesetResolver.forVisionTasks(new URL('mediapipe/wasm', document.baseURI).href);
      const localModel = new URL('models/pose_landmarker_full.task', document.baseURI).href;
      const modelAssetPath = (await exists(localModel)) ? localModel : REMOTE_MODEL;
      const make = (delegate: 'GPU' | 'CPU') =>
        PoseLandmarker.createFromOptions(wasm, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: 'IMAGE',
          numPoses: 1,
          minPoseDetectionConfidence: 0.4,
          minPosePresenceConfidence: 0.4,
        });
      try {
        return await make('GPU');
      } catch {
        return await make('CPU');
      }
    })();
    this.landmarker.catch(() => (this.landmarker = undefined));
    return this.landmarker;
  }

  /** Warm up the model in the background so the first analysis starts faster. */
  preload() {
    this.load().catch(() => undefined);
  }

  async detect(
    video: HTMLVideoElement,
    fps: number,
    totalFrames: number,
    onProgress: (p: DetectProgress) => void,
    signal?: AbortSignal,
  ): Promise<DetectResult> {
    onProgress({ stage: 'loading', done: 0, total: 1 });
    let model: PoseLandmarker;
    try {
      model = await this.load();
    } catch {
      throw new DetectionError("Couldn't load the pose model. Check your connection and try again.");
    }

    const cache = new Map<number, FootSample>();
    const sample = async (frame: number): Promise<FootSample> => {
      const hit = cache.get(frame);
      if (hit) return hit;
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      await seekToFrame(video, frame, fps);
      const res = model.detect(video);
      const lm = res.landmarks[0];
      let s: FootSample = { frame, footY: NaN, legLen: NaN };
      if (lm) {
        const footY = Math.max(...FOOT_POINTS.map((i) => lm[i].y));
        const hipY = (lm[L_HIP].y + lm[R_HIP].y) / 2;
        const ankleY = (lm[L_ANKLE].y + lm[R_ANKLE].y) / 2;
        s = { frame, footY, legLen: ankleY - hipY };
      }
      cache.set(frame, s);
      return s;
    };

    // Pass 1: sparse scan of the whole clip to find the jump.
    const maxSamples = 240;
    const step = Math.max(1, Math.ceil(totalFrames / maxSamples));
    const frames: number[] = [];
    for (let f = 0; f < totalFrames; f += step) frames.push(f);
    const sparse: FootSample[] = [];
    for (let k = 0; k < frames.length; k++) {
      sparse.push(await sample(frames[k]));
      onProgress({ stage: 'scanning', done: k + 1, total: frames.length });
    }
    const coarse = coarseLocate(sparse);

    // Pass 2: every frame around take-off and landing.
    const pad = Math.max(step, 4);
    const range = (a: number, b: number) => {
      const out: number[] = [];
      for (let f = Math.max(0, a); f <= Math.min(totalFrames - 1, b); f++) out.push(f);
      return out;
    };
    const upFrames = range(coarse.lastGroundBefore - pad, coarse.firstAirCoarse + pad);
    const downFrames = range(coarse.lastAirCoarse - pad, coarse.firstGroundAfter + pad);
    const total = upFrames.length + downFrames.length;
    let done = 0;
    const up: FootSample[] = [];
    for (const f of upFrames) {
      up.push(await sample(f));
      onProgress({ stage: 'refining', done: ++done, total });
    }
    const down: FootSample[] = [];
    for (const f of downFrames) {
      down.push(await sample(f));
      onProgress({ stage: 'refining', done: ++done, total });
    }

    const estimate = refineFlight(coarse, sparse, up, down);
    const trace = [...cache.values()].filter((s) => isFinite(s.footY)).sort((a, b) => a.frame - b.frame);
    return { ...estimate, trace };
  }
}

async function exists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok && !(r.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}
