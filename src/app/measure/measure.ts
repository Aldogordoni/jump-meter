import { Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  JUMP_TYPE_HINT,
  JUMP_TYPES,
  JumpType,
  Units,
  fromUnits,
  heightFromFlight,
  heightUncertaintyCm,
  isDropJump,
  rsi,
  rsiMod,
  sayersPower,
  takeoffVelocity,
  toUnits,
} from '../core/jump-math';
import { readVideoInfo, VideoInfo } from '../core/mp4-info';
import { StoreService } from '../core/store.service';
import { FrameSource, openFrameSource } from '../core/frame-source';
import { DetectProgress, DetectResult, PoseDetectorService } from '../core/pose-detector.service';
import { DetectionError, FootSample } from '../core/flight-detect';
import { estimateFps, reconcileFps } from '../core/fps-infer';
import { HeightPipe, formatNumber } from '../core/height.pipe';
import { makeClip } from '../core/clip-maker';
import { clipStore, requestPersistentStorage } from '../core/clip-store';
import { CloudService } from '../core/cloud.service';
import { VaneGauge } from '../shared/vane-gauge';
import { FootTrace } from '../shared/foot-trace';

export type MarkKey = 'start' | 'contact' | 'air' | 'ground';

interface MarkDef {
  key: MarkKey;
  title: string;
  hint: string;
  optional?: boolean;
}

const MARKS: Record<MarkKey, MarkDef> = {
  start: {
    key: 'start',
    title: 'Movement start',
    hint: 'Last frame standing still, before you dip. Optional: adds time to take-off and RSI-modified.',
    optional: true,
  },
  contact: { key: 'contact', title: 'Box landing', hint: 'First frame touching the floor after stepping off the box.' },
  air: { key: 'air', title: 'Take-off', hint: 'First frame with both feet off the ground.' },
  ground: { key: 'ground', title: 'Landing', hint: 'First frame touching the ground again.' },
};

const NO_MARKS: Record<MarkKey, number | null> = { start: null, contact: null, air: null, ground: null };

/** Jump types where the Sayers power equation applies. */
const POWER_TYPES: JumpType[] = ['CMJ', 'CMJ + arms', 'Squat jump'];

@Component({
  selector: 'app-measure',
  imports: [FormsModule, DecimalPipe, RouterLink, VaneGauge, FootTrace, HeightPipe],
  templateUrl: './measure.html',
  styleUrl: './measure.scss',
})
export class Measure implements OnDestroy {
  protected readonly store = inject(StoreService);
  protected readonly cloud = inject(CloudService);
  private readonly pose = inject(PoseDetectorService);

  protected readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('frame');
  protected readonly jumpTypes = JUMP_TYPES;
  protected readonly typeHint = JUMP_TYPE_HINT;

  // Video
  protected readonly loaded = signal(false);
  protected readonly loading = signal(false);
  protected readonly fileName = signal('');
  protected readonly info = signal<VideoInfo | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly engine = signal<'webcodecs' | 'video' | null>(null);
  protected readonly totalFrames = signal(0);
  /** Frame rate the file plays back at. */
  protected readonly fileFps = signal<number | null>(null);
  /** Real-world capture rate, entered or read from metadata. Null = same as file. */
  protected readonly captureFps = signal<number | null>(null);
  /** Where the frame rate in use came from. */
  protected readonly fpsSource = signal<'file' | 'metadata' | 'motion' | 'manual'>('file');
  protected readonly editingFps = signal(false);
  protected readonly fpsCheck = signal<
    | { state: 'idle' | 'running' | 'unavailable' }
    | { state: 'agrees'; fps: number }
    | { state: 'corrected'; from: number; to: number }
    | { state: 'suggest'; fps: number }
  >({ state: 'idle' });
  protected readonly commonRates = [30, 60, 120, 240];
  private lastCheckKey = '';
  private checkAbort?: AbortController;
  protected readonly currentFrame = signal(0);
  protected readonly shownFrame = signal<number | null>(null);
  protected readonly playing = signal(false);

  // Jump type and marks
  protected readonly type = signal<JumpType>(this.store.settings().defaultType);
  protected readonly isDrop = computed(() => isDropJump(this.type()));
  protected readonly marks = signal<Record<MarkKey, number | null>>({ ...NO_MARKS });
  /** Sub-frame instants from auto-detection; each is dropped when its mark is edited. */
  protected readonly exact = signal<Partial<Record<MarkKey, number>>>({});
  protected readonly method = signal<'manual' | 'auto' | 'auto-adjusted'>('manual');
  protected readonly markDefs = computed<MarkDef[]>(() =>
    this.isDrop() ? [MARKS.contact, MARKS.air, MARKS.ground] : [MARKS.start, MARKS.air, MARKS.ground],
  );

