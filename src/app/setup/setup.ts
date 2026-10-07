import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { StoreService } from '../core/store.service';
import { JUMP_TYPES, JumpRecord, fromUnits, toUnits } from '../core/jump-math';
import { clipStore, requestPersistentStorage } from '../core/clip-store';
import { CloudService } from '../core/cloud.service';
import { BackupProgress, buildBackup, readBackup, restoreClips } from '../core/backup';

@Component({
  selector: 'app-setup',
  imports: [FormsModule, RouterLink],
  template: `
    <h1>Setup</h1>

    <section>
      <h2>Filming a jump</h2>
      <ol class="how">
        <li>
          <strong>Use slow motion.</strong> Accuracy depends on the frame rate: at 240 fps the timing error is about ±0.5 cm;
          at 30 fps it's about ±5 cm.
        </li>
        <li>
          <strong>Put the phone on the floor</strong>, side-on, 1.5–3 m away, landscape or portrait. Your feet and the
          floor must stay sharp and in frame. A low camera makes the moment your toes leave the floor obvious.
        </li>
        <li>
          <strong>Start recording a second before</strong> the jump and stop a second after landing. Shorter clips analyse
          faster.
        </li>
        <li>
          <strong>Land with straight legs and pointed toes</strong>, in the same position you took off. Bending your knees or
          landing flat-footed early stretches the flight time and inflates the height.
        </li>
        <li>
          <strong>Keep the jump type consistent.</strong> Hands on hips is a CMJ; swinging your arms adds 5–10 cm, so save
          those as "CMJ + arms" to keep your progress honest.
        </li>
      </ol>

      <h3>Phone notes</h3>
      <p>
        <strong>iPhone:</strong> Slo-mo at 240 fps (Settings › Camera › Record Slo-mo). If a clip won't open, set Settings ›
        Camera › Formats to <em>Most Compatible</em>. If the app reads the video as 30 fps but you shot at 240, enter 240 in
        "Recorded at".
      </p>
      <p>
        <strong>Android:</strong> use Slow motion or Super slow-mo. Many phones save the real rate in the file and the app
        picks it up automatically.
      </p>
    </section>

    <section>
      <h2>Your details</h2>
      <div class="grid">
        <div class="field">
          <label for="units">Height units</label>
          <select id="units" [ngModel]="store.settings().units" (ngModelChange)="store.updateSettings({ units: $event })">
            <option value="cm">Centimetres (cm)</option>
            <option value="in">Inches (in)</option>
          </select>
        </div>
        <div class="field">
          <label for="mass">Body mass (kg)</label>
          <input
            id="mass"
            type="number"
            inputmode="decimal"
            min="20"
            max="250"
            [ngModel]="store.settings().massKg"
            (ngModelChange)="store.updateSettings({ massKg: $event ? +$event : null })"
            placeholder="Optional"
          />
          <span class="hint">Used to estimate peak power (Sayers equation).</span>
        </div>
        <div class="field">
          <label for="stature">Your height ({{ store.settings().units }})</label>
          <input
            id="stature"
            type="number"
            inputmode="decimal"
            [ngModel]="statureInUnits()"
            (ngModelChange)="setStature($event)"
            placeholder="Optional"
          />
          <span class="hint">Makes the frame-rate check more precise.</span>
        </div>
        <div class="field">
          <label for="dtype">Default jump type</label>
          <select id="dtype" [ngModel]="store.settings().defaultType" (ngModelChange)="store.updateSettings({ defaultType: $event })">
            @for (t of types; track t) {
              <option [value]="t">{{ t }}</option>
            }
          </select>
        </div>
      </div>
    </section>

    <section>
      <h2>Jump types and what they measure</h2>
      <dl class="metrics">
        <dt>CMJ, CMJ + arms, squat jump</dt>
        <dd>
          Height, flight time, take-off speed and estimated peak power. Mark the <strong>movement start</strong> (the last
          frame standing still before you dip) to also get <strong>time to take-off</strong> and
          <strong>RSI-modified</strong> = height (m) ÷ time to take-off (s). RSI-mod shows how quickly you produce your
          jump: around 0.3 is typical, 0.5+ is very good. Auto-detect finds the movement start for you when there's a
          clear dip.
        </dd>
        <dt>Drop jump</dt>
        <dd>
          Step off a box (start around 30 cm / 12 in), land on both feet and jump straight back up as high and fast as
          you can. The app times <strong>ground contact</strong> from the box landing to take-off, and works out
          <strong>RSI</strong> = jump height (m) ÷ contact time (s). Above 1.5 is good, 2.0+ is elite. Film from before
          you step off until after you land. Keep the box and the floor in shot.
        </dd>
        <dt>Single-leg left and right</dt>
        <dd>
          Countermovement jumps off one leg. With both sides saved, History shows your best on each side and the
          <strong>asymmetry</strong> between them. Over 10–15% is worth working on.
        </dd>
        <dt>Approach</dt>
        <dd>A run-up jump. Film side-on and make sure your take-off foot stays in frame.</dd>
      </dl>
    </section>

    <section>
      <h2>Your data</h2>
      <p>
        Your jumps, details and clips are always saved on this phone first, so the app works offline. If you
        <a routerLink="/account">sign in</a>, they're also kept in the cloud as a long-term record: a private database in
        the EU that only you can read. Accounts are invite-only. Videos are only uploaded as the short clips you choose to
        save, never the original recording.
      </p>
      <p>
        Without signing in, clearing this browser's data or losing the phone loses your history, so export a backup now
        and then.
        @if (persisted() === false) {
          <strong>On iPhone, add the app to your home screen.</strong> Safari can otherwise delete data for sites you
          haven't opened in 7 days.
        }
      </p>
      @if (usage(); as u) {
        <p class="small muted">Using {{ u }} of storage on this device.</p>
      }
      <h3>Backup</h3>
      <p class="small">
        One file with every jump, your settings and all your video clips (including ones only in the cloud). Import it
        on any phone to get everything back.
      </p>
      <label class="check">
        <input type="checkbox" [checked]="includeClips()" (change)="includeClips.set($any($event.target).checked)" />
        Include video clips
      </label>
      <div class="row">
        <button class="btn" type="button" (click)="export()" [disabled]="!store.history().length || working()">Export backup</button>
        <label class="btn" [class.disabled]="working()">
          Import backup
          <input type="file" accept=".zip,.json,application/zip,application/json" (change)="import($event)" class="sr-only" [disabled]="working()" />
        </label>
      </div>
      @if (progress(); as p) {
        <p class="small muted" role="status">{{ p }}</p>
      }
      @if (message()) {
        <p role="status" class="msg">{{ message() }}</p>
      }
    </section>

    <section>
      <h2>How it works</h2>
      <p>
        Going up takes as long as coming down, so the flight time <em>t</em> gives your height directly:
        <strong>h = g·t² ÷ 8</strong>. A 0.60 s flight is 44.1 cm (17.4 in). This is the same method used by contact mats and the My
        Jump app, which have been checked against force plates.
      </p>
      <p>
        Auto-detect runs Google's MediaPipe pose model in your browser. It finds the lowest point of your feet in every
        frame around the jump, then times when it leaves and rejoins the floor, down to a fraction of a frame.
      </p>
    </section>
  `,
  styles: `
    section {
      margin-bottom: 28px;
      max-width: 40em;
    }
    .how {
      padding-left: 1.3em;
      display: grid;
      gap: 10px;
      li::marker {
        font-family: var(--display);
        font-weight: 700;
        color: var(--red);
      }
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .metrics {
      margin: 0;
      dt {
        font-family: var(--display);
        font-weight: 700;
        font-size: 1.15rem;
        margin-top: 14px;
      }
      dd {
        margin: 2px 0 0;
      }
    }
    .row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .small {
      font-size: 0.85rem;
    }
    .check {
      display: flex;
      gap: 8px;
      align-items: center;
      min-height: 44px;
      margin-bottom: 4px;
    }
    .btn.disabled {
      opacity: 0.45;
      pointer-events: none;
    }
    .msg {
      margin-top: 10px;
      font-weight: 600;
    }
    @media (max-width: 480px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class Setup {
  protected readonly store = inject(StoreService);
  private readonly cloud = inject(CloudService);
  protected readonly types = JUMP_TYPES;
  protected readonly message = signal('');
  protected readonly persisted = signal<boolean | null>(null);
  protected readonly usage = signal<string | null>(null);

  protected readonly statureInUnits = computed(() => {
    const cm = this.store.settings().statureCm;
    return cm === null ? null : Math.round(toUnits(cm, this.store.settings().units) * 10) / 10;
  });

  constructor() {
    requestPersistentStorage().then((p) => this.persisted.set(p));
    navigator.storage
      ?.estimate?.()
      .then((e) => e.usage !== undefined && this.usage.set(`${(e.usage / 1024 / 1024).toFixed(1)} MB`))
      .catch(() => undefined);
  }

  protected setStature(v: number | null) {
    const n = Number(v);
    const cm = n > 0 ? fromUnits(n, this.store.settings().units) : null;
    this.store.updateSettings({ statureCm: cm && cm > 100 && cm < 250 ? Math.round(cm) : null });
  }

  protected readonly includeClips = signal(true);
  protected readonly working = signal(false);
  protected readonly progress = signal<string | null>(null);

  private progressText(p: BackupProgress) {
    switch (p.stage) {
      case 'collecting':
        return `Gathering clips: ${p.done + 1} of ${p.total} jumps…`;
      case 'packing':
        return 'Packing the backup…';
      case 'reading':
        return `Reading the backup: ${Math.round((100 * p.done) / Math.max(1, p.total))}%`;
      case 'restoring':
        return `Restoring clips: ${p.done + 1} of ${p.total}…`;
    }
  }

  protected async export() {
    this.working.set(true);
    this.message.set('');
    try {
      const withClips = this.includeClips();
      const getClip = withClips
        ? async (r: JumpRecord) =>
            (await clipStore.get(r.id).catch(() => undefined)) ??
            (r.hasClip && this.cloud.signedIn() ? await this.cloud.fetchClip(r.id) : undefined)
        : null;
      const { blob, clipCount } = await buildBackup(this.store.sorted(), this.store.settings(), getClip, (p) =>
        this.progress.set(this.progressText(p)),
      );
      const name = `jump-meter-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      const file = new File([blob], name, { type: 'application/zip' });
      // On phones the share sheet is the friendliest way to save a big file (Save to Files, AirDrop…).
      if (navigator.canShare?.({ files: [file] }) && blob.size > 20 * 1024 * 1024) {
        await navigator.share({ files: [file], title: 'Jump Meter backup' }).catch(() => this.download(file));
      } else {
        this.download(file);
      }
      const mb = (blob.size / 1024 / 1024).toFixed(1);
      this.message.set(
        `Backup ready: ${this.store.history().length} jumps${withClips ? ` and ${clipCount} clip${clipCount === 1 ? '' : 's'}` : ''}, ${mb} MB.`,
      );
    } catch (e) {
      this.message.set(`Couldn't make the backup. ${(e as Error).message}`);
    } finally {
      this.working.set(false);
      this.progress.set(null);
    }
  }

  private download(file: File) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }

  protected async import(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.working.set(true);
    this.message.set('');
    try {
      const backup = await readBackup(file, (p) => this.progress.set(this.progressText(p)));
      const jumps = this.store.importRecords(backup.history);
      const clips = await restoreClips(backup.clips, (p) => this.progress.set(this.progressText(p)));
      this.cloud.schedule(0);
      const parts = [
        jumps ? `${jumps} jump${jumps === 1 ? '' : 's'}` : null,
        clips ? `${clips} clip${clips === 1 ? '' : 's'}` : null,
      ].filter(Boolean);
      this.message.set(
        parts.length
          ? `Imported ${parts.join(' and ')}.${this.cloud.signedIn() ? ' Uploading to your account…' : ''}`
          : 'Nothing new in that file: everything in it is already here.',
      );
    } catch (e) {
      this.message.set(`Couldn't import that file. ${(e as Error).message}`);
    } finally {
      this.working.set(false);
      this.progress.set(null);
    }
  }
}
