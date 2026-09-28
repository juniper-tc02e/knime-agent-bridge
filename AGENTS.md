# Working on or through this bridge

Use MCP for discoverable agent operations and the CLI for diagnosis/scripts. They share the same client and native KNIME process. Start with session discovery and check the workspace before mutations. Use an explicit session ID when more than one live instance exists.

Read `README.md`, `docs/GATEWAY_API.md`, and `docs/CORE_API.md`. Discover the installed service methods/entities rather than guessing JSON shapes or factory names. `core.describe` provides core argument contracts. `desktop.uiState` diagnoses a modal dialog that blocks project opening. Do not replace KNIME's UI event subscriptions.

Prefer native gateway commands for graph editing and undo/redo. Use typed core settings for configuration and paged core table reads for data. Preserve the full settings envelope and protected values. Never rewrite the on-disk XML of a workflow while it is loaded in KNIME.

Acknowledgement is not completion. After opening, poll application state. After editing, inspect the graph. After execution, inspect node states/messages and independently check the expected data. Save and verify persistence. A timeout has an unknown mutation outcome; inspect before retrying.

In v0.2 bind an explicit context and use its expected revisions for mutations. For canvas work, capture before/after views, inspect readable image tiles and run curve/text layout checks. Supply preserved groups and pinned objects to layout planning; annotation meaning is not inferred automatically. A screenshot generated is not a screenshot reviewed. Completion must distinguish functional, visual and persistence evidence and expose missing coverage. Use exact native operation IDs to reconcile timeouts; direct native layout setters have no gateway undo entry.

Tests that mutate KNIME must create synthetic workflows in `runtime/workspace`. Do not point them at coursework or production workspaces. Stop/restart only the isolated test process you launched, after saving any needed work. Building a new bundle does not update an already running KNIME process.

The user requested broad local agent access, including live canvas editing. This does not implicitly authorise sending messages, publishing, spending, credential extraction, or running workflows against production systems. Follow the user's current authorisation; do not ask again for routine reversible work already in scope.

Before claiming a release, run adapter tests and the real-process MCP workflow round trip. Record the exact supported build, verified operations and untested gaps in `docs/VERIFICATION.md`. Keep release claims bounded by that evidence.
