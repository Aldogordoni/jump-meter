import { Component, ElementRef, OnDestroy, OnInit, computed, output, signal, viewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';

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
        @if (mode(); as m) {
          <span class="badge num">{{ m.height }}p, {{ m.fps | number: '1.0-0' }} fps</span>
        }
        @if (recording()) {
          <span class="live num"><span class="dot"></span>{{ seconds() }}s</span>
        }
        @if (!recording() && ready()) {
          <p class="tip">Phone on the floor, side-on, about 2 m away. Keep your whole body and the floor in shot.</p>
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

      <div class="controls">
        <button class="btn ghost" type="button" (click)="cancel()">Cancel</button>
        @if (!recording()) {
          <button class="shutter" type="button" (click)="startRecording()" [disabled]="!ready()" aria-label="Start recording"></button>
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
    this.stopStream();
    this.recorded.emit({ file, recordedAt: this.startedAt, fps: fps ? Math.round(fps) : null });
  }

  protected cancel() {
    this.discard = true;
    this.stopRecording();
    this.stopStream();
    this.cancelled.emit();
  }
}
