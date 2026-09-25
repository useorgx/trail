// Final status call: the tree model overrides the rules where it is confident; the rule verdict is kept for audit.
import { pAbandon } from './model.mjs';

export function decide(t) {
  const p = pAbandon(t.feat);
  t.status_rule = t.status;
  if (p == null) return t;
  t.p_abandon = +p.toFixed(3);
  if (p >= 0.5 && t.status !== 'abandoned' && !/s/.test(t.moves)) t.status = 'abandoned';
  else if (p < 0.5 && t.status === 'abandoned') t.status = 'outcome?';
  return t;
}
