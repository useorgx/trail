import crypto from 'node:crypto';
import { canonicalizeAgentWorkJson } from '@useorgx/agent-work-receipt';
import { receiptFingerprint } from './integrity.mjs';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
const bytes = (value, length) => {
  if (typeof value !== 'string') return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === length && decoded.toString('base64url') === value ? decoded : null;
};

// This is deliberately narrower than general receipt verification. Trail sends a
// freshly hashed document without producer signatures. OrgX may append exactly
// one custody seal; every submitted byte (including the digest) must survive.
export async function matchesReceiptReadback(document, pending, { root, fetchImpl }) {
  if (receiptFingerprint(document) !== pending.fingerprint) return false;
  if (hash(canonicalizeAgentWorkJson(document)) === pending.wireHash) return true;
  const integrity = document.integrity;
  if (!exactKeys(integrity, ['content_hash', 'signatures']) || !Array.isArray(integrity.signatures) || integrity.signatures.length !== 1) return false;
  const digest = integrity.content_hash; const seal = integrity.signatures[0];
  if (!exactKeys(digest, ['algorithm', 'encoding', 'value']) || digest.algorithm !== 'sha-256' || digest.encoding !== 'hex' || digest.value !== pending.fingerprint) return false;
  if (!exactKeys(seal, ['algorithm', 'encoding', 'key_id', 'signer', 'signed_at', 'attests', 'value']) ||
    seal.algorithm !== 'ed25519' || seal.encoding !== 'base64url' || seal.attests !== 'ingested' ||
    !/^orgx-receipt-[a-f0-9]{16}$/.test(seal.key_id) || typeof seal.signed_at !== 'string' || !Number.isFinite(Date.parse(seal.signed_at)) ||
    !exactKeys(seal.signer, ['type', 'id', 'display_name']) || seal.signer.type !== 'service' || seal.signer.id !== 'orgx' || seal.signer.display_name !== 'OrgX') return false;
  const signature = bytes(seal.value, 64);
  if (!signature) return false;
  const submitted = { ...document, integrity: { content_hash: digest } };
  if (hash(canonicalizeAgentWorkJson(submitted)) !== pending.wireHash) return false;
  // Resolve only the configured origin's public keys, never a key URL supplied
  // by the receipt. No private credential is needed for this public endpoint.
  const response = await fetchImpl(`${root}/.well-known/orgx-receipt-keys.json`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) return false;
  const jwks = await response.json();
  if (!Array.isArray(jwks?.keys) || jwks.keys.length > 17) return false;
  const candidates = jwks.keys.filter((key) => key?.kid === seal.key_id);
  if (candidates.length !== 1) return false;
  const key = candidates[0]; const publicBytes = bytes(key.x, 32);
  if (key.kty !== 'OKP' || key.crv !== 'Ed25519' || key.alg !== 'EdDSA' || key.use !== 'sig' || Object.hasOwn(key, 'd') || !publicBytes ||
    `orgx-receipt-${hash(publicBytes).slice(0, 16)}` !== key.kid) return false;
  // Exact agent-work-receipt-signature/v0.1 protected payload, including
  // attests. Do not use a pre-attestation SDK helper that omits this field.
  const payload = canonicalizeAgentWorkJson({
    content_hash: { algorithm: 'sha-256', value: digest.value },
    profile: 'agent-work-receipt-signature/v0.1',
    protected: { algorithm: seal.algorithm, encoding: seal.encoding, key_id: seal.key_id,
      signer: seal.signer, signed_at: seal.signed_at, attests: seal.attests },
  });
  return crypto.verify(null, Buffer.from(payload), crypto.createPublicKey({ key, format: 'jwk' }), signature);
}
