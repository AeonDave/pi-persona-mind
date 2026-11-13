# AGENTS.md — pi-persona-mind

An extension requiring a compatible loaded pi-persona: durable persona-aware memory + backlog,
coupled through a versioned local companion handshake to
[`pi-persona`](https://github.com/AeonDave/pi-persona). Binding design: [`docs/DESIGN.md`](docs/DESIGN.md).

## Commands

- Typecheck: `npm run typecheck` (`tsc --noEmit`, strict + `exactOptionalPropertyTypes`)
- Tests: `npm test` · both: `npm run verify`
- Hermetic choke point: `node --import tsx --import ./test/setup/hermetic-env.ts --test test/*.test.ts`
- Installed Pi 1.5.2 qualification: `node --import tsx scripts/qualify-host.mjs <absolute-pi-package-root> <absolute-pi-persona-extension-path> [<absolute-packed-mind-extension-path>]`
  (isolated profile, offline synthetic provider; no cloud authentication/model-quality claim).

## Conventions

- User-requested commits use **AeonDave** as both author and committer, retaining the user's configured
  email. Never add `Co-authored-by` or assistant/bot attribution; do not push unless explicitly requested.
- Erasable-syntax-only TS. `src/core/*` is pure (no Pi imports) and unit-tested.
- Target the latest stable Pi only (currently 1.5.2), Node 22.19.0+. Keep host packages and
  typebox as optional peers on `*`, with all four Pi development packages pinned together.
  No historical-host branches; never bundle a second host runtime. Scope development security
  overrides to their affected parent/version and remove them when that graph no longer needs them.
- Tests clear `PI_PERSONA_*` case-insensitively and pin `PI_AGENT_DIR` to a throwaway directory.
  Keep the hermetic import on every direct test invocation. Real SDK tests use an offline provider.
- Require the loaded companion protocol at session activation and tool call time; missing or
  incompatible Persona means no capture, storage/migration, injection or scheduler activity.
  Settings files alone do not prove presence. Resolve the actual active persona through the
  session-bound `pi-persona:memory-owner:v1` runtime contract; never reconstruct it from CLI or saved
  selection. Before that owner is ready, do no memory IO. Delegated engines freeze the parent's
  persona for their lifetime. Canonical `<agentDir>/persona/settings.json` supplies only Mind's
  `mindCapture`/`mindNudge` session preference snapshots. Do not interpret retired state markers.
  Contribute effective Mind settings
  only from a supervisor via the shared settings event bus. Mirror `PI_PERSONA_LEG` /
  `PI_PERSONA_CHILD`, and `pi-persona-deferred-input` by env/customType only.
- Model configuration changes are not persona switches;
  `/persona models` must leave Mind's scope unchanged. Do not duplicate persona discovery here.
- Wakes are display-only (`appendEntry` + toast). Never `sendUserMessage` / `triggerTurn`.
- Lifecycle generations bind capture/injection UI state to the accepting session. An accepted
  session-only capture may remain on its original native branch; its acknowledgement must not leak to a new turn.
- Nested tool results reach only their caller. Nudge on a blocked report only when the top-level
  result actually relays it; bound provenance by `parentToolCallId` and clear it on lifecycle change.
- Persona/shared and repository LTM are durable across sessions. Every long-term `remember` must
  explicitly choose `scope: project|persona|shared`; there is no implicit persona destination.
  `project` with long term stays in the repository; promotion defaults to project and requires an
  owned source. `project-long` is the optimizer target; `project` still means working STM. Shared
  writes use `scope: shared`, not a boolean. Scope expresses API routing intent, not authenticated
  user consent. Use session for task-specific/uncertain choices (models, strategies, task constraints),
  project for stable repository facts, persona for intent across all projects of the same persona,
  and shared only for intent across personas. Existing persona facts are not automatically reassigned.
  STM/backlog auto-delete after ~48h. `kind: objective` never changes the requested lifetime. Explicit
  session notes live in Pi's native active branch, survive compaction/resume when session history is
  persistent, are not copied to a new session, and stay absent from delegated workers. A non-persistent
  host session reports in-memory storage; forget is a branch-local tombstone.
- AUTO strong direct-user cue capture writes only native session notes; even explicit “remember”,
  “from now on”, or durable wording does not write project/persona/shared stores or dirty optimizer
  targets. Capture feedback states session-only lifetime and does not claim durable storage. Prompt
  mode remains nudge-only; off disables capture; foreign/quoted/worker content remains non-direct.
  Broader persistence requires a deliberate memory call with an explicit scope chosen from actual intent.
  Never fall back to durable storage if a native session append fails.
- Bare `/mind optimize` (also `/mind optimize all`) reviews one bounded window for each currently allowed nonshared target, sequentially, at most three workers; home allows persona only. Named `/mind optimize project|project-long|persona` stays single-target. All explicit work bypasses automatic dirty/token/cooldown and auto-off gates but not owner, busy, validation or CAS safeguards; retain the real Persona worker, strict JSON/provenance/preview/apply/receipt path, exact session model, no fallback/tools, per-tier outcomes, and honest bounded no-op/skip diagnostics. A skipped page is not proof the whole target is empty. Stop a batch on cancellation, owner change or failed/refused/uncertain work. Shared is refused with a pointer to `/mind optimize inspect shared`; it is excluded from all LLM automatic and explicit writes. Inspect/history defaults stay unchanged. Do not publish a separate persistent activity row for full optimization; let Persona's normal worker row terminate. Interrupted/stale explicit runs never apply, report across owner change, or arm an automatic retry.
- Optimization inspect/stage exact replacements/apply a short-lived plan ID remains available through explicit inspect/show/apply commands and the memory tool. Similarity
  is advisory. Compare the original raw store fingerprint under its lock; reject stale/expired
  plans, invalid stores, ownership mixing, provenance overflow and extended STM expiry.
  Lifecycle changes invalidate plans. Automatic semantic review is user-authorized and on by default
  unless `PI_PERSONA_MIND_OPTIMIZE=off`; session commands may switch it immediately. Queue after a
  successful remember/promotion. First eligible burst has no token floor; later attempts need dirty
  memories AND 1M main-session input tokens since the prior launch (exclude output/cache/worker usage).
  Actual explicit worker launches also reset the automatic token/cooldown baseline and persist their
  completed digests, but interrupted explicit work never grants automatic retry. Usage alone never
  marks memories dirty. Coalesce 2s after `agent_settled` while idle with no queued
  work; cool down 5min between actual attempts. Only the interrupted attempt can retry without the
  token floor, after a later settled event and cooldown. One worker per instance; unchanged semantic
  digests skip review. New input, agent start,
  off or owner changes cancel and invalidate plans. Use a real visible
  Persona-hosted Mind worker on exactly the session model, no fallback or arbitrary tools. Give it
  at most 12 full source records/24k JSON characters, a 180s deadline and at most 4 strict JSON
  replacement operations/12 source IDs each, then validate/apply through parent-owned
  provenance/freshness/CAS checks. Automatic operations must consolidate at least two compatible
  supplied sources; single-record rewrites remain explicit-only. A window without a same-kind pair
  cannot start an automatic model call or consume its first-attempt allowance. Shared memories and
  age-based deletion remain excluded. Persist the full proposal audit before apply, but keep it out
  of the automatic transcript; show one informative `mind` toast on successful change, no routine
  result card, and no no-op card or toast. Keep durable history and guarded undo available.
  Manual detail and important warnings remain visible. Worker completion is not proof of semantic truth.
- Evidence-grounded knowledge review is explicit and separate from consolidation. F10 actions close
  the overlay before native prompts. Parent-selected, bounded trusted-repository files and active-branch
  user-role text are evidence, never instructions or authenticated truth. Use the real exact-session-model
  Persona worker with no tools; validate closed findings/citations. Corrections remain staged in a separate
  optimizer until user approval and source/owner freshness checks, including the guarded store callback.
  Shared/session are not review write targets. Retirement is recommendation-only, not an implicit delete.
  Reuse maintenance admission/accounting; interrupted reviews never earn automatic retries.
- For `pi-persona:card-frame:v1`, custom-entry renderers pass their original entry object as optional
  `expansionKey`; Persona owns click/keyboard synchronization. Mind must not duplicate interaction state.
- Rotate completed automatic review over older records/pages; account for actual byte admission,
  preserve newest-fact inclusion, and never mark stopped/interrupted work as completed. No unbounded
  sweeper. Optimizer receipts precede replacement and persist at most 32/2MiB per target; unresolved
  prepared receipts are protected. Undo compares affected facts and owner generation under lock,
  never restores expired STM or clobbers unrelated writes. Propagate uncertain-finalization warnings.
- Retrieval uses one lexical/tag/path ranker; do not introduce a second recall policy. All injected
  tiers share a 2400-token planning estimate (UTF-8 bytes/3); session notes use up to 600. Include
  wrappers, separators and omission counts, keep whole excerpts, and never exempt pinned facts from
  the bound. The estimate and synthetic evaluation are not billing or semantic-quality guarantees.
- `exactOptionalPropertyTypes`: omit optional props; do not assign `undefined`.

## Done

`npm run typecheck` clean, `npm test` green, full `npm audit --audit-level=low`, and package dry-run
inspection. Re-run after final edits. Keep published files explicit; no tests, drafts or local artifacts.

### Accepted platform diagnostics

- Windows runs have zero expected skips. On other platforms, only the two Windows recovery-gate
  sharing-violation cases in `test/store.test.ts` are intentionally skipped: they exercise the
  Windows-specific `EPERM` handling, not the POSIX path. Report them as untested, never passed.
- Evidence symlink-boundary tests are required on every platform. Windows test accounts need
  Developer Mode or `SeCreateSymbolicLinkPrivilege`; missing support fails rather than silently
  dropping those security checks. No other conditional skips are accepted.