  // Auto-detect
  protected readonly detecting = signal(false);
  protected readonly progress = signal<DetectProgress | null>(null);
  protected readonly detectError = signal<string | null>(null);
  protected readonly detection = signal<DetectResult | null>(null);
  protected readonly elapsed = signal(0);
  private abort?: AbortController;

  // Save
  protected readonly note = signal('');
  protected readonly savedId = signal<string | null>(null);
  protected readonly saveClip = signal(true);
  protected readonly clipProgress = signal<number | null>(null);
  protected readonly clipError = signal<string | null>(null);

  protected readonly units = computed(() => this.store.settings().units);
  protected readonly boxInUnits = computed(() => {
    const cm = this.store.settings().boxCm;
    return cm === null ? null : Math.round(toUnits(cm, this.units()) * 10) / 10;
  });

  protected readonly realFps = computed(() => this.captureFps() ?? this.fileFps());
  protected readonly isSlowedDown = computed(() => {
    const f = this.fileFps();
    const c = this.realFps();
    return !!f && !!c && c > f * 1.05;
  });
  protected readonly lowFps = computed(() => (this.realFps() ?? 0) > 0 && (this.realFps() ?? 0) < 100);

  /** Mark position, using the sub-frame instant when auto-detect provided one. */
  private at(key: MarkKey): number | null {
    return this.exact()[key] ?? this.marks()[key];
  }

  protected readonly orderError = computed(() => {
    const m = this.marks();
    if (m.air !== null && m.ground !== null && m.ground <= m.air) return 'Landing has to come after take-off.';
    if (this.isDrop() && m.contact !== null && m.air !== null && m.air <= m.contact)
      return 'Take-off has to come after the box landing.';
    if (!this.isDrop() && m.start !== null && m.air !== null && m.air <= m.start)
      return 'Movement start has to come before take-off.';
    return null;
  });

  protected readonly result = computed(() => {
    const fps = this.realFps();
    const air = this.at('air');
    const ground = this.at('ground');
    if (!fps || air === null || ground === null || ground <= air) return null;
    const frames = ground - air;
    const flight = frames / fps;
    const heightCm = heightFromFlight(flight) * 100;
    const mass = this.store.settings().massKg;

    let contactMs: number | null = null;
    let rsiValue: number | null = null;
    let fctRatio: number | null = null;
    const contact = this.at('contact');
    if (this.isDrop() && contact !== null && air > contact) {
      const ct = (air - contact) / fps;
      contactMs = ct * 1000;
      rsiValue = rsi(heightCm, ct);
      fctRatio = flight / ct;
    }

    let tttMs: number | null = null;
    let rsiModValue: number | null = null;
    const start = this.marks().start;
    if (!this.isDrop() && start !== null && air > start) {
      const ttt = (air - start) / fps;
      tttMs = ttt * 1000;
      rsiModValue = rsiMod(heightCm, ttt);
    }

    return {
      flightMs: flight * 1000,
      heightCm,
      velocity: takeoffVelocity(flight),
      errCm: heightUncertaintyCm(flight, fps) * (this.exact().air !== undefined && this.exact().ground !== undefined ? 0.5 : 1),
      powerW: mass && POWER_TYPES.includes(this.type()) ? sayersPower(heightCm, mass) : null,
      frames,
      contactMs,
      rsi: rsiValue,
      fctRatio,
      tttMs,
      rsiMod: rsiModValue,
      implausible: flight < 0.15 || flight > 1.1 || (contactMs !== null && (contactMs < 80 || contactMs > 1000)),
    };
  });

  protected readonly best = computed(() => this.store.bestFor(this.type()));

