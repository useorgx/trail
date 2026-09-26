// Every client trail reads, in one place: how to read it, what to call it, and its id in the upload contract.
// Also the package's public reader: `import { readSession, CLIENTS } from '@useorgx/trail/sessions'`.
import { readClaude, readCodex } from './adapters.mjs';
import { readOpenCode, readCursor } from './adapters-sqlite.mjs';

export const CLIENTS = {
  claude: { label: 'Claude Code', short: 'cc', contract: 'claude-code', read: readClaude },
  codex: { label: 'Codex', short: 'cx', contract: 'codex', read: readCodex },
  opencode: { label: 'OpenCode', short: 'oc', contract: 'opencode', read: readOpenCode },
  cursor: { label: 'Cursor', short: 'cu', contract: 'cursor', read: readCursor },
};
export const readSession = (file, client) => (CLIENTS[client] || CLIENTS.claude).read(file);
export const clientLabel = (c) => CLIENTS[c]?.label || c;
export const clientShort = (c) => CLIENTS[c]?.short || String(c).slice(0, 2);
