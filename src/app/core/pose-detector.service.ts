import { Injectable } from '@angular/core';
import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { coarseLocate, DetectionError, FlightEstimate, FootSample, refineFlight } from './flight-detect';
import { FrameSource } from './frame-source';

const REMOTE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';

// MediaPipe pose landmark indices
const L_HIP = 23, R_HIP = 24, L_ANKLE = 27, R_ANKLE = 28;
const FOOT_POINTS = [29, 30, 31, 32]; // heels and toes

/** Pose input size. The model works at 256 px internally, so bigger only costs time. */
const POSE_MAX_SIDE = 384;
const DELEGATE_KEY = 'jump-meter.delegate';

type Delegate = 'GPU' | 'CPU';

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
  private readonly models = new Map<Delegate, Promise<PoseLandmarker>>();
  private modelPath?: Promise<string>;

  private load(delegate: Delegate): Promise<PoseLandmarker> {
    let p = this.models.get(delegate);
    if (!p) {
      p = withTimeout(
        (async () => {
          const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
          const wasm = await FilesetResolver.forVisionTasks(new URL('mediapipe/wasm', document.baseURI).href);
          this.modelPath ??= (async () => {
            const local = new URL('models/pose_landmarker_full.task', document.baseURI).href;
            return (await exists(local)) ? local : REMOTE_MODEL;
          })();
          return PoseLandmarker.createFromOptions(wasm, {
            baseOptions: { modelAssetPath: await this.modelPath, delegate },
            runningMode: 'IMAGE',
            numPoses: 1,
            minPoseDetectionConfidence: 0.4,
            minPosePresenceConfidence: 0.4,
          });
        })(),
        delegate === 'GPU' ? 20000 : 60000,
      );
      p.catch(() => this.models.delete(delegate));
      this.models.set(delegate, p);
    }
    return p;
  }

  private preferred(): Delegate {
    try {
      return localStorage.getItem(DELEGATE_KEY) === 'CPU' ? 'CPU' : 'GPU';
    } catch {
      return 'GPU';
    }
  }

  private remember(d: Delegate) {
    try {
      localStorage.setItem(DELEGATE_KEY, d);
    } catch {
      /* ignore */
    }
  }

  /** Warm up the model in the background so the first analysis starts faster. */
  preload() {
    this.load(this.preferred()).catch(() => undefined);
  }

  /** Load the preferred model, falling back to the other delegate if it fails. */
  private async loadAny(): Promise<{ model: PoseLandmarker; delegate: Delegate }> {
    const first = this.preferred();
    try {
      return { model: await this.load(first), delegate: first };
    } catch {
      const other: Delegate = first === 'GPU' ? 'CPU' : 'GPU';
      return { model: await this.load(other), delegate: other };
    }
  }

  async detect(
    source: FrameSource,
    realFps: number,
    onProgress: (p: DetectProgress) => void,
    signal?: AbortSignal,
  ): Promise<DetectResult> {
    onProgress({ stage: 'loading', done: 0, total: 1 });
    let model: PoseLandmarker;
    let delegate: Delegate;
    try {
      ({ model, delegate } = await this.loadAny());
    } catch {
      throw new DetectionError("Couldn't load the pose model. Check your connection and try again.");
    }

    const total = source.frameCount;
    const cache = new Map<number, FootSample>();
    const timings: number[] = [];
    let benchmarked = false;

    const measure = async (frame: number, image: ImageBitmap) => {
      const t = performance.now();
      const lm = model.detect(image).landmarks[0];
      timings.push(performance.now() - t);

      // After a few frames, check the other delegate isn't much faster on this device.
      if (!benchmarked && timings.length === 4) {
        benchmarked = true;
        const avg = (timings[1] + timings[2] + timings[3]) / 3;
        if (avg > 90) {
          const other: Delegate = delegate === 'GPU' ? 'CPU' : 'GPU';
          try {
            const alt = await this.load(other);
            alt.detect(image); // warm-up
            const t2 = performance.now();
            alt.detect(image);
            alt.detect(image);
            const altAvg = (performance.now() - t2) / 2;
            if (altAvg < avg * 0.7) {
              model = alt;
              delegate = other;
              this.remember(other);
            }
            console.info(`[jump-meter] pose ${delegate === other ? 'switched to' : 'kept'} ${delegate}: ${Math.round(avg)} ms vs ${Math.round(altAvg)} ms`);
          } catch {
            /* keep the current one */
          }
        }
      }

      let s: FootSample = { frame, footY: NaN, legLen: NaN };
      if (lm) {
        const footY = Math.max(...FOOT_POINTS.map((i) => lm[i].y));
        const hipY = (lm[L_HIP].y + lm[R_HIP].y) / 2;
        const ankleY = (lm[L_ANKLE].y + lm[R_ANKLE].y) / 2;
        s = { frame, footY, legLen: ankleY - hipY };
      }
      cache.set(frame, s);
    };

    // Pass 1: sparse scan – about every 30 ms of real time, capped for long clips.
    const step = Math.max(1, Math.round(realFps * 0.03), Math.ceil(total / 200));
    const sparseFrames: number[] = [];
    for (let f = 0; f < total; f += step) sparseFrames.push(f);
    let done = 0;
    const tStart = performance.now();
    await source.scan(
      sparseFrames,
      POSE_MAX_SIDE,
      async (i, img) => {
        await measure(i, img);
        onProgress({ stage: 'scanning', done: ++done, total: sparseFrames.length });
        await yieldToUi(done);
      },
      signal,
    );
    console.info(
      `[jump-meter] scan: ${sparseFrames.length} frames in ${Math.round(performance.now() - tStart)} ms (${delegate})`,
    );
    const sparse = sparseFrames.map((f) => cache.get(f)!).filter(Boolean);
    const coarse = coarseLocate(sparse);

    // Pass 2: every frame around take-off and landing.
    const pad = Math.max(step, 4);
    const range = (a: number, b: number) => {
      const out: number[] = [];
      for (let f = Math.max(0, a); f <= Math.min(total - 1, b); f++) out.push(f);
      return out;
    };
    const upFrames = range(coarse.lastGroundBefore - pad, coarse.firstAirCoarse + pad);
    const downFrames = range(coarse.lastAirCoarse - pad, coarse.firstGroundAfter + pad);
    const dense = [...upFrames, ...downFrames].filter((f) => !cache.has(f));
    done = 0;
    await source.scan(
      dense,
      POSE_MAX_SIDE,
      async (i, img) => {
        await measure(i, img);
        onProgress({ stage: 'refining', done: ++done, total: dense.length });
        await yieldToUi(done);
      },
      signal,
    );

    const up = upFrames.map((f) => cache.get(f)!).filter(Boolean);
    const down = downFrames.map((f) => cache.get(f)!).filter(Boolean);
    const estimate = refineFlight(coarse, sparse, up, down);
    const trace = [...cache.values()].filter((s) => isFinite(s.footY)).sort((a, b) => a.frame - b.frame);
    return { ...estimate, trace };
  }
}

/** Let the progress bar repaint every few frames. */
function yieldToUi(n: number): Promise<void> | void {
  if (n % 3 === 0) return new Promise((r) => setTimeout(r, 0));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

async function exists(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok && !(r.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}
