import { Component, ElementRef, HostListener, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  JUMP_TYPES,
  JumpType,
  heightFromFlight,
  heightUncertaintyCm,
  sayersPower,
  takeoffVelocity,
} from '../core/jump-math';
import { readVideoInfo, VideoInfo } from '../core/mp4-info';
import { StoreService } from '../core/store.service';
import { FrameSource, openFrameSource } from '../core/frame-source';
import { DetectProgress, DetectResult, PoseDetectorService } from '../core/pose-detector.service';
import { DetectionError } from '../core/flight-detect';
import { VaneGauge } from '../shared/vane-gauge';
import { FootTrace } from '../shared/foot-trace';

@Component({
  selector: 'app-measure',
  imports: [FormsModule, DecimalPipe, RouterLink, VaneGauge, FootTrace],
  templateUrl: './measure.html',
  styleUrl: './measure.scss',
})
export class Measure implements OnDestroy {
  private readonly store = inject(StoreService);
  private readonly pose = inject(PoseDetectorService);

  protected readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('frame');
  protected readonly jumpTypes = JUMP_TYPES;

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
  protected readonly currentFrame = signal(0);
  protected readonly shownFrame = signal<number | null>(null);
  protected readonly playing = signal(false);

  // Marks
  protected readonly firstAir = signal<number | null>(null);
  protected readonly firstGround = signal<number | null>(null);
  /** Sub-frame flight length from auto-detection; cleared on manual edits. */
  protected readonly exactFrames = signal<number | null>(null);
  protected readonly method = signal<'manual' | 'auto' | 'auto-adjusted'>('manual');

  // Auto-detect
  protected readonly detecting = signal(false);
  protected readonly progress = signal<DetectProgress | null>(null);
  protected readonly detectError = signal<string | null>(null);
  protected readonly detection = signal<DetectResult | null>(null);
  protected readonly elapsed = signal(0);
  private abort?: AbortController;

  // Save
  protected readonly type = signal<JumpType>(this.store.settings().defaultType);
  protected readonly note = signal('');
  protected readonly savedId = signal<string | null>(null);

  protected readonly realFps = computed(() => this.captureFps() ?? this.fileFps());
  protected readonly isSlowedDown = computed(() => {
    const f = this.fileFps();
    const c = this.realFps();
    return !!f && !!c && c > f * 1.05;
  });
  protected readonly lowFps = computed(() => (this.realFps() ?? 0) > 0 && (this.realFps() ?? 0) < 100);

  protected readonly flightFrames = computed(() => {
    const a = this.firstAir();
    const g = this.firstGround();
    if (a === null || g === null || g <= a) return null;
    return this.exactFrames() ?? g - a;
  });

  protected readonly result = computed(() => {
    const frames = this.flightFrames();
    const fps = this.realFps();
    if (frames === null || !fps) return null;
    const flight = frames / fps;
    const heightCm = heightFromFlight(flight) * 100;
    const mass = this.store.settings().massKg;
    return {
      flightMs: flight * 1000,
      heightCm,
      velocity: takeoffVelocity(flight),
      errCm: heightUncertaintyCm(flight, fps) * (this.exactFrames() !== null ? 0.5 : 1),
      powerW: mass ? sayersPower(heightCm, mass) : null,
      frames,
      implausible: flight < 0.15 || flight > 1.1,
    };
  });

  protected readonly best = computed(() => this.store.bestFor(this.type()));

  private source: FrameSource | null = null;
  private playTimer?: ReturnType<typeof setTimeout>;
  private elapsedTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.pose.preload();
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
      if (info.captureFps && info.captureFps > fileFps * 1.05) this.captureFps.set(info.captureFps);
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
    this.currentFrame.set(0);
    this.shownFrame.set(null);
    this.firstAir.set(null);
    this.firstGround.set(null);
    this.exactFrames.set(null);
    this.method.set('manual');
    this.detecting.set(false);
    this.detectError.set(null);
    this.detection.set(null);
    this.progress.set(null);
    this.note.set('');
    this.savedId.set(null);
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
    else if (e.key === 'a') this.markAir();
    else if (e.key === 'l') this.markGround();
    else if (e.key === ' ') this.togglePlay();
    else return;
    e.preventDefault();
  }

  // ---------- Marking ----------

  markAir() {
    this.firstAir.set(this.currentFrame());
    this.touchedMarks();
  }

  markGround() {
    this.firstGround.set(this.currentFrame());
    this.touchedMarks();
  }

  nudge(which: 'air' | 'ground', delta: number) {
    const s = which === 'air' ? this.firstAir : this.firstGround;
    const v = s();
    if (v === null) return;
    const next = Math.min(this.totalFrames() - 1, Math.max(0, v + delta));
    s.set(next);
    this.stopPlay();
    this.goTo(next);
    this.touchedMarks();
  }

  private touchedMarks() {
    this.savedId.set(null);
    this.exactFrames.set(null);
    if (this.method() === 'auto') this.method.set('auto-adjusted');
  }

  setCaptureFps(v: number | null) {
    const n = Number(v);
    this.captureFps.set(n > 0 ? n : null);
    this.savedId.set(null);
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
      const r = await this.pose.detect(this.source, fps, (p) => this.progress.set(p), this.abort.signal);
      this.detection.set(r);
      this.firstAir.set(r.firstAir);
      this.firstGround.set(r.firstGround);
      this.exactFrames.set(r.landingExact - r.takeoffExact);
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
    if (!r || !fps) return;
    const rec = this.store.add({
      date: new Date().toISOString(),
      heightCm: Math.round(r.heightCm * 10) / 10,
      flightMs: Math.round(r.flightMs * 10) / 10,
      captureFps: fps,
      frames: Math.round(r.frames * 100) / 100,
      type: this.type(),
      method: this.method(),
      note: this.note().trim() || undefined,
    });
    this.savedId.set(rec.id);
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
