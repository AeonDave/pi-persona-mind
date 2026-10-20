# Changelog

## Unreleased

## [0.8.3](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.8.3) - 2026-10-20

- Read persona selection and startup `defaultPersona`/`persist` preferences from pi-persona's
  canonical settings store, preserving legacy marker fallback only when canonical settings are absent.
- Contribute Mind's capture/nudge settings to pi-persona's unified settings panel, while retaining
  environment overrides and session-start snapshot behavior.
- Scope marker latches and Mind-specific preference snapshots to Pi session IDs so child sessions
  cannot reset their supervisor's active scope or companion controls.
- Match pi-persona's extension-factory snapshot for the scalar persona selectors, keeping Mind's
  memory scope aligned across `/new` sessions until Pi reloads/restarts extensions.

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
