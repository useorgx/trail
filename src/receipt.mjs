// One Agent Work Receipt (agent-work-receipt/v0.1, github.com/useorgx/agent-work-receipt) per piece of work.
// Trail fills exactly what a session capture can't: what was asked and what "done" means (acceptance criteria), what
// happened step by step, which artifacts were the deliverable, what checked it, how it ended, what it cost, where a
// person stepped in. Every inferred value says so (extensions['org.orgx.trail/v1'].provenance) with a confidence.
import { isShip, isVerification } from './steps.mjs';

export const SCHEMA_VERSION = 'agent-work-receipt/v0.1';
export const EXT = 'org.orgx.trail/v1';
const iso = (t) => { if (!t) return null; const d = new Date(t); return isNaN(d) ? null : d.toISOString(); };
const clip = (s, n) => { const x = String(s ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1) + '…' : x; };
const nonEmpty = (s, fallback) => (String(s ?? '').trim() ? String(s) : fallback);
const firstSentence = (s) => clip(String(s || '').split(/(?<=[.!?])\s|\n/)[0] || s, 200);
const isPath = (t) => /^(\/|~\/|\.{0,2}\/)?[\w.@-]+(\/[\w.@-]+)+\.\w{1,8}$/.test(String(t || '').trim());
const base = (p) => String(p).split('/').pop();

