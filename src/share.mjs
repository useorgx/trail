// `trail share <wall>`: a public page for a fix, with its effect measured across everyone who adopted it.
// Only named walls (generic ids like denied-chain) are shareable; nothing about your repos or sessions is in the link.
import { corpus } from './metrics.mjs';
import { loadSessions, loadAdoptions } from './store.mjs';
import { actionFor, effectText, wallId } from './actions.mjs';
import { wallById } from './walls.mjs';
import { baseUrl } from './sync.mjs';

export function shareFor(id, base) {
  const K = corpus(loadSessions(), loadAdoptions());
  const w = K.walls.find((x) => wallId(x.sig) === id) || K.walls.find((x) => wallId(x.sig).startsWith(id || '§'));
  if (!w) return { error: `No wall matches "${id}". See: trail walls` };
  if (!wallById(w.sig)) return { error: `“${w.name}” was grouped from your own error text, so it isn't shared publicly. Named walls can be: trail walls` };
  const url = `${baseUrl(base)}/trail/fixes/${w.sig}`; const act = actionFor(w); const e = w.adopted ? effectText(w.adopted) : null;
  const text = `My coding agents hit "${w.name}" in ${w.sessions} sessions.${e && !w.adopted.confounded && w.adopted.enough ? ` After one rule: ${e.text}.` : ''}\n\nThe fix, measured across everyone who adopted it: ${url}`;
  return { wall: w, url, text, action: act, effect: e, adopted: !!w.adopted };
}
