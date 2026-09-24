const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(currency: string): Intl.NumberFormat {
  let f = formatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { style: "currency", currency });
    formatters.set(currency, f);
  }
  return f;
}

/** Integer cents from Convex, formatted for display. Never do money math here. */
export function formatCents(cents: number, currency = "USD"): string {
  return formatterFor(currency).format(cents / 100);
}

/** Integer cents → the plain `12.34` an amount input starts with. */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** An amount input's value → integer cents. */
export function inputToCents(value: string): number {
  return Math.round(Number(value) * 100);
}
