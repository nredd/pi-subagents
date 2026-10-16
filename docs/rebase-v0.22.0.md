# Fork rebase onto v0.22.0

Maintainer notes for the `nredd/v0.22.0` queue. This is preparation only, not a release.

## History

Rebased the 30 commits from `e955e29..nredd/v0.19.0` with:

```sh
git rebase --onto v0.22.0 e955e29 nredd/v0.22.0
```

Retained 27 commits, individually replayed from `bef7635` through `958af24`, followed by an integration-fix commit. No project-wide squash. Package version remains upstream `0.22.0`; host packages remain peers. No tags, pins, package installs into pi, releases or npm publication were performed.

## Superseded patches

- `0269065` (`Declare typebox as a host-provided peer dependency`): upstream `25eb4fa` declares `typebox: "*"` as a peer and removes the old runtime declaration. A stock-package assertion checked the peer and absence from runtime dependencies. Child stand-ins now import `typebox`, not the legacy package. Upstream's legacy test-fixture devDependency is unchanged.
- `833bbe8` (`Queue completion notices and flush them as one message`): upstream `2f8dd3a` provides `CompletionOutbox`. Its stock 13-test suite passes the fork's coalescing, cancellation, replacement, group flattening and stale-send invariants, and adds turn-boundary and aborted-turn coverage. Keep that implementation rather than wiring two outboxes.
- `099959b` (`Move to pi 1.0.0 and port e2e tests to the system-message transcript`): upstream `25eb4fa` ports the clone, transcript writer and faux responders to pi 1.x, with a newer `1.1.0` development pin. Stock `mention-clone`, `output-file`, `completion-outbox` and fullscreen mouse tests: 73 passed across four files. The final scripted e2e gate also verifies clone history/tool reachability and prompt/system-message transcript handling. No compatibility helper for the pre-1.x shape is retained.

The stock tests ran from an archive of `v0.22.0` inside this isolated worktree, using its installed dependencies. The archive was removed afterward.

## Reconciliation

- Keep upstream's full-terminal observer, scrollbar, footer controls, project trust, package agent/workflow discovery and foreground-to-background handoff. Port the Ctrl+B hint into the fork's one-line result renderer. Retain streaming text and live model activity. Remove only the superseded centered-fullscreen/backdrop mouse implementation; stock fullscreen mouse coverage remains intact.
- Keep upstream's busy-parent `turn_end` steering delivery, idle 200ms coalescing window, `agent_end`/`agent_settled` fallback and Esc/error handling. Detached completions enter that same outbox, not a second follow-up channel.
- Transfer held notices to the parent session spool on confirmed shutdown, including registered groups and completions awaiting group registration. Restore them once without appending their existing history again. Results consumed or already delivered before the switch are not replayed. Running background agents retain the fork's session-scoped detached manager and fleet registry.
- Preserve explicit model choices, machine-local aliases, model ranking/overrides, quota admission/parking/re-admission, physical routed model display, retention/eviction, bounded tool-free reports, queued steering, no nested background work, cwd worktree isolation, renderer probe guards and fleet widget lifecycle.
- Adjust tests for upstream's thrown worktree failure and pre-aborted-child behavior, the merged fleet constructor, and pi's current tool declarations. Advance the retention clock synchronously rather than sleeping through thousands of async fake-timer ticks. Deduplicate fork changelog entries; released upstream sections are byte-identical.

## Evidence

All model-backed tests used scripted faux responses, with `PI_E2E_LIVE=0`.

- `npm run check` (`PI_E2E_LIVE=0`): biome clean, TypeScript clean, 126 test files passed; 2578 tests passed, 7 opt-in live tests skipped.
- `npm run test:e2e` (`PI_E2E_LIVE=0`): 16 files passed; 88 tests passed, 7 opt-in live tests skipped.
- `npm run build`: passed.
- `git diff --check`: passed (rerun after the review fixes).
- Package/version/peer assertions and released-changelog comparison: passed (not rerun after the review fixes).
- Review fixes: a quota-parked job re-admitted with a refusal that cannot park (`wait: false`, no reset, or a reset already past) now ends with `lastStatus: "error"` and a `subagents:scheduled` error event instead of spawning; it is not re-parked. Before the `src/schedule.ts` change, the rewritten `wait: false` case (formerly asserting a spawn) and the missing-reset case failed against the old source (2 failed, 15 passed). The already-past-reset case was added afterwards to cover the newly documented behavior and was not run against the old source. The three cases assert no spawn, the persisted error and the error event.
- New held-notice transfer regressions were red before wiring the spool into the boundary outbox, then green. Coverage includes smart/group pending notices, consumed/delivered suppression, coalesced detached completions at a busy parent's boundary, one-shot group draining and outbox transfer without duplicate delivery.

Vitest reports upstream's advisory about ESM syntax in `vitest.config.ts` under a future native config loader. It does not fail any gate.

External harness, installed-core `1.3.0-nredd.1` router gate and adversarial review remain the main session's responsibility. Own tests use upstream's pinned pi `1.1.0`; no live model calls were made. A disk failure can still prevent spool persistence; shutdown logs that failure and the transcript remains the fallback, as for detached results previously.
