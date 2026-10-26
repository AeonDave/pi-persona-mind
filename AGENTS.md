# AGENTS.md — pi-persona-mind

An extension requiring a compatible loaded pi-persona: durable persona-aware memory + backlog,
coupled through a versioned local companion handshake to
[`pi-persona`](https://github.com/AeonDave/pi-persona). Binding design: [`docs/DESIGN.md`](docs/DESIGN.md).

## Commands

- Typecheck: `npm run typecheck` (`tsc --noEmit`, strict + `exactOptionalPropertyTypes`)
- Tests: `npm test` · both: `npm run verify`
- Hermetic choke point: `node --import tsx --import ./test/setup/hermetic-env.ts --test test/*.test.ts`
- Installed Pi 1.4 qualification: `node --import tsx scripts/qualify-host.mjs <absolute-pi-package-root> <absolute-pi-persona-extension-path> [<absolute-packed-mind-extension-path>]`
  (isolated profile, offline synthetic provider; no cloud authentication/model-quality claim).

## Conventions

- Erasable-syntax-only TS. `src/core/*` is pure (no Pi imports) and unit-tested.
- Target the latest stable Pi only (currently 1.4.0), Node 22.19.0+. Keep host packages and
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
- Lifecycle generations bound capture/injection UI state to the accepting session. An accepted
  explicit capture may finish in its original store; its acknowledgement must not leak to a new turn.
- Nested tool results reach only their caller. Nudge on a blocked report only when the top-level
  result actually relays it; bound provenance by `parentToolCallId` and clear it on lifecycle change.
- Persona/shared and repository LTM are durable across sessions. `scope: project` with long term
  stays in the repository; promotion defaults there and requires an owned source. `project-long`
  is the optimizer target; `project` still means working STM. Shared writes use `scope: shared`,
  not a boolean. Existing persona facts are not automatically reassigned. STM/backlog auto-delete after ~48h. Explicit session notes live
  in Pi's native active branch, survive compaction/resume, and stay absent from delegated workers.
  A non-persistent host session reports in-memory storage; forget is a branch-local tombstone.
- `/mind optimize [project|project-long|persona]` starts one bounded real Persona-hosted LLM review NOW, bypassing automatic dirty/token/cooldown and auto-off gates but not owner, busy, validation or CAS safeguards. It uses the existing worker/prompt/strict JSON/provenance/preview/apply/receipt pipeline, exact current model only, no fallback/tools, and reports bounded coverage/no-op honestly. Shared is refused with a pointer to `/mind optimize inspect shared`; it is excluded from all LLM automatic and explicit writes. `/mind optimize inspect [target]` stays read-only. Do not publish a separate persistent activity row for full optimization; let Persona's normal worker row terminate. Interrupted/stale explicit runs never apply, report across owner change, or arm an automatic retry.
- Optimization inspect/stage exact replacements/apply a short-lived plan ID remains available through explicit inspect/show/apply commands and the memory tool. Similarity
  is advisory. Compare the original raw store fingerprint under its lock; reject stale/expired
  plans, invalid stores, ownership mixing, provenance overflow and extended STM expiry.
  Lifecycle changes invalidate plans. Automatic semantic review is user-authorized and on by default
  unless `PI_PERSONA_MIND_OPTIMIZE=off`; session commands may switch it immediately. Queue after a
  successful remember/promotion. First eligible burst has no token floor; later attempts need dirty
  memories AND 1M main-session input tokens since the prior launch (exclude output/cache/worker usage).
  Usage alone never marks memories dirty. Coalesce 2s after `agent_settled` while idle with no queued
  work; cool down 5min between actual attempts. Only the interrupted attempt can retry without the
  token floor, after a later settled event and cooldown. One worker per instance; unchanged semantic
  digests skip review. New input, agent start,
  off or owner changes cancel and invalidate plans. Use a real visible
  Persona-hosted Mind worker on exactly the session model, no fallback or arbitrary tools. Give it
  at most 12 full source records/24k JSON characters, a 180s deadline and at most 4 strict JSON
  replacement operations/12 source IDs each, then validate/apply through parent-owned
  provenance/freshness/CAS checks. Shared memories and age-based deletion remain excluded. Preserve
  durable before/after operator cards; worker completion is not proof of semantic truth.
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
