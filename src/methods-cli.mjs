import { credential, baseUrl } from './credentials.mjs';
import { publishMethod } from './methods.mjs';

async function responseJson(response) {
  if (!response.ok) throw new Error(`OrgX refused the method request (${response.status}). Existing instructions were preserved.`);
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length;
      if (bytes > 128 * 1024) throw new Error('Method response exceeds the publisher limit.'); chunks.push(Buffer.from(next.value)); }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function methodsCommand(argv, { fetchImpl = fetch } = {}) {
  const value = (flag) => { const index = argv.indexOf(`--${flag}`); return index >= 0 ? argv[index + 1] : undefined; };
  const operation = argv[0] || 'list';
  if (!['list', 'publish', 'remove'].includes(operation)) throw new Error('Use trail methods list, publish, or remove.');
  const workspaceId = value('workspace');
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId || '')) throw new Error('Supply --workspace with the canonical workspace ID.');
  const origin = new URL(baseUrl(value('base')));
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('Method authority requires HTTPS or a local test server.');
  const auth = credential();
  if (!auth?.key) throw new Error('Run trail connect or set ORGX_API_KEY to read canonical methods.');
  const url = new URL('/api/v1/precedents/methods', origin);
  url.searchParams.set('workspace_id', workspaceId);
  if (value('method')) url.searchParams.set('method_id', value('method'));
  const headers = { authorization: `Bearer ${auth.key}` };
  const loadAuthority = async () => {
    const body = await responseJson(await fetchImpl(url, { headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000) }));
    if (!body.ok) throw new Error('Current method authority is unavailable.');
    return body.data;
  };
  if (operation === 'list') return { catalog: await loadAuthority(), preview: true };
  const expected = { workspaceId, id: value('method'), version: Number(value('version')), digest: value('digest') };
  if (!expected.id || !Number.isSafeInteger(expected.version) || expected.version < 1 || !/^sha256:[0-9a-f]{64}$/.test(expected.digest || '') || !value('repo')) throw new Error('Supply --repo, --method, --version and --digest from the current canonical method.');
  const result = await publishMethod({ repo: value('repo'), targetName: value('to') || 'AGENTS.md', expected, loadAuthority,
    enabled: argv.includes('--yes'), remove: operation === 'remove' });
  if (!result.preview && result.blockDigest) {
    try {
      const body = await responseJson(await fetchImpl(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId, method_id: expected.id, version: expected.version, digest: expected.digest,
          opportunity_id: result.opportunity, target: value('to') || 'AGENTS.md', installed_block_digest: result.blockDigest }),
        redirect: 'error', signal: AbortSignal.timeout(10_000) }));
      result.delivery = body.data;
    } catch (error) { result.delivery = { stage: 'unrecorded', error: error.message }; }
  }
  return result;
}
