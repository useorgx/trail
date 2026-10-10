// Use the portable receipt's canonicalization, so every material field participates in its revision.
import crypto from 'node:crypto';
import { canonicalizeAgentWorkReceiptContent } from '@useorgx/agent-work-receipt';

export const receiptFingerprint = (receipt) => crypto.createHash('sha256')
  .update(canonicalizeAgentWorkReceiptContent(receipt)).digest('hex');

/** Snapshot the JSON actually stored/sent. Re-hash after any redaction, review or graph enrichment. */
export function withIntegrity(receipt) {
  const value = JSON.parse(JSON.stringify(receipt));
  value.integrity = { content_hash: { algorithm: 'sha-256', encoding: 'hex', value: receiptFingerprint(value) } };
  return value;
}
