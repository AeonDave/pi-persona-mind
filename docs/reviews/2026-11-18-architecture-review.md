# Architecture review — 2026-11-18

## Scope

Reviewed the current Mind codebase at `601f1ae`, including the existing uncommitted F10/shared-frame
integration. The initial tree passed strict typechecking and all 658 tests on Windows with Node 22.19.0.
Existing edits were preserved. No dependency, storage schema, model-routing policy or release version
was changed.

Independent Sol 6.1 and Astra 6 reviews covered persistence/recovery, optimizer CAS/history/undo,
capture, lifecycle and automatic scheduling. Supervisor review covered evidence admission, inspector
and card contracts, retrieval budgets, integration and documentation. Findings were reproduced before
fixes; the reviewers cross-checked each other's changes.

## Demonstrated defects

| Boundary | Failure | Correction and regression evidence |
|---|---|---|
| Backup recovery | A reader observed a missing live file, waited for the lock, then restored an old backup over a concurrent writer's committed facts. | Re-enter the canonical live-load path under the lock. A deterministic filesystem/lock regression preserves the new sequence, new fact and original backup. |
| Capture intent | Negated remember/adoption wording could lose its negation and create an affirmative session note. | Preserve negative request wording and reject negated decision premises before extracting the fact. Tests retain valid affirmative requests whose fact contains negative wording. |
| Reminder acknowledgement | Acknowledging an old display by ID alone consumed a newer deadline written by another session. | Require the displayed `(id, dueAtEpochMs)` and compare under the backlog lock. Tests cover stale acknowledgement, exact/duplicate acknowledgement and empty input; the backlog item stays open. |
| Memory promotion | A schema-valid but unsafe record already present outside the current save API could be moved into durable/shared memory without rescanning. | Reuse the common persisted-content guard before writing either tier. Tests cover unsafe text/tags/source, unchanged source/destination bytes and a valid broader-scope promotion. Current `remember` already rejected these unsafe inputs. |
| Status lifecycle | A slow summary or failure from the previous persona could replace the current persona's counts or show a stale warning. | Reuse the accepting-owner guard after asynchronous reads and on failure. Native SDK tests hold the old read across persona change/shutdown, with both success and rejection. |

Capture remains a bounded deterministic cue detector, not a general natural-language intent model.
Its automatic output remains provisional session memory; these fixes do not authorize durable capture.

## Shared contracts and decisions

- `isSafeMemoryContent` belongs to `core/memory.ts`. Full reads, promotion, optimizer selection,
  application/history and undo use the same text/tag/source/persona policy. Its implementation is
  unchanged; the optimizer-specific export was removed and all callers updated. Full reads and
  automatic input selection no longer load the optimizer for this policy.
- Recovery reuses `loadInternal` under the existing lock instead of creating a second recovery
  state machine. Reminder acknowledgement identifies the displayed event, not merely its item.
- `captureMemoryOwner` remains the common stale-operation guard. The status fix closes an uncovered
  caller rather than introducing another generation counter or owner cache.
- Native session replay remains authoritative for session notes. Durable stores, bounded retrieval,
  staged consolidation, evidence-grounded proposals and presentation retain separate responsibilities.
- Retrieval and session recall already share the lexical/path ranker and context-budget helpers.
  The inspector reuses strict read-only inspection and native history; it does not create a second
  retrieval engine or infer source truth from arbitrary paths.
- F10 consumes Persona's shared frame. Standalone cards use the shared card service, while native
  tool results retain Pi's own shell. Existing click/expansion and compact-notification work is retained.

Not selected: a generic transaction framework, a shared abstraction for data locks and the long-lived
display-reminder lease, or splitting the composition root solely to reduce its line count. Their
invariants differ; no current defect or measured cost justified those rewrites. No index, cache,
embedding service, model classifier or new runtime dependency was added. No speedup is claimed.

## Documentation

