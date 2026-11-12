# Cloud receipt boundary

Automatic cloud capture needs a prepared workspace, origin, authentication mode, client and content consent. A caller-supplied `ORGX_AUTH_SCOPE` is not authentication proof.

The cloud sender checks `/api/v1/me` before each receipt POST, including batch fallback and rate-limit retries. It requires the prepared workspace to match authenticated default-workspace identity and includes `workspace_id` in the POST. The receiver must still authorize that explicit workspace atomically with admission. Redirects are refused and the existing proxy/CA transport remains in use.

Preparation requires `--consent content --workspace <uuid>` and a fresh image without Trail task history. Generated hooks keep a `--cloud-required` marker so deleting cloud configuration cannot restore unbound desktop behavior. The activation timestamp is carried through the worker; a native session started before preparation, or without a usable start timestamp, is not uploaded. Re-enabling capture creates a new activation boundary. These timestamps are native source facts, not cryptographic source provenance.

Cloud receipts contain derived request, action, artifact, evidence, outcome and human-intervention text. Secret redaction is applied before sending. Personal-data masking remains a separate setting. Cloud capture does not drain the machine-wide precedent signal backlog, and it does not change or erase that backlog.

## Acknowledgments and uncertain outcomes

Local journals are scoped to destination, authenticated actor and workspace, independently of credential rotation. Before transport, the sender records the exact attempted receipt fingerprint and idempotency key. Acknowledgments must match the expected external receipt ID and schema and include a ledger receipt UUID. HTTP success alone cannot override a false outcome or establish human acceptance.

Unknown transport outcomes, malformed acknowledgments and server failures remain pending. In particular, a batch HTTP 422 can contain a per-item 500 after a durable import; that item must not be treated as a confirmed refusal. Missing or corrupt journal evidence is not permission to recreate an empty journal. Preserve the journal and resolve pending items through scoped ledger readback. This change does not yet provide an automatic reconciliation command; deleting the journal is not a recovery procedure.

## Release gates

This change does not enable Wizard content receipts, change global defaults, or bump the Trail release version. Keep the Wizard guard until a compatible Trail release is reviewed, deliberately pinned and tested through actual hosted Codex and Claude sessions. Full worker lifecycle checks, pending-send recovery and scoped ledger readback remain distinct from HTTP acknowledgment. Receipt delivery does not establish managed execution, independent verification or accepted outcomes.

Validation uses synthetic data and temporary profiles. The boundary regressions cover mismatched identity, transport modes, origin/client changes, actor drift, retries, workspace/actor-scoped journals, key rotation, contradictory responses, uncertain writes, corrupt journals, activation changes and old/new Claude and Codex sessions.
