import { Component, ElementRef, OnDestroy, OnInit, computed, inject, output, signal, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { PoseDetectorService } from '../core/pose-detector.service';
import { FeedbackService } from '../core/feedback.service';
import { framingOf, isStill, JumpWatcher } from '../core/framing';
import { median, type FootSample, type Joint } from '../core/flight-detect';

const BONES: [Joint, Joint][] = [
  ['shoulderL', 'shoulderR'], ['hipL', 'hipR'], ['shoulderL', 'hipL'], ['shoulderR', 'hipR'],
  ['hipL', 'kneeL'], ['kneeL', 'ankleL'], ['ankleL', 'heelL'], ['heelL', 'toeL'], ['ankleL', 'toeL'],
  ['hipR', 'kneeR'], ['kneeR', 'ankleR'], ['ankleR', 'heelR'], ['heelR', 'toeR'], ['ankleR', 'toeR'],
  ['shoulderL', 'wristL'], ['shoulderR', 'wristR'],
];
const HANDS_FREE_KEY = 'jump-meter.handsfree';

export interface Recording {
  file: File;
  /** When recording started (ISO). */
  recordedAt: string;
  /** Frame rate the camera actually delivered. */
  fps: number | null;
}

interface CameraMode {
  width: number;
  height: number;
  fps: number;
}

/**
 * In-app camera, tuned for timing jumps: asks for the highest frame rate the camera
 * offers at 720p or better, and records at a high bitrate. (The file picker's
 * "Take Video" option records at medium quality, which websites can't change.)
 */
@Component({
  selector: 'app-recorder',
  template: `
    <div class="rec">
      <div class="view">
        <video #preview playsinline muted autoplay></video>
        @if (guide() && size(); as v) {
          <svg class="guide" [attr.viewBox]="'0 0 ' + v.w + ' ' + v.h" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            @if (pose()?.pts; as p) {
              @for (b of bones; track $index) {
                @if (p[b[0]] && p[b[1]] && p[b[0]]![2] > 0.4 && p[b[1]]![2] > 0.4) {
                  <line
                    [attr.x1]="p[b[0]]![0] * v.w" [attr.y1]="p[b[0]]![1] * v.h"
                    [attr.x2]="p[b[1]]![0] * v.w" [attr.y2]="p[b[1]]![1] * v.h"
                    [class.ok]="framing().ok" [attr.stroke-width]="v.w / 160"
                  />
                }
              }
            }
            @if (floorY() !== null) {
              <line class="floor" x1="0" [attr.x2]="v.w" [attr.y1]="floorY()! * v.h" [attr.y2]="floorY()! * v.h" [attr.stroke-width]="v.w / 200" />
            }
          </svg>
        }
        @if (countdown() !== null) {
          <span class="count num" aria-live="assertive">{{ countdown() }}</span>
        }
        @if (mode(); as m) {
          <span class="badge num">{{ m.height }}p, {{ m.fps | number: '1.0-0' }} fps</span>
        }
        @if (recording()) {
          <span class="live num"><span class="dot"></span>{{ seconds() }}s</span>
        }
        @if (ready()) {
          <p class="tip" [class.good]="guide() && framing().ok" role="status" aria-live="polite">
            @if (!guide()) {
              Phone on the floor, side-on, about 2 m away. Keep your whole body and the floor in shot.
            } @else if (recording()) {
              {{ handsFree() ? (watchState() === 'air' ? 'In the air…' : watchState() === 'landed' ? 'Landed. Stopping in a moment…' : 'Recording. Jump when ready.') : 'Recording…' }}
            } @else if (handsFree() && framing().ok) {
              {{ countdown() !== null ? 'Get ready…' : 'Good framing. Hold still to start recording.' }}
            } @else {
              {{ framing().message }}
            }
          </p>
        }
      </div>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      @if (lowFps()) {
        <p class="warn">
          This browser only gives {{ mode()!.fps | number: '1.0-0' }} fps, so expect about ±{{ approxErr() }} cm. For the
          most accurate results, film in your camera app's Slo-mo (240 fps) and choose the video instead.
        </p>
      }

      <label class="hands-free">
        <input type="checkbox" [checked]="handsFree()" (change)="setHandsFree($any($event.target).checked)" [disabled]="recording()" />
        Hands-free: start when I stand still, stop after I land
      </label>

      <div class="controls">
        <button class="btn ghost" type="button" (click)="cancel()">Cancel</button>
        @if (!recording()) {
          <button class="shutter" type="button" (click)="manualStart()" [disabled]="!ready()" aria-label="Start recording"></button>
        } @else {
          <button class="shutter stop" type="button" (click)="stopRecording()" aria-label="Stop recording"></button>
        }
        <button class="btn ghost" type="button" (click)="flip()" [disabled]="recording()" aria-label="Switch camera">Flip</button>
      </div>
    </div>
  `,
  styles: `
    .rec {
      display: grid;
      gap: 12px;
    }
    .view {
      position: relative;
      background: #000;
      border-radius: var(--r-lg);
      overflow: hidden;
      min-height: 240px;
      display: grid;
      place-items: center;
    }
    video {
      width: 100%;
      max-height: 62vh;
      object-fit: contain;
      display: block;
    }
    .badge,
    .live {
      position: absolute;
      top: 10px;
      padding: 2px 10px;
      border-radius: 999px;
      font-weight: 700;
      font-size: 0.85rem;
      color: #fff;
      background: rgba(0, 0, 0, 0.55);
    }
    .badge {
      left: 10px;
    }
    .live {
      right: 10px;
      background: var(--red);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #fff;
      }
    }
    .guide {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      line {
        stroke: #ffb020;
        stroke-linecap: round;
        &.ok {
          stroke: #3ddc97;
        }
        &.floor {
          stroke: rgba(255, 255, 255, 0.7);
          stroke-dasharray: 10 8;
        }
      }
    }
    .count {
      position: absolute;
      font-family: var(--display);
      font-size: 7rem;
      font-weight: 700;
      color: #fff;
      text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
    }
    .hands-free {
      display: flex;
      gap: 8px;
      align-items: center;
      font-weight: 600;
      input {
        width: 22px;
        height: 22px;
      }
    }
    .tip.good {
      background: rgba(31, 138, 76, 0.85);
    }
    .tip {
      position: absolute;
      left: 10px;
      right: 10px;
      bottom: 10px;
      margin: 0;
      padding: 6px 10px;
      border-radius: var(--r-sm);
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      font-size: 0.85rem;
    }
    .controls {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      justify-items: center;
    }
    .shutter {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      border: 5px solid var(--ink);
      background: var(--red);
      cursor: pointer;
      &.stop {
        background: var(--ink);
        box-shadow: inset 0 0 0 14px var(--paper);
      }
      &:disabled {
        opacity: 0.4;
      }
    }
    .error,
    .warn {
      margin: 0;
      padding: 8px 12px;
      border-left: 4px solid var(--red);
      background: var(--surface);
      border-radius: var(--r-sm);
      font-size: 0.92rem;
    }
    .warn {
      border-color: var(--blue);
    }
  `,
  imports: [DecimalPipe],
})
export class Recorder implements OnInit, OnDestroy {
  readonly recorded = output<Recording>();
  readonly cancelled = output<void>();

  private readonly preview = viewChild.required<ElementRef<HTMLVideoElement>>('preview');
  private readonly poseSvc = inject(PoseDetectorService);
  private readonly feedback = inject(FeedbackService);
  protected readonly bones = BONES;
  /** Live pose guide is running (the model loaded). */
  protected readonly guide = signal(false);
  protected readonly pose = signal<FootSample | null>(null);
  protected readonly size = signal<{ w: number; h: number } | null>(null);
  protected readonly framing = computed(() => framingOf(this.pose()));
  protected readonly floorY = computed(() => {
    const p = this.pose();
    return p && isFinite(p.footY) ? p.footY : null;
  });
  protected readonly handsFree = signal(readHandsFree());
  protected readonly countdown = signal<number | null>(null);
  protected readonly watchState = signal<'ground' | 'air' | 'landed' | 'done'>('ground');
  private recent: FootSample[] = [];
  private stillSince: number | null = null;
  private watcher: JumpWatcher | null = null;
  private loopAlive = false;
  private countdownTimer?: ReturnType<typeof setTimeout>;
  protected readonly mode = signal<CameraMode | null>(null);
  protected readonly ready = signal(false);
  protected readonly recording = signal(false);
  protected readonly seconds = signal(0);
  protected readonly error = signal<string | null>(null);
  protected readonly lowFps = computed(() => (this.mode()?.fps ?? 999) < 100);
  protected readonly approxErr = computed(() => {
    const fps = this.mode()?.fps ?? 30;
    // Height error for a typical 0.5 s flight with ±1 frame of timing error.
    return Math.max(1, Math.round(((9.81 * 0.5) / fps / 4) * 100));
  });

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private facing: 'environment' | 'user' = 'environment';
  private startedAt = '';
  private timer?: ReturnType<typeof setInterval>;
  private discard = false;

  ngOnInit() {
    this.open();
  }

  ngOnDestroy() {
    this.loopAlive = false;
    clearTimeout(this.countdownTimer);
    this.discard = true;
    clearInterval(this.timer);
    this.recorder?.state === 'recording' && this.recorder.stop();
    this.stopStream();
  }

  private stopStream() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private async open() {
    this.ready.set(false);
    this.error.set(null);
    this.stopStream();
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error.set("This browser can't use the camera. Record in your camera app and choose the video instead.");
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: this.facing },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
        },
      });
      const track = this.stream.getVideoTracks()[0];
      await this.pickBestMode(track);
      const v = this.preview().nativeElement;
      v.srcObject = this.stream;
      await v.play().catch(() => undefined);
      this.ready.set(true);
      this.startGuide();
    } catch (e) {
      const name = (e as Error).name;
      this.error.set(
        name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow it in your browser settings, or choose a video instead.'
          : "Couldn't start the camera. Close other apps using it, or choose a video instead.",
      );
    }
  }

  /**
   * Frame rate matters most for timing, then resolution. Try the camera's top frame
   * rate at 1080p, then at 720p, and keep whichever gives more frames per second.
   */
  private async pickBestMode(track: MediaStreamTrack) {
    const read = (): CameraMode => {
      const s = track.getSettings();
      return { width: s.width ?? 0, height: s.height ?? 0, fps: s.frameRate ?? 0 };
    };
    const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities;
    const maxFps = caps.frameRate?.max ?? 60;
    const tryMode = async (width: number, height: number) => {
      try {
        await track.applyConstraints({ width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: maxFps } });
      } catch {
        /* keep current */
      }
      return read();
    };
    let best = await tryMode(1920, 1080);
    if (best.fps < Math.min(maxFps, 120) - 1) {
      const hd = await tryMode(1280, 720);
      if (hd.fps > best.fps + 1 && Math.min(hd.width, hd.height) >= 700) best = hd;
      else best = await tryMode(1920, 1080);
    }
    // Some browsers report landscape sizes for a portrait camera; normalise for display.
    this.mode.set({ ...best, height: Math.min(best.width, best.height) || best.height });
  }

  /** Pose on the preview a few times a second: framing hints, and hands-free start/stop. */
  private async startGuide() {
    if (this.loopAlive) return;
    this.loopAlive = true;
    const v = this.preview().nativeElement;
    let failures = 0;
    while (this.loopAlive) {
      const busy = this.recording() && !this.handsFree();
      if (!busy && this.ready() && v.videoWidth) {
        try {
          const s = await this.poseSvc.detectLive(v);
          if (!this.loopAlive) break;
          this.guide.set(true);
          this.size.set({ w: v.videoWidth, h: v.videoHeight });
          this.pose.set(s);
          if (s) this.onPose(s);
        } catch {
          // No model (offline): keep the plain tip.
          if (++failures > 2) {
            this.guide.set(false);
            this.loopAlive = false;
            break;
          }
        }
      }
      await new Promise((r) => setTimeout(r, this.recording() ? 100 : 160));
    }
  }

  private onPose(s: FootSample) {
    const now = performance.now();
    this.recent.push(s);
    if (this.recent.length > 8) this.recent.shift();
    if (!this.handsFree()) return;

    if (this.recording()) {
      const st = this.watcher!.push(s, now);
      this.watchState.set(st);
      if (st === 'done') {
        this.feedback.cue('stop');
        this.stopRecording();
      }
      return;
    }
    const legLen = median(this.recent.map((x) => x.legLen).filter((x) => x > 0));
    const ready = this.framing().ok && isStill(this.recent, legLen);
    if (!ready) {
      this.stillSince = null;
      this.cancelCountdown();
      return;
    }
    this.stillSince ??= now;
    if (now - this.stillSince > 800 && this.countdown() === null) this.runCountdown(3);
  }

  private runCountdown(n: number) {
    if (n === 0) {
      this.countdown.set(null);
      this.feedback.cue('go');
      this.startRecording();
      return;
    }
    this.countdown.set(n);
    this.feedback.cue('tick');
    this.countdownTimer = setTimeout(() => this.runCountdown(n - 1), 800);
  }

  private cancelCountdown() {
    if (this.countdown() === null) return;
    clearTimeout(this.countdownTimer);
    this.countdown.set(null);
  }

  protected manualStart() {
    this.cancelCountdown();
    this.feedback.unlock();
    this.startRecording();
  }

  protected setHandsFree(on: boolean) {
    this.handsFree.set(on);
    this.feedback.unlock();
    this.cancelCountdown();
    this.stillSince = null;
    try {
      localStorage.setItem(HANDS_FREE_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  protected flip() {
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    this.open();
  }

  protected startRecording() {
    if (!this.stream) return;
    const mime = [
      'video/mp4;codecs=avc1.640028',
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm',
    ].find((m) => MediaRecorder.isTypeSupported(m));
    const m = this.mode();
    // Plenty of bitrate so fast motion stays sharp: ~16 Mbps at 1080p60.
    const pixelsPerSec = (m?.width ?? 1920) * (m?.height ?? 1080) * (m?.fps ?? 30);
    const bitrate = Math.min(25_000_000, Math.max(8_000_000, Math.round(pixelsPerSec * 0.13)));
    try {
      this.recorder = new MediaRecorder(this.stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    } catch {
      this.recorder = new MediaRecorder(this.stream);
    }
    this.chunks = [];
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.onstop = () => this.finish();
    this.startedAt = new Date().toISOString();
    this.recorder.start(1000);
    this.recording.set(true);
    this.watcher = new JumpWatcher();
    this.watchState.set('ground');
    this.seconds.set(0);
    const t0 = Date.now();
    this.timer = setInterval(() => {
      this.seconds.set(Math.floor((Date.now() - t0) / 1000));
      // Jumps are short; long clips just make analysis slower.
      if (Date.now() - t0 > 20_000) this.stopRecording();
    }, 250);
  }

  protected stopRecording() {
    clearInterval(this.timer);
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.recording.set(false);
  }

  private finish() {
    if (this.discard) return;
    const type = this.recorder?.mimeType || this.chunks[0]?.type || 'video/mp4';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(this.chunks, { type: type.split(';')[0] });
    const stamp = this.startedAt.slice(0, 19).replace(/[:T]/g, '-');
    const file = new File([blob], `jump-${stamp}.${ext}`, { type: blob.type });
    const fps = this.mode()?.fps ?? null;
    this.loopAlive = false;
    this.stopStream();
    this.recorded.emit({ file, recordedAt: this.startedAt, fps: fps ? Math.round(fps) : null });
  }

  protected cancel() {
    this.loopAlive = false;
    this.cancelCountdown();
    this.discard = true;
    this.stopRecording();
    this.stopStream();
    this.cancelled.emit();
  }
}

function readHandsFree(): boolean {
  try {
    return localStorage.getItem(HANDS_FREE_KEY) === '1';
  } catch {
    return false;
  }
}
