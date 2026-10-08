/**
 * Small, dependency-free password strength estimate. Not as thorough as zxcvbn, but catches
 * the usual weak choices: short, common, keyboard runs, repeats, and your own name or email.
 */
export interface Strength {
  score: 0 | 1 | 2 | 3 | 4;
  label: 'Too weak' | 'Weak' | 'Fair' | 'Strong' | 'Very strong';
  hint: string | null;
  ok: boolean;
}

export const MIN_LENGTH = 10;

const COMMON = new Set(
  `password password1 password123 passw0rd 123456 1234567 12345678 123456789 1234567890 qwerty qwerty123 qwertyuiop
  azerty asdfgh asdfghjkl zxcvbnm abc123 abcdef 111111 000000 iloveyou letmein welcome welcome1 admin admin123 login
  monkey dragon football baseball basketball soccer master shadow sunshine princess superman batman trustno1 starwars
  whatever freedom hello hello123 charlie michael jordan23 liverpool chelsea arsenal juventus milano roma napoli
  ciao ciao123 amore tirana albania polska haslo123 changeme secret secret123 jumpmeter jump jumping vertical
  summer winter autumn spring 2024 2025 2026 qazwsx 1q2w3e4r 1qaz2wsx zaq12wsx`.split(/\s+/),
);

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'abcdefghijklmnopqrstuvwxyz'];

function hasRun(pw: string, len = 4): boolean {
  const p = pw.toLowerCase();
  for (const row of ROWS) {
    for (let i = 0; i + len <= row.length; i++) {
      const seq = row.slice(i, i + len);
      if (p.includes(seq) || p.includes([...seq].reverse().join(''))) return true;
    }
  }
  return false;
}

export function passwordStrength(pw: string, context: string[] = []): Strength {
  const out = (score: Strength['score'], hint: string | null): Strength => ({
    score,
    label: (['Too weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const)[score],
    hint,
    ok: score >= 2 && pw.length >= MIN_LENGTH,
  });
  if (!pw) return out(0, null);
  const lower = pw.toLowerCase();
  const stripped = lower.replace(/[^a-z0-9]/g, '');
  if (COMMON.has(lower) || COMMON.has(stripped) || COMMON.has(stripped.replace(/\d+$/, ''))) {
    return out(0, 'This is one of the most common passwords.');
  }
  const words = context
    .flatMap((c) => c.toLowerCase().split(/[^a-z0-9]+/))
    .filter((w) => w.length >= 3);
  if (words.some((w) => lower.includes(w))) return out(1, "Don't use your name, username or email.");
  if (pw.length < MIN_LENGTH) return out(pw.length < 8 ? 0 : 1, `Use at least ${MIN_LENGTH} characters.`);

  // Rough entropy: character pool × length, discounted for repeats and runs.
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
  const unique = new Set(pw).size;
  let bits = Math.log2(Math.max(pool, 2)) * Math.min(pw.length, unique * 2.5);
  if (/(.)\1{2,}/.test(pw)) bits -= 10;
  if (hasRun(pw)) bits -= 12;
  if (/^[a-z]+\d{1,4}$/i.test(pw)) bits -= 10; // word + a few digits

  const score: Strength['score'] = bits < 35 ? 1 : bits < 50 ? 2 : bits < 70 ? 3 : 4;
  const hint =
    score < 2
      ? hasRun(pw)
        ? 'Avoid keyboard runs like "qwerty" or "1234".'
        : 'Add more words, or mix in numbers and symbols.'
      : score === 2
        ? 'Fine. A few more characters or a short phrase makes it much stronger.'
        : null;
  return out(score, hint);
}
