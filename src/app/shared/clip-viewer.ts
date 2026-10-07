import {
  AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, inject, input, output, signal, viewChildren,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { trimClip } from '../core/clip-maker';
import { clipStore } from '../core/clip-store';
import { StoreService } from '../core/store.service';
import { CloudService } from '../core/cloud.service';

export interface ViewClip {
  id: string;
  url: string;
  label: string;
  fileName: string;
  video: Blob;
  mime: string;
}

const STEP = 1 / 30; // clips are encoded at 30 fps

/**
 * Clip player with slow motion, frame stepping, trim, and side-by-side compare
 * (when given two clips, both play in step).
 */
@Component({
  selector: 'app-clip-viewer',
  imports: [DecimalPipe],
  template: `
    <div class="viewer" role="dialog" aria-modal="true" [attr.aria-label]="compare() ? 'Compare two jumps' : 'Jump clip'" (click)="close()">
      <div class="box" (click)="$event.stopPropagation()">
        <div class="videos" [class.two]="compare()">
          @for (c of clips(); track c.id) {
            <figure>
              <video
                #vid
                [src]="c.url"
                playsinline
                muted
                [attr.aria-label]="c.label"
                (loadedmetadata)="onMeta()"
                (timeupdate)="onTime()"
                (ended)="onEnded()"
              ></video>
              @if (compare()) {
                <figcaption>{{ c.label }}</figcaption>
              }
            </figure>
          }
        </div>

        <div class="controls" role="group" aria-label="Playback">
          <input
            class="scrub"
            type="range"
            min="0"
            [max]="duration()"
            step="0.001"
            [value]="time()"
            (input)="seek(+$any($event.target).value)"
            aria-label="Position"
          />
          <div class="row">
            <button class="btn" type="button" (click)="step(-1)" aria-label="Back one frame">−1</button>
            <button class="btn primary play" type="button" (click)="toggle()">{{ playing() ? 'Pause' : 'Play' }}</button>
            <button class="btn" type="button" (click)="step(1)" aria-label="Forward one frame">+1</button>
            <span class="num t">{{ time() | number: '1.2-2' }} s</span>
          </div>
          <div class="speeds" role="radiogroup" aria-label="Speed">
            @for (r of rates; track r) {
              <button type="button" role="radio" [attr.aria-checked]="rate() === r" [class.on]="rate() === r" (click)="setRate(r)">{{ r }}×</button>
            }
          </div>
        </div>

        @if (!compare()) {
          @if (trimming()) {
            <div class="trim" role="group" aria-label="Trim">
              <p class="small">Play or step to a moment, then set where the clip should start and end.</p>
              <div class="row">
                <button class="btn" type="button" (click)="trimFrom.set(time())">Start here ({{ trimFrom() | number: '1.2-2' }} s)</button>
                <button class="btn" type="button" (click)="trimTo.set(time())">End here ({{ trimTo() ?? duration() | number: '1.2-2' }} s)</button>
              </div>
              <div class="row">
                <button class="btn primary" type="button" (click)="saveTrim()" [disabled]="!trimValid() || trimProgress() !== null">
                  {{ trimProgress() !== null ? 'Saving… ' + trimProgress() + '%' : 'Save trimmed clip' }}
                </button>
                <button class="btn ghost" type="button" (click)="cancelTrim()">Cancel</button>
              </div>
              @if (trimError()) {
                <p class="small err" role="alert">{{ trimError() }}</p>
              }
            </div>
          }
          <div class="actions">
            @if (!trimming()) {
              <button class="btn" type="button" (click)="startTrim()">Trim</button>
            }
            @if (canShare) {
              <button class="btn" type="button" (click)="share()">Share</button>
            }
            <a class="btn" [href]="clips()[0].url" [download]="clips()[0].fileName">Download</a>
            <button #closeBtn class="btn ghost" type="button" (click)="close()">Close</button>
          </div>
        } @else {
          <div class="actions">
            <button #closeBtn class="btn ghost" type="button" (click)="close()">Close</button>
          </div>
        }
      </div>
    </div>
  `,
  styles: `
    .viewer {
      position: fixed;
      inset: 0;
      z-index: 30;
      background: rgba(10, 14, 24, 0.9);
      display: grid;
      place-items: center;
      padding: 12px;
      overflow: auto;
    }
    .box {
      width: min(100%, 860px);
      display: grid;
      gap: 10px;
      color: #fff;
    }
    .videos {
      display: grid;
      gap: 8px;
      &.two {
        grid-template-columns: 1fr 1fr;
      }
      figure {
        margin: 0;
        display: grid;
        gap: 4px;
      }
      video {
        width: 100%;
        max-height: 62vh;
        background: #000;
        border-radius: var(--r-lg);
      }
      figcaption {
        font-size: 0.85rem;
        text-align: center;
      }
    }
    .controls,
    .trim {
      display: grid;
      gap: 8px;
    }
    .scrub {
      width: 100%;
      accent-color: var(--red);
    }
    .row,
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .t {
      margin-left: auto;
      font-weight: 600;
    }
    .btn {
      color: #fff;
      border-color: #fff;
      background: transparent;
    }
    .btn.primary {
      background: var(--blue);
      border-color: var(--blue);
    }
    .play {
      min-width: 6em;
    }
    .speeds {
      display: inline-flex;
      justify-self: start;
      border: 1.5px solid #fff;
      border-radius: 999px;
      overflow: hidden;
      button {
        min-height: 40px;
        padding: 0 14px;
        border: 0;
        background: transparent;
        color: #fff;
        font-weight: 600;
        cursor: pointer;
        &.on {
          background: #fff;
          color: #172033;
        }
      }
    }
    .trim {
      padding: 10px;
      border: 1px solid rgba(255, 255, 255, 0.4);
      border-radius: var(--r-sm);
      p {
        margin: 0;
      }
      .err {
        color: #ff8a96;
      }
    }
  `,
})
export class ClipViewer implements AfterViewInit, OnDestroy {
  private readonly store = inject(StoreService);
  private readonly cloud = inject(CloudService);
  readonly clips = input.required<ViewClip[]>();
  readonly closed = output<void>();
  /** A trimmed clip was saved for this jump id. */
  readonly trimmed = output<string>();

  private readonly vids = viewChildren<ElementRef<HTMLVideoElement>>('vid');
  protected readonly compare = computed(() => this.clips().length > 1);
  protected readonly rates = [0.25, 0.5, 1];
  protected readonly rate = signal(1);
  protected readonly playing = signal(false);
  protected readonly time = signal(0);
  protected readonly duration = signal(0);
  protected readonly canShare = typeof navigator !== 'undefined' && !!navigator.canShare;

  protected readonly trimming = signal(false);
  protected readonly trimFrom = signal(0);
  protected readonly trimTo = signal<number | null>(null);
  protected readonly trimProgress = signal<number | null>(null);
  protected readonly trimError = signal<string | null>(null);
  protected readonly trimValid = computed(() => {
    const to = this.trimTo() ?? this.duration();
    return to - this.trimFrom() >= 0.2 && (this.trimFrom() > 0.02 || to < this.duration() - 0.02);
  });

  private returnFocus: HTMLElement | null = null;

  ngAfterViewInit() {
    this.returnFocus = document.activeElement as HTMLElement | null;
    setTimeout(() => {
      (document.querySelector('app-clip-viewer .play') as HTMLElement | null)?.focus();
      this.play();
    });
  }

  ngOnDestroy() {
    this.returnFocus?.focus?.();
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') this.close();
    else if (e.key === 'ArrowRight' || e.key === '.') this.step(1);
    else if (e.key === 'ArrowLeft' || e.key === ',') this.step(-1);
    else if (e.key === ' ' && !(e.target as HTMLElement)?.closest('button, input')) this.toggle();
    else return;
    e.preventDefault();
  }

  private els() {
    return this.vids().map((v) => v.nativeElement);
  }

  protected onMeta() {
    this.duration.set(Math.max(0, ...this.els().map((v) => (isFinite(v.duration) ? v.duration : 0))));
    for (const v of this.els()) v.playbackRate = this.rate();
  }

  protected onTime() {
    const [a, b] = this.els();
    if (!a) return;
    this.time.set(a.currentTime);
    // Keep the second clip in step with the first.
    if (b && this.playing() && !b.ended && Math.abs(b.currentTime - a.currentTime) > 0.08 && a.currentTime < b.duration) {
      b.currentTime = a.currentTime;
    }
    // Trim preview: loop inside the chosen range.
    const to = this.trimTo();
    if (this.trimming() && to !== null && a.currentTime > to) this.seek(this.trimFrom(), true);
  }

  protected onEnded() {
    if (this.els().every((v) => v.ended || v.paused)) {
      // Loop from the start (or the trim start).
      this.seek(this.trimming() ? this.trimFrom() : 0, true);
    }
  }

  protected play() {
    this.playing.set(true);
    for (const v of this.els()) {
      v.playbackRate = this.rate();
      v.play().catch(() => this.playing.set(false));
    }
  }

  protected pause() {
    this.playing.set(false);
    for (const v of this.els()) v.pause();
  }

  protected toggle() {
    if (this.playing()) this.pause();
    else this.play();
  }

  protected setRate(r: number) {
    this.rate.set(r);
    for (const v of this.els()) v.playbackRate = r;
  }

  protected seek(t: number, keepPlaying = false) {
    if (!keepPlaying) this.pause();
    for (const v of this.els()) v.currentTime = Math.min(t, isFinite(v.duration) ? v.duration : t);
    this.time.set(t);
    if (keepPlaying && this.playing()) for (const v of this.els()) v.play().catch(() => undefined);
  }

  protected step(n: number) {
    this.seek(Math.max(0, Math.min(this.duration(), this.time() + n * STEP)));
  }

  protected startTrim() {
    this.trimming.set(true);
    this.trimFrom.set(0);
    this.trimTo.set(null);
    this.trimError.set(null);
  }

  protected cancelTrim() {
    this.trimming.set(false);
  }

  protected async saveTrim() {
    const c = this.clips()[0];
    const from = Math.min(this.trimFrom(), this.trimTo() ?? this.duration());
    const to = Math.max(this.trimFrom(), this.trimTo() ?? this.duration());
    this.pause();
    this.trimError.set(null);
    this.trimProgress.set(0);
    try {
      const out = await trimClip(c.video, c.mime, from, to, (f) => this.trimProgress.set(Math.round(f * 100)));
      if (!out) {
        this.trimming.set(false);
        return;
      }
      await clipStore.put({ id: c.id, ...out, createdAt: new Date().toISOString() });
      // Re-upload the shorter clip on the next sync.
      if (this.store.history().find((r) => r.id === c.id)?.hasClip) this.store.edit(c.id, { hasClip: false });
      this.cloud.schedule(0);
      this.trimming.set(false);
      this.trimmed.emit(c.id);
    } catch (e) {
      console.error(e);
      this.trimError.set("Couldn't trim the clip on this browser.");
    } finally {
      this.trimProgress.set(null);
    }
  }

  protected async share() {
    const c = this.clips()[0];
    const file = new File([c.video], c.fileName, { type: c.mime.split(';')[0] });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'My jump' });
    } catch {
      /* cancelled */
    }
  }

  protected close() {
    this.pause();
    this.closed.emit();
  }
}
