# Changelog

## [0.9.5](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.9.5) - 2026-11-25

- Saved Persona workers rank lean memory by the launch task and show relative ages as of the
  launch turn. They still load current durable memory for Persona to check against the saved
  worker contract.

## [0.9.4](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.9.4) - 2026-11-23

- A memory replacement or consolidation refused before anything was written (a full store, a lock
  timeout, any failure that left the memory unchanged) no longer leaves a permanent `prepared` receipt.
  Thirty-two of them used to block every later replacement and consolidation on that store. Receipts
  left prepared by earlier versions carry no store fingerprint and stay protected, so a store already
  holding 32 of them still refuses replacements until its history file is repaired by hand.
- Words after a dotted version are searchable again: `node:22.19-alpine` matches `alpine`, `3.12-slim`
  matches `slim`. Numeric versions stay exact (`22.19` still does not match `22.19-alpine`), and a tail
  word is never treated as a negation.
- Automatic memory review retries an interrupted input once, not on every turn. A second interruption
  parks that window until its records change, and rotation moves past it instead of stopping there.
  Turning automatic review off and on no longer resets the count. When a review is parked, the status
  line says so and a result card reports that it was interrupted twice. A worker that reaches its
  180-second deadline is a failure and is not retried with pi-persona 1.20.0 or later, which reports it
  as failed; earlier pi-persona versions report it as a stop, so it is retried once and then parked.
- A skipped review window no longer marks another window's pending retry as reviewed. An input whose
  review was interrupted could be recorded as settled when rotation reached a different window, so it
  was never reviewed. The retry is now kept, or dropped without a receipt when its own records are gone.
- The 32-handoff limit is per persona. One persona's handoffs no longer stop the others from saving;
  only the 128 KiB file limit is shared, and a save it refuses says how many entries the caller and the
  other personas hold. Handoff refusals for an unreadable file say what is wrong with it (unsafe path, size,
  version, missing with a backup, corrupt or inaccessible), name the file and no longer mention optimizing.
- `remember` with `supersedes` is no longer blocked by a corrupt memory tier it does not write to, when
  that tier recovers completely from its backup. It still refuses, naming the store, when another tier
  cannot be read completely, because that tier could hide the fact being replaced. A backup that exists
  but cannot be used is now reported as a warning on every read instead of being treated as absent.
- Session shutdown waits at most 5 seconds for a Persona worker's completion; local apply and
  persistence work is still joined in full.
- The memory evaluation reports held-out false positives both strictly and with its acceptable-match
  labels (5 and 5 strictly; 5 and 3 with labels), and states that the held-out set was written alongside
  the implementation.

## [0.9.3](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.9.3) - 2026-11-22

- Improve lexical recall for camelCase/acronyms and vowel accents with weaker fallback scores;
  preserve Unicode, exact paths, numeric versions and negation. Extend the offline evaluator with
  the preceding implementation, negative controls and a separate labelled holdout.
- Retain before/after receipts for ordinary explicit memory replacements in the existing bounded
  history. Discover them with `memory history` or `/mind history`, then page the full retained detail.
  Historical facts stay outside active recall; ordinary replacement undo is deliberately unavailable.
- Add explicit project/persona handoffs with goals, completed/pending work, next steps, references
  and native session/branch provenance. Read them in later sessions; completion and forgetting require
  the current revision. No automatic expiry, injection, model call or worker restoration is involved.
- Target and qualify Pi 1.6.0, keeping all four development host packages aligned and unbundled.
- Recheck the accepting memory owner and replacement expiry under the write lock. Refuse malformed
  history/handoff records, keep discovery output bounded, and distinguish branch navigation from
  ordinary native-session appends.

- Preserve recording provenance and lineage when an identical memory is recorded again without
  replacement metadata.
- Refuse `remember` replacements whose `supersedes` target exists only in another memory tier,
  instead of reporting success while keeping both facts active. No cross-tier deletion is implied.

## [0.9.2](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.9.2) - 2026-11-18

- F10 divides its title, content and keys with the same rules as F9, and its key legend uses the
  same glyphs for the plain keys (`↑↓`, `⏎`, `esc`). The margin above and below the content comes
  from the shared inspector frame of pi-persona 1.19.0; with 1.18.1 the window keeps its previous
  height.

## [0.9.1](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.9.1) - 2026-11-18

- Require pi-persona 1.18.1 or later for the shared F9/F10 inspector frame.

- Recheck the live memory file under the recovery lock before restoring a backup, preserving facts
  committed by another writer while recovery was waiting.
- Preserve negated capture requests: “Never remember that …” no longer creates a positive session
  note; negated decision premises are retained instead of discarded before `:`. Affirmative requests
  whose fact contains negative wording, such as “Remember that I never …”, remain valid.
- Acknowledge backlog reminders by both ID and the displayed deadline, preserving concurrent
  rescheduling instead of silently consuming the new reminder.
- Recheck persisted memory content before promotion through the shared content guard. Unsafe
  out-of-band records cannot move into durable/shared memory, and refusal preserves both stores.
- Suppress late status counts and storage warnings after persona changes or shutdown, using the
  same accepting-owner guard as other asynchronous memory operations.
- Simplify the README around memory lifetimes, retrieval, F10 and deliberate maintenance, with
  technical details linked to the design contract.
- Share Persona's F9 window frame in F10, including responsive dimensions, gutters and theme
  border. Page navigation follows the visible content without gaps; narrow windows preserve the
  selected record and search focus belongs only to the active native input.

