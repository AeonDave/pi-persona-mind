# Mind improvement — implementation record

2026-10-25. The user authorized implementation after independent research, then required visible
Mind activity in Persona and no operation without a compatible loaded pi-persona.

This file replaces the preliminary proposal. Its research claims and stale inventories must not
be used as current contracts. The source review corrected the LongMemEval attribution, the proposed
universal decay rate, reset behavior and the claim that native entry renderers were missing.

Canonical documents:

- [README](../../README.md): supported setup, all commands and optimization workflow.
- [DESIGN](../DESIGN.md): lifecycle, storage, session notes, consolidation and UI contracts.
- [MEMORY-RESEARCH](../MEMORY-RESEARCH.md): primary sources, limitations and design decisions.
- [CHANGELOG](../../CHANGELOG.md): unreleased changes.

Implementation scope:

1. Pi 1.4-only APIs and dependency qualification; live Persona ownership, frozen for each worker.
2. Native active-branch session notes, full reads, source-session provenance and honest in-memory receipts.
3. Explicit inspect → stage → apply consolidation; stale-write refusal, bounded proposals, lineage
   preservation and no automatic semantic deletion or hidden model calls.
4. Coherent cards, strict command parsing and lifecycle-owned output.
5. Honest migration progress and actionable diagnostics.
6. Required loaded companion handshake and standardized Mind activity visibility.

Automatic exact deduplication and project expiry remain. Age alone does not invalidate durable facts.
Memory-data migration remains to preserve user data; retired host/companion compatibility branches do not.
Release publication is separate from implementation and qualification.

## Prior verification — before automatic LLM optimization

These results cover the earlier slice. The subsequent automatic worker and its final gates are
recorded in [automatic optimization](2026-10-25-automatic-optimization.md).

- Official Node 22.23.3, Windows: Mind full suite **363/363**, zero skips; Persona full suite
  **2,913 passed / 2,915 total**, the two documented Windows skips, zero failures.
- Both repositories: typecheck clean, dependency audit including development dependencies reports
  zero vulnerabilities, and `git diff --check` clean.
- Both final tarballs extracted outside the repositories: the real installed Pi 1.4.0 loads them
  together. Qualification covers live persona selection with `persist:false`, alpha/beta isolation,
  shared LTM, model-picker changes, native session notes, full reads, explicit consolidation,
  stale-plan refusal, retained expiry/origins, lean worker memory and one display-only backlog wake.
  The installed-host fixture made seven synthetic requests and zero network fetches.
- The development SDK independently loads the extracted pair and passes memory/tool/wake checks.
  All 246 packed files were compared byte-for-byte with their final source counterparts. Mind packs
  35 files; plans, tests, scripts and pre-existing local artwork are excluded.
- Real-provider smoke with **openai/gpt-6-luna, xhigh**, passed on **both in-process and child engines**:
  with persistence disabled, a worker receives its launching persona's private marker and not the
  other persona's marker. Profiles, memory fixtures and selected-provider credential copies are
  temporary and removed by the harness; the user's memory stores are not rewritten.
- Independent review reproduced and closed three additional defects: an exact replacement causing
  a needless write, omitted optimization tags being lost, and delayed old-persona injection after a
  persona switch. Regression tests cover each. Activity rendering is checked at widths 36/80 and
  through the actual factory/native loader, including session disposal and persona switches.

These checks qualify the exercised Windows/current-Pi paths. They do not establish semantic truth,
universal compression ratios or fresh Linux/macOS provider results. No commit, push or publication
was performed. The compatible Persona changes must be loaded alongside Mind; published Persona
1.17.4 does not yet expose this new companion contract.
