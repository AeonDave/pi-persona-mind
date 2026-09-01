# AGENTS.md — pi-persona-mind

A standalone Pi extension: durable persona-aware memory + backlog, loosely coupled to
[`pi-persona`](https://github.com/AeonDave/pi-persona). Binding design: [`docs/DESIGN.md`](docs/DESIGN.md).

## Commands

- Typecheck: `npm run typecheck` (`tsc --noEmit`, strict + `exactOptionalPropertyTypes`)
- Tests: `npm test` · both: `npm run verify`
- Hermetic choke point: `node --import tsx --import ./test/setup/hermetic-env.ts --test test/*.test.ts`

## Conventions

- Erasable-syntax-only TS. `src/core/*` is pure (no Pi imports) and unit-tested.
- No hard dependency on pi-persona. Mirror its persona resolution, `PI_PERSONA_LEG` /
  `PI_PERSONA_CHILD`, and `pi-persona-deferred-input` by env/customType only.
- Wakes are display-only (`appendEntry` + toast). Never `sendUserMessage` / `triggerTurn`.
- Only LTM is durable. STM and backlog auto-delete after ~48h (write-back on session start + inject).
- `exactOptionalPropertyTypes`: omit optional props; do not assign `undefined`.

## Done

`npm run typecheck` clean **and** `npm test` green.
