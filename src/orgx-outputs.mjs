// Keep only typed observations from an actual OrgX tool response. Prose, reads,
// nearby timestamps and producer-supplied URLs never create an output link.
const ATTACH = new Set(['orgx_attach', 'orgx_attach_artifact', 'orgx_update_work']);
const CONTEXT = new Set(['orgx_bootstrap', 'orgx_get_workspace_context']);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const timestamp = value => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(value.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) === value.slice(0, 10);
export const ORGX_RESULT_MAX_BYTES = 1_200_000;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
export const orgxTool = event => String(event?.rawTool || event?.tool || '').split('__').pop();
export function isOrgxContextCall(event) {
  const name = orgxTool(event);
  return CONTEXT.has(name) || (name === 'get_task_with_context' && /(?:^|__)orgx(?:__|$)/i.test(event?.rawTool || ''));
}
export const observesOrgxResult = event => ATTACH.has(orgxTool(event)) || isOrgxContextCall(event);
export function orgxArtifactRefs(value) {
  const refs = new Map();
  for (const ref of Array.isArray(value) ? value : []) {
    if (!ref || !UUID.test(ref.artifact_id || '') || !ATTACH.has(ref.tool) || !timestamp(ref.observed_at)) continue;
    const id = ref.artifact_id.toLowerCase();
    refs.set(id, { artifact_id: id, tool: ref.tool, observed_at: new Date(ref.observed_at).toISOString() });
  }
  return [...refs.values()].slice(0, 20);
}
const parse = value => {
  if (typeof value !== 'string') return object(value);
  if (value.length > ORGX_RESULT_MAX_BYTES) return null;
  try { return object(JSON.parse(value)); } catch { return null; }
};
function bodies(value) {
  const root = parse(value);
  if (!root) return [];
  const out = [root];
  // Explicit MCP/API envelopes only: never recursively search arbitrary content.
  for (let i = 0; i < out.length && i < 12; i++) {
    const body = out[i];
    for (const key of ['structuredContent', 'data', 'result']) {
      const next = object(body[key]); if (next && !out.includes(next)) out.push(next);
    }
    if (Array.isArray(body.content)) for (const part of body.content.slice(0, 5)) {
      if (part?.type !== 'text') continue;
      const next = parse(part.text); if (next) out.push(next);
    }
  }
  return out.slice(0, 12);
}
const failed = value => value.isError === true || value.is_error === true || value.ok === false || value.success === false || value.error != null;

export function observeOrgxResult(event, result, observedAt = event?.completedAt || event?.ts) {
  if (!observesOrgxResult(event)) return;
  delete event.orgx_artifact;
  const payloads = bodies(result);
  const error = payloads.find(failed);
  if (error) {
    event.err = true;
    if (!event.errText) event.errText = String(typeof error.error === 'string' ? error.error : error.error?.message || error.message ||
      (Array.isArray(error.content) ? error.content.find(part => part?.type === 'text')?.text : '') || 'OrgX tool returned an error').slice(0, 400);
  }
  if (!ATTACH.has(orgxTool(event)) || event.err || event.denied || event.rejected || event.pending || error) return;
  const ids = [...new Set(payloads.flatMap(body => UUID.test(body.artifact?.id || '') ? [body.artifact.id.toLowerCase()] : []))];
  // Conflicting acknowledgments do not identify one attached artifact.
  if (ids.length !== 1 || !timestamp(observedAt)) return;
  event.orgx_artifact = { artifact_id: ids[0], tool: orgxTool(event), observed_at: new Date(observedAt).toISOString() };
}

export function observedThreadArtifacts(events, spans) {
  const refs = new Map();
  for (const [start, end] of spans || []) for (let i = start; i <= end; i++) {
    const event = events[i], ref = event?.orgx_artifact;
    if (!ref || event.err || event.pending || event.denied || event.rejected || !UUID.test(ref.artifact_id) || !ATTACH.has(ref.tool)) continue;
    refs.set(ref.artifact_id, { artifact_id: ref.artifact_id, tool: ref.tool, observed_at: ref.observed_at });
  }
  return orgxArtifactRefs([...refs.values()]);
}
