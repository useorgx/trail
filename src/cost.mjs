// Estimated cost from token counts and list prices (src/prices.json, a dated OpenRouter snapshot). Estimates, not
// bills: subscriptions, discounts and batch pricing differ. Unknown models get tokens and no price.
import fs from 'node:fs';

const PRICES = JSON.parse(fs.readFileSync(new URL('./prices.json', import.meta.url), 'utf8'));
export const PRICE_SOURCE = `${PRICES.source}, ${PRICES.fetched}`;
const norm = (m) => String(m || '').toLowerCase().split('/').pop().replace(/\./g, '-').replace(/-(\d{8}|latest)$/, '').replace(/\[.*\]$/, '');
export function priceFor(model) { const k = norm(model); return PRICES.models[k] || PRICES.models[k.replace(/-(high|low|medium|xhigh)$/, '')] || null; }

/**
 * @param {{input?:number, cached?:number, cacheWrite?:number, output?:number}} u  Claude: input excludes cache reads/writes;
 *   Codex/OpenAI: input includes cached (pass client 'codex').
 */
export function costOf(u, model, client) {
  const p = priceFor(model); if (!u || !p || p.input == null) return null;
  const cached = u.cached || 0; const fresh = client === 'codex' ? Math.max(0, (u.input || 0) - cached) : (u.input || 0);
  const usd = (fresh * p.input + cached * (p.cacheRead ?? p.input) + (u.cacheWrite || 0) * (p.cacheWrite ?? p.input) + (u.output || 0) * (p.output ?? 0)) / 1e6;
  return +usd.toFixed(4);
}
/** All tokens processed. Codex/OpenAI input already includes cached tokens; Claude's does not. */
export const tokensOf = (u, client) => (u ? (u.input || 0) + (client === 'codex' ? 0 : (u.cached || 0)) + (u.cacheWrite || 0) + (u.output || 0) : 0);
/** Cost and tokens of the usage records that fall inside some event spans. */
export function spanCost(usageEvents, spans, model, client) {
  const inside = usageEvents.filter((u) => spans.some(([a, b]) => u.i >= a && u.i <= b + 1));
  if (!inside.length) return null;
  const sum = inside.reduce((a, u) => ({ input: a.input + (u.input || 0), cached: a.cached + (u.cached || 0), cacheWrite: a.cacheWrite + (u.cacheWrite || 0), output: a.output + (u.output || 0) }), { input: 0, cached: 0, cacheWrite: 0, output: 0 });
  return { tokens: tokensOf(sum, client), usd: costOf(sum, inside[0].model || model, client) };
}
