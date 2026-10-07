import { Injectable } from '@angular/core';
import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { coarseLocate, DetectionError, DetectMode, findMovementStart, FlightEstimate, FootSample, Joint, refineFlight } from './flight-detect';
import { FrameSource } from './frame-source';
import { coarseHops, findHops, type HopEvent } from './pose-analysis';
import type { WorkerIn, WorkerOut } from './pose.worker';

const REMOTE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';

// MediaPipe pose landmark indices
const L_HIP = 23, R_HIP = 24, L_ANKLE = 27, R_ANKLE = 28;
const FOOT_POINTS = [29, 30, 31, 32]; // heels and toes

/** Pose input size. The model works at 256 px internally, so bigger only costs time. */
const POSE_MAX_SIDE = 384;
const DELEGATE_KEY = 'jump-meter.delegate';
const ENGINE_KEY = 'jump-meter.pose-engine';

type Delegate = 'GPU' | 'CPU';
type Landmark = { x: number; y: number; visibility?: number };

export interface DetectProgress {
  stage: 'loading' | 'scanning' | 'refining';
  done: number;
  total: number;
}

export interface DetectResult extends FlightEstimate {
  trace: FootSample[];
}

/** Something that turns an image into pose landmarks: a Web Worker, or the main thread. */
interface Engine {
  kind: 'worker' | 'main';
  detect(img: ImageBitmap | HTMLCanvasElement): Promise<Landmark[] | undefined>;
}

@Injectable({ providedIn: 'root' })
export class PoseDetectorService {
  private enginePromise?: Promise<Engine>;
  private modelPath?: Promise<string>;
  /** Which engine is running, for diagnostics. */
  engineKind: Engine['kind'] | null = null;

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

  private model(): Promise<string> {
    this.modelPath ??= (async () => {
      const local = new URL('models/pose_landmarker_full.task', document.baseURI).href;
      return (await exists(local)) ? local : REMOTE_MODEL;
    })();
    return this.modelPath;
  }

  /** Warm up the model in the background so the first analysis starts faster. */
  preload() {
    this.engine().catch(() => undefined);
  }

  private engine(): Promise<Engine> {
    if (!this.enginePromise) {
      const p = (async () => {
        let workerFailed = false;
        if (workerSupported()) {
          try {
            return await this.workerEngine();
          } catch (e) {
            console.warn('[jump-meter] pose worker unavailable, using the main thread', e);
            workerFailed = true;
          }
        }
        const main = await this.mainEngine();
        // The worker failed where the main thread works: skip the worker next time on this device.
        if (workerFailed) {
          try {
            localStorage.setItem(ENGINE_KEY, 'main');
          } catch {
            /* ignore */
          }
        }
        return main;
      })();
      p.then((e) => (this.engineKind = e.kind)).catch(() => (this.enginePromise = undefined));
      this.enginePromise = p;
    }
    return this.enginePromise;
  }

