// Refresh src/prices.json from OpenRouter's public model list (list prices, USD per million tokens). trail uses it
// offline to turn token counts into estimated cost; a model not in the list shows tokens and no price.
import fs from 'node:fs';
const res = await fetch('https://openrouter.ai/api/v1/models'); const { data } = await res.json();
const per1M = (x) => (x == null || x === '' ? null : +(Number(x) * 1e6).toFixed(4));
const models = {};
for (const m of data) {
  if (m.id.includes(':') || m.id.startsWith('~')) continue; // batch variants and aliases
  const key = m.id.split('/').pop().toLowerCase().replace(/\./g, '-');
  models[key] = { id: m.id, input: per1M(m.pricing?.prompt), output: per1M(m.pricing?.completion), cacheRead: per1M(m.pricing?.input_cache_read), cacheWrite: per1M(m.pricing?.input_cache_write) };
}
fs.writeFileSync(new URL('../src/prices.json', import.meta.url), JSON.stringify({ source: 'OpenRouter list prices (openrouter.ai/api/v1/models)', fetched: new Date().toISOString().slice(0, 10), unit: 'USD per 1M tokens', models }));
console.log(`${Object.keys(models).length} models priced`);
