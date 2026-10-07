import { Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  G,
  Hop,
  JUMP_TYPE_HINT,
  JUMP_TYPES,
  JumpType,
  Units,
  isDistanceType,
  isRepeated,
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
import { Recorder, Recording } from './recorder';
import { TagPicker } from '../shared/tag-picker';
import { FeedbackService } from '../core/feedback.service';
import { cardDataFor, drawShareCard, shareImage } from '../core/share-card';
import type { JumpRecord } from '../core/jump-math';
import { groupSessions, isPersonalRecord, milestonesCrossed, readiness, sessionIdFor } from '../core/insights';
import { uuid } from '../core/store.service';
import {
  HopEvent,
  best5Rsi,
  confidenceOf,
  detectArmSwing,
  footVisibility,
  hopsToStats,
  kinematics,
  metresPerUnit,
  postureCheck,
  scaledDistanceCm,
} from '../core/pose-analysis';

interface Pt {
  x: number;
  y: number;
}
type TapTarget = 'calA' | 'calB' | 'p1' | 'p2';

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
  imports: [FormsModule, DecimalPipe, RouterLink, VaneGauge, FootTrace, HeightPipe, Recorder, TagPicker],
  templateUrl: './measure.html',
  styleUrl: './measure.scss',
})
export class Measure implements OnDestroy {
  protected readonly store = inject(StoreService);
  protected readonly cloud = inject(CloudService);
  private readonly pose = inject(PoseDetectorService);
  private readonly feedback = inject(FeedbackService);

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
  protected readonly isRep = computed(() => isRepeated(this.type()));
  protected readonly isDist = computed(() => isDistanceType(this.type()));
  protected readonly markDefs = computed<MarkDef[]>(() =>
    this.isDrop()
      ? [MARKS.contact, MARKS.air, MARKS.ground]
      : this.isRep()
        ? [MARKS.air, MARKS.ground]
        : [MARKS.start, MARKS.air, MARKS.ground],
  );

  // Repeated jumps: every hop, as sub-frame take-off/landing instants.
  protected readonly hopEvents = signal<HopEvent[]>([]);
  protected readonly hopTrace = signal<{ trace: FootSample[]; floor: number } | null>(null);
  protected readonly hops = computed<Hop[]>(() => {
    const ev = this.hopEvents();
    if (!ev.length || !this.realFps()) return [];
    return hopsToStats(ev, (a, b) => this.realSeconds(a, b));
  });
  /** Hops that count towards the best-5 score. */
  protected readonly bestHopIdx = computed(() => {
    const ranked = this.hops()
      .map((h, i) => ({ h, i }))
      .filter((x) => x.h.rsi !== null)
      .sort((a, b) => b.h.rsi! - a.h.rsi!);
    return new Set(ranked.slice(0, 5).map((x) => x.i));
  });

  // Pose samples around the marks, for technique analysis.
  private readonly poseSamples = signal<Map<number, FootSample>>(new Map());
  private readonly standFrames = signal<number[]>([]);
  protected readonly videoSize = signal<{ w: number; h: number } | null>(null);

  // Distance tool (broad jump, jump & reach). Points are in video pixels.
  protected readonly tapping = signal<TapTarget | null>(null);
  protected readonly pts = signal<Partial<Record<TapTarget, Pt>>>({});
  /** Length of the reference object, cm. */
  protected readonly calCm = signal<number | null>(100);
  protected readonly scaleMode = signal<'object' | 'body'>('object');

  // Auto-detect
  protected readonly detecting = signal(false);
  protected readonly progress = signal<DetectProgress | null>(null);
  protected readonly detectError = signal<string | null>(null);
  protected readonly detection = signal<DetectResult | null>(null);
  protected readonly elapsed = signal(0);
  private abort?: AbortController;

  // Camera
  protected readonly cameraOpen = signal(false);
  protected readonly live = signal(false);

  // When the jump happened (drives the progress chart), and where that came from.
  protected readonly jumpDate = signal<string>(new Date().toISOString());
  protected readonly dateSource = signal<'video' | 'file' | 'live' | 'unknown' | 'resaved' | 'manual'>('unknown');
  /** The date needs the user's attention before saving. */
  protected readonly dateUncertain = computed(() => this.dateSource() === 'unknown' || this.dateSource() === 'resaved');
  protected readonly jumpDateLocal = computed(() => toLocalInput(this.jumpDate()));

