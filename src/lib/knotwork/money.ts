// Money is integer cents everywhere; this is the only place it becomes a string.
// From showcall src/money.ts (usd, parseCents), with a guard on usd so a float cannot be formatted by accident.

export const usd = (cents: number) => {
  if (!Number.isInteger(cents)) throw new Error('money is integer cents');
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
};

/** Dollars as typed ("1,234.5", "$80") to integer cents, with no float in between; null if it is not an amount. */
export function parseCents(s: string): number | null {
  const m = /^\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  return m ? Number(m[1]!.replaceAll(',', '')) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}
