// The review extension (extensions['org.orgx.review/v1'], github.com/useorgx/agent-work-receipt docs/review-extension.md):
// what a reviewer needs to approve or send back the work, which the v0.2 core can't carry. Where each criterion was
// read from (the person's words, quoted, with the message it came from), whether that source still agrees, four kinds
// of proof per criterion, the episodes of the work with stable ids tied to commits, and which layers of the record
// exist. Trail says `none` and `missing` where it has nothing: a gap in the record is a fact, not a judgment.
import crypto from 'node:crypto';
import { cleanAsk } from './receipt.mjs';

export const REVIEW_EXT = 'org.orgx.review/v1';
const iso = (t) => { if (!t) return null; const d = new Date(t); return isNaN(d) ? null : d.toISOString(); };
const clip = (s, n) => { const x = String(s ?? '').replace(/\s+/g, ' ').trim().replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, ''); if (x.length <= n) return x; let cut = x.slice(0, n - 1); if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); return cut + '…'; };
const nonEmpty = (s, fallback) => (String(s ?? '').trim() ? String(s) : fallback);
const firstSentence = (s, n = 200) => clip(String(s || '').split(/(?<=[.!?])\s|\n/)[0] || s, n);
const TICKET = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;
const SHA = /\[[\w./-]+ ([0-9a-f]{7,40})\]|\bcommit ([0-9a-f]{7,40})\b/;

/** Stable, content-derived episode id: same work, same id, however the threads were cut. */
export const episodeId = (receiptId, kind, step) => 'ep-' + crypto.createHash('sha1').update(`${receiptId}|${kind}|${step.at}|${step.ts || ''}`).digest('hex').slice(0, 12);

const DETOUR = { recovery: 'retry', wall: 'change', found: 'change', plan: 'change', surprise: 'change' };
const TRIGGER_WORDS = { error: 'a failure', denied: 'a denied action', person: 'a person stepped in', human: 'a person stepped in', steer: 'a person stepped in', reasoning: 'reconsidering', evidence: 'what the output showed' };

/**
 * Build the extension from the pieces buildReceipt already computed.
 * @param {object} p
 * @param {any} p.session · @param {any} p.goal · @param {any[]} p.mine steps inside the goal · @param {any} p.thread root thread
 * @param {any[]} [p.threads] every thread of the session, for the detours inside this goal
 * @param {string} p.receiptId · @param {any[]} p.checked criteria from checkCriteria (with quote/index from extractIntent)
 * @param {any[]} p.evidence receipt.evidence · @param {Map<number,string>} p.evId step.at → evidence id
 * @param {any[]} p.actions receipt.actions · @param {any[]} p.trajectory receipt.trajectory
 */