  // Save
  protected readonly note = signal('');
  protected readonly savedId = signal<string | null>(null);
  protected readonly saveClip = signal(true);
  protected readonly tags = signal<string[]>([]);
  protected readonly refOpen = signal(false);
  protected readonly refValue = signal<number | null>(null);
  protected readonly refDevice = signal('');
  /** Shown after saving: new record, milestones, today's readiness. */
  protected readonly celebration = signal<{ pr: boolean; gainCm: number | null; milestones: number[]; readiness: string | null } | null>(null);
  protected readonly clipProgress = signal<number | null>(null);
  /** Share card for the jump just saved, drawn ahead so sharing opens instantly. */
  protected readonly card = signal<Blob | null>(null);
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
    if (this.isRep()) return fps ? this.repeatResult(fps) : null;
    const air = this.at('air');
    const ground = this.at('ground');
    if (!fps || air === null || ground === null || ground <= air) return null;
    const frames = ground - air;
    const flight = this.realSeconds(air, ground);
    const heightCm = heightFromFlight(flight) * 100;
    const mass = this.store.settings().massKg;

    let contactMs: number | null = null;
    let rsiValue: number | null = null;
    let fctRatio: number | null = null;
    const contact = this.at('contact');
    if (this.isDrop() && contact !== null && air > contact) {
      const ct = this.realSeconds(contact, air);
      contactMs = ct * 1000;
      rsiValue = rsi(heightCm, ct);
      fctRatio = flight / ct;
    }

