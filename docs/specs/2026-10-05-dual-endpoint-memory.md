# Windows/WSL shared memory: implementation contract

Status: implementation and offline/native acceptance completed on 2026-10-05; deployment NOT yet performed.

Verified: 246 regression tests / 892 assertions, typecheck, lint, and diff checks. Actual installed Pi 1.0.2 loaders on Windows and WSL passed shared/local/project/legacy visibility, foreign-preserving mutations and recovery, context freshness, and 200/200 simultaneous native tool writes (Windows 100 / WSL 100). Native direct-file readers completed 628 Windows and 589 WSL probes without corruption or lock/temp residue. See [retained acceptance evidence](../../test/native-acceptance/EVIDENCE.md).

Scope limitations: JEV responses and qmd filtering are covered with offline fixtures, not live paid JEV or native qmd queries. Automatic LLM summary hooks are fixture-tested, not exercised against a paid provider. Ownership checks are not atomic fencing; manual lock replacement during a live write is unsupported. Existing deployment/library remains unchanged.
Owner: parent designs/reviews; OpenAI 6.1 SOL implementation workers, with 6 Luna allowed only for particularly simple tasks. No paid non-plan worker routes.

## Goal and non-goals

One authoritative Markdown memory directory, accessible natively from Windows and via /mnt/c from WSL. The existing PI_MEMORY_DIR setting supplies the endpoint-specific spelling of that SAME directory. Do not create a memory server, share qmd SQLite files, duplicate the content to per-endpoint libraries, migrate session history, or change unrelated deployment configuration.

Existing mkdir-lock + reread-under-lock + atomic-replace protocol remains mandatory. Inference/network requests MUST happen outside file locks; commit against freshly reread state. Sources and applicability are distinct: a WSL-authored preference can be shared, while a Windows runtime observation cannot silently become a WSL fact.

User-selected crash policy: safety before automatic recovery. Never reclaim a lock solely because its mtime is old: synchronous work can block timer-based heartbeats while the owner remains alive. Wait within a bounded budget, then return an explicit error without modifying the target or lock. Crash-orphaned locks require manual cleanup only after confirming no writer remains. A releasing writer must not intentionally delete a lock belonging to a different owner. Test slow synchronous holders beyond the former stale threshold and preserve lock ownership; do not treat a timer heartbeat as proof of liveness.

## User decisions

- Conservative automatic classification: general requirements/preferences may be shared; runtime, paths, commands and code/workspace state stay environment/project scoped. Uncertain/failing classification stays source-local.
- Historical untagged data is legacy/source unknown. Keep original bytes; do not guess its source or promote it into ambient facts. Explicit inspection remains possible with warnings.
- JEV may receive candidate ORIGINAL text without redaction. Send only that candidate and necessary environment/project context, not the whole store. Never log API keys or payload bodies.
- Main thread owns design and final acceptance. Latest user policy: concrete coding/tests default to `openai/gpt-6.1-sol`; only particularly simple tasks may use `openai/gpt-6-luna`. Do not launch new Terra workers. Normally medium thinking; mechanical work low. Escalation requires a demonstrated difficult issue.

## Data contract

Each new logical record has:

- version: 1, id: random UUID, createdAt: ISO timestamp, sessionId: short session identifier.
- source: actual `windows | wsl | linux | unknown`, detected from process.platform and os.release (Linux kernel containing microsoft indicates WSL). Model output cannot change source.
- scope: `shared | environment | project`.
- environment: required for non-shared scope, fixed to detected origin by default; unknown origin cannot receive auto-shared status.
- project: required for project scope, derived conservatively from normalized workspace root (or explicit PI_MEMORY_PROJECT_ID). Do not equate repositories merely by basename. An explicit common project ID alone does NOT broaden environment applicability.
- classification: decision mechanism `explicit | rule | jev | fallback`, optional bounded confidence; no private payload in diagnostics.
- content: verbatim body; classification cannot paraphrase it.