export function buildReview({ session, goal, mine, thread, threads = [], receiptId, checked, evidence, evId, actions, trajectory }) {
  const threadById = new Map(threads.map((t) => [t.id, t]));
  const evIds = new Set(evidence.map((e) => e.id)); const actIds = new Set(actions.map((a) => a.id));
  const ev = (step) => { const id = evId.get(step.at); return id && evIds.has(id) ? [id] : []; };
  const act = (step) => (actIds.has(`step-${step.at}`) ? [`step-${step.at}`] : []);
  const asks = mine.filter((x) => x.kind === 'ask'); const askStep = asks[0];
  const tools = mine.filter((x) => x.kind === 'tool'); const says = mine.filter((x) => x.kind === 'say');
  const msgIndex = new Map(asks.map((a, i) => [a.at, i + 1]));

  // ---- sources: the ask, tickets named in it, PRs the work produced, the repo it ran in ----
  const sources = [];
  if (askStep) sources.push({ id: 'ask', type: 'chat', title: asks.length > 1 ? `Request from the person, ${asks.length} messages` : 'Request from the person', where: asks.length > 1 ? `messages 1–${asks.length}` : 'message 1', note: 'The person’s own words. Criteria below are read from them by Trail’s rules.' });
  const tickets = [...new Set([...String(askStep?.text || '').matchAll(TICKET)].map((m) => m[1]))].slice(0, 10);
  for (const t of tickets) sources.push({ id: `ticket-${t}`, type: 'ticket', title: t, note: 'Named in the ask. Trail did not read the ticket; its acceptance criteria are not in this record.' });
  const prs = [...new Set(tools.filter((x) => x.pr).map((x) => x.pr))].slice(0, 10);
  for (const n of prs) sources.push({ id: `pr-${n}`, type: 'pr', title: `PR #${n}`, ...(session.repo ? { href: `https://github.com/${session.repo}/pull/${n}` } : {}), note: 'Produced or touched by this work.' });
  if (session.repo) sources.push({ id: 'repo', type: 'artifact', title: String(session.repo), where: session.cwd ? clip(session.cwd, 200) : undefined, href: `https://github.com/${session.repo}`, note: 'The repository the work ran in.' });
  for (const s of sources) for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k];
  const srcIds = new Set(sources.map((s) => s.id));

  // ---- episodes: asks, steers, changes of course, retries, checks, commits ----
  const episodes = []; const seen = new Set();
  const push = (e) => { if (!e.at || seen.has(e.id)) return; seen.add(e.id); episodes.push(e); };
  asks.forEach((a, i) => {
    const steer = i > 0 && a.who === 'human' && (goal.backtracks || []).some((b) => b.at === a.at && b.trigger === 'person');
    push({ id: episodeId(receiptId, steer ? 'steer' : 'ask', a), kind: steer ? 'steer' : 'ask', at: iso(a.ts), title: nonEmpty(firstSentence(cleanAsk(a.text)), steer ? 'The person redirected the work' : 'The person asked for something'), ...(steer ? { why: clip(a.text, 400) } : {}), evidence_ids: ev(a), action_ids: [] });
  });
  const byTraj = new Map((trajectory || []).map((t) => [t.action_ids?.[0], t.id]));
  (goal.backtracks || []).forEach((b) => {
    if (b.trigger === 'person') return; // already an episode on the ask that caused it
    const step = mine.find((x) => x.at === b.at); if (!step) return;
    const tid = byTraj.get(`step-${b.at}`);
    push({ id: episodeId(receiptId, 'change', step), kind: 'change', at: iso(step.ts), title: `Changed approach after ${TRIGGER_WORDS[b.trigger] || 'reconsidering'}`, ...(step.text ? { why: firstSentence(step.text, 300) } : {}), evidence_ids: ev(step), action_ids: act(step), ...(tid ? { trajectory_id: tid } : {}), ...(typeof goal.conf?.backtracks === 'number' ? { confidence: +goal.conf.backtracks.toFixed(2) } : {}) });
  });
  // Detours threadify split out of this goal: recoveries are retries; walls, discoveries and plan steps are changes.
  for (const d of goal.episodes || []) {
    const th = d.thread && threadById.get(d.thread); const step = th ? mine.find((x) => x.at === th.at) : null;
    if (!step) continue;
    const kind = DETOUR[d.kind] || 'change';
    push({ id: episodeId(receiptId, kind, step), kind, at: iso(step.ts), title: kind === 'retry' ? `Retried after a failure: ${firstSentence(d.title, 120)}` : d.kind === 'wall' ? `Hit a denied action: ${firstSentence(d.title, 120)}` : d.kind === 'found' ? `Found something unexpected: ${firstSentence(d.title, 120)}` : firstSentence(d.title, 160), ...(th.backs?.length ? { why: th.backs.map((b) => b.why).filter(Boolean).slice(0, 3).join(' · ') } : {}), evidence_ids: ev(step), action_ids: act(step), thread: d.thread });
  }
  // Checks and commits are the moments a reviewer can hold on to.
  const lastEdit = Math.max(-1, ...tools.filter((x) => x.action === 'edit').map((x) => x.at));
  for (const x of tools) {
    if (['test', 'typecheck', 'lint', 'build'].includes(x.action) && x.result !== 'denied') {
      push({ id: episodeId(receiptId, 'check', x), kind: 'check', at: iso(x.ts), title: `${x.result === 'pass' ? 'Passed' : x.result === 'fail' ? 'Failed' : 'Ran'} ${x.action}${x.target ? `: ${clip(x.target, 120)}` : ''}`, ...(x.at > lastEdit ? { why: 'After the last change.' } : {}), evidence_ids: ev(x), action_ids: act(x) });
    } else if (x.action === 'commit' && x.result !== 'fail' && x.result !== 'denied') {
      const m = `${x.out || ''} ${x.outTail || ''}`.match(SHA); const msg = String(x.target || '').match(/-m\s+["']([^"']{1,200})/);
      push({ id: episodeId(receiptId, 'commit', x), kind: 'commit', at: iso(x.ts), title: msg ? `Committed: ${clip(msg[1], 160)}` : 'Committed the change', ...(m ? { commit: { sha: m[1] || m[2], ...(msg ? { message: clip(msg[1], 200) } : {}), ...(session.repo ? { href: `https://github.com/${session.repo}/commit/${m[1] || m[2]}` } : {}) } } : {}), evidence_ids: ev(x), action_ids: act(x) });
    }
  }
  episodes.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  // A commit episode must carry its sha; one whose output didn't show it is recorded as a change instead.
  for (const e of episodes) if (e.kind === 'commit' && !e.commit) { e.kind = 'change'; e.title = e.title.replace(/^Committed/, 'Tried to commit'); }

  // ---- criteria: where each was read from, and the four kinds of proof ----
  const criteria = checked.map((c) => {
    const quote = c.quote ? clip(c.quote, 400) : null;
    const source_refs = askStep && srcIds.has('ask') ? [{ source_id: 'ask', at: `message ${msgIndex.get(askStep.at) || 1}`, ...(quote ? { quote } : {}) }] : [];
    const decided = c.evidence_ids.filter((id) => evIds.has(id));
    const decidingEv = decided.map((id) => evidence.find((e) => e.id === id)).filter(Boolean);
    const kindOfEv = decidingEv[0]?.kind;
    const met = c.status === 'met', unmet = c.status === 'unmet';
    const measured = ['tests', 'typecheck', 'build', 'change_checked'].includes(c.kind)
      ? (met ? { status: 'pass', note: `${c.kind === 'change_checked' ? 'A check' : `The ${c.kind}`} ran after the last change and did not fail.`, evidence_ids: decided } : unmet ? { status: 'fail', note: decidingEv[0]?.summary ? `Last run: ${clip(decidingEv[0].summary, 200)}` : 'The last run after the change failed.', evidence_ids: decided } : { status: 'none', note: 'No run of this kind after the last change.' })
      : { status: 'na', note: 'Not a test or build criterion.' };
    const observed = ['check_output', 'ship_output', 'tool_output'].includes(kindOfEv) && decidingEv[0]?.excerpt
      ? { status: met ? 'pass' : unmet ? 'fail' : 'partial', note: met ? 'Recorded output shows it.' : unmet ? 'Recorded output shows the failure.' : 'Output recorded; the result could not be read from it.', evidence_ids: decided }
      : c.kind === 'answer' && met ? { status: 'pass', note: 'The closing report is the proof.', evidence_ids: decided }
      : { status: 'none', note: 'No output excerpt recorded for this.' };
    return {
      criterion_id: c.id, short: c.text, source_refs,
      source_check: 'unchecked',
      source_note: quote ? 'Read from the person’s words by Trail’s rules. The wording of the criterion is Trail’s; the quote is theirs.' : 'Inferred from the kind of ask; nothing in the person’s words states it directly.',
      lenses: {
        judged: { status: 'none', note: 'No review against the codebase or a skill was recorded.' },
        measured, observed,
        outcome: { status: 'none', note: 'No log or analytics signal linked.' },
      },
      episode_ids: episodes.filter((e) => (e.kind === 'check' || e.kind === 'commit') && e.evidence_ids.some((id) => decided.includes(id))).map((e) => e.id),
    };
  });

  // ---- layers: what this record has ----
  const measuredStatuses = criteria.map((c) => c.lenses.measured.status).filter((s) => s !== 'na');
  const observedStatuses = criteria.map((c) => c.lenses.observed.status);
  const layer = (statuses, full, part, none) => (!statuses.length || statuses.every((s) => s === 'none') ? ['missing', none] : statuses.every((s) => s !== 'none') ? ['full', full] : ['part', part]);
  const [mS, mN] = layer(measuredStatuses, `${measuredStatuses.filter((s) => s === 'pass').length} of ${measuredStatuses.length} tested`, `${measuredStatuses.filter((s) => s !== 'none').length} of ${measuredStatuses.length} tested`, 'No check ran');
  const [oS, oN] = layer(observedStatuses, 'Outputs recorded', 'Some outputs recorded', 'No output attached');
  const L = (status, note, how) => ({ status, note, ...(how ? { how } : {}) });
  const layers = {
    inputs: askStep ? L(asks.length > 1 ? 'full' : 'part', asks.length > 1 ? `${asks.length} messages from the person` : 'One message', undefined) : L('missing', 'No recorded ask', 'Start the work from a message so the request is on record.'),
    sources: tickets.length ? L('part', 'Ask names a ticket; not read') : L('part', 'Ask only; no doc or ticket', 'Name the spec, ticket or doc in the ask so criteria can be quoted from it.'),
    transcript: L('full', `${asks.length + says.length} messages, ${tools.length} tool calls`),
    judged: L('missing', 'No review', 'Add a reviewer pass against the codebase and the pinned skills; record it as a verification check.'),
    measured: L(mS, mN, mS === 'missing' ? 'Run the project’s tests after the last change so the result is on record.' : undefined),
    observed: L(oS, oN, oS === 'missing' ? 'Keep tool output in the transcript; Trail attaches the deciding excerpt.' : undefined),
    outcome: L('missing', 'No signal', 'Link a log or analytics query that shows the behavior after release.'),
  };

  const inputs = asks.slice(0, 50).map((a) => ({ who: a.who === 'human' ? 'Person' : a.who === 'schedule' ? 'Schedule' : 'Hook', type: 'chat', text: clip(a.text, 2000), ...(iso(a.ts) ? { at: iso(a.ts) } : {}), quality: checked.some((c) => c.quote) ? 'full' : 'part' }));
  const epByAt = new Map(episodes.filter((e) => e.kind === 'ask' || e.kind === 'steer').map((e) => [e.at, e.id]));
  const conversation = mine.filter((x) => x.kind === 'ask' || x.kind === 'say').slice(0, 400).map((x) => ({ who: x.kind === 'ask' ? (x.who === 'human' ? 'human' : 'system') : 'agent', text: clip(x.text, 2000) || '…', ...(iso(x.ts) ? { at: iso(x.ts) } : {}), ...(x.kind === 'ask' && epByAt.get(iso(x.ts)) ? { episode_id: epByAt.get(iso(x.ts)) } : {}) })).filter((u) => u.text.trim());
  const met = checked.filter((c) => c.status === 'met').length, unmet = checked.filter((c) => c.status === 'unmet').length, unknown = checked.filter((c) => c.status === 'unknown').length;
  const readings = [
    { label: 'Trail’s rules, reading the steps', value: `${goal.outcome?.kind || 'unclear'}${typeof goal.conf?.outcome === 'number' ? ` · confidence ${goal.conf.outcome}` : ''}` },
    ...(checked.length ? [{ label: 'Each criterion, judged against evidence', value: `${met} met, ${unmet} not met${unknown ? `, ${unknown} unknown` : ''}` }] : []),
    ...(goal.jev ? [{ label: 'A second reader (Jev)', value: `${goal.jev.status}${goal.agree ? ' · agrees' : ' · disagrees'}` }] : []),
  ];
  const work = clip([session.project || session.repo || session.client, firstSentence(cleanAsk(thread?.ask || goal.title || ''), 120)].filter(Boolean).join(' · '), 200) || 'Untitled work';
  const pr = prs[0]; const subject = pr ? { type: 'pull_request', title: `${session.repo ? session.repo + ' ' : ''}#${pr}`, system: 'github', id: session.repo ? `${session.repo}#${pr}` : String(pr), ...(session.repo ? { href: `https://github.com/${session.repo}/pull/${pr}` } : {}) } : session.repo ? { type: 'commit', title: String(session.repo), system: 'github', id: String(session.repo) } : { type: 'other', title: work };
  return { version: REVIEW_EXT, domain: 'code', subject, work, sources, criteria, episodes, layers, inputs, conversation, readings, metadata: { producer: 'trail', threads: (goal.threads || []).length, backtracks: (goal.backtracks || []).length, tool_calls: tools.length, failed_calls: tools.filter((x) => x.result === 'fail').length } };
}
