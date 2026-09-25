// Walls: failures agents keep rediscovering. Named walls carry a fix you can adopt;
// everything else is grouped by a normalized error signature so new walls surface on their own.

/** @typedef {{id:string,name:string,detect:(e:any)=>boolean,rule:string,kind:'agents'|'permissions'|'environment'}} Wall */
/** @type {Wall[]} */
export const WALLS = [
  { id: 'denied-home', kind: 'agents', name: 'Don’t-ask runs can’t read or write ~/.claude', detect: (e) => e.denied && /\.claude\//.test(e.target),
    rule: 'In scheduled / don’t-ask runs, files under ~/.claude are not readable or writable. Keep run state inside the repo (a gitignored file) or read your own earlier output instead.' },
  { id: 'denied-chain', kind: 'agents', name: 'Loops and chained shell commands get denied', detect: (e) => e.denied && e.tool === 'Bash' && /&&|\|\||;|\bfor\b|\bwhile\b/.test(e.target),
    rule: 'In don’t-ask mode, shell loops (`for`, `while`) and chains (`&&`, `;`) are denied. Run one simple command per call. Plain pipes into grep/head are allowed.' },
  { id: 'denied-gh-api', kind: 'agents', name: '`gh api` and `gh issue` are denied', detect: (e) => e.denied && /\bgh (api|issue|run)\b/.test(e.target),
    rule: 'In don’t-ask mode, `gh api`, `gh issue` and `gh run` are denied. Use `gh pr list|view|diff|checks|comment` instead.' },
  { id: 'denied-mcp', kind: 'agents', name: 'MCP tools are denied', detect: (e) => e.denied && /^mcp__/.test(e.rawTool || ''),
    rule: 'In don’t-ask mode, MCP tools are denied. Use repo files and git history as evidence and say the MCP source was unavailable.' },
  { id: 'denied-web', kind: 'agents', name: 'Web fetches are denied', detect: (e) => e.denied && /WebFetch|WebSearch/.test(e.tool),
    rule: 'In don’t-ask mode, WebFetch and WebSearch are denied. Do not plan on external lookups.' },
  { id: 'denied-other', kind: 'agents', name: 'Other tools denied in don’t-ask mode', detect: (e) => e.denied,
    rule: 'This run is in don’t-ask mode: tools outside the allowed set are denied, not prompted. Prefer Read/Grep/Glob and simple single commands, and report BLOCKED instead of retrying variants.' },
  { id: 'disk-full', kind: 'environment', name: 'The disk fills up mid-run', detect: (e) => e.err && /ENOSPC|No space left/i.test(e.errText),
    rule: 'This machine runs low on disk during builds and renders. Check `df -h` before long builds and clean caches first.' },
  { id: 'heap', kind: 'environment', name: 'Typecheck or build runs out of memory', detect: (e) => e.err && /heap out of memory|JavaScript heap/i.test(e.errText),
    rule: 'Full typecheck/build exceeds the default Node heap here. Use the scoped/staged typecheck, or set NODE_OPTIONS=--max-old-space-size explicitly.' },
  { id: 'port', kind: 'environment', name: 'Dev server port already in use', detect: (e) => e.err && /EADDRINUSE|address already in use/i.test(e.errText),
    rule: 'A dev server is often already running. Check the port (`lsof -i :3000`) and reuse it before starting another.' },
  { id: 'auth-expired', kind: 'environment', name: 'A CLI or OAuth login expired', detect: (e) => e.err && /(OAuth|session) (session )?expired|Failed to authenticate|401 Unauthorized/i.test(e.errText),
    rule: 'CLI logins here expire. If a CLI reports expired auth, stop and ask the human to log in again. Don’t retry.' },
  { id: 'no-module', kind: 'environment', name: 'A dependency is missing (broken node_modules)', detect: (e) => e.err && /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(e.errText),
    rule: 'node_modules here breaks between worktrees. If a module is missing, run the package manager install for that worktree before debugging code.' },
];

/** Normalize an error into a stable signature so identical failures group together. */
export function signature(e) {
  const line = String(e.errText || '').replace(/^[\s"{[]+/, '').replace(/\\n/g, '\n').split('\n').map((l) => l.trim()).find((l) => l.length > 8 && !/^(exit code:? \d+|(process )?exited with code \d+|script (failed|completed|error:?\s*$)|wall time|output:|chunk id|original token count|\(exited)/i.test(l)) || '';
  const norm = line.toLowerCase()
    .replace(/(\/[\w.@~-]+)+/g, '<path>').replace(/\b[0-9a-f]{7,}\b/g, '<id>').replace(/\d+(\.\d+)?/g, 'n')
    .replace(/(["'`]).*?\1/g, '"…"').replace(/^(script failed|error|fatal)[:\s]+/, '').replace(/\s+/g, ' ').trim().slice(0, 90);
  return norm.length > 6 ? `${e.tool}: ${norm}` : null;
}

export const wallById = (id) => WALLS.find((w) => w.id === id);
