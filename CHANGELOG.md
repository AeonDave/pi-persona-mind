# Changelog

## [0.8.6](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.8.6) - 2026-10-26

- Allow bare `/mind optimize` and `/mind optimize all` to review one bounded window per currently
  allowed nonshared tier sequentially; home sessions allow persona only. Named targets remain
  single-target, and shared remains excluded from LLM review.
- Report target-local skip reasons and visible batch outcomes. Skips and reviewed no-ops can continue;
  cancellation, owner changes, and failed, refused, or uncertain work stop later tiers. Prevent
  overlapping batch work; add regression coverage for these behaviors.

## [0.8.5](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.8.5) - 2026-10-26

- Add `/mind optimize [project|project-long|persona]` for an immediate, bounded review by a visible Persona-hosted worker using the current session model. Changes pass Mind's validation, provenance and compare-and-swap checks; successful writes retain receipts and support guarded undo.
- Remove the worker row on completion while retaining results in the conversation. Keep reviews bounded, rotate completed windows, and handle busy sessions, cancellation, stale owners and errors safely.
- **Usage change:** use `/mind optimize inspect [target]` to inspect; `/mind optimize [target]` now starts a review instead.

## [0.8.4](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.8.4) - 2026-10-25

- Add durable project memory and scope-preserving promotion; expose project/persona/shared scope
  consistently in tools, snapshots and diagnostics. Replace the shared-write boolean with scope.
- Rank injected context and recall by task words, tags and repository paths; apply a combined
  token estimate across archive and session context, retaining explicit omissions and full reads.
- Rotate bounded automatic reviews over older records and retain durable consolidation receipts.
  Add history and guarded undo that preserves unrelated writes and refuses stale affected facts.
- Add deterministic retrieval evaluation with an explicit baseline and no semantic-quality claim.

- Add automatic semantic consolidation through a visible asynchronous Mind worker on the current
  session model. The first new-memory burst queues an idle review; subsequent attempts require new
  memories and 1M main-session input tokens, excluding output/cache/worker usage. Rapid saves coalesce;
  new input cancels the worker. Parent validation and fingerprint checks protect application; shared
  memory is excluded.
  `/mind optimize auto [status|on|off]` controls this session, doctor reports its state, and
  `PI_PERSONA_MIND_OPTIMIZE=off` changes the initial default.
- Require the loaded pi-persona companion protocol; without it Mind remains inactive, including
  direct programmatic calls. Local optimization appears as a Mind activity row in Persona's tree/F9.
- Use the actual live persona for memory ownership even with selection persistence disabled;
  delegated workers keep their launching persona on both engines. Remove the obsolete selection mirror.
- Target Pi 1.4.0 exclusively; align development packages and native event contracts, and remove
  the retired companion state-marker fallback. Existing memory-data imports remain available.
- Add active-branch session notes, honest persistent/in-memory receipts, and full ID-based memory
  reads. Session notes preserve their origin across forks and never enter delegated worker context.
- Add explicit, bounded memory consolidation: inspect candidates, stage exact replacements, then
  apply a fingerprint-checked plan. Preserve source lineage and STM expiry; refuse stale plans.
- Paginate inspection to reach older facts, and distinguish slow background imports from persistent
  failures instead of leaving a successful import marked with a warning.
- Add `/persona-mind` with `/mind` as the same-handler alias, strict command parsing, session and
  optimization commands, and consistent expandable command cards.
- Include inline flow reports in the blocked-work hint and preserve concurrent backlog additions
  during expiry cleanup. Qualify package and companion integration on the current host.

## [0.8.3](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.8.3) - 2026-10-20

- Read persona selection and startup `defaultPersona`/`persist` preferences from pi-persona's
  canonical settings store, preserving legacy marker fallback only when canonical settings are absent.
- Contribute Mind's capture/nudge settings to pi-persona's unified settings panel, while retaining
  environment overrides and session-start snapshot behavior.
- Scope marker latches and Mind-specific preference snapshots to Pi session IDs so child sessions
  cannot reset their supervisor's active scope or companion controls.
- Match pi-persona's extension-factory snapshot for the scalar persona selectors, keeping Mind's
  memory scope aligned across `/new` sessions until Pi reloads/restarts extensions.
- Reject malformed UTF-8 in canonical and legacy persona markers rather than deriving a replacement-character memory scope.

## [0.8.2](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.8.2) - 2026-10-19

- Respect Pi's `--` CLI separator when resolving persona memory scope; prompt text resembling
  `--persona` no longer selects a different memory store.
- Add isolated installed-Pi 1.3 qualification alongside the minimum-Pi 1.0 SDK suite, including
  optional pi-persona integration for model refresh and delegated read-only memory.

## [0.8.1](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.8.1) - 2026-10-13

- Handle Pi 1.2 custom-triggered completion reports from their attributed `before_agent_start`
  message event, deduplicate follow-up nudges, and keep custom report text out of direct-user capture.

## [0.8.0](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.8.0) - 2026-10-03

- Require Pi 1.0.0+ and Node.js 22.19.0+; keep host libraries and typebox as host-provided peers.
- Reset capture hints and empty-store announcements when a session changes; prevent late capture
  notices and memory injection from leaking into the next session.
- Skip migration/storage waits for ordinary input with no capture cue.
- Preserve undelivered backlog alarms across slow storage reads and concurrent re-arm calls; a
  newly queued reminder that is already due is shown immediately, without restarting Pi.
- Deduplicate a reminder's displayed deadline while acknowledgement persists, including re-arms
  triggered by background migration; a later deadline remains eligible.
- Suggest backlog capture only for blocked nested output actually relayed by its outer tool.
- Enforce erasable-only TypeScript, including store/service constructors.
- Isolate test profiles; exercise capture, persistence, tool execution, display-only reminders and
  read-only workers in real Pi 1.0 SDK sessions with an offline provider.
- Align package/lock metadata, upgrade development dependencies and pin three-platform CI actions.

Older storage roots remain readable through non-destructive migration. No existing store is deleted
or moved by the host compatibility update.