## [0.9.0](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.9.0) - 2026-11-13

- Require pi-persona 1.18.0 or later for this release. Mind custom entries use the shared
  primary-click expansion contract, preserving state across ordinary renderer rebuilds.
- Invalidate consolidation and staged plans on native branch navigation without treating ordinary
  appended turns as owner changes. Old workers cannot apply or report on the new branch;
  automatic maintenance retains its existing fresh-worker retry policy.
- Join admitted knowledge-review application through approval, persistence, receipt finalization
  and cleanup during shutdown. Revocation does not pretend to roll back already committed writes.
- Keep evidence root/file checks on the same native canonicalization path, including Windows
  short-name aliases. Cross-platform swap tests retain real symlink and descriptor defenses.
  Lifecycle tests explicitly advance automatic admission timers on the minimum supported Node.
- Add explicit consolidation and evidence-grounded knowledge-review actions to F10. Review selected
  facts or bounded scope windows against parent-selected repository files and active-branch user-role
  text on the session model; show cited findings before separately approved corrections.
- Revalidate reviewed evidence inside guarded optimizer application and retain the existing CAS,
  history and undo path. Knowledge review shares maintenance admission/accounting; retirement findings
  remain recommendations, not deletions. Owner/input/model/branch changes cancel pending review work.

- Add a read-only F10 memory inspector (`/mind browse`) with scoped facts, the last prepared Mind
  context, and a bounded active-branch conversation timeline (`/mind timeline`). Search, paginated
  lists and scrollable detail/source views do not start model calls or change storage.
- Attribute new explicit save receipts to their accepting owner and target. Open only matching native
  recording sources; keep legacy/free-text provenance literal and distinguish recordings from truth.
  Session/branch/owner changes revoke open views and prepared-context snapshots.

- Show the active worker as lowercase `mind`; successful automatic consolidation emits one informative
  toast instead of routine result cards. Proposal audits and durable undo history remain available;
  explicit reports and important warnings stay visible.
- Include manual worker launches in automatic cooldown/token accounting, preserve their completed
  digests, and keep interrupted manual work out of automatic retries. Hold the active slot until a
  cancelled worker settles when attempt persistence fails.
- Refuse optimization previews invalidated while their store read is in flight.
- Use the same lexical/path ranker for session recall and archive retrieval, including punctuation,
  source references and CJK text. Save receipts explain bounded context selection instead of promising
  that every saved fact will reappear automatically.
- Parse each retrieval query once per search instead of once per record, preserving ranking and
  tie order while reducing repeated work in large archives.
- Restore only the latest automatic attempt for each target; persist uncertain terminal failures
  without advancing coverage and surface attempt-persistence failures after cancellation joins.
- Handle Windows sharing conflicts while acquiring the dead-lock recovery gate as bounded
  contention, preserving exclusive callbacks and the existing ownership checks.
- Qualify long-project memory at the 10,000-entry store limit: old-fact recall/read/injection,
  pagination, reopen, capacity refusal, consolidation, undo and preservation of unrelated facts.
- Update live qualification to verify the actual toast/audit/receipt contract, exact multi-source
  application and successful undo in both Persona engines.
- Resolve installed Pi qualification dependencies through the selected host's public package
  exports, including ordinary hoisted npm layouts.
- Use lowercase Mind card headings and review notification prefixes while preserving saved history
  and custom titles.
- Keep automatic maintenance quiet: persist the full proposal audit without a visible proposal card,
  omit no-op notifications, and preserve manual detail and important warnings.
- Limit background application to multi-source consolidation; skip model admission without a
  compatible pair and leave single-record edits available to explicit workflows. This is an eligibility
  guard, not a semantic-truth guarantee. Ordinary LLM-selected global memory saves remain available.
- Preserve short-objective lifetime and earliest expiry when consolidating project working memory.
- Require explicit project/persona/shared scope for every long-term remember at both the public tool and
  MindService boundary; short-term memory stays project-scoped by default, and objective kind no longer
  changes the caller-selected lifetime.
- Route AUTO strong direct-user cues only to native active-branch session notes, with explicit session-only
  receipts and no durable fallback or optimizer dirtying. Session tool corrections include canonical
  examples; redundant `scope=session` is accepted without making scope mandatory.
- Target the current Pi 1.5.2 host and align offline qualification metadata.
- Standalone Mind entries use Persona's one shared card frame through a versioned local presentation
  query, honoring native padding and configured expand keys. Native memory/backlog tool shells remain
  host-owned; retained entries have a readable plain-text fallback without a compatible frame provider.
- Expanded save receipts expose their original IDs and lifetime evidence; compact summaries disclose
  hidden detail. Explicit scope mismatches cannot tombstone a session note through another tier.
- Extend the existing offline evaluator with paired sentinel outcomes and provenance-checked token
  reference diagnostics. Calculation is language-agnostic; no runtime ranking, budget, dependency,
  service or model-call changes are introduced. Published reference vectors are not billing counts.

## [0.8.7](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.8.7) - 2026-10-27

- Interrupted explicit optimization batches identify the tiers not yet reviewed. Worker failures
  and invalid proposals retain the worker's model/effort and terminal-report reference without
  echoing malformed model output. Invalid proposals never reach application.
- Setup failures report that no tier was reviewed; cleanup failures cannot overwrite completed
  results or retain the active-work slot. Migration-warning tests wait for background completion,
  and the live smoke checks proposal order, confirmed application counts and durable undo receipts;
  refused or uncertain writes cannot pass as successful application.

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
