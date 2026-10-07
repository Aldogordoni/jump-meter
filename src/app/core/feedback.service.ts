import { Injectable, inject } from '@angular/core';
import { StoreService } from './store.service';

type Cue = 'tick' | 'go' | 'start' | 'stop' | 'detected' | 'saved' | 'record';

const PATTERNS: Record<Cue, { buzz: number | number[]; tones: [number, number][] }> = {
  // [frequency Hz, duration ms]
  tick: { buzz: 15, tones: [[880, 70]] },
  go: { buzz: 60, tones: [[1320, 160]] },
  start: { buzz: [40, 60, 40], tones: [[660, 90], [990, 120]] },
  stop: { buzz: [40], tones: [[990, 90], [660, 120]] },
  detected: { buzz: [25, 50, 25], tones: [[784, 80], [1046, 110]] },
  saved: { buzz: 30, tones: [[1046, 90]] },
  record: { buzz: [30, 40, 30, 40, 80], tones: [[784, 90], [988, 90], [1175, 90], [1568, 220]] },
};

/** Vibration and short beeps, honouring the "Vibrate and beep" setting. */
@Injectable({ providedIn: 'root' })
export class FeedbackService {
  private readonly store = inject(StoreService);
  private ctx: AudioContext | null = null;

  /** Call from a user gesture once so iOS lets us play sounds later. */
  unlock() {
    if (!this.enabled()) return;
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => undefined);
    } catch {
      /* no audio */
    }
  }

  cue(c: Cue) {
    if (!this.enabled()) return;
    const p = PATTERNS[c];
    try {
      navigator.vibrate?.(p.buzz);
    } catch {
      /* not supported */
    }
    this.beep(p.tones);
  }

  private enabled() {
    return this.store.settings().haptics;
  }

  private beep(tones: [number, number][]) {
    try {
      this.ctx ??= new AudioContext();
      const ctx = this.ctx;
      let t = ctx.currentTime + 0.01;
      for (const [freq, ms] of tones) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + ms / 1000 + 0.02);
        t += ms / 1000 + 0.03;
      }
    } catch {
      /* no audio */
    }
  }
}
