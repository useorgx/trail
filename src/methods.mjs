// Explicit canonical method delivery. No session store, transcript discovery or global targets.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_FILE_BYTES = 128 * 1024;
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const namespace = '<!-- orgx-method:';
const keyFor = (id) => sha(id);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function validateMethod(catalog, expected) {
  assert(catalog?.schema_version === 'orgx.ratified-method-delivery/v1' && catalog.workspace_id === expected.workspaceId &&
    catalog.consistency === 'best_effort_multi_read' && catalog.candidates_withheld === 0 && Array.isArray(catalog.methods), 'Current method authority is incomplete or has the wrong workspace.');
  assert(Number.isFinite(Date.parse(catalog.read_at)) && Math.abs(Date.now() - Date.parse(catalog.read_at)) < 60_000, 'Method authority is stale. Fetch it again.');
  const matches = catalog.methods.filter((method) => method.id === expected.id);
  assert(matches.length === 1, 'The method is absent or ambiguous. Existing instructions were preserved.');
  const method = matches[0];
  assert(method.version === expected.version && method.digest === expected.digest && digestPattern.test(method.digest), 'The method changed. Review its current version and digest before publishing.');
  assert(Number.isSafeInteger(method.version) && method.version > 0 && Number.isSafeInteger(method.method_version) && method.method_version > 0 &&
    ['effective', 'revoked', 'inactive'].includes(method.status) && ['shadow', 'inform', 'warn', 'block'].includes(method.mode) &&
    method.revocation?.head_version === method.version && method.revocation.checked_at === catalog.read_at &&
    typeof method.ratification_ref === 'string' &&
    ((method.ratification_kind === 'decision' && method.ratification_ref.startsWith('orgx://decisions/')) ||
      (method.ratification_kind === 'canonical_human_ratification' && method.ratification_ref.startsWith(`orgx://precedents/${method.id}/ratify/`) && digestPattern.test(method.ratification_event_hash))) &&
    digestPattern.test(method.authority_event_hash), 'The method has no current ratified authority witness.');
  for (const [key, limit, length] of [['steps', 30, 1000], ['prerequisites', 20, 500], ['exceptions', 20, 500], ['supporting_evidence', 50, 500]]) {
    assert(Array.isArray(method[key]) && method[key].length <= limit && (key !== 'steps' || method[key].length > 0) &&
      method[key].every((text) => typeof text === 'string' && text.length > 0 && text.length <= length), `The method's ${key} are invalid.`);
  }
  assert(method.scope && ['workspace', 'org'].includes(method.scope.kind) && typeof method.scope.id === 'string' &&
    typeof method.workspace_id === 'string' && typeof method.owner_id === 'string' && typeof method.authority_owner_id === 'string' &&
    typeof method.title === 'string' && typeof method.ruling === 'string' && typeof method.authority_ref === 'string' &&
    Number.isFinite(Date.parse(method.valid_from)) && (method.valid_until === null || Number.isFinite(Date.parse(method.valid_until))), 'The method provenance is invalid.');
  if (method.status === 'effective') assert(method.mode !== 'shadow' && Date.parse(method.valid_from) <= Date.now() && (!method.valid_until || Date.parse(method.valid_until) > Date.now()), 'The method is outside its effective interval.');
  if (method.status === 'revoked') assert(Number.isFinite(Date.parse(method.revocation.revoked_at)), 'The revocation has no canonical timestamp.');
  return method;
}

function blocks(text) {
  const pattern = /<!-- orgx-method:([0-9a-f]{64}) BEGIN -->\n<!-- orgx-method-state:([A-Za-z0-9_-]+) -->\n([\s\S]*?)<!-- orgx-method:\1 END -->/g;
  const result = new Map();
  for (const match of text.matchAll(pattern)) {
    assert(!result.has(match[1]), 'Duplicate managed method blocks. Existing instructions were preserved.');
    let metadata;
    try { metadata = JSON.parse(Buffer.from(match[2], 'base64url').toString('utf8')); } catch { throw new Error('Managed method metadata is unreadable.'); }
    assert(metadata && keyFor(metadata.id) === match[1] && Number.isSafeInteger(metadata.version) &&
      digestPattern.test(metadata.digest) && metadata.body_digest === `sha256:${sha(match[3])}`, 'The managed method block was edited. Existing instructions were preserved.');
    result.set(match[1], { start: match.index, end: match.index + match[0].length, metadata, body: match[3] });
  }
  const unparsed = text.replace(pattern, '');
  assert(!unparsed.includes(namespace) && !unparsed.includes('<!-- orgx-method-state:'), 'Malformed managed method markers. Existing instructions were preserved.');
  return result;
}

