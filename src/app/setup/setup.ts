import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { StoreService } from '../core/store.service';
import { JUMP_TYPES } from '../core/jump-math';

@Component({
  selector: 'app-setup',
  imports: [FormsModule],
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
      <h2>Your data</h2>
      <p>
        Jumps are saved on this device only, in this browser. Export a backup to keep them safe or move them to another
        phone.
      </p>
      <div class="row">
        <button class="btn" type="button" (click)="export()" [disabled]="!store.history().length">Export backup</button>
        <label class="btn">
          Import backup
          <input type="file" accept="application/json,.json" (change)="import($event)" class="sr-only" />
        </label>
      </div>
      @if (message()) {
        <p role="status" class="msg">{{ message() }}</p>
      }
    </section>

    <section>
      <h2>How it works</h2>
      <p>
        Going up takes as long as coming down, so the flight time <em>t</em> gives your height directly:
        <strong>h = g·t² ÷ 8</strong>. A 0.60 s flight is 44.1 cm. This is the same method used by contact mats and the My
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
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
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
  protected readonly types = JUMP_TYPES;
  protected readonly message = signal('');

  protected export() {
    const blob = new Blob([this.store.exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `jump-meter-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.message.set('Backup downloaded.');
  }

  protected async import(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const n = this.store.importJson(await file.text());
      this.message.set(n ? `Imported ${n} jump${n === 1 ? '' : 's'}.` : 'Nothing new in that file: all those jumps are already here.');
    } catch (e) {
      this.message.set(`Couldn't import that file. ${(e as Error).message}`);
    }
  }
}