// ---- 2. Acceptance criteria: what "done" means, from the ask, each checked against evidence --------------------------
// Rules, not a model: each phrase family maps to a kind of check trail can see in the steps. A model tier can add
// criteria later; these are the ones the transcript can prove or disprove.
const CRITERIA = [
  { kind: 'pull_request', re: /\b(open|create|make|raise|put up|submit)\b[^.]{0,30}\b(pr|pull request)\b/i, text: 'A pull request is opened' },
  { kind: 'merge', re: /\bmerge\b/i, text: 'The change is merged' },
  { kind: 'deploy', re: /\b(deploy|ship it|release|go live)\b/i, text: 'The change is deployed' },
  { kind: 'publish', re: /\bpublish\b/i, text: 'The package or post is published' },
  { kind: 'commit', re: /\bcommit\b/i, text: 'The change is committed' },
  { kind: 'tests', re: /\b(tests?|specs?|suite)\b[^.]{0,30}\b(pass|green|fix|fixed|work)|\b(fix|make)\b[^.]{0,40}\b(tests?|failing|flaky|red)\b|\bgreen\b/i, text: 'Tests pass after the change' },
  { kind: 'typecheck', re: /\b(typecheck|type-check|tsc|type errors?)\b/i, text: 'Typecheck passes after the change' },
  { kind: 'build', re: /\b(build|compile)s?\b[^.]{0,20}\b(pass|green|work|fix)|\bfix\b[^.]{0,20}\bbuild\b/i, text: 'The build passes after the change' },
  { kind: 'answer', re: /^\s*(why|what|how|where|when|which|who|can you (explain|tell|check|find)|explain|investigate|look into|figure out|summari[sz]e|review)\b|\?\s*$/i, text: 'The question is answered with a report' },
];
const CONSTRAINT = /\b(do not|don't|dont|never|without|only|must not|avoid|no more than|keep .{1,30} (unchanged|as is))\b[^.;\n]{3,120}/gi;

export function extractIntent(ask) {
  const text = String(ask || '');
  const criteria = []; const seen = new Set();
  for (const c of CRITERIA) if (c.re.test(text) && !seen.has(c.kind)) { seen.add(c.kind); criteria.push({ id: `c${criteria.length + 1}`, kind: c.kind, text: c.text }); }
  // A named file to create or write is its own criterion.
  for (const m of text.matchAll(/\b(create|write|add|save)\b[^.\n]{0,30}?([\w./@-]+\.(md|ts|tsx|js|mjs|py|json|yaml|yml|html|css|sql|sh|png|jpg|svg|pdf|csv))\b/gi)) {
    const f = m[2]; if (!seen.has('file:' + f)) { seen.add('file:' + f); criteria.push({ id: `c${criteria.length + 1}`, kind: 'file', file: f, text: `${base(f)} is created or updated` }); }
  }
  // Otherwise "fix/implement/add X" still has a checkable minimum: a change with a check after it.
  if (!criteria.some((c) => ['tests', 'typecheck', 'build', 'answer', 'file'].includes(c.kind)) && /\b(fix|implement|add|build|refactor|update|change|improve|make)\b/i.test(text)) criteria.push({ id: `c${criteria.length + 1}`, kind: 'change_checked', text: 'A change is made and checked afterwards' });
  const constraints = [...text.matchAll(CONSTRAINT)].map((m) => clip(m[0], 200)).slice(0, 10);
  return { criteria, constraints };
}

/** Each criterion met / unmet / unknown, with the evidence step that decided it. */
export function checkCriteria(criteria, mine, evidenceFor) {
  const tools = mine.filter((x) => x.kind === 'tool'); const says = mine.filter((x) => x.kind === 'say');
  const lastCode = Math.max(-1, ...tools.filter((x) => x.action === 'edit' && x.code).map((x) => x.at));
  const lastEdit = Math.max(-1, ...tools.filter((x) => x.action === 'edit').map((x) => x.at));
  const after = (acts) => tools.filter((x) => acts.includes(x.action) && x.at > lastCode);
  const decide = (step, met, confidence) => (step ? { status: met ? 'met' : 'unmet', confidence, evidence_ids: [evidenceFor(step)] } : { status: 'unknown', confidence: 0.3, evidence_ids: [] });
  const lastOf = (xs) => xs[xs.length - 1];
  return criteria.map((c) => {
    let r;
    switch (c.kind) {
      case 'pull_request': { const s = lastOf(tools.filter((x) => /gh pr create/.test(x.target || '') || x.pr)); r = decide(s, s && s.result !== 'fail' && s.result !== 'denied', 0.85); break; }
      case 'merge': { const s = lastOf(tools.filter((x) => /gh pr merge|git merge/.test(x.target || ''))); r = decide(s, s && s.result !== 'fail' && s.result !== 'denied', 0.8); break; }
      case 'deploy': case 'publish': { const s = lastOf(tools.filter((x) => x.action === 'deploy' || (c.kind === 'publish' && /publish/.test(x.target || '')))); r = decide(s, s && s.result !== 'fail' && s.result !== 'denied', 0.8); break; }
      case 'commit': { const s = lastOf(tools.filter((x) => x.action === 'commit' || x.action === 'ship')); r = decide(s, s && s.result !== 'fail' && s.result !== 'denied', 0.8); break; }
      case 'tests': case 'typecheck': case 'build': { const s = lastOf(after([c.kind === 'tests' ? 'test' : c.kind])); r = decide(s, s && s.result !== 'fail' && s.result !== 'denied', s?.result === 'pass' ? 0.9 : 0.6); break; }
      case 'file': { const s = lastOf(tools.filter((x) => x.action === 'edit' && base(x.target || '') === base(c.file))); r = decide(s, !!s && s.result !== 'fail', 0.85); break; }
      case 'answer': { const s = lastOf(says); r = decide(s, !!s && String(s.text || '').length > 160, 0.6); break; }
      case 'change_checked': { const s = lastOf(tools.filter((x) => ['test', 'typecheck', 'lint', 'build'].includes(x.action) && x.at > lastEdit)); r = lastEdit < 0 ? { status: 'unmet', confidence: 0.5, evidence_ids: [] } : decide(s, s && s.result !== 'fail' && s.result !== 'denied', 0.6); break; }
      default: r = { status: 'unknown', confidence: 0.2, evidence_ids: [] };
    }
    return { ...c, ...r };
  });
}

// ---- 3. Artifact roles: the deliverable vs the scratch work ----------------------------------------------------------
// A file is an output when the work shipped or committed after touching it, or the closing message names it;
// otherwise it was intermediate. PRs are outputs; the closing report is a report.
function artifacts(mine, finalText, receiptId, sessionRef) {
  const tools = mine.filter((x) => x.kind === 'tool'); const out = []; const seen = new Set();
  const shippedAt = Math.max(-1, ...tools.filter((x) => (x.action === 'commit' || isShip(x)) && x.result !== 'fail').map((x) => x.at));
  for (const t of tools) {
    if (t.action !== 'edit' || !t.target || t.result === 'fail' || seen.has(t.target)) continue; seen.add(t.target);
    const named = finalText && base(t.target).length > 3 && finalText.includes(base(t.target));
    const role = (shippedAt > t.at || named) ? 'output' : 'intermediate';
    out.push({ id: `file-${out.length + 1}`, kind: t.code ? 'source_file' : 'file', name: clip(base(t.target), 200) || 'file', role, ref: { system: 'workspace', type: 'file', id: clip(t.target, 500) }, ...(iso(t.ts) ? { created_at: iso(t.ts) } : {}), metadata: { decided_by: role === 'output' ? (named ? 'named_in_closing_message' : 'committed_or_shipped_after') : 'edited_not_delivered' } });
    if (out.length >= 100) break;
  }
  for (const t of tools) if (t.pr && !seen.has('pr:' + t.pr)) { seen.add('pr:' + t.pr); out.push({ id: `pr-${t.pr}`, kind: 'pull_request', name: `PR #${t.pr}`, role: 'output', ref: { system: 'github', type: 'pull_request', id: String(t.pr) } }); }
  if (finalText && finalText.length > 160) out.push({ id: 'closing-report', kind: 'agent_report', name: 'Closing report', role: 'report', ref: { system: sessionRef.system, type: 'message', id: `${receiptId}#closing` } });
  return out;
}

const OUTCOME = { shipped_checked: 'succeeded', verified_change: 'succeeded', answered: 'succeeded', shipped_unchecked: 'succeeded', reported_change: 'succeeded', handed_back: 'blocked', blocked_reported: 'blocked', blocked_wall: 'blocked', abandoned: 'failed', open: 'unknown', unclear: 'unknown' };
const AUTHORITY = { dontAsk: ['policy', 'restricted'], bypassPermissions: ['delegated', 'granted'], default: ['explicit', 'granted'], acceptEdits: ['delegated', 'restricted'], auto: ['policy', 'restricted'], plan: ['explicit', 'restricted'] };
const PROVIDER = (m) => (/claude/i.test(m) ? 'anthropic' : /^(gpt|o\d|codex)/i.test(m) ? 'openai' : /gemini/i.test(m) ? 'google' : /grok/i.test(m) ? 'xai' : /deepseek/i.test(m) ? 'deepseek' : 'unknown');
const CORRECTION = /\b(no|wrong|instead|actually|don'?t|stop|not that|revert|undo|that's not)\b/i;

/**
 * @param {{client:string, id:string, model?:string, mode?:string, cwd?:string, label?:string}} session
 * @param {any} goal  from goals.mjs (with spans, outcome, backtracks, conf, cost, checkedAfterChange)
 * @param {any[]} steps  steps(s, lang) for the whole session
 * @param {any} thread  the goal's root thread (ask, title, origin)
 */
export function buildReceipt(session, goal, steps, thread) {
  const own = new Set(); for (const [a, b] of goal.spans || []) for (let i = a; i <= b; i++) own.add(i);
  const mine = steps.filter((x) => own.has(x.at) || (x.kind === 'think' && own.has(Math.min(x.at, Math.max(...own)))));
  const ask = thread?.ask || goal.title || ''; const receiptId = `trail:${session.client}:${session.id}:${goal.root}`;
  const times = mine.map((x) => iso(x.ts)).filter(Boolean); const started = times[0] || iso(session.start) || new Date(0).toISOString(); const completed = times[times.length - 1] || iso(session.end) || started;
  const sessionRef = { system: session.client, type: 'session', id: String(session.id) };
  const says = mine.filter((x) => x.kind === 'say'); const finalText = says.length ? String(says[says.length - 1].text || '') : '';

  // Evidence: checks, ships, the closing report and the step that decided the outcome, each with its own id.
  const evidence = []; const evId = new Map();
  const addEvidence = (step, kind, summary, excerpt) => {
    if (evId.has(step.at)) return evId.get(step.at);
    const id = `ev-${step.at}`; evId.set(step.at, id);
    evidence.push({ id, kind, summary: nonEmpty(clip(summary, 500), kind), observed_at: iso(step.ts) || completed, ...(excerpt ? { excerpt: clip(excerpt, 1200) } : {}), ref: { system: session.client, type: 'transcript_event', id: `${session.id}#${step.at}` } });
    return id;
  };
  const evidenceFor = (step) => (step.kind === 'tool' ? addEvidence(step, isVerification(step) || ['test', 'typecheck', 'lint', 'build'].includes(step.action) ? 'check_output' : isShip(step) ? 'ship_output' : 'tool_output', `${step.action} ${step.result}: ${step.target || step.tool}`, step.out || step.errText) : addEvidence(step, 'agent_report', firstSentence(step.text), step.text));

  const { criteria, constraints } = extractIntent(ask);
  const checked = checkCriteria(criteria, mine, evidenceFor);
  // Every check that ran after the last change is a verification check, criteria or not.
  const tools = mine.filter((x) => x.kind === 'tool');
  const lastChange = Math.max(-1, ...tools.filter((x) => x.action === 'edit').map((x) => x.at));
  const runChecks = tools.filter((x) => ['test', 'typecheck', 'lint', 'build'].includes(x.action) && x.at > lastChange && x.result !== 'denied');
  const checks = [
    ...runChecks.map((x) => ({ id: `check-${x.at}`, name: `${x.action}: ${clip(x.target, 120) || x.action}`, status: x.result === 'fail' ? 'failed' : x.result === 'pass' ? 'passed' : 'inconclusive', method: x.result === 'ok' ? 'Ran without a failure; output did not state a pass count.' : 'Pass/fail read from the command output.', evidence_ids: [evidenceFor(x)] })),
    ...checked.filter((c) => c.status !== 'unknown').map((c) => ({ id: `criterion-${c.id}`, name: c.text, status: c.status === 'met' ? 'passed' : 'failed', method: `Acceptance criterion (${c.kind}) matched to evidence by trail rules.`, evidence_ids: c.evidence_ids })),
  ].filter((c) => c.evidence_ids.length);
  const outcomeStep = mine.find((x) => x.at === goal.outcome?.at); const outcomeEv = outcomeStep ? evidenceFor(outcomeStep) : null;
  const vStatus = !checks.length ? 'unverified' : checks.every((c) => c.status === 'passed') ? 'passed' : checks.some((c) => c.status === 'passed') ? 'partial' : checks.every((c) => c.status === 'inconclusive') ? 'inconclusive' : 'failed';
  let oStatus = OUTCOME[goal.outcome?.kind] || 'unknown';
  if (oStatus === 'succeeded' && checked.some((c) => c.status === 'unmet')) oStatus = 'partially_succeeded';

  // Actions: every tool step (bounded), with the file or command it touched.
  const toolSteps = tools.length > 300 ? [...tools.slice(0, 150), ...tools.slice(-150)] : tools;
  const actions = toolSteps.map((x) => ({ id: `step-${x.at}`, type: `${String(x.tool || 'tool').toLowerCase().replace(/[^a-z0-9_.-]/g, '_').slice(0, 60)}.${x.action}`, summary: nonEmpty(clip(x.target, 300), `${x.tool} ${x.action}`), status: x.result === 'denied' ? 'blocked' : x.result === 'fail' ? 'failed' : 'completed', system: session.client, ...(isPath(x.target) ? { target_refs: [{ system: 'workspace', type: 'file', id: clip(x.target, 500) }] } : {}), started_at: iso(x.ts) || started, completed_at: iso(x.ts) || started, ...(x.result === 'fail' || x.result === 'denied' ? { error: nonEmpty(clip(x.errText, 500), x.result) } : {}) }));
  if (!actions.length) actions.push({ id: 'no-tools', type: 'conversation.reply', summary: 'Answered without using tools.', status: 'completed', system: session.client, started_at: started, completed_at: completed });

  // Where a person stepped in: every later message from them inside this piece of work.
  const asks = mine.filter((x) => x.kind === 'ask' && x.who !== 'schedule');
  // The ask itself is always evidence: a receipt with no other evidence still records what was requested.
  const askStep = mine.find((x) => x.kind === 'ask');
  if (askStep) addEvidence(askStep, 'request', 'What the person asked', askStep.text);
  else evidence.push({ id: 'ev-request', kind: 'request', summary: nonEmpty(clip(goal.title, 300), 'Work started without a recorded ask'), observed_at: started });
  const human_interventions = asks.slice(1).map((x) => ({ id: `human-${x.at}`, kind: CORRECTION.test(x.text || '') ? 'correction' : 'input', actor: { type: 'human', id: 'workspace-member' }, summary: nonEmpty(clip(x.text, 300), 'message'), occurred_at: iso(x.ts) || completed }));

  const arts = artifacts(mine, finalText, receiptId, sessionRef);
  const [mode, astatus] = AUTHORITY[session.mode] || ['unknown', 'unknown'];
  const receipt = {
    schema_version: SCHEMA_VERSION,
    receipt_id: receiptId,
    intent: { summary: nonEmpty(firstSentence(goal.title || ask), 'Untitled work'), ...(ask ? { objective: clip(ask, 2000) } : {}), ...(checked.length ? { acceptance_criteria: checked.map((c) => c.text) } : {}), ...(constraints.length ? { constraints } : {}), request_ref: sessionRef, metadata: { origin: goal.origin, provenance: 'trail_inferred' } },
    actor: { type: 'agent', id: session.client, display_name: session.label || session.client, runtime: { name: session.client }, ...(session.model ? { model: { provider: PROVIDER(session.model), name: String(session.model).slice(0, 200) } } : {}) },
    authority: { mode, status: astatus, scope: { actions: [], resources: [] }, metadata: { permission_mode: session.mode || 'unknown', provenance: 'observed' } },
    actions, artifacts: arts, evidence,
    outcome: { status: oStatus, summary: nonEmpty(finalText ? firstSentence(finalText) : `${goal.outcome?.kind || 'unclear'} (inferred from the steps)`, 'No closing message.'), acceptance: { status: 'pending' }, metadata: { kind: goal.outcome?.kind || 'unclear', confidence: goal.conf?.outcome ?? null, provenance: 'trail_inferred', ...(outcomeEv ? { decided_by_evidence: outcomeEv } : {}) } },
    verification: { status: vStatus, method: checks.length ? 'Checks observed in the transcript (test, typecheck, lint, build runs after the last change) and acceptance criteria matched to evidence.' : 'No check ran after the last change, and no acceptance criterion could be matched to evidence.', verifier: { type: 'service', id: 'orgx-trail', display_name: 'trail' }, checks, evidence_ids: [...new Set(checks.flatMap((c) => c.evidence_ids))], ...(checks.length ? { verified_at: evidence.filter((e) => checks.some((c) => c.evidence_ids.includes(e.id))).map((e) => e.observed_at).sort().pop() || completed } : {}) },
    cost: { currency: 'USD', total: goal.cost?.usd ?? 0, estimated: true, ...(goal.cost?.tokens ? { usage: [{ name: 'model_tokens', quantity: goal.cost.tokens, unit: 'token' }] } : {}), metadata: { basis: goal.cost ? 'list prices × transcript token counts' : 'no token counts in this transcript' } },
    lineage: { run_ref: sessionRef, parent_receipt_refs: [], references: [...arts.filter((a) => a.role === 'output').map((a) => ({ relationship: a.kind === 'pull_request' ? 'produced' : 'changes', ref: a.ref }))].slice(0, 200) },
    human_interventions,
    timestamps: { started_at: started, completed_at: completed, issued_at: completed },
    extensions: { [EXT]: {
      goal_id: goal.id, root_thread: goal.root, origin: goal.origin, cwd: session.cwd || null,
      outcome_kind: goal.outcome?.kind || 'unclear',
      confidence: { outcome: goal.conf?.outcome ?? null, boundary: goal.conf?.boundary ?? null, backtracks: goal.conf?.backtracks ?? null, criteria: checked.length ? +Math.min(...checked.map((c) => c.confidence)).toFixed(2) : null },
      criteria: checked.map(({ id, kind, text, status, confidence, evidence_ids }) => ({ id, kind, text, status, confidence, evidence_ids })),
      episodes: goal.episodes || [], changes_of_course: (goal.backtracks || []).map((b) => ({ at: b.at, trigger: b.trigger, evidence: `${session.id}#${b.at}` })),
      verified_by_two_reads: goal.verified || false,
      provenance: { intent: 'observed (the ask)', criteria: 'rules over the ask', outcome: goal.jev ? 'steps + Jev' : 'rules over the steps', artifacts_roles: 'rules', cost: goal.cost ? 'estimated' : 'none' },
    } },
  };
  return receipt;
}
