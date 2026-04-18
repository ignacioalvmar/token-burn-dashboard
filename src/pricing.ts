export interface ModelPricing { in: number; out: number; }
export type PricingMap = Record<string, ModelPricing>;

export function costFor(model: string | null | undefined, inTok: number, outTok: number, pricing: PricingMap): number {
  if (!model) return 0;
  // match by prefix if no exact key
  let p = pricing[model];
  if (!p) {
    const key = Object.keys(pricing).find(k => model.startsWith(k) || k.startsWith(model));
    if (key) p = pricing[key];
  }
  if (!p) return 0;
  return (inTok * p.in + outTok * p.out) / 1e6;
}

export function formatUSD(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1)    return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
