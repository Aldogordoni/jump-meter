/**
 * Reference ranges to put a result in context. These are broad bands from published
 * sources, not precise percentiles; the app shows them with their sources.
 */

export type Sex = 'male' | 'female';

export interface Band {
  label: string;
  /** Lower bound (inclusive). */
  from: number;
}

export interface NormTable {
  metric: 'heightCm' | 'rsi' | 'rsiMod';
  title: string;
  bands: Band[];
  source: { name: string; url: string };
  note?: string;
}

/** CMJ height (cm), trained athletes. Topend Sports rating table. */
const CMJ: Record<Sex, Band[]> = {
  male: [
    { label: 'Below average', from: 0 },
    { label: 'Average', from: 50 },
    { label: 'Good', from: 60 },
    { label: 'Excellent', from: 70 },
  ],
  female: [
    { label: 'Below average', from: 0 },
    { label: 'Average', from: 35 },
    { label: 'Good', from: 45 },
    { label: 'Excellent', from: 55 },
  ],
};

export function cmjNorms(sex: Sex): NormTable {
  return {
    metric: 'heightCm',
    title: `CMJ height, trained ${sex === 'male' ? 'men' : 'women'}`,
    bands: CMJ[sex],
    source: { name: 'Topend Sports CMJ rating tables', url: 'https://new.topendsports.com/testing/tests/bosco-counter-movement-jump.htm' },
    note:
      sex === 'male'
        ? 'For scale: national-team male sprinters average about 63 cm (Haugen et al.).'
        : 'For scale: national-team female sprinters average about 48 cm (Haugen et al.).',
  };
}

/** Drop-jump RSI categories (Flanagan & Comyns 2008). */
export const RSI_NORMS: NormTable = {
  metric: 'rsi',
  title: 'Drop-jump RSI',
  bands: [
    { label: 'Poor', from: 0 },
    { label: 'Fair', from: 1.0 },
    { label: 'Good', from: 1.5 },
    { label: 'Very good', from: 2.0 },
    { label: 'Excellent', from: 2.5 },
  ],
  source: { name: 'Flanagan & Comyns (2008), via Topend Sports', url: 'https://new.topendsports.com/testing/tests/bosco-drop-jump.htm' },
};

/**
 * RSI-modified. Sole et al. report ranges of 0.21–0.70 (men) and 0.14–0.55 (women)
 * in college athletes; bands split those ranges into thirds.
 */
export function rsiModNorms(sex: Sex): NormTable {
  const [lo, hi] = sex === 'male' ? [0.21, 0.7] : [0.14, 0.55];
  const third = (hi - lo) / 3;
  return {
    metric: 'rsiMod',
    title: `RSI-modified, ${sex === 'male' ? 'men' : 'women'}`,
    bands: [
      { label: 'Lower third', from: 0 },
      { label: 'Middle third', from: round2(lo + third) },
      { label: 'Upper third', from: round2(lo + 2 * third) },
    ],
    source: {
      name: 'Sole et al., preliminary RSImod reference values',
      url: 'https://etsu.elsevierpure.com/en/publications/preliminary-scale-of-reference-values-for-evaluating-reactive-str/',
    },
    note: `Published range in college athletes: ${lo}–${hi}.`,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function bandFor(table: NormTable, value: number): { band: Band; index: number } {
  let index = 0;
  table.bands.forEach((b, i) => {
    if (value >= b.from) index = i;
  });
  return { band: table.bands[index], index };
}
