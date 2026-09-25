// A small gradient-boosted tree model, distilled from model-labeled threads, evaluated in plain JS.
// Decides one structural question: did this thread get abandoned? ~16µs per thread, no network.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let M = null;
try { M = JSON.parse(fs.readFileSync(path.join(here, 'model', 'abandon.json'), 'utf8')); } catch { M = null; }
export const modelInfo = () => (M ? { name: M.name, trained_on: M.trained_on, cv: M.cv } : null);

function tree(t, x) { let n = 0; while (t.left[n] !== -1) n = x[t.feature[n]] <= t.threshold[n] ? t.left[n] : t.right[n]; return t.value[n]; }
/** @returns {number|null} probability the thread was abandoned */
export function pAbandon(feat) {
  if (!M) return null;
  let z = M.init; for (const t of M.trees) z += M.lr * tree(t, feat);
  return 1 / (1 + Math.exp(-z));
}