    let tttMs: number | null = null;
    let rsiModValue: number | null = null;
    const start = this.marks().start;
    if (!this.isDrop() && start !== null && air > start) {
      const ttt = this.realSeconds(start, air);
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

  /**
   * Real-world seconds between two (possibly fractional) frame positions. Uses the
   * frames' own timestamps, so uneven timing in live recordings is handled, then scales
   * file time to real time for slow-motion clips saved at normal speed.
   */
  private realSeconds(from: number, to: number): number {
    const fps = this.realFps()!;
    const fileFps = this.fileFps();
    this.loaded(); // re-evaluate when a new video loads
    if (!this.source || !fileFps) return (to - from) / fps;
    const fileTime = this.source.timeAt(to) - this.source.timeAt(from);
    return fileTime * (fileFps / fps);
  }

  /** 10/5 score: the best five hops by RSI. */
  private repeatResult(fps: number) {
    const b = best5Rsi(this.hops());
    if (!b) return null;
    const flight = Math.sqrt((8 * b.heightCm) / 100 / G);
    const exact = this.method() === 'auto';
    return {
      flightMs: flight * 1000,
      heightCm: b.heightCm,
      velocity: takeoffVelocity(flight),
      errCm: heightUncertaintyCm(flight, fps) * (exact ? 0.5 : 1),
      powerW: null as number | null,
      frames: flight * fps,
      contactMs: b.contactMs as number | null,
      rsi: b.rsi as number | null,
      fctRatio: b.contactMs > 0 ? flight / (b.contactMs / 1000) : null,
      tttMs: null as number | null,
      rsiMod: null as number | null,
      implausible: b.contactMs < 80 || b.contactMs > 1000,
    };
  }

  /** Metres per normalised image unit, from body size while standing. */
  private readonly bodyScale = computed(() => {
    const smp = this.poseSamples();
    const standing = this.standFrames()
      .map((f) => smp.get(f))
      .filter((s): s is FootSample => !!s);
    return metresPerUnit(standing, (this.store.settings().statureCm ?? 175) / 100);
  });

  /** Technique and quality from the pose: landing, arm swing, movement phases, confidence. */
  protected readonly deep = computed(() => {
    const r = this.result();
    const fps = this.realFps();
    const size = this.videoSize();
    if (!r || !fps || !size) return null;
    const smp = this.poseSamples();
    const m = this.marks();
    const exactBoth = this.exact().air !== undefined && this.exact().ground !== undefined;

    if (this.isRep()) {
      const vis = footVisibility(this.hopTrace()?.trace ?? []);
      return {
        posture: null,
        armSwing: null,
        kinematics: null,
        confidence: confidenceOf({
          fps, auto: this.method() === 'auto', subFrame: this.method() === 'auto', fpsCheck: 'idle',
          poseVisibility: vis, postureFlagged: false, implausible: r.implausible,
        }),
      };
    }
    if (m.air === null || m.ground === null) return null;
    const S = this.bodyScale();
    const aspect = size.w / size.h;
    const takeoff = smp.get(m.air - 1);
    const landing = smp.get(m.ground);
    const flightSec = r.flightMs / 1000;
    const posture =
      takeoff && landing && this.type() !== 'Broad jump' ? postureCheck(takeoff, landing, flightSec, S, aspect) : null;
    const sorted = [...smp.values()].sort((a, b) => a.frame - b.frame);
    const F = m.ground - m.air;
    const armWindow = sorted.filter((s) => s.frame >= m.air! - fps * 0.6 && s.frame <= m.air! + F * 0.3);
    const armSwing = this.isDrop() ? null : detectArmSwing(armWindow);
    const pre = sorted.filter((s) => s.frame < m.air! && s.frame >= m.air! - fps * 1.6);
    const kin =
      !this.isDrop() && this.type() !== 'Broad jump' && pre.length >= 5
        ? kinematics({
            samples: pre,
            movementStart: m.start,
            takeoffFrame: this.at('air')!,
            timeOf: (f) => this.realSeconds(0, f),
            metresPerUnit: S,
            flightSec,
            massKg: this.store.settings().massKg,
          })
        : null;
    const state = this.fpsCheck().state;
    const confidence = confidenceOf({
      fps,
      auto: this.method() === 'auto',
      subFrame: exactBoth,
      fpsCheck: state,
      poseVisibility: footVisibility([takeoff, landing].filter((s): s is FootSample => !!s)),
      postureFlagged: !!posture?.flagged,
      implausible: r.implausible,
    });
    return { posture, armSwing, kinematics: kin, confidence };
  });

  // ---------- Distance ----------

  protected readonly cmPerPx = computed(() => {
    const size = this.videoSize();
    if (!size) return null;
    if (this.scaleMode() === 'body') {
      const S = this.bodyScale();
      return S ? (S * 100) / size.h : null;
    }
    const p = this.pts();
    const L = this.calCm();
    if (!p.calA || !p.calB || !L || L <= 0) return null;
    const d = Math.hypot(p.calB.x - p.calA.x, p.calB.y - p.calA.y);
    return d > 4 ? L / d : null;
  });

  /** Broad jump: horizontal distance. Jump & reach: vertical gain of the fingertips. */
  protected readonly distanceCm = computed(() => {
    const p = this.pts();
    const s = this.cmPerPx();
    if (!this.isDist() || !p.p1 || !p.p2 || !s) return null;
    return scaledDistanceCm(p.p1, p.p2, s, this.type() === 'Broad jump' ? 'x' : 'y');
  });

  protected readonly calInUnits = computed(() => {
    const cm = this.calCm();
    return cm === null ? null : Math.round(toUnits(cm, this.units()) * 10) / 10;
  });

  setCal(v: number | null) {
    const n = Number(v);
    this.calCm.set(n > 0 ? fromUnits(n, this.units()) : null);
    this.savedId.set(null);
  }

  /** Arm the next tap on the video to set this point. Jumps to the relevant frame. */
  startTap(t: TapTarget) {
    this.stopPlay();
    this.tapping.set(this.tapping() === t ? null : t);
    if (this.type() === 'Broad jump') {
      if (t === 'p1' && this.marks().air !== null) this.goTo(Math.max(0, this.marks().air! - 1));
      if (t === 'p2' && this.marks().ground !== null) this.goTo(this.marks().ground!);
    } else if (this.type() === 'Jump & reach' && t === 'p2') {
      const m = this.marks();
      if (m.air !== null && m.ground !== null) this.goTo(Math.round((m.air + m.ground) / 2));
    }
  }

  onStageTap(ev: MouseEvent) {
    const t = this.tapping();
    const size = this.videoSize();
    if (!t || !size) return;
    const rect = (ev.currentTarget as Element).getBoundingClientRect();
    const pt = {
      x: ((ev.clientX - rect.left) / rect.width) * size.w,
      y: ((ev.clientY - rect.top) / rect.height) * size.h,
    };
    this.pts.update((p) => ({ ...p, [t]: pt }));
    this.tapping.set(t === 'calA' ? 'calB' : null);
    this.savedId.set(null);
  }

  protected readonly tapPrompt = computed(() => {
    const t = this.tapping();
    const broad = this.type() === 'Broad jump';
    switch (t) {
      case 'calA':
        return 'Tap one end of the object you know the length of.';
      case 'calB':
        return 'Now tap the other end.';
      case 'p1':
        return broad ? 'Tap the tip of your toes at take-off.' : 'Tap your fingertips while standing with your arm stretched up.';
      case 'p2':
        return broad
          ? 'Tap the back of your heel that landed closest to the start.'
          : 'Step to your highest point and tap your fingertips.';
      default:
        return null;
    }
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
      timer = setTimeout(() => untracked(() => this.analyse()), 700);
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
    if (file) await this.loadFile(file);
  }

  onRecorded(r: Recording) {
    this.cameraOpen.set(false);
    this.loadFile(r.file, r);
  }

  private async loadFile(file: File, live?: Recording) {
    this.reset();
    this.fileName.set(live ? 'Camera recording' : file.name);
    this.live.set(!!live);
    this.loading.set(true);
    try {
      const info = await readVideoInfo(file);
      this.info.set(info);
      this.setDetectedDate(file, info.recordedAt, live?.recordedAt);
      const source = await openFrameSource(file, live?.fps ?? info.containerFps);
      this.source = source;
      this.engine.set(source.kind);
      this.totalFrames.set(source.frameCount);
      this.videoSize.set(source.width && source.height ? { w: source.width, h: source.height } : null);
      // Live recordings have uneven frame timing; the camera's rate is the honest figure.
      const fileFps = live?.fps ?? info.containerFps ?? source.fps;
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
    this.live.set(false);
    this.jumpDate.set(new Date().toISOString());
    this.dateSource.set('unknown');
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
    this.celebration.set(null);
    this.refValue.set(null);
    this.refOpen.set(false);
    this.videoSize.set(null);
    this.poseSamples.set(new Map());
    this.standFrames.set([]);
    this.pts.set({});
    this.tapping.set(null);
    this.scaleMode.set('object');
  }

  private clearMarks() {
    this.marks.set({ ...NO_MARKS });
    this.exact.set({});
    this.method.set('manual');
    this.detection.set(null);
    this.detectError.set(null);
    this.savedId.set(null);
    this.hopEvents.set([]);
    this.hopTrace.set(null);
  }

  setType(t: JumpType) {
    const wasDrop = this.isDrop();
    const wasRep = this.isRep();
    this.type.set(t);
    this.savedId.set(null);
    this.tapping.set(null);
    // Drop jumps and hop tests time different events, so earlier detection no longer applies.
    if ((wasDrop !== isDropJump(t) || wasRep !== isRepeated(t)) && (this.detection() || this.hopEvents().length)) {
      this.clearMarks();
    }
  }

  /** Repeated jumps, by hand: mark a take-off and landing, then add it as a hop. */
  addHop() {
    const a = this.at('air');
    const g = this.at('ground');
    if (a === null || g === null || g <= a) return;
    this.hopEvents.update((ev) => [...ev, { takeoff: a, landing: g }].sort((x, y) => x.takeoff - y.takeoff));
    this.marks.update((m) => ({ ...m, air: null, ground: null }));
    this.exact.set({});
    if (this.method() === 'auto') this.method.set('auto-adjusted');
    this.savedId.set(null);
  }

  removeHop(i: number) {
    this.hopEvents.update((ev) => ev.filter((_, k) => k !== i));
    if (this.method() === 'auto') this.method.set('auto-adjusted');
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

  /** Date of the jump: when it was filmed if the video says so, else a best guess. */
  private setDetectedDate(file: File, fromVideo: string | null, liveAt?: string) {
    if (liveAt) {
      this.jumpDate.set(liveAt);
      this.dateSource.set('live');
    } else if (fromVideo && !isJustNow(fromVideo)) {
      this.jumpDate.set(fromVideo);
      this.dateSource.set('video');
    } else if (fromVideo) {
      // iPhone re-saves videos picked from Photos and stamps the copy with the current time,
      // so a "filmed" time of just now really means the real date was lost.
      this.jumpDate.set(new Date().toISOString());
      this.dateSource.set('resaved');
    } else if (file.lastModified && !isJustNow(new Date(file.lastModified).toISOString())) {
      // Phones often give picked videos a fresh timestamp, so only trust one that's clearly older.
      this.jumpDate.set(new Date(file.lastModified).toISOString());
      this.dateSource.set('file');
    } else {
      this.jumpDate.set(new Date().toISOString());
      this.dateSource.set('unknown');
    }
  }

  setJumpDate(local: string) {
    const d = new Date(local);
    if (isNaN(d.getTime())) return;
    this.jumpDate.set(d.toISOString());
    this.dateSource.set('manual');
    this.savedId.set(null);
  }

  setCaptureFps(v: number | null) {
    const n = Number(v);
    if (!(n > 0)) return;
    this.captureFps.set(n);
    this.fpsSource.set('manual');
    this.savedId.set(null);
    // Let the motion check re-evaluate against the new choice.
    this.lastCheckKey = '';
    this.analyse();
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
  async analyse() {
    const m = this.marks();
    const base = this.fileStatedFps();
    if (!this.source || m.air === null || m.ground === null || !base || this.isRep()) return;
    const key = `${m.start}-${m.air}-${m.ground}-${this.fpsSource() === 'manual' ? this.realFps() : ''}`;
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
    // Technique: take-off and touchdown poses, and the push-off before take-off.
    const fpsNow = this.realFps() ?? base;
    const pushFrom = Math.max(
      0,
      Math.min(m.start ?? Infinity, m.air - Math.round(fpsNow * 1.1)) - Math.round(fpsNow * 0.15),
    );
    const technique = [
      Math.max(0, m.air - 1),
      m.ground,
      ...pick(pushFrom, m.air - 1, 26),
      ...pick(m.air, m.air + Math.round(F * 0.3), 3),
    ];
    this.standFrames.set(standFrames);

    try {
      const known = new Map<number, FootSample>(this.poseSamples());
      for (const t of this.detection()?.trace ?? []) if (t.pts && !known.has(t.frame)) known.set(t.frame, t);
      const need = [...new Set([...flightFrames, ...standFrames, ...technique])].filter((f) => !known.has(f));
      if (need.length) {
        for (const smp of await this.pose.samplePoses(this.source, need, abort.signal)) known.set(smp.frame, smp);
      }
      if (abort.signal.aborted) return;
      this.poseSamples.set(new Map(known));
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
    this.feedback.unlock();
    this.abort = new AbortController();
    this.detecting.set(true);
    this.detectError.set(null);
    this.savedId.set(null);
    const t0 = performance.now();
    this.elapsed.set(0);
    this.elapsedTimer = setInterval(() => this.elapsed.set(Math.round((performance.now() - t0) / 1000)), 500);
    try {
      if (this.isRep()) {
        const r = await this.pose.detectHops(this.source, fps, (p) => this.progress.set(p), this.abort.signal);
        this.hopEvents.set(r.events);
        this.hopTrace.set({ trace: r.trace, floor: r.floor });
        this.marks.set({ ...NO_MARKS });
        this.exact.set({});
        this.method.set('auto');
        this.feedback.cue('detected');
        this.goTo(Math.floor(r.events[0].takeoff));
        return;
      }
      const mode = this.isDrop() ? 'drop' : 'single';
      const r = await this.pose.detect(this.source, fps, mode, (p) => this.progress.set(p), this.abort.signal);
      this.detection.set(r);
      this.marks.set({ start: r.movementStart, contact: r.contact, air: r.firstAir, ground: r.firstGround });
      const ex: Partial<Record<MarkKey, number>> = { air: r.takeoffExact, ground: r.landingExact };
      if (r.contactExact !== null) ex.contact = r.contactExact;
      this.exact.set(ex);
      this.method.set('auto');
      this.feedback.cue('detected');
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
    const before = this.store.history();
    const dist = this.distanceCm();
    const byDistance = this.type() === 'Broad jump' && dist !== null;
    const metric = byDistance ? 'distanceCm' : 'heightCm';
    const prevBest = Math.max(0, ...before.filter((x) => x.type === this.type()).map((x) => x[metric] ?? 0));
    const ref = Number(this.refValue());
    const deep = this.deep();
    const rec = this.store.add({
      date: this.jumpDate(),
      sessionId: sessionIdFor(before, this.jumpDate()) ?? uuid(),
      tags: this.tags().length ? this.tags() : undefined,
      reference:
        ref > 0
          ? { heightCm: Math.round(fromUnits(ref, this.units()) * 10) / 10, device: this.refDevice().trim() || 'Other device' }
          : undefined,
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
      posture: deep?.posture ?? undefined,
      armSwing: deep?.armSwing ?? undefined,
      confidence: deep?.confidence,
      kinematics: deep?.kinematics ?? undefined,
      hops: this.isRep() ? this.hops() : undefined,
      distanceCm: dist !== null && this.type() === 'Broad jump' ? round(dist) : undefined,
      reachCm: dist !== null && this.type() === 'Jump & reach' ? round(dist) : undefined,
    });
    this.savedId.set(rec.id);
    requestPersistentStorage();
    const all = this.store.history();
    const pr = isPersonalRecord(all, rec, metric);
    const sessions = groupSessions(all, this.type(), 'heightCm', this.store.settings().sessionScore);
    const rd = readiness(sessions);
    const status = rd && sessions.at(-1)?.jumps.some((j) => j.id === rec.id)
      ? `${rd.diffPct > 0 ? '+' : ''}${rd.diffPct.toFixed(1)}% vs your baseline (${{ fresh: 'fresh', normal: 'normal', 'slightly-down': 'slightly down', fatigued: 'fatigued' }[rd.status]})`
      : null;
    this.celebration.set({
      pr,
      gainCm: pr && prevBest > 0 ? (rec[metric] ?? 0) - prevBest : null,
      milestones: byDistance ? [] : milestonesCrossed(all, rec, this.units()),
      readiness: status,
    });
    this.feedback.cue(pr ? 'record' : 'saved');
    this.card.set(null);
    const clipDone = this.saveClip() ? this.storeClip(rec.id, byDistance ? dist! : r.heightCm, r.rsi, r.rsiMod) : Promise.resolve();
    clipDone.then(() => this.prepareCard(rec, pr));
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
    const marks = this.isRep()
      ? this.hopEvents().map((e, i) => ({ frame: Math.round(e.takeoff), label: `Hop ${i + 1}` }))
      : this.markDefs()
          .filter((d) => m[d.key] !== null)
          .map((d) => ({ frame: m[d.key]!, label: labels[d.key] }));
    const u = this.units();
    const value = formatNumber(toUnits(heightCm, u), 1);
    const extra = this.isRep() && rsiValue !== null ? `RSI ${rsiValue.toFixed(2)} (best 5 of ${this.hops().length} hops), ` : rsiValue !== null ? `RSI ${rsiValue.toFixed(2)}, ` : rsiModValue !== null ? `RSI-mod ${rsiModValue.toFixed(2)}, ` : '';
    const date = new Date(this.jumpDate()).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
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

  private async prepareCard(rec: JumpRecord, pr: boolean) {
    try {
      // A clean frame just before take-off; the clip poster (with its caption bar) as a fallback.
      let image: Blob | HTMLCanvasElement | null = null;
      let captioned = false;
      const ev = this.hopEvents()[0];
      const f = this.marks().air ?? (ev ? Math.floor(ev.takeoff) : null);
      if (this.source && f !== null) {
        const c = document.createElement('canvas');
        if (await this.source.show(Math.max(0, f - 1), c).catch(() => false)) image = c;
      }
      if (!image) {
        image = (await clipStore.get(rec.id).catch(() => undefined))?.poster ?? null;
        captioned = !!image;
      }
      const blob = await drawShareCard(
        cardDataFor(rec, this.units(), { pr, name: this.cloud.user() ? this.cloud.shownName() : null, image, captioned }),
      );
      if (this.savedId() === rec.id) this.card.set(blob);
    } catch (e) {
      console.warn('[jump-meter] share card failed', e);
    }
  }

  async shareCard() {
    const blob = this.card();
    const rec = this.store.history().find((r) => r.id === this.savedId());
    if (blob && rec) await shareImage(blob, `jump-${rec.date.slice(0, 10)}.png`, 'My jump');
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

/** ISO → value for <input type="datetime-local"> in the user's time zone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Within 15 minutes of now: a timestamp from re-saving the file, not from filming. */
function isJustNow(iso: string): boolean {
  return Math.abs(Date.now() - new Date(iso).getTime()) < 15 * 60_000;
}
