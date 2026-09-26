// `trail credits`: the people whose work trail is built on, what each one figured out, and where it lives in trail.
// "Built on", never "built with" or "backed by": none of them endorse trail. The OrgX /trail/credits page mirrors
// this list; keep the two in sync.
export const CREDITS = [
  { id: 'clio', who: 'Alex Tamkin and the Clio team at Anthropic', work: 'Clio: privacy-preserving insights into real-world AI use', year: 2024,
    url: 'https://www.anthropic.com/research/clio',
    idea: 'You can learn how people really use AI without anyone reading their conversations: have a model summarize and cluster conversations, then show a cluster only when enough different people are behind it.',
    took: 'A fix’s public numbers appear only once at least 5 separate people have adopted it, and uploads carry counts, not words (thread titles only if you opt in with --with-titles).',
    where: 'trail share · the /trail/fixes pages · trail sync (metadata only by default)' },
  { id: 'error-analysis', who: 'Hamel Husain and Shreya Shankar', work: 'Error analysis for AI systems (open coding → axial coding → count → judge)', year: 2025,
    url: 'https://hamel.dev/blog/posts/evals-faq/why-is-error-analysis-so-important-in-llm-evals-and-how-is-it-performed.html',
    idea: 'Look at real traces before building any metric. Write down what went wrong in your own words, group the notes into failure types, count them, and only then automate a judge you have checked against people.',
    took: 'The walls are failure types counted across real sessions, and trail’s classifier is checked against human labels in a labeling lab. (We wrote our codebook before our notes, which they warn against; the next labeling pass starts from notes.)',
    where: 'trail walls · the labeling lab (lab/serve.mjs)' },
  { id: 'sniffly', who: 'Chip Huyen', work: 'Sniffly: a dashboard over your local Claude Code logs', year: 2025,
    url: 'https://github.com/chiphuyen/sniffly',
    idea: 'Your agent’s own logs, read locally, can tell you something surprising about how it fails, like how many errors come from looking for files that don’t exist.',
    took: 'Lead with one surprising number about your own agents, found locally.',
    where: 'trail card · the Overview' },
  { id: 'docent', who: 'Transluce', work: 'Docent: searching agent transcripts against a rubric, with cited evidence', year: 2025,
    url: 'https://transluce.org/docent/blog/introducing-docent',
    idea: 'Turn anecdotes about agent transcripts into traceable measurements, and prove a finding by fixing it and measuring again.',
    took: 'Every adopted fix is reported as a measured before and after, not a claim.',
    where: 'trail adopt · the effect line on each wall' },
  { id: 'agents-md-measured', who: 'Andrea Griffiths', work: 'Measuring AGENTS.md: what five runs show that one doesn’t (AAIF)', year: 2026,
    url: 'https://aaif.io/blog/measuring-agents-md-what-five-runs-show-that-one-doesn-t',
    idea: 'A single before/after comparison of agent runs can point the wrong way and still look convincing; repeat the runs before believing a result.',
    took: 'trail experiments reports intervals and says “no detectable change” when the interval spans zero. We learned the same lesson the hard way: our first before/after was confounded by a permission-mode switch.',
    where: 'trail experiments · trail bench' },
  { id: 'metr', who: 'Joel Becker, Nate Rush, Beth Barnes and David Rein (METR)', work: 'Measuring the impact of early-2025 AI on experienced open-source developer productivity', year: 2025,
    url: 'https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/',
    idea: 'In a randomized trial, developers took 19% longer with AI tools while believing they were faster. How agent work feels is not evidence of how it went.',
    took: 'trail compares like with like (same client, same permission mode) and marks a result confounded instead of reporting it.',
    where: 'trail adopt effects · trail experiments' },
  { id: 'agents-md', who: 'The AGENTS.md contributors (now stewarded by the Agentic AI Foundation)', work: 'AGENTS.md: a simple, open format for guiding coding agents', year: 2025,
    url: 'https://agents.md/',
    idea: 'One plain Markdown file at the root of a repo that every coding agent reads.',
    took: 'Fixes are written where agents already look, as a removable block in AGENTS.md or CLAUDE.md.',
    where: 'trail adopt · trail unadopt' },
  { id: 'entire', who: 'Thomas Dohmke and the Entire team', work: 'Entire: agent checkpoints stored in git, next to the code', year: 2026,
    url: 'https://entire.io/',
    idea: 'The record of what an agent did should travel with the code it changed.',
    took: 'Lessons live in the repo, in files a team reviews like any other change.',
    where: 'trail adopt' },
  { id: 'agent-trace', who: 'Cursor', work: 'Agent Trace: an open, vendor-neutral spec for AI code attribution', year: 2026,
    url: 'https://agent-trace.dev/',
    idea: 'A small open spec that any tool can implement beats a format one product owns.',
    took: 'trail’s upload format (orgx-trail-threads/v1) is a short, versioned contract you can inspect with --dry-run; publishing it as an open spec is next.',
    where: 'trail sync --dry-run' },
  { id: 'ccusage', who: 'ryoppippi and the ccusage contributors', work: 'ccusage: token and cost analysis from local agent logs', year: 2025,
    url: 'https://github.com/ccusage/ccusage',
    idea: 'Answer an anxious question instantly, from files already on your machine, with one npx command and no signup.',
    took: 'npx, no account, nothing uploaded, a first answer in about 40 seconds.',
    where: 'npx @useorgx/trail' },
  { id: 'pgn', who: 'Steven J. Edwards', work: 'Portable Game Notation (PGN)', year: 1993,
    url: 'https://en.wikipedia.org/wiki/Portable_Game_Notation',
    idea: 'A whole game can be written as a short line of moves that people and programs both read.',
    took: 'Each thread is a move string (probe, run, change, check, ship, failed, denied) you can read at a glance and compare.',
    where: 'the braid on every thread' },
  { id: 'stigmergy', who: 'Pierre-Paul Grassé', work: 'Stigmergy: coordination through traces left in the environment', year: 1959,
    url: 'https://pubmed.ncbi.nlm.nih.gov/10633572/',
    idea: 'Termites coordinate without talking to each other: each one responds to what earlier work left behind.',
    took: 'A wall one session hit becomes a trace the next session reads before it starts, instead of every session starting from zero.',
    where: 'trail guard · trail mcp (trail_check)' },
];

export function creditsText(C) {
  const out = [`${C.b}Built on the work of${C.r}  ${C.dim}(none of them endorse trail; this is what we learned from them)${C.r}`, ''];
  for (const c of CREDITS) {
    out.push(`${C.lime}■${C.r} ${C.b}${c.who}${C.r}  ${C.dim}${c.year}${C.r}`);
    out.push(`  ${c.work}`);
    out.push(`  ${C.mid}${c.idea}${C.r}`);
    out.push(`  ${C.teal}In trail:${C.r} ${c.took} ${C.dim}(${c.where})${C.r}`);
    out.push(`  ${C.dim}${c.url}${C.r}`, '');
  }
  return out.join('\n');
}
