import { Pipe, PipeTransform, inject } from '@angular/core';
import { StoreService } from './store.service';
import { toUnits, Units } from './jump-math';

/**
 * Formats a height stored in cm in the user's chosen units.
 * `{{ 36.5 | height }}` → "36.5 cm" or "14.4 in".
 * Pass `'value'` to drop the unit: `{{ 36.5 | height: 'value' }}` → "14.4".
 */
@Pipe({ name: 'height', pure: false })
export class HeightPipe implements PipeTransform {
  private readonly store = inject(StoreService);

  transform(cm: number | null | undefined, mode: 'full' | 'value' = 'full', digits = 1): string {
    if (cm === null || cm === undefined || !isFinite(cm)) return '–';
    const units = this.store.settings().units;
    const v = formatNumber(toUnits(cm, units), digits);
    return mode === 'value' ? v : `${v} ${units}`;
  }
}

export function formatNumber(v: number, digits: number) {
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function unitLabel(units: Units) {
  return units === 'in' ? 'in' : 'cm';
}
