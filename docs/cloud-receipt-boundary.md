# Cloud receipt boundary

Automatic cloud capture needs a prepared workspace, origin, authentication mode, client and content consent. A caller-supplied `ORGX_AUTH_SCOPE` is not authentication proof.

The cloud sender checks `/api/v1/me` before each receipt POST, including batch fallback and rate-limit retries. It requires the prepared workspace to match authenticated default-workspace identity and includes `workspace_id` in the POST. The receiver must still authorize that explicit workspace atomically with admission. Redirects are refused and the existing proxy/CA transport remains in use.

Preparation requires `--consent content --workspace <uuid>` and a fresh image without Trail task history. Run preparation only during image setup, not on task startup or resume. An existing same-binding native session resumes through its installed hooks and saved checkpoints without re-preparation. Generated hooks keep a `--cloud-required` marker so deleting cloud configuration cannot restore unbound desktop behavior. The activation timestamp is carried through the worker; a native session started before preparation, or without a usable start timestamp, is not uploaded. Re-enabling capture creates a new activation boundary. These timestamps are native source facts, not cryptographic source provenance.

Cloud receipts contain derived request, action, artifact, evidence, outcome and human-intervention text. Secret redaction is applied before sending. Personal-data masking remains a separate setting. Cloud capture does not drain the machine-wide precedent signal backlog, and it does not change or erase that backlog.

## Acknowledgments and uncertain outcomes

Local journals are scoped to destination, authenticated actor and workspace, independently of credential rotation. Before transport, the sender records the exact attempted receipt fingerprint and idempotency key. Acknowledgments must match the expected external receipt ID and schema and include a ledger receipt UUID. HTTP success alone cannot override a false outcome or establish human acceptance.

Unknown transport outcomes, malformed acknowledgments and server failures remain pending. In particular, a batch HTTP 422 can contain a per-item 500 after a durable import; that item must not be treated as a confirmed refusal. Missing or corrupt journal evidence is not permission to recreate an empty journal. Preserve the journal and resolve pending items through scoped ledger readback. Use `trail receipt-hook reconcile --workspace <uuid> --base <origin>` for read-only remote reconciliation. It returns a bounded page and `nextCursor`; continue with `--cursor <nextCursor>` so unresolved early entries do not hide later ones. It acknowledges only an exact full-document hash observed through the workspace-scoped ledger GET. A 404, a newer/different revision or unavailable readback leaves the upload pending. This confirms document presence, not the committing idempotency attempt, importer or downstream side effects. Deleting the journal is not a recovery procedure.

OrgX normally adds a custody signature before storing the receipt. Readback allows only that narrow transformation: the exact original digest, exactly one `ingested` OrgX service signature verified with the configured origin's public Ed25519 keys, and the complete original wire hash after removing only the added signature. Other integrity changes, altered content, claim-level downgrades, missing/invalid keys and signatures remain unresolved. The signature attests custody, not the producer's claims or acceptance.

## Release gates

This change does not enable Wizard content receipts, change global defaults, or bump the Trail release version. Keep the Wizard guard until a compatible Trail release is reviewed, deliberately pinned and tested through actual hosted Codex and Claude sessions. Full worker lifecycle checks, pending-send recovery and scoped ledger readback remain distinct from HTTP acknowledgment. Receipt delivery does not establish managed execution, independent verification or accepted outcomes.

Validation uses synthetic data and temporary profiles. The boundary regressions cover mismatched identity, transport modes, origin/client changes, actor drift, retries, workspace/actor-scoped journals, key rotation, contradictory responses, uncertain writes, corrupt journals, activation changes and old/new Claude and Codex sessions.