  private source: FrameSource | null = null;
  private playTimer?: ReturnType<typeof setTimeout>;
  private elapsedTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.pose.preload();
    // Re-check the frame rate against the jump's motion whenever take-off/landing change.
    let timer: ReturnType<typeof setTimeout> | undefined;
    effect(() => {
      const m = this.marks();
      const loaded = this.loaded();
      clearTimeout(timer);
      if (!loaded || m.air === null || m.ground === null || m.ground - m.air < 4) return;
      timer = setTimeout(() => untracked(() => this.checkFps()), 700);
    });
  }

  ngOnDestroy() {
    this.stopPlay();
    this.abort?.abort();
    clearInterval(this.elapsedTimer);
    this.source?.dispose();
  }

  // ---------- Loading ----------

  async onFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.reset();
    this.fileName.set(file.name);
    this.loading.set(true);
    try {
      const info = await readVideoInfo(file);
      this.info.set(info);
      const source = await openFrameSource(file, info.containerFps);
      this.source = source;
      this.engine.set(source.kind);
      this.totalFrames.set(source.frameCount);
      const fileFps = info.containerFps ?? source.fps;
      this.fileFps.set(Math.round(fileFps * 100) / 100);
      if (info.captureFps && info.captureFps > fileFps * 1.05) {
        this.captureFps.set(info.captureFps);
        this.fpsSource.set('metadata');
      }
      this.loaded.set(true);
      // Let the canvas render before drawing into it.
      setTimeout(() => this.goTo(0));
    } catch (e) {
      console.error(e);
      this.loadError.set(
        "This browser can't open that video. On iPhone, set Settings › Camera › Formats to Most Compatible and record again, or try another browser.",
      );
    } finally {
      this.loading.set(false);
    }
  }

  reset() {
    this.stopPlay();
    this.abort?.abort();
    clearInterval(this.elapsedTimer);
    this.source?.dispose();
    this.source = null;
    this.loaded.set(false);
    this.info.set(null);
    this.loadError.set(null);
    this.engine.set(null);
    this.totalFrames.set(0);
    this.fileFps.set(null);
    this.captureFps.set(null);
    this.fpsSource.set('file');
    this.editingFps.set(false);
    this.checkAbort?.abort();
    this.fpsCheck.set({ state: 'idle' });
    this.lastCheckKey = '';
    this.currentFrame.set(0);
    this.shownFrame.set(null);
    this.clearMarks();
    this.detecting.set(false);
    this.progress.set(null);
    this.note.set('');
  }

  private clearMarks() {
    this.marks.set({ ...NO_MARKS });
    this.exact.set({});
    this.method.set('manual');
    this.detection.set(null);
    this.detectError.set(null);
    this.savedId.set(null);
  }

  setType(t: JumpType) {
    const wasDrop = this.isDrop();
    this.type.set(t);
    this.savedId.set(null);
    // Drop jumps time different events, so earlier auto-detection no longer applies.
    if (wasDrop !== isDropJump(t) && this.detection()) this.clearMarks();
  }

  // ---------- Frame navigation ----------

  goTo(frame: number) {
    const canvas = this.canvasRef()?.nativeElement;
    if (!this.source || !canvas) return;
    const max = Math.max(0, this.totalFrames() - 1);
    const f = Math.min(max, Math.max(0, Math.round(+frame)));
    this.currentFrame.set(f);
    return this.source.show(f, canvas).then(
      (ok) => {
        if (ok) this.shownFrame.set(f);
        return ok;
      },
      (e) => {
        console.error(e);
        return false;
      },
    );
  }

  step(delta: number) {
    this.stopPlay();
    this.goTo(this.currentFrame() + delta);
  }

  togglePlay() {
    if (this.playing()) {
      this.stopPlay();
      return;
    }
    this.playing.set(true);
    const tick = async () => {
      if (!this.playing()) return;
      const next = this.currentFrame() + 1;
      if (next >= this.totalFrames()) {
        this.stopPlay();
        return;
      }
      const started = performance.now();
      await this.goTo(next);
      // About 30 frames per second on screen: slow motion for high-fps clips.
      this.playTimer = setTimeout(tick, Math.max(0, 33 - (performance.now() - started)));
    };
    tick();
  }

  private stopPlay() {
    this.playing.set(false);
    clearTimeout(this.playTimer);
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    if (!this.loaded() || (e.target as HTMLElement)?.closest('input, textarea, select')) return;
    const big = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowRight' || e.key === '.') this.step(big);
    else if (e.key === 'ArrowLeft' || e.key === ',') this.step(-big);
    else if (e.key === 'a') this.setMark('air');
    else if (e.key === 'l') this.setMark('ground');
    else if (e.key === ' ') this.togglePlay();
    else return;
    e.preventDefault();
  }

  // ---------- Marking ----------

  protected markAt(key: MarkKey) {
    return this.marks()[key];
  }

  protected markOnFrame(frame: number): MarkDef | undefined {
    return this.markDefs().find((d) => this.marks()[d.key] === frame);
  }

  setMark(key: MarkKey, frame = this.currentFrame()) {
    this.marks.update((m) => ({ ...m, [key]: frame }));
    this.touched(key);
  }

  clearMark(key: MarkKey) {
    this.marks.update((m) => ({ ...m, [key]: null }));
    this.touched(key);
  }

  nudge(key: MarkKey, delta: number) {
    const v = this.marks()[key];
    if (v === null) return;
    const next = Math.min(this.totalFrames() - 1, Math.max(0, v + delta));
    this.setMark(key, next);
    this.stopPlay();
    this.goTo(next);
  }

  private touched(key: MarkKey) {
    this.savedId.set(null);
    this.exact.update((e) => {
      const { [key]: _, ...rest } = e;
      return rest;
    });
    if (this.method() === 'auto') this.method.set('auto-adjusted');
  }

  setCaptureFps(v: number | null) {
    const n = Number(v);
    if (!(n > 0)) return;
    this.captureFps.set(n);
    this.fpsSource.set('manual');
    this.savedId.set(null);
    // Let the motion check re-evaluate against the new choice.
    this.lastCheckKey = '';
    this.checkFps();
  }

  /** Accept the frame rate the motion check suggests. */
  useFps(fps: number, source: 'motion' | 'file' = 'motion') {
    this.captureFps.set(fps);
    this.fpsSource.set(source);
    this.savedId.set(null);
    this.fpsCheck.set({ state: 'agrees', fps });
  }

  /** The frame rate the file itself states (slow-mo metadata first). */
  private fileStatedFps(): number | null {
    const info = this.info();
    const f = this.fileFps();
    return info?.captureFps && f && info.captureFps > f * 1.05 ? info.captureFps : f;
  }

  /**
   * Check the frame rate against physics: fit the hips' parabola in the air.
   * Silently fixes slow-motion clips saved at normal speed, unless the user chose a rate.
   */
  async checkFps() {
    const m = this.marks();
    const base = this.fileStatedFps();
    if (!this.source || m.air === null || m.ground === null || !base) return;
    const key = `${m.air}-${m.ground}-${this.fpsSource() === 'manual' ? this.realFps() : ''}`;
    if (key === this.lastCheckKey) return;
    this.lastCheckKey = key;
    this.checkAbort?.abort();
    const abort = (this.checkAbort = new AbortController());
    this.fpsCheck.set({ state: 'running' });

    const total = this.totalFrames();
    const F = m.ground - m.air;
    const pick = (a: number, b: number, n: number) => {
      const out: number[] = [];
      if (b < a) return out;
      const step = Math.max(1, (b - a) / Math.max(1, n - 1));
      for (let x = a; x <= b + 1e-9 && out.length < n; x += step) out.push(Math.round(x));
      return [...new Set(out)];
    };
    const flightFrames = pick(m.air + 1, m.ground - 1, 16);
    // Standing frames: well before the dip, else well after landing.
    let standFrames = pick(0, m.air - Math.ceil(1.5 * F) - 1, 6);
    if (standFrames.length < 3) standFrames = pick(m.ground + Math.ceil(1.5 * F), total - 1, 6);

    try {
      const known = new Map<number, FootSample>((this.detection()?.trace ?? []).map((t) => [t.frame, t]));
      const need = [...flightFrames, ...standFrames].filter((f) => !known.has(f));
      if (need.length) {
        for (const smp of await this.pose.samplePoses(this.source, need, abort.signal)) known.set(smp.frame, smp);
      }
      if (abort.signal.aborted) return;
      const inFlight = [...known.values()].filter((p) => p.frame > m.air! && p.frame < m.ground!);
      const standing = standFrames.map((f) => known.get(f)).filter((p): p is FootSample => !!p);
      const stature = (this.store.settings().statureCm ?? 175) / 100;
      const est = estimateFps(inFlight, standing, stature);
      const r = est ? reconcileFps(base, est) : null;
      console.info('[jump-meter] fps check', { base, est, r });
      if (!r) {
        this.fpsCheck.set({ state: 'unavailable' });
        return;
      }
      const current = this.realFps()!;
      if (Math.abs(Math.log(r.fps / current)) < Math.log(1.1)) {
        this.fpsCheck.set({ state: 'agrees', fps: current });
      } else if (this.fpsSource() === 'manual') {
        this.fpsCheck.set({ state: 'suggest', fps: r.fps });
      } else {
        this.captureFps.set(r.fps);
        this.fpsSource.set(r.agrees ? 'file' : 'motion');
        this.savedId.set(null);
        this.fpsCheck.set(r.agrees ? { state: 'agrees', fps: r.fps } : { state: 'corrected', from: current, to: r.fps });
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        console.warn(e);
        this.fpsCheck.set({ state: 'unavailable' });
      }
    }
  }

  setBox(v: number | null) {
    const n = Number(v);
    this.store.updateSettings({ boxCm: n > 0 ? Math.round(fromUnits(n, this.units()) * 10) / 10 : null });
    this.savedId.set(null);
  }

  setUnits(u: Units) {
    this.store.updateSettings({ units: u });
  }

  // ---------- Auto-detect ----------

  async autoDetect() {
    const fps = this.realFps();
    if (!this.source || !fps || this.detecting()) return;
    this.stopPlay();
    this.abort = new AbortController();
    this.detecting.set(true);
    this.detectError.set(null);
    this.savedId.set(null);
    const t0 = performance.now();
    this.elapsed.set(0);
    this.elapsedTimer = setInterval(() => this.elapsed.set(Math.round((performance.now() - t0) / 1000)), 500);
    try {
      const mode = this.isDrop() ? 'drop' : 'single';
      const r = await this.pose.detect(this.source, fps, mode, (p) => this.progress.set(p), this.abort.signal);
      this.detection.set(r);
      this.marks.set({ start: r.movementStart, contact: r.contact, air: r.firstAir, ground: r.firstGround });
      const ex: Partial<Record<MarkKey, number>> = { air: r.takeoffExact, ground: r.landingExact };
      if (r.contactExact !== null) ex.contact = r.contactExact;
      this.exact.set(ex);
      this.method.set('auto');
      this.goTo(r.firstAir);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      console.error(e);
      this.detectError.set(
        e instanceof DetectionError ? e.message : 'Auto-detect failed on this device. Mark the frames by hand instead.',
      );
    } finally {
      clearInterval(this.elapsedTimer);
      this.detecting.set(false);
      this.progress.set(null);
    }
  }

  cancelDetect() {
    this.abort?.abort();
    clearInterval(this.elapsedTimer);
    this.detecting.set(false);
    this.progress.set(null);
  }

  // ---------- Save ----------

  save() {
    const r = this.result();
    const fps = this.realFps();
    if (!r || !fps || this.orderError()) return;
    const round = (v: number | null, d = 1) => (v === null ? undefined : Math.round(v * 10 ** d) / 10 ** d);
    const rec = this.store.add({
      date: new Date().toISOString(),
      heightCm: round(r.heightCm)!,
      flightMs: round(r.flightMs)!,
      captureFps: fps,
      frames: round(r.frames, 2)!,
      type: this.type(),
      method: this.method(),
      note: this.note().trim() || undefined,
      contactMs: round(r.contactMs),
      rsi: round(r.rsi, 2),
      boxCm: this.isDrop() ? (this.store.settings().boxCm ?? undefined) : undefined,
      timeToTakeoffMs: round(r.tttMs),
      rsiMod: round(r.rsiMod, 2),
    });
    this.savedId.set(rec.id);
    requestPersistentStorage();
    if (this.saveClip()) this.storeClip(rec.id, r.heightCm, r.rsi, r.rsiMod);
  }

  private async storeClip(id: string, heightCm: number, rsiValue: number | null, rsiModValue: number | null) {
    const fps = this.realFps();
    if (!this.source || !fps) return;
    const m = this.marks();
    const labels: Record<MarkKey, string> = {
      start: 'Movement start',
      contact: 'Box landing',
      air: 'Take-off',
      ground: 'Landing',
    };
    const marks = this.markDefs()
      .filter((d) => m[d.key] !== null)
      .map((d) => ({ frame: m[d.key]!, label: labels[d.key] }));
    const u = this.units();
    const value = formatNumber(toUnits(heightCm, u), 1);
    const extra = rsiValue !== null ? `RSI ${rsiValue.toFixed(2)}, ` : rsiModValue !== null ? `RSI-mod ${rsiModValue.toFixed(2)}, ` : '';
    const date = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    this.clipError.set(null);
    this.clipProgress.set(0);
    try {
      const clip = await makeClip({
        source: this.source,
        realFps: fps,
        marks,
        caption: `${value} ${u} ${this.type()}`,
        subcaption: `${extra}${date}`,
        onProgress: (f) => this.clipProgress.set(Math.round(f * 100)),
      });
      await clipStore.put({ id, ...clip, createdAt: new Date().toISOString() });
      this.cloud.schedule(0);
    } catch (e) {
      console.error(e);
      this.clipError.set("The jump is saved, but the video clip couldn't be made on this browser.");
    } finally {
      this.clipProgress.set(null);
    }
  }

  protected progressPct() {
    const p = this.progress();
    if (!p) return 0;
    if (p.stage === 'loading') return 2;
    const base = p.stage === 'scanning' ? 2 : 75;
    const span = p.stage === 'scanning' ? 73 : 25;
    return Math.round(base + (span * p.done) / Math.max(1, p.total));
  }
}