Store records in the existing MEMORY.md, daily/*.md and SCRATCHPAD.md files, not a second authoritative database. Metadata must be machine-readable and framing unambiguous even when the body contains HTML comments, blank lines, code fences, or fake metadata. Prefer a length-framed start comment containing encoded/validated metadata followed by readable original Markdown. Reject malformed/unknown-version framing conservatively as legacy; never expose its body as shared on parse failure. Existing original timestamp comments can remain inside bodies where useful. Tests must cover CRLF and Unicode length semantics. Do not trust arbitrary comments anywhere in a body as metadata.

Legacy spans are returned separately from valid records and retained verbatim through transforms. No eager bulk rewriting required. This avoids a destructive migration before source knowledge exists.

## Applicability and output

Default visible set = shared records + matching environment records + matching environment AND project records. Legacy/foreign records are excluded from ambient injection, default reads, write previews, scratchpad list and default search results. Visible records explicitly display source and scope.

Provide an explicit inspection option for historical/foreign data with a prominent warning that these are reference records, not current-environment facts. Inspection permission is NOT mutation permission.

Qmd is a candidate finder only. Raw snippets can contain adjacent foreign records, so NEVER send raw qmd snippets directly to the model. Resolve hits to authoritative Markdown, parse/filter records, and render only visible matching evidence. On malformed paths/identities or unresolvable hits, fail conservatively. Local indexes may independently rebuild from the one authoritative store.

Snapshots must invalidate on cross-process file changes; do not only refresh after the current process writes. Handle same-size replacement and coarse filesystem mtime resolution (content signature or conservative reread where necessary).

## Mutation rules

All transforms lock and reread authoritative content. They preserve foreign/legacy spans and unrelated records. This includes long_term overwrite (replace only caller-visible managed records, not entire library), scratchpad done/undo/clear_done, forget and restore. Responses and recovery metadata must not leak hidden records.

Recovery restores original source/scope/identity and remains idempotent; it must not reclassify a foreign entry as local. Match only authorized visible records. Recovery records themselves need sufficient provenance for applicability checks. A caller inspection override cannot erase foreign records. Mixed-scope overwrite is NOT permission to wipe the full file.

Every automatic write (exit summaries, compact handoffs) receives actual provenance and conservative applicability. Scratchpad metadata survives serialization/toggle/clear operations. Existing direct appendToStore/atomic-lock unit tests remain valid for generic raw-store functions.

## JEV contract

Use existing TYPESAFE_API_KEY environment variable, never read ~/.secrets or embed keys. Follow live TypeSafe /v1/systemone Choice docs. Candidate original text is untrusted evidence, not classifier instructions. Prompt asks only applicability; source is supplied as observed metadata.

Policy order: trusted explicit requested scope (subject to hard environment isolation) -> local deterministic environment/code constraints -> JEV classification for ambiguous/general candidates -> conservative source-local fallback. Model labels cannot override hard environment evidence. Explicit shared requests containing concrete runtime/path evidence should be rejected clearly or downgraded with an explicit explanation, not silently broadened.

Initial confidence gate (0.8) is a heuristic, NOT a correctness guarantee; document it and evaluate representative fixtures. Validate choice, probability/confidence types and ranges; invalid/low-confidence replies, missing key, disabled classifier, unknown environment, timeout, cancellation, HTTP/network/body failure and oversize input all fall back conservatively. Bound latency across fetch AND body read, even if AbortSignal is ignored. No unbounded retries or automatic paid tests. A JEV timeout must not lose the memory write. Never hold filesystem locks during inference.

## Phases (sequential writers)

1. Foundation: source/project detection, record framing/parse/render/filter, conservative applicability and JEV classifier primitives; unit tests. No deployed behavior changes yet.
2. Integration: all tools, mutation/recovery, automated writes, context/snapshot/search filtering; fixture integration tests and existing regressions. No real-store edits.
3. Parent acceptance: review diff, typecheck/lint/full relevant tests; native Windows and WSL tools through Pi loader against the same marked disposable NTFS test store. Concurrent write/read and foreign-preserving mutation scenarios.
4. Deployment only after acceptance: backup real library, document compatible legacy inspection, install same fork commit on both endpoints, verify canonical path/flags. Never use rsync overwrite as a substitute for merge; retain old data until reconciliation verified. Restart requirement reported accurately. Device configuration changes require pc-tweaks disaster-backup commit/push closure.

## Acceptance matrix

- Windows and WSL independently detect the right real source, with no model-supplied source override.
- Shared preference written on either side is visible on both; environment facts visible only in their applicable environment.
- Project facts never appear in unrelated workspace context or searches, even same project basename.
- Legacy original text survives all mutations and is accessible only via explicit inspection, not ambient injection.
- Unicode/CRLF/embedded marker bodies roundtrip without forged scope, truncation or merged boundaries.
- Overwrite/toggle/clear/forget/restore preserve other-endpoint records and correct recovery scope.
- Tool responses/previews and context/search never leak adjacent hidden records.
- Another process writes: next appropriate context refresh observes the change.
- JEV offline/errors/timeout/body hang/low confidence preserve writes and source-local isolation; classified text remains byte-for-byte original.
- Deterministic fixtures prove original candidate (not redacted) is sent, and whole store/API key is never included in state/diagnostics.
- Native cross-endpoint concurrent writes all land; no malformed records, leaked locks or half-writes.

Phases 2 and 3 have passed within the documented offline/native scope. Phase 4 is separate deployment/reconciliation work; do not imply that installed endpoints or real historical memory have already been migrated.
