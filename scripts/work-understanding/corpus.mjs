// Public development data, assistant-authored draft labels. No human-gold or accuracy claim.
import fs from 'node:fs';
import crypto from 'node:crypto';

export const SCHEMA = 'orgx.trail.adversarial.v1.0.0';
export const CORPUS = new URL('../../test/fixtures/work-understanding/adversarial-v1.jsonl', import.meta.url);
export function readCorpus(file = CORPUS) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid JSON on line ${i + 1}`); }
  });
}

export function validateCorpus(cases, { expectedCount = 42 } = {}) {
  const issues = []; const ids = new Set();
  const check = (ok, path, message) => { if (!ok) issues.push({ path, message }); };
  check(cases.length === expectedCount, 'corpus', `Expected ${expectedCount} cases, got ${cases.length}`);
  for (const c of cases) {
    const p = c?.case_id || '?';
    check(c?.schema_version === SCHEMA, p, 'Unsupported schema');
    check(/^T\d{2,}$/.test(p) && !ids.has(p), p, 'Invalid or duplicate case ID'); ids.add(p);
    check(c?.privacy === 'fully_synthetic_no_user_data' && c?.split === 'public_development', p, 'Synthetic development boundary required');
    for (const field of ['title', 'mutation_family']) check(typeof c?.[field] === 'string' && c[field].length > 0, `${p}.${field}`, 'Non-empty string required');
    check(['low', 'medium', 'high', 'critical'].includes(c?.risk), p, 'Unknown risk');
    check(['current_contract', 'extended_semantics'].includes(c?.capability_track), p, 'Unknown capability track');
    check(c?.input?.default_context && typeof c.input.default_context === 'object', p, 'Context required');
    const events = new Map();
    check(Array.isArray(c?.input?.events) && c.input.events.length > 0, p, 'Events required');
    for (const e of c?.input?.events || []) {
      check(typeof e.event_id === 'string' && e.event_id.length > 0 && !events.has(e.event_id), p, 'Invalid or duplicate event ID');
      check(['user', 'assistant', 'tool', 'tool_call', 'system', 'attachment'].includes(e.role), p, 'Unknown event role');
      check(typeof e.text === 'string', p, 'Event text required'); events.set(e.event_id, e);
    }
    const entities = new Set();
    for (const field of ['entities', 'edges', 'forbidden_inferences']) check(Array.isArray(c?.expected?.[field]), `${p}.${field}`, 'Array required');
    check(typeof c?.expected?.notes === 'string', p, 'Notes required');
    const refs = (item, where) => {
      check(Array.isArray(item.source_refs) && item.source_refs.length > 0, where, 'Source references required');
      for (const ref of item.source_refs || []) {
        const event = events.get(ref.event_id);
        check(!!event, where, `Unresolved event ${ref.event_id}`);
        check(typeof ref.quote === 'string' && ref.quote.length > 0 && event?.text?.includes(ref.quote), where, 'Quote must match source text exactly');
        check(['observed', 'inferred'].includes(ref.basis), where, 'Invalid source basis');
      }
    };
    for (const e of c?.expected?.entities || []) {
      check(typeof e.id === 'string' && e.id.length > 0 && !entities.has(e.id), p, 'Invalid or duplicate entity ID'); entities.add(e.id);
      check(typeof e.type === 'string' && typeof e.status === 'string', p, 'Entity type/status required');
      if (e.identity?.startsWith('github:')) check(/^github:[^/:]+\/[^/:]+(?::(?:pr|issue):\d+)?$/.test(e.identity), p, 'Repository-qualified object identity required');
      if (e.identity?.startsWith('repo:')) check(!!c.input?.default_context?.canonical_repo, p, 'File alias requires canonical repository context');
      refs(e, `${p}.entity.${e.id}`);
    }
    for (const e of c?.expected?.edges || []) {
      check(entities.has(e.from_id) && entities.has(e.to_id), p, 'Unresolved edge endpoint');
      check(typeof e.relation === 'string' && e.relation.length > 0, p, 'Relation required'); refs(e, `${p}.edge`);
    }
    for (const f of c?.expected?.forbidden_inferences || []) check(typeof f === 'string' && f.length > 0, p, 'Forbidden inference must be text');
  }
  return issues;
}

export function corpusManifest(file = CORPUS) {
  const cases = readCorpus(file); const issues = validateCorpus(cases);
  return { schema_version: SCHEMA, label_status: 'assistant_authored_draft', split: 'public_development',
    human_adjudicated: false, sealed_benchmark: false, cases: cases.length,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    tracks: Object.fromEntries(['current_contract', 'extended_semantics'].map((track) => [track, cases.filter((c) => c.capability_track === track).length])),
    issues };
}