README now leads with user capabilities, maps memory scope/lifetime in one table, and links technical
contracts for storage, inspection and review. DESIGN records the corrected concurrency and ownership
rules and current companion minimum. CHANGELOG separates these fixes from the previously pending
shared-frame work.

## Qualification

Windows, Node 22.19.0, installed Pi 1.5.2; all profiles and test writes isolated from user memory.

| Check | Result |
|---|---|
| `npm run verify` | Strict typecheck clean; **668 passed, 0 failed, 0 skipped**. |
| `npm audit --audit-level=low` | **0 vulnerabilities**, including development dependencies. |
| `npm run eval:memory` | 30 synthetic cases/31 facts; expected first result in 29 judged cases, one correct abstention, 7/7 paired sentinel cases. Runtime ranking and budget unchanged. |
| Installed-host qualification | Source and extracted npm package both pass against installed Pi 1.5.2 and the current Persona checkout, with **zero network requests**. |
| Automatic maintenance in both engines | Offline scripted provider passes in-process and child-process worker paths: two sources consolidate into one fact, one notification, no routine result cards, proposal audit, receipt and successful undo. |
| Package inspection | Explicit allowlist: 53 entries; no tests, scripts, review/plan drafts, bundled host or node_modules. README links/anchors and `git diff --check` pass. |
| Snapshot check | All 125 tracked-for-review source/test/doc/script/config files unchanged across the full qualification. Only documentation was finalized afterwards; pre-existing F10 files remained intact. |
| Real Sonnet smoke | Attempted `claude-pro-max-native/sonnet-5.5` in-process automatic smoke; stopped before a provider call because the model was absent from the isolated harness's configured catalog. **No successful live-provider qualification is claimed.** |

The full suite includes the existing **10,000-record** test: an old fact remains recallable/readable
after reopening, injection stays bounded, capacity overflow preserves the archive, and undo restores
the original fact without disturbing unrelated records. Native session tests cover branch/compaction
and lifecycle behavior; these are stronger evidence for long-project durability than a retrieval
score alone.

## Release qualification: 0.9.1

The release pass requires Persona 1.18.1 for the shared inspector frame and updates package,
lockfile, README and design metadata together. The final README review verified 21 local links
and anchors and clarified automatic model usage, per-tier review windows and interactive-only
knowledge review. The final full suite passed **668 tests, zero failures and zero skips**, with
strict typechecking and a full dependency audit reporting zero vulnerabilities.

The extracted 53-file npm package passed against installed Pi 1.5.2, including native session
notes, durable project memory, expiry/provenance checks, stale-plan refusal, consolidation/undo,
lean delegated memory and a display-only reminder with zero extra model requests. No production
source changed during this release qualification.

The earlier live-provider limitation above was resolved in the qualification harness:
`LIVE_PROVIDER_EXTENSION` loads the explicit provider, model lookup follows extension binding,
and both Pi directory variables plus provider state remain confined to a disposable profile.
With `claude-pro-max-native/claude-sonnet-5-5`, **both in-process and child-process live automatic
smokes passed**: two supplied facts consolidated into one, one informative notification, no routine
result card, retained proposal/receipt and successful undo. This demonstrates the bounded exercised
workflow; it does not establish semantic correctness for arbitrary future memories.

Local evidence logs are under the OS temporary directory: `mind-architecture-verify.log`,
`mind-architecture-eval.log`, `mind-architecture-host.log`, `mind-architecture-packed-host.log`,
`mind-architecture-auto-inproc.log`, `mind-architecture-auto-child.log` and
`mind-architecture-live-sonnet.log`. They are not shipped in the package.

## Limits

Local tests establish the exercised Windows behavior, including real filesystem and native SDK paths.
They do not establish crash consistency on network filesystems, other operating systems, unrestricted
language understanding, or semantic correctness of arbitrary model consolidation. The lexical
evaluation uses curated synthetic cases; successful model-generated consolidation was not measured
in this audit. These checks are bounded evidence, not a guarantee of perfect memory.
