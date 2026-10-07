import { Injectable } from '@angular/core';
import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { coarseLocate, DetectionError, DetectMode, findMovementStart, FlightEstimate, FootSample, Joint, refineFlight } from './flight-detect';
import { FrameSource } from './frame-source';
import { coarseHops, findHops, type HopEvent } from './pose-analysis';

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
    mode: DetectMode,
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

      cache.set(frame, toSample(frame, lm));
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
    const coarse = coarseLocate(sparse, mode);

    // Pass 2: every frame around take-off and landing.
    const pad = Math.max(step, 4);
    const range = (a: number, b: number) => {
      const out: number[] = [];
      for (let f = Math.max(0, a); f <= Math.min(total - 1, b); f++) out.push(f);
      return out;
    };
    const upFrames = range(coarse.lastGroundBefore - pad, coarse.firstAirCoarse + pad);
    const downFrames = range(coarse.lastAirCoarse - pad, coarse.firstGroundAfter + pad);
    const contactFrames =
      coarse.dropLastAir !== null && coarse.dropFirstGround !== null
        ? range(coarse.dropLastAir - pad, coarse.dropFirstGround + pad)
        : [];
    const dense = [...contactFrames, ...upFrames, ...downFrames].filter((f) => !cache.has(f));
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
    const contactWin = contactFrames.map((f) => cache.get(f)!).filter(Boolean);
    const estimate = refineFlight(coarse, sparse, up, down, contactWin);
    if (mode === 'single') estimate.movementStart = findMovementStart(coarse, sparse, realFps);
    const trace = [...cache.values()].filter((s) => isFinite(s.footY)).sort((a, b) => a.frame - b.frame);
    return { ...estimate, trace };
  }

  /**
   * Repeated jumps: sparse scan of the whole clip, then every frame around each take-off
   * and landing, then all flights from the combined trace.
   */
  async detectHops(
    source: FrameSource,
    realFps: number,
    onProgress: (p: DetectProgress) => void,
    signal?: AbortSignal,
  ): Promise<{ trace: FootSample[]; events: HopEvent[]; floor: number }> {
    onProgress({ stage: 'loading', done: 0, total: 1 });
    let model: PoseLandmarker;
    try {
      ({ model } = await this.loadAny());
    } catch {
      throw new DetectionError("Couldn't load the pose model. Check your connection and try again.");
    }
    const total = source.frameCount;
    const cache = new Map<number, FootSample>();
    const run = async (frames: number[], stage: DetectProgress['stage']) => {
      let done = 0;
      await source.scan(
        frames,
        POSE_MAX_SIDE,
        async (i, img) => {
          cache.set(i, toSample(i, model.detect(img).landmarks[0]));
          onProgress({ stage, done: ++done, total: frames.length });
          await yieldToUi(done);
        },
        signal,
      );
    };
    // Hops are short, so scan a little finer than for a single jump.
    const step = Math.max(1, Math.round(realFps * 0.025), Math.ceil(total / 300));
    const sparse: number[] = [];
    for (let f = 0; f < total; f += step) sparse.push(f);
    await run(sparse, 'scanning');
    const coarse = coarseHops(sparse.map((f) => cache.get(f)!).filter(Boolean));
    if (!coarse) throw new DetectionError("Couldn't find repeated hops. Film side-on with your feet clearly in shot.");
    const dense = new Set<number>();
    for (const t of coarse.transitions) {
      for (let f = Math.max(0, t.from - 2); f <= Math.min(total - 1, t.to + 2); f++) if (!cache.has(f)) dense.add(f);
    }
    await run([...dense].sort((a, b) => a - b), 'refining');
    const trace = [...cache.values()].filter((s) => isFinite(s.footY)).sort((a, b) => a.frame - b.frame);
    const events = findHops(trace, coarse.floor, coarse.threshold);
    if (events.length < 2) throw new DetectionError('Found fewer than two hops. Keep recording until the last landing.');
    return { trace, events, floor: coarse.floor };
  }

  private liveCanvas?: HTMLCanvasElement;

  /** One pose from the live camera preview (downscaled first, so it stays quick). */
  async detectLive(video: HTMLVideoElement): Promise<FootSample | null> {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    const { model } = await this.loadAny();
    const s = Math.min(1, 256 / Math.max(w, h));
    const c = (this.liveCanvas ??= document.createElement('canvas'));
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
    return toSample(0, model.detect(c).landmarks[0]);
  }

  /** Run the pose model on specific frames (used for the frame-rate check after manual marking). */
  async samplePoses(source: FrameSource, frames: number[], signal?: AbortSignal): Promise<FootSample[]> {
    const { model } = await this.loadAny();
    const out: FootSample[] = [];
    await source.scan(
      frames,
      POSE_MAX_SIDE,
      async (i, img) => {
        out.push(toSample(i, model.detect(img).landmarks[0]));
        await yieldToUi(out.length);
      },
      signal,
    );
    return out.sort((a, b) => a.frame - b.frame);
  }
}

/** Turn MediaPipe landmarks into the measurements we use. */
const JOINTS: Record<Joint, number> = {
  shoulderL: 11, shoulderR: 12, wristL: 15, wristR: 16, hipL: 23, hipR: 24, kneeL: 25, kneeR: 26,
  ankleL: 27, ankleR: 28, heelL: 29, heelR: 30, toeL: 31, toeR: 32,
};

export function toSample(frame: number, lm: { x: number; y: number; visibility?: number }[] | undefined): FootSample {
  if (!lm) return { frame, footY: NaN, legLen: NaN };
  const footY = Math.max(...FOOT_POINTS.map((i) => lm[i].y));
  const hipY = (lm[L_HIP].y + lm[R_HIP].y) / 2;
  const ankleY = (lm[L_ANKLE].y + lm[R_ANKLE].y) / 2;
  const pts: FootSample['pts'] = {};
  for (const [name, i] of Object.entries(JOINTS) as [Joint, number][]) {
    pts[name] = [lm[i].x, lm[i].y, lm[i].visibility ?? 1];
  }
  return { frame, footY, legLen: ankleY - hipY, hipY, noseY: lm[0].y, heelY: Math.max(lm[29].y, lm[30].y), pts };
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
