// A cloud receipt is bound to its prepared destination. Configuration is not authentication.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { authHeaders } from './credentials.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
export function receiptDestination(value) {
  const url = new URL(value);
  assert(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Cloud receipt destination must be an origin without credentials, path, query or fragment.');
  assert(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)), 'Cloud receipt destination requires HTTPS.');
  return url.origin;
}

function preparedConfig(required) {
  const file = path.join(os.homedir(), '.orgx', 'cloud.json');
  let fd;
  try {
    // Refuse malformed, unreadable and replaced configuration instead of falling back to desktop credentials.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    assert(stat.isFile() && stat.size <= 16_384, 'Cloud receipt configuration must be a bounded regular file.');
    const text = fs.readFileSync(fd, 'utf8');
    assert(Buffer.byteLength(text) <= 16_384, 'Cloud receipt configuration exceeds its limit.');
    const config = JSON.parse(text);
    assert(config?.schemaVersion === 'orgx-cloud-config/v1' && uuid.test(config.workspaceId), 'Cloud receipt configuration has no valid workspace binding.');
    assert(['direct', 'proxy-header', 'proxy-placeholder'].includes(config.authMode), 'Cloud receipt configuration has an invalid auth mode.');
    assert(config.receipts === 'content' && config.nativePayloads === true, 'Cloud receipt content capture is not enabled in prepared configuration.');
    assert(['codex', 'claude-code'].includes(config.client), 'Cloud receipt client is unsupported.');
    return { workspaceId: config.workspaceId, base: receiptDestination(config.baseUrl), authMode: config.authMode, client: config.client };
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return null;
    throw new Error('Cloud receipt binding is missing, disabled or invalid. Prepare the intended workspace before sending.', { cause: error });
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function receiptBoundary({ root, workspace, cloudRequired = false, client, captureAfter } = {}) {
  const prepared = preparedConfig(cloudRequired);
  if (!prepared) {
    assert(!workspace, 'A workspace-bound automatic receipt requires prepared cloud configuration.');
    return null;
  }
  assert(receiptDestination(root) === prepared.base, 'Receipt destination differs from prepared cloud configuration.');
  assert(!workspace || workspace === prepared.workspaceId, 'Receipt workspace differs from prepared cloud configuration.');
  assert(!client || (client === 'claude' ? 'claude-code' : client) === prepared.client, 'Receipt client differs from prepared cloud configuration.');
  if (cloudRequired) {
    const file = path.join(process.env.TRAIL_HOME || path.join(os.homedir(), '.orgx', 'trail'), 'receipt-hooks.json');
    let hook; try { hook = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const preparedAt = Date.parse(hook?.preparedAt);
    assert(Number.isFinite(preparedAt) && preparedAt <= Date.now() + 60_000 && (!captureAfter || captureAfter === hook.preparedAt), 'Cloud receipt activation boundary is missing or changed.');
    captureAfter = hook.preparedAt;
    assert(hook?.enabled === true && hook.cloudRequired === true && hook.workspace === prepared.workspaceId && hook.base === prepared.base && hook.clients?.includes(prepared.client === 'claude-code' ? 'claude' : prepared.client), 'Cloud receipt hooks are disabled or their destination changed.');
  }
  return Object.freeze({ ...prepared, cloudRequired, captureAfter });
}

export async function verifyReceiptBoundary(boundary, cred, fetchImpl, previousActor) {
  if (!boundary) return null;
  const current = receiptBoundary({ root: boundary.base, workspace: boundary.workspaceId, cloudRequired: boundary.cloudRequired, client: boundary.client, captureAfter: boundary.captureAfter });
  assert(current, 'Cloud receipt configuration was removed.');
  assert(current.authMode === boundary.authMode, 'Cloud receipt auth mode changed after capture.');
  assert((cred.mode || 'direct') === boundary.authMode, 'Receipt credential transport differs from prepared configuration.');
  if (boundary.authMode === 'direct') assert(cred.from === 'ORGX_API_KEY', 'Cloud receipts require the runtime credential, not a stored desktop credential.');
  const response = await fetchImpl(`${boundary.base}/api/v1/me`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8_000), headers: authHeaders(cred) });
  const data = (await response.json().catch(() => null))?.data;
  const actor = data?.principal?.user_id;
  assert(response.ok && uuid.test(actor) && data?.default_workspace_id === boundary.workspaceId && Array.isArray(data?.workspaces) && data.workspaces.some((item) => item?.id === boundary.workspaceId), 'Receipt identity does not match the intended workspace. No content was sent.');
  assert(!previousActor || previousActor === actor, 'Receipt actor changed before send. No content was sent.');
  if (boundary.authMode !== 'direct') assert(cred.scope === `${boundary.workspaceId}:${actor}`, 'ORGX_AUTH_SCOPE does not match authenticated receipt identity.');
  // Recheck after the asynchronous identity read as well as before it.
  const after = receiptBoundary({ root: boundary.base, workspace: boundary.workspaceId, cloudRequired: boundary.cloudRequired, client: boundary.client, captureAfter: boundary.captureAfter });
  assert(after, 'Cloud receipt configuration was removed during verification.');
  assert(after.authMode === boundary.authMode, 'Cloud receipt auth mode changed during verification.');
  return { workspaceId: boundary.workspaceId, actorId: actor, destination: boundary.base,
    scopeHash: crypto.createHash('sha256').update(cred.scope || cred.key).digest('hex') };
}
