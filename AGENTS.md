# AGENTS.md — pi-persona-mind

A standalone Pi extension: durable persona-aware memory + backlog, loosely coupled to
[`pi-persona`](https://github.com/AeonDave/pi-persona). Binding design: [`docs/DESIGN.md`](docs/DESIGN.md).

## Commands

- Typecheck: `npm run typecheck` (`tsc --noEmit`, strict + `exactOptionalPropertyTypes`)
- Tests: `npm test` · both: `npm run verify`
- Hermetic choke point: `node --import tsx --import ./test/setup/hermetic-env.ts --test test/*.test.ts`

## Conventions

- Erasable-syntax-only TS. `src/core/*` is pure (no Pi imports) and unit-tested.
- Require Pi 1.0.0+ / Node 22.19.0+. Keep host packages and typebox as optional peers on `*`,
  with all four Pi development packages pinned together. Never bundle a second host runtime.
- Tests clear `PI_PERSONA_*` case-insensitively and pin `PI_AGENT_DIR` to a throwaway directory.
  Keep the hermetic import on every direct test invocation. Real SDK tests use an offline provider.
- No hard dependency on pi-persona. Mirror its persona resolution, `PI_PERSONA_LEG` /
  `PI_PERSONA_CHILD`, and `pi-persona-deferred-input` by env/customType only.
- Wakes are display-only (`appendEntry` + toast). Never `sendUserMessage` / `triggerTurn`.
- Lifecycle generations bound capture/injection UI state to the accepting session. An accepted
  explicit capture may finish in its original store; its acknowledgement must not leak to a new turn.
- Nested tool results reach only their caller. Nudge on a blocked report only when the top-level
  result actually relays it; bound provenance by `parentToolCallId` and clear it on lifecycle change.
- Only LTM is durable. STM and backlog auto-delete after ~48h (write-back on session start + inject).
- `exactOptionalPropertyTypes`: omit optional props; do not assign `undefined`.

## Done

`npm run typecheck` clean, `npm test` green, full `npm audit --audit-level=low`, and package dry-run
inspection. Re-run after final edits. Keep published files explicit; no tests, drafts or local artifacts.
