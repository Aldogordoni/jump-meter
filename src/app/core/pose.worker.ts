/// <reference lib="webworker" />
/**
 * Pose model off the main thread, so scrubbing and progress stay smooth while the AI runs.
 * Uses MediaPipe's ES-module WASM loader (the classic one needs importScripts) and an
 * OffscreenCanvas for the GPU delegate.
 */
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

type Delegate = 'GPU' | 'CPU';
export type WorkerIn =
  | { type: 'init'; wasmBase: string; modelPath: string; delegate: Delegate }
  | { type: 'detect'; id: number; image: ImageBitmap };
export type WorkerOut =
  | { type: 'ready'; delegate: Delegate }
  | { type: 'error'; message: string }
  | { type: 'result'; id: number; lm: [number, number, number][] | null; ms: number }
  | { type: 'fail'; id: number; message: string }
  | { type: 'delegate'; delegate: Delegate; ms: number; altMs: number };

let files: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
let modelPath = '';
let model: PoseLandmarker | null = null;
let delegate: Delegate = 'GPU';
const timings: number[] = [];
let benchmarked = false;

const post = (m: WorkerOut, transfer: Transferable[] = []) => postMessage(m, transfer);

/**
 * MediaPipe clears the global WASM factory after each model it creates. In a module worker
 * the loader is an ES module, which only runs once, so put the factory back each time.
 */
let factory: unknown;

function create(d: Delegate) {
  const g = self as unknown as { ModuleFactory?: unknown };
  g.ModuleFactory ??= factory;
  return PoseLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: modelPath, delegate: d },
    canvas: d === 'GPU' ? new OffscreenCanvas(1, 1) : undefined,
    runningMode: 'IMAGE',
    numPoses: 1,
    minPoseDetectionConfidence: 0.4,
    minPosePresenceConfidence: 0.4,
  });
}

/** After a few frames, try the other delegate once and keep whichever is clearly faster. */
async function maybeSwitch(image: ImageBitmap) {
  if (benchmarked || timings.length < 4) return;
  benchmarked = true;
  const avg = (timings[1] + timings[2] + timings[3]) / 3;
  if (avg <= 90) return;
  const other: Delegate = delegate === 'GPU' ? 'CPU' : 'GPU';
  try {
    const alt = await create(other);
    alt.detect(image);
    const t = performance.now();
    alt.detect(image);
    alt.detect(image);
    const altAvg = (performance.now() - t) / 2;
    if (altAvg < avg * 0.7) {
      model?.close();
      model = alt;
      delegate = other;
      post({ type: 'delegate', delegate, ms: avg, altMs: altAvg });
    } else {
      alt.close();
    }
  } catch {
    /* keep the current one */
  }
}

addEventListener('message', async ({ data }: MessageEvent<WorkerIn>) => {
  if (data.type === 'init') {
    try {
      files = await FilesetResolver.forVisionTasks(data.wasmBase, true);
      factory = (await import(/* @vite-ignore */ files.wasmLoaderPath)).default;
      modelPath = data.modelPath;
      delegate = data.delegate;
      try {
        model = await create(delegate);
      } catch {
        delegate = delegate === 'GPU' ? 'CPU' : 'GPU';
        model = await create(delegate);
      }
      post({ type: 'ready', delegate });
    } catch (e) {
      post({ type: 'error', message: String((e as Error)?.message ?? e) });
    }
    return;
  }
  if (data.type === 'detect') {
    const image = data.image;
    try {
      if (!model) throw new Error('model not ready');
      const t = performance.now();
      const lm = model.detect(image).landmarks[0];
      const ms = performance.now() - t;
      timings.push(ms);
      await maybeSwitch(image);
      post({ type: 'result', id: data.id, lm: lm ? lm.map((p) => [p.x, p.y, p.visibility ?? 1]) : null, ms });
    } catch (e) {
      post({ type: 'fail', id: data.id, message: String((e as Error)?.message ?? e) });
    } finally {
      image.close();
    }
  }
});