function render(method, workspaceId, prefixNewline) {
  const body = [`## ${method.title}`, '', `${method.ruling}`, '',
    `Canonical method: ${method.id}@${method.version}`, `Digest: ${method.digest}`,
    `Owner: ${method.owner_id}`, `Scope: ${method.scope.kind}:${method.scope.id}`,
    `Applies to: ${JSON.stringify(method.applies_to)}`, `Ratification: ${method.ratification_ref}`,
    `Current authority: ${method.authority_ref}`, `Effective from: ${method.valid_from}`,
    `Expires: ${method.valid_until || 'No expiry recorded'}`, '', 'Steps:', ...method.steps.map((step, i) => `${i + 1}. ${step}`),
    '', 'Prerequisites:', ...method.prerequisites.map((text) => `- ${text}`),
    '', 'Exceptions:', ...method.exceptions.map((text) => `- ${text}`),
    '', 'Supporting evidence:', ...method.supporting_evidence.map((text) => `- ${text}`),
    '', 'Recheck current canonical authority before use; a newer version or revocation supersedes this block.',
    'Cite this canonical method when using it. Delivery alone does not prove use or improvement.', ''].join('\n');
  assert(!body.includes(namespace) && !body.includes('<!-- orgx-method-state:') && !body.includes('\0'), 'Method text conflicts with managed markers. Existing instructions were preserved.');
  const metadata = { id: method.id, version: method.version, digest: method.digest, workspace_id: workspaceId,
    prefix_newline: prefixNewline, body_digest: `sha256:${sha(body)}` };
  const key = keyFor(method.id);
  return { text: `${namespace}${key} BEGIN -->\n<!-- orgx-method-state:${Buffer.from(JSON.stringify(metadata)).toString('base64url')} -->\n${body}${namespace}${key} END -->`, metadata };
}

export function planMethodPublication(text, catalog, expected, { remove = false, repo } = {}) {
  const method = validateMethod(catalog, expected);
  const managed = blocks(text).get(keyFor(method.id));
  if (managed) {
    assert(managed.metadata.workspace_id === expected.workspaceId, 'This method block belongs to another workspace.');
    assert(managed.metadata.version <= method.version && (managed.metadata.version !== method.version || managed.metadata.digest === method.digest), 'The installed method is newer or conflicts with current authority.');
  }
  if (remove || method.status !== 'effective') {
    const start = managed?.metadata.prefix_newline && text[managed.start - 1] === '\n' ? managed.start - 1 : managed?.start;
    return { method, operation: managed ? 'removed' : 'unchanged', text: managed ? text.slice(0, start) + text.slice(managed.end) : text, blockDigest: null };
  }
  const repos = method.applies_to?.repos;
  assert(repos === undefined || (Array.isArray(repos) && repos.every((value) => typeof value === 'string') &&
    repos.some((value) => String(repo || '').toLowerCase().includes(value.toLowerCase().replace(/\.git$/, '')))), 'This method does not apply to the selected repository.');
  const block = render(method, expected.workspaceId, managed ? !!managed.metadata.prefix_newline : !!text && !text.endsWith('\n'));
  const next = managed ? text.slice(0, managed.start) + block.text + text.slice(managed.end) : text + (text && !text.endsWith('\n') ? '\n' : '') + block.text;
  return { method, operation: next === text ? 'unchanged' : managed ? 'rewritten' : 'published', text: next, blockDigest: block.metadata.body_digest };
}

function readTarget(target) {
  let fd;
  try {
    const stat = fs.lstatSync(target);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_FILE_BYTES, 'Instruction target must be a bounded regular file, not a symlink.');
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    assert(opened.isFile() && opened.ino === stat.ino && opened.dev === stat.dev, 'Instruction target changed while it was opened.');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1); let length = 0;
    while (length < buffer.length) { const count = fs.readSync(fd, buffer, length, buffer.length - length); if (!count) break; length += count; }
    const bytes = buffer.subarray(0, length);
    assert(bytes.length <= MAX_FILE_BYTES, 'Instruction file exceeds the publisher limit.');
    return { bytes, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), mode: stat.mode & 0o777 };
  } catch (error) { if (error.code === 'ENOENT') return { bytes: null, text: '', mode: 0o600 }; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
const sameBytes = (left, right) => left === null ? right === null : right !== null && left.equals(right);

/** Opt-in writes are locked against other publishers and checked against editor changes before rename. */
export async function publishMethod({ repo, targetName = 'AGENTS.md', expected, loadAuthority, enabled = false, remove = false, beforeCommit } = {}) {
  assert(['AGENTS.md', 'CLAUDE.md'].includes(targetName), 'Choose AGENTS.md or CLAUDE.md at the selected repository root.');
  const root = fs.realpathSync(repo);
  assert(fs.statSync(root).isDirectory(), 'Repository must be an existing directory.');
  const target = path.join(root, targetName);
  const original = readTarget(target);
  let plan = planMethodPublication(original.text, await loadAuthority(), expected, { remove, repo: root });
  if (!enabled) return { ...plan, target, preview: true };
  const lock = path.join(root, '.orgx-methods.lock');
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  let temporary;
  try {
    // A preview never grants permission for a changed canonical version.
    plan = planMethodPublication(original.text, await loadAuthority(), expected, { remove, repo: root });
    if (beforeCommit) await beforeCommit();
    assert(sameBytes(original.bytes, readTarget(target).bytes), 'Instruction file changed during publication. Nothing was overwritten.');
    if (plan.operation !== 'unchanged') {
      assert(Buffer.byteLength(plan.text) <= MAX_FILE_BYTES, 'Published instruction file exceeds the publisher limit.');
      temporary = path.join(root, `.orgx-methods-${crypto.randomUUID()}.tmp`);
      fs.writeFileSync(temporary, plan.text, { flag: 'wx', mode: original.mode });
      fs.chmodSync(temporary, original.mode);
      assert(sameBytes(original.bytes, readTarget(target).bytes), 'Instruction file changed before publication. Nothing was overwritten.');
      fs.renameSync(temporary, target); temporary = null;
    }
    return { ...plan, target, preview: false, opportunity: `instruction-file:${sha(`${root}\0${targetName}\0${expected.id}\0${expected.version}`)}` };
  } finally {
    if (temporary) fs.unlinkSync(temporary);
    fs.closeSync(lockFd); fs.unlinkSync(lock);
  }
}
