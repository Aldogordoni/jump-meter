import { Injectable, inject } from '@angular/core';
import { StoreService } from './store.service';
import { CloudService } from './cloud.service';
import { clipStore } from './clip-store';

/**
 * Deletes video clips of jumps older than the chosen age, on this phone and in the cloud.
 * The jumps themselves (results, notes, tags) are always kept.
 */
@Injectable({ providedIn: 'root' })
export class HousekeepingService {
  private readonly store = inject(StoreService);
  private readonly cloud = inject(CloudService);

  /** Jumps whose clips are due for removal. */
  due(months = this.store.settings().clipRetentionMonths): string[] {
    if (!months) return [];
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const iso = cutoff.toISOString();
    return this.store
      .history()
      .filter((r) => r.date < iso)
      .map((r) => r.id);
  }

  /** Returns how many clips were removed. */
  async run(): Promise<number> {
    const ids = this.due();
    if (!ids.length) return 0;
    const local = await clipStore.ids().catch(() => new Set<string>());
    const localDue = ids.filter((id) => local.has(id));
    const cloudDue = this.store
      .history()
      .filter((r) => ids.includes(r.id) && r.hasClip)
      .map((r) => r.id);
    await Promise.all(localDue.map((id) => clipStore.delete(id).catch(() => undefined)));
    if (cloudDue.length && this.cloud.signedIn()) {
      await this.cloud.removeClips(cloudDue);
      for (const id of cloudDue) this.store.patch(id, { hasClip: false });
    }
    return new Set([...localDue, ...cloudDue]).size;
  }

  /** Total size of clips kept on this phone, in bytes. */
  async localBytes(): Promise<number> {
    const ids = await clipStore.ids().catch(() => new Set<string>());
    let total = 0;
    for (const id of ids) {
      const c = await clipStore.get(id).catch(() => undefined);
      if (c) total += c.video.size + c.poster.size;
    }
    return total;
  }
}
