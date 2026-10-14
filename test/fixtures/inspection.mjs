import { buildReceipt } from '../../src/receipt.mjs';
export function syntheticReceipt(id = 'synthetic-review') {
  const at = '2026-10-14T10:00:00Z'; const ask = 'Fix the tests and typecheck after the change';
  const steps = [{ at: 0, kind: 'ask', ts: at, who: 'human', text: ask },
    { at: 1, kind: 'tool', ts: at, tool: 'Edit', target: 'src/retry.ts', action: 'edit', result: 'ok', code: true },
    { at: 2, kind: 'tool', ts: at, tool: 'Bash', target: 'npm test', out: '12 tests passed', action: 'test', result: 'pass' }];
  return buildReceipt({ client: 'synthetic-codex', id, repo: 'example-labs/atlas' },
    { root: 'T1', title: ask, origin: 'ask', spans: [[0,2]], outcome: { kind: 'verified_change', at: 2 }, conf: { outcome: 0.3 } },steps,{ ask });
}