  private async workerEngine(): Promise<Engine> {
    const worker = new Worker(new URL('./pose.worker', import.meta.url), { type: 'module' });
    const pending = new Map<number, { resolve: (v: Landmark[] | undefined) => void; reject: (e: Error) => void }>();
    let nextId = 1;
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
        worker.onmessage = ({ data }: MessageEvent<WorkerOut>) => {
          switch (data.type) {
            case 'ready':
              this.remember(data.delegate);
              resolve();
              break;
            case 'error':
              reject(new Error(data.message));
              break;
            case 'delegate':
              this.remember(data.delegate);
              console.info(`[jump-meter] pose switched to ${data.delegate}: ${Math.round(data.ms)} ms vs ${Math.round(data.altMs)} ms`);
              break;
            case 'result':
              pending.get(data.id)?.resolve(data.lm ? data.lm.map(([x, y, visibility]) => ({ x, y, visibility })) : undefined);
              pending.delete(data.id);
              break;
            case 'fail':
              pending.get(data.id)?.reject(new Error(data.message));
              pending.delete(data.id);
              break;
          }
        };
        const init: WorkerIn = {
          type: 'init',
          wasmBase: new URL('mediapipe/wasm', document.baseURI).href,
          modelPath: '',
          delegate: this.preferred(),
        };
        this.model().then((modelPath) => worker.postMessage({ ...init, modelPath }), reject);
      }),
      30000,
    ).catch((e) => {
      worker.terminate();
      throw e;
    });
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'worker error'));
      pending.clear();
    };
    return {
      kind: 'worker',
      async detect(img) {
        // The frame source may reuse its bitmap, so send a copy (cheap at pose size).
        const copy = await createImageBitmap(img);
        const id = nextId++;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          const msg: WorkerIn = { type: 'detect', id, image: copy };
          worker.postMessage(msg, [copy]);
        });
      },
    };
  }

  /** Fallback: MediaPipe on the main thread, with the same GPU/CPU benchmark. */
  private async mainEngine(): Promise<Engine> {
    const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
    const wasm = await FilesetResolver.forVisionTasks(new URL('mediapipe/wasm', document.baseURI).href);
    const modelAssetPath = await this.model();
    const create = (delegate: Delegate) =>
      withTimeout(
        PoseLandmarker.createFromOptions(wasm, {
          baseOptions: { modelAssetPath, delegate },
          runningMode: 'IMAGE',
          numPoses: 1,
          minPoseDetectionConfidence: 0.4,
          minPosePresenceConfidence: 0.4,
        }),
        delegate === 'GPU' ? 20000 : 60000,
      );
    let delegate = this.preferred();
    let model: PoseLandmarker;
    try {
      model = await create(delegate);
    } catch {
      delegate = delegate === 'GPU' ? 'CPU' : 'GPU';
      model = await create(delegate);
    }
    const timings: number[] = [];
    let benchmarked = false;
    return {
      kind: 'main',
      detect: async (img) => {
        const t = performance.now();
        const lm = model.detect(img).landmarks[0];
        timings.push(performance.now() - t);
        if (!benchmarked && timings.length === 4) {
          benchmarked = true;
          const avg = (timings[1] + timings[2] + timings[3]) / 3;
          if (avg > 90) {
            const other: Delegate = delegate === 'GPU' ? 'CPU' : 'GPU';
            try {
              const alt = await create(other);
              alt.detect(img);
              const t2 = performance.now();
              alt.detect(img);
              alt.detect(img);
              const altAvg = (performance.now() - t2) / 2;
              if (altAvg < avg * 0.7) {
                model = alt;
                delegate = other;
                this.remember(other);
              }
            } catch {
              /* keep the current one */
            }
          }
        }
        return lm;
      },
    };
  }

  private async ready(onProgress?: (p: DetectProgress) => void): Promise<Engine> {
    onProgress?.({ stage: 'loading', done: 0, total: 1 });
    try {
      return await this.engine();
    } catch {
      throw new DetectionError("Couldn't load the pose model. Check your connection and try again.");
    }
  }

  /** Pose for each frame, in order, with progress. */
  private async run(
    engine: Engine,
    source: FrameSource,
    frames: number[],
    onSample: (s: FootSample) => void,
    onStep?: (done: number) => void,
    signal?: AbortSignal,
  ) {
    let done = 0;
    await source.scan(
      frames,
      POSE_MAX_SIDE,
      async (i, img) => {
        onSample(toSample(i, await engine.detect(img)));
        onStep?.(++done);
        // The worker keeps the UI responsive; the main-thread engine needs a breather.
        if (engine.kind === 'main') await yieldToUi(done);
      },
      signal,
    );
  }

  async detect(
    source: FrameSource,
    realFps: number,
    mode: DetectMode,
    onProgress: (p: DetectProgress) => void,
    signal?: AbortSignal,
  ): Promise<DetectResult> {
    const engine = await this.ready(onProgress);
    const total = source.frameCount;
    const cache = new Map<number, FootSample>();
    const keep = (s: FootSample) => cache.set(s.frame, s);

    // Pass 1: sparse scan – about every 30 ms of real time, capped for long clips.
    const step = Math.max(1, Math.round(realFps * 0.03), Math.ceil(total / 200));
    const sparseFrames: number[] = [];
    for (let f = 0; f < total; f += step) sparseFrames.push(f);
    const tStart = performance.now();
    await this.run(engine, source, sparseFrames, keep, (d) => onProgress({ stage: 'scanning', done: d, total: sparseFrames.length }), signal);
    console.info(`[jump-meter] scan: ${sparseFrames.length} frames in ${Math.round(performance.now() - tStart)} ms (${engine.kind})`);
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
    await this.run(engine, source, dense, keep, (d) => onProgress({ stage: 'refining', done: d, total: dense.length }), signal);

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
    const engine = await this.ready(onProgress);
    const total = source.frameCount;
    const cache = new Map<number, FootSample>();
    const keep = (s: FootSample) => cache.set(s.frame, s);
    // Hops are short, so scan a little finer than for a single jump.
    const step = Math.max(1, Math.round(realFps * 0.025), Math.ceil(total / 300));
    const sparse: number[] = [];
    for (let f = 0; f < total; f += step) sparse.push(f);
    await this.run(engine, source, sparse, keep, (d) => onProgress({ stage: 'scanning', done: d, total: sparse.length }), signal);
    const coarse = coarseHops(sparse.map((f) => cache.get(f)!).filter(Boolean));
    if (!coarse) throw new DetectionError("Couldn't find repeated hops. Film side-on with your feet clearly in shot.");
    const dense = new Set<number>();
    for (const t of coarse.transitions) {
      for (let f = Math.max(0, t.from - 2); f <= Math.min(total - 1, t.to + 2); f++) if (!cache.has(f)) dense.add(f);
    }
    const denseList = [...dense].sort((a, b) => a - b);
    await this.run(engine, source, denseList, keep, (d) => onProgress({ stage: 'refining', done: d, total: denseList.length }), signal);
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
    const engine = await this.engine();
    const s = Math.min(1, 256 / Math.max(w, h));
    const c = (this.liveCanvas ??= document.createElement('canvas'));
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
    return toSample(0, await engine.detect(c));
  }

  /** Run the pose model on specific frames (used for the frame-rate check after manual marking). */
  async samplePoses(source: FrameSource, frames: number[], signal?: AbortSignal): Promise<FootSample[]> {
    const engine = await this.engine();
    const out: FootSample[] = [];
    await this.run(engine, source, frames, (s) => out.push(s), undefined, signal);
    return out.sort((a, b) => a.frame - b.frame);
  }
}

/** Turn MediaPipe landmarks into the measurements we use. */
const JOINTS: Record<Joint, number> = {
  shoulderL: 11, shoulderR: 12, wristL: 15, wristR: 16, hipL: 23, hipR: 24, kneeL: 25, kneeR: 26,
  ankleL: 27, ankleR: 28, heelL: 29, heelR: 30, toeL: 31, toeR: 32,
};

export function toSample(frame: number, lm: Landmark[] | undefined): FootSample {
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

function workerSupported(): boolean {
  try {
    if (localStorage.getItem(ENGINE_KEY) === 'main') return false;
  } catch {
    /* ignore */
  }
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';
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
