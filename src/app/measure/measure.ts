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
import { seekToFrame, timeToFrame } from '../core/video-frames';
import { DetectProgress, DetectResult, PoseDetectorService } from '../core/pose-detector.service';
import { DetectionError } from '../core/flight-detect';
import { VaneGauge } from '../shared/vane-gauge';
import { FootTrace } from '../shared/foot-trace';

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
};

@Component({
  selector: 'app-measure',
  imports: [FormsModule, DecimalPipe, RouterLink, VaneGauge, FootTrace],
  templateUrl: './measure.html',
  styleUrl: './measure.scss',
})
export class Measure implements OnDestroy {
  private readonly store = inject(StoreService);
  private readonly pose = inject(PoseDetectorService);

  protected readonly videoRef = viewChild<ElementRef<HTMLVideoElement>>('video');
  protected readonly jumpTypes = JUMP_TYPES;

  // Video
  protected readonly src = signal<string | null>(null);
  protected readonly fileName = signal('');
  protected readonly info = signal<VideoInfo | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly duration = signal(0);
  protected readonly fileFps = signal<number | null>(null);
  protected readonly captureFps = signal<number | null>(null);
  protected readonly currentFrame = signal(0);
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
  private abort?: AbortController;

  // Save
  protected readonly type = signal<JumpType>(this.store.settings().defaultType);
  protected readonly note = signal('');
  protected readonly savedId = signal<string | null>(null);

  protected readonly totalFrames = computed(() => {
    const fps = this.fileFps();
    const fc = this.info()?.frameCount;
    if (fc) return fc;
    return fps && this.duration() ? Math.floor(this.duration() * fps) : 0;
  });

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

  private objectUrl: string | null = null;
  private seekChain: Promise<void> = Promise.resolve();
  private targetFrame = 0;

  constructor() {
    this.pose.preload();
  }

  ngOnDestroy() {
    this.abort?.abort();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }

  // ---------- Loading ----------

  async onFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.reset();
    this.fileName.set(file.name);
    const info = await readVideoInfo(file);
    this.info.set(info);
    this.fileFps.set(info.containerFps ? Math.round(info.containerFps * 100) / 100 : null);
    this.captureFps.set(info.captureFps && info.containerFps && info.captureFps > info.containerFps * 1.05 ? info.captureFps : null);
    this.objectUrl = URL.createObjectURL(file);
    this.src.set(this.objectUrl);
  }

  onLoadedMetadata() {
    const v = this.videoRef()?.nativeElement;
    if (!v) return;
    this.duration.set(v.duration);
    this.goTo(0);
  }

  onVideoError() {
    this.loadError.set(
      "This browser can't play that video. iPhone HEVC clips may need 'Most Compatible' (Settings › Camera › Formats), or try Safari/Chrome.",
    );
  }

  reset() {
    this.abort?.abort();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.src.set(null);
    this.info.set(null);
    this.loadError.set(null);
    this.duration.set(0);
    this.fileFps.set(null);
    this.captureFps.set(null);
    this.currentFrame.set(0);
    this.playing.set(false);
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
    const v = this.videoRef()?.nativeElement;
    const fps = this.fileFps();
    if (!v || !fps) return;
    const max = Math.max(0, this.totalFrames() - 1);
    const f = Math.min(max, Math.max(0, Math.round(frame)));
    if (!v.paused) v.pause();
    this.targetFrame = f;
    this.currentFrame.set(f);
    // Collapse rapid taps/scrubs into the latest target.
    this.seekChain = this.seekChain.then(() => (this.targetFrame === f ? seekToFrame(v, f, fps) : undefined));
  }

  step(delta: number) {
    this.goTo(this.currentFrame() + delta);
  }

  togglePlay() {
    const v = this.videoRef()?.nativeElement as FrameCallbackVideo | undefined;
    const fps = this.fileFps();
    if (!v || !fps) return;
    if (!v.paused) {
      v.pause();
      return;
    }
    v.play();
    const tick = () => {
      if (v.paused) return;
      this.currentFrame.set(timeToFrame(v.currentTime, fps));
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };
    tick();
  }

  onPause() {
    this.playing.set(false);
    const v = this.videoRef()?.nativeElement;
    const fps = this.fileFps();
    if (v && fps) this.goTo(timeToFrame(v.currentTime, fps));
  }

  @HostListener('window:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    if (!this.src() || (e.target as HTMLElement)?.closest('input, textarea, select')) return;
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
    s.set(v + delta);
    this.goTo(v + delta);
    this.touchedMarks();
  }

  private touchedMarks() {
    this.savedId.set(null);
    this.exactFrames.set(null);
    if (this.method() === 'auto') this.method.set('auto-adjusted');
  }

  setFileFps(v: number | null) {
    this.fileFps.set(v && v > 0 ? v : null);
    this.savedId.set(null);
  }

  setCaptureFps(v: number | null) {
    this.captureFps.set(v && v > 0 ? v : null);
    this.savedId.set(null);
  }

  // ---------- Auto-detect ----------

  async autoDetect() {
    const v = this.videoRef()?.nativeElement;
    const fps = this.fileFps();
    if (!v || !fps || this.detecting()) return;
    this.abort = new AbortController();
    this.detecting.set(true);
    this.detectError.set(null);
    this.savedId.set(null);
    try {
      const r = await this.pose.detect(v, fps, this.totalFrames(), (p) => this.progress.set(p), this.abort.signal);
      this.detection.set(r);
      this.firstAir.set(r.firstAir);
      this.firstGround.set(r.firstGround);
      this.exactFrames.set(r.landingExact - r.takeoffExact);
      this.method.set('auto');
      this.goTo(r.firstAir);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      this.detectError.set(
        e instanceof DetectionError ? e.message : 'Auto-detect failed on this device. Mark the frames by hand instead.',
      );
      console.error(e);
    } finally {
      this.detecting.set(false);
      this.progress.set(null);
    }
  }

  cancelDetect() {
    this.abort?.abort();
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
    if (p.stage === 'loading') return 3;
    const base = p.stage === 'scanning' ? 0 : 70;
    const span = p.stage === 'scanning' ? 70 : 30;
    return Math.round(base + (span * p.done) / Math.max(1, p.total));
  }

  protected frameTimeMs(frame: number) {
    const fps = this.realFps();
    return fps ? (frame / fps) * 1000 : 0;
  }
}
