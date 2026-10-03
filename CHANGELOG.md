# Changelog

## Unreleased

## [0.8.0](https://github.com/AeonDave/pi-persona-mind/releases/tag/v0.8.0) - 2026-10-03

- Require Pi 1.0.0+ and Node.js 22.19.0+; keep host libraries and typebox as host-provided peers.
- Reset capture hints and empty-store announcements when a session changes; prevent late capture
  notices and memory injection from leaking into the next session.
- Skip migration/storage waits for ordinary input with no capture cue.
- Suggest backlog capture only for blocked nested output actually relayed by its outer tool.
- Enforce erasable-only TypeScript, including store/service constructors.
- Isolate test profiles; exercise capture, persistence, tool execution and read-only workers in real
  Pi 1.0 SDK sessions with an offline provider.
- Align package/lock metadata, upgrade development dependencies and pin three-platform CI actions.

Older storage roots remain readable through non-destructive migration. No existing store is deleted
or moved by the host compatibility update.
