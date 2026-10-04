# v0.5 long-session reliability implementation plan

**Goal:** repair long-session routing, deadlines, observation and recovery while making unverified evidence explicit.

**Architecture:** preserve filesystem IPC and one native mutation lane; add bounded lock-free telemetry, explicit client profiles and async disk-authoritative history inspection. Add compact transport results with full retrievable evidence, selected path gates and stable complete-table verification.

**Tech stack:** Node >=22 ES modules, MCP SDK 1.30.1, Java 21 target, installed KNIME 5.12 modern UI, Windows 11.

**Spec:** `docs/superpowers/specs/2026-10-04-observability-design.md`.

## Global constraints

- Original configured source/runtime and analytical workflows remain untouched; only a newly launched synthetic native process may be stopped.
- No automatic replay/cancel of unknown outcomes, no cached payload authority, no eviction of uncertain contexts and no weakened revisions or identity checks.
- User has explicitly authorized next-version publication. No other outward messages, secrets, spending or model science.
- Parallel workers have disjoint ownership and preserve each other's edits. Use GPT-6.1 Sol workers as specified in the handover.
- Tests retain original bounds. Claim only measured behavior and disclose unavailable UI/performance coverage.

## Review focus

- A profile alias redirected during staging must fail before publication; native version and source version remain distinct.
- EOF during an unknown mutation must terminate only the owned observer and preserve original UUID uncertainty.
- Selected history changed/removed/locked between pages must invalidate the cursor or fail, never return old success.
- A table replaced mid-page read must fail identity guards; sample metrics must never become full metrics.
- Journal/publication failure after a native effect must retain earliest primary failure, one-effect dedup and honest durability state.

## Tasks

- [ ] Client/profile/deadline/lifecycle worker: modify `src/client.mjs`, `src/cli.mjs`, `src/server.mjs`, `src/wait.mjs`; add profile/trace/lifecycle modules and tests. Freeze regressions for total deadline, tiny residual waits, expected version/bundle, EOF with pending work and parallel clients. Run 100 owned stdio connect/disconnect iterations with timing/resource receipt. Expose `connectionDiagnostics`, `lifecycleDiagnostics` and trace references without raw argument values.
- [ ] Native scheduling/recovery worker: modify `BridgeActivator.java`, `OperationAccess.java`; add bounded telemetry helper and production-boundary harness. Expose `bridge.diagnostics`, current UUID, queue depth/age and monotonic stages without workflow locks/UI. Keep `core.cancel` serialized. Harness blocks worker, queues read/mutation/cancel and checks bounded diagnostic response plus one effect. Inject journal/response failures and preserve primary error separately.
- [ ] History worker: measure v0.4 cold/warm at 10/1000/10000+ records with comparable fixtures/counters; add async listing/paging with immutable reference validation and explicit cursor invalidation. Preserve synchronous consumers. Add independent-writer/replacement/removal/locked-file regressions; publish sanitized JSON/CSV performance results.
- [ ] Main integration: extend `src/catalog.mjs` with strict diagnostics/history/detail/table-verification contracts; reduce duplicate text in `src/mcp-result.mjs`; add confined immutable detail store. Extend native `DependencyAccess.java` with named variables/root/path gates and `CoreAccess.java` with expected table identity. Add complete keyed/constant/positive-label metric verification and final token recheck. Synthetic fixtures check cached parent/copy semantics and 3544-row exact coverage, ties/nulls/Unicode, no hidden execution.
- [ ] Build and acceptance: update package/manifest/version; compile against actual installation; launch only separate `runtime/workspace-w2-v05-*`. Run existing beta fixtures and new native cases serially with finite bounds, context release, queue/unknown-outcome checks, actual PNG inspection and save-close-reopen/export manifest. Keep prior failed receipts and exact run accounting. Independently review danger paths before final acceptance.
- [ ] Publication: update setup/migration/rollback and issue/status/verification docs; export source without private handover/runtime/vendor artifacts; attach compiled JAR, file manifests/checksums and sanitized measurements. Push next version/tag and verify public assets by downloading and hashing. Stop only exact owned test process after saving needed synthetic work.
