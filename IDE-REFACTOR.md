# 2do refactor · IDE for life

**Week is the default. Month (Calendar) is the other planner view.** Capture in any day of Week and keep typing. A task with zero matching plugins is a complete, usable task. When a plugin has something relevant to contribute, the same row can show a field, suggestion, diagnostic, or action. The inspector and Review inbox open in context from either view.

First pass ships the editor contract with the existing Nutrition plugin. Use small Budget, Health, and Study fixtures to test where that contract breaks. The screenshots guide the slash picker, row, inspector, and diff. The current Week and Month navigation governs the shell. [Planner design](./plan.md)

### Implementation status

- The local build supports immediate Week capture, immutable source text, full-input Clef classification, batched row hints, editable inline fields, inlays, persistent skip/restore, and the Week/Month task inspector. Nutrition is the first production descriptor.
- Fixtures cover pre-session Study prompts and connected features scoped to a particular task or local day. Tests exercise installation order, multiple facts for one task, permission changes, and provider disconnect during a read.
- The Week and Month shell includes a command palette, keyboard status bar, and Review panel. Plugin descriptors supply slash capture commands. The inspector can recheck an existing task and display its last real classification result. The local Worker sends inference to the signed-in Cloudflare account.
- Fixed-time rescheduling supports user and Copilot proposals, before/after review, accept/reject, and guarded undo. Upcoming work includes reversible title normalization, ambiguous classification suggestions, more field primitives, and review for other kinds of edits.

## Starting point for the refactor

| Area | Initial implementation | Planned changes |
| --- | --- | --- |
| Capture | [Slash editor](./apps/web/client/slash-editor.ts) inserts a UUID-backed `taskRef` and advances the caret. [DayBuffer](./apps/web/client/day-buffer.ts) debounces saves by 350 ms. [Notebook.saveDay](./apps/api/src/core/notebook.ts) commits the page and embedded task together and recognizes an identical retry. | Keep the transaction. Preserve the original body before trimming. Flush on task capture. Retain the optimistic title until the plan read acknowledges the ID. |
| Intelligence | [UserPlanner](./apps/api/src/user-planner.ts) enqueues Clef on create/title change with an AI binding and enabled subtype. [Classification](./apps/api/src/core/task-classification.ts) already handles leases, retries, stale work, and manual overrides. | Add Claric title normalization, ambiguous suggestions, provenance, and lifecycle-aware prompt eligibility. Claric has no adapter in this checkout. |
| Plugins | [TaskPlugin](./apps/api/src/interfaces/task-plugins.ts) already declares subtype schemas and grouped editor fields. [Nutrition](./apps/api/src/plugins/meal.ts) is registered. Budget appears in a test fixture. | Extend the descriptor and port Nutrition, including existing foods and nutrition data. Test multiple independent matches and one opt-in cross-plugin feature. |
| Workspace | [PlannerView](./apps/web/client/main.tsx) defaults to Week, supports Month, and stores focused day as a Week option. [NotebookReference](./apps/web/client/notebook-reference.tsx) renders an ID against the plan. | Keep both views and the existing date links. Reuse one task row and a nonmodal inspector. Keep existing chats reachable by explicit command. |
| Decisions | [Planner](./apps/api/src/core/planner.ts) supports revision-checked edits. [MCP](./apps/api/src/mcp/server.ts) dispatches generated tools, including direct mutations. | Add a stored proposal, a real producer, and a user decision endpoint. Enforce the agent’s write permissions at dispatch. |

## Editor behavior

| Signal | Surface | User control |
| --- | --- | --- |
| New capture | One line in the selected day of Week. Raw text visible immediately. Save state separate from inference state. | Keep typing. Retry a failed save using the same task ID. |
| Safe Claric normalization | Display title updates in place. Limit automatic edits to verified meaning-preserving transformations such as casing and whitespace. | Inspector shows original and Undo. A changed name, amount, date, negation, or uncertain rewrite needs a suggestion or review. |
| High-confidence Clef match | Inferred type chip. Multiple types can coexist. | Remove, correct, or explicitly add a type. A manual rejection survives later inference. |
| Ambiguous match | Dismissible inline suggestion. Low-confidence match stays quiet. | Accept or dismiss by keyboard or pointer. |
| Inferred property | Small inlay such as a time or quoted price. Inspector identifies the source and confirmation state. | Confirm, edit, or dismiss. A date in the sentence can differ from the notebook date. |
| Missing optional detail | Collapsed count once the declared trigger and field conditions hold. A planning field can be useful before an activity. A result field can become useful afterward. | Expand with the row action or `e`. Enter a value, attach evidence, or skip. Manual entry remains available from the inspector. |
| Conflict or agent decision | A diagnostic on the affected row. A meaningful proposed edit gets a before/after diff in Review and a pending count. | Inspect, accept, or reject. Open a task from Review. |
| Work in flight | Quiet status bar. Failure leaves the raw task usable. | See stage, failure, and retry in the inspector. Background updates preserve focus, selection, scroll, and editor mode. |

## Dispatch

Run **one coordinator and three workers**. Branch workers from the same integration snapshot containing current tracked and untracked refactor work. A clean worktree created from today's `HEAD` alone omits the in-progress plugin system. Record the base and baseline check results before dispatch.

| Owner | Exclusive write area | First handoff |
| --- | --- | --- |
| **Coordinator — contracts and integration** | Shared API interfaces, `db/schema.ts`, migration files, `user-planner.ts`, route registration, generated artifacts. Own shared wiring and merge order. | Publish the four contracts below, typed fixtures, and a list of owned paths. Resolve cross-owner contract changes here. |
| **A — capture and intelligence** | API notebook capture, task-write lifecycle, classification queue/repository, Claric and Clef adapters, visible-task summary read. | Hold the provider. Show that the task and page commit before inference resolves. Prove delayed output respects a concurrent manual edit. |
| **B — notebook and workspace** | Web day buffer, editor/node views, commands, shell, preferences, styles, inspector and Review panel. | Wire one Week row end to end. Reuse it in the agenda for tasks without an embedded reference. Open inspector and Review while preserving the selected Week or Month. |
| **C — plugins and review** | API plugin registry, built-in plugin declarations, optional feature activation, proposal storage/routes, Flue/MCP policy. Web field primitives in `subtype-fields` and `task-subtypes`. | Port Nutrition. Demonstrate that an unfamiliar fixture renders through the same primitives and a connected feature can be enabled and disabled independently of the base plugin. Then wire a proposed reschedule of any fixed event. |

### Contracts to settle before parallel edits

1. **Capture and provenance.** Keep the client-assigned ID, capture day, local date/time zone, and immutable raw task body. Store display title and its source separately. User edits and Undo advance the input generation. Existing `{id,title}` callers keep working. For older rows, identify a legacy title snapshot as such. The original wording may be unrecoverable.
2. **Plugin capabilities and optional features.** Each plugin declares its own typed fields, actions, prompts, and exported facts. The host validates field values and renders shared primitives. Keep current grouped text-list and number fields. Extend the vocabulary as the traces require. Each prompt declares a stable ID, field, trigger, and eligibility condition. Actions reference registered handlers. Track proposed and confirmed values per field. A feature can declare a required fact type and version exported by another plugin. The registry activates it when the providers are enabled, compatible, and allowed to share those facts for this planner. See the connected-feature test below.
3. **Editor read model.** Agree on a bounded batch read keyed by visible task IDs. Each summary supplies display title, type chips, inlays, eligible prompt count, diagnostics, and processing state. Fetch detailed provenance, activity, and actions for an inspected task. Subscribe or refresh once per visible batch while work is pending. Keep ProseMirror nodes ID-only. Inline row and inspector share query keys and mutation results.
4. **Review.** First operation is a proposed reschedule of an existing fixed event. Store task ID, source/effect key, reason, reviewed revision, full before/after interval, proposal version, and decision status. User submits ID, version, decision. Server derives the patch from the stored diff. Use the same record for the badge, inbox, inspector link, and audit.

### Execution order

| Wave | A · backend | B · editor | C · plugins and review | Coordinator gate |
| --- | --- | --- | --- | --- |
| 0 · freeze | Trace day save and direct task create. | Trace slash Enter, IME, Week focus, and existing bindings. | Trace manual subtype writes, image ownership, and every MCP mutation. | Publish fixtures for zero, one, and multiple matching plugins, plus connected/disconnected feature states. |
| 1 · capture | Save raw input with the task. Extend the existing DO alarm with revisioned jobs. Classify the latest user-authored input. Verify the Claric adapter independently. | Flush captures through the ordered day-save path. Preserve pending title, next paragraph, Week focus, and graph embeds. | Port existing Nutrition through shared primitives. Register a Study fixture using the same descriptor. | Merge a real task capture with all plugins disabled. Repeat with a provider delayed or unavailable. Then resolve an eligible chip without disturbing the next edit. |
| 2 · contextual actions | Serve visible summaries. Recompute eligibility on relevant task, field, and provider changes. | Ship slash and contextual completions, chips, inlays, inline actions, inspector, command palette, and status bar. Display shortcuts from active bindings. | Wire plugin actions, the Health/Nutrition fixture, and a real “Propose new time” action. Apply model tool restrictions. | Run the plugin matrix. Open and decide a stored proposal from Week and Month. |
| 3 · integrate | Exercise retries, concurrent writers, disabled plugins, migrations, provider failure. | Verify keyboard-only flows, responsive layout, and focus across late updates. | Exercise duplicate decisions, stale diffs, agent permissions, and the Copilot evals. | Run the release checks below. Land each slice with its evidence. |

Merge shared contracts first. Consumers may develop against fixtures as soon as the shapes land. For each handoff, return changed paths, checks run, remaining failures, and the next consumer’s entry point. Only the coordinator regenerates public artifacts after route changes.

## Scenarios for testing the contract

Only Nutrition needs a production implementation in this pass. Run the other declarations in tests through the real registry, renderer, and action dispatcher. Keep domain names out of editor switches, queue routing, and planner tables.

| Configuration | Example | What must work |
| --- | --- | --- |
| All plugins disabled | “Return the library book” | Capture, edit, schedule, complete, and reopen in Week. Month reflects its scheduled date. Zero chips or enrichment prompts. |
| Meal / Nutrition alone | “Lunch at home on Friday” | A high-confidence match exposes Meal. The plugin can offer an optional photo after completion. Skip persists on reload. |
| Budget alone | “Replace bike lights, estimated $35 CAD” | Show an estimated cost. Recording payment requires separate evidence or an explicit action. Replaying that action yields one recorded payment. |
| Health alone | “Cycle for 30 minutes tomorrow” | Track a planned cardio session. Record actual duration separately. Workout logging works with Nutrition disconnected. |
| Study alone | “Prepare for Friday’s database exam” | Offer a planning field such as target topics before the session. A later review action uses the same field and action primitives. |
| Two independent matches | “Lunch after class, budget $15 CAD” | Meal and Expense can annotate one task. Dismiss Expense or disable Budget. The Meal annotation and its fields still work. |
| Health + Nutrition connected | Log a ride and a meal on **different tasks** that day | A Health feature consumes a permitted Nutrition fact and exposes a “View meals on workout day” action. Results follow the confirmed records for that planner and local day. |

**Connected-feature test.** Start with Health alone. Log the ride. Connect Nutrition, then record the meal. Verify the additional action actually returns the matching record. Update that record and replay its change event. The result updates once. Disconnect Nutrition mid-refresh. Its action disappears and its queued result is ignored. Health still owns the ride. Reconnect and resolve the result from current facts. Also exercise the reverse installation order and an incompatible export version. Use a fixture reader or a keyed derived value for this test. A new integration service is unnecessary for this slice.

## Implementation decisions that cross owners

- **Two planner views.** Week edits the existing per-day documents. Month reads the same accepted schedule. The inspector follows the selected task ID. Review opens as an inbox panel. Closing either panel restores the originating date, view, and focus. Use the existing planner event kind and schedule for rescheduling. Preserve graph, parent, and dependency editing.
- **One keyboard command per action.** Share action IDs between slash menu, palette, row menu, and inspector. Generate typed capture commands from enabled descriptors. An explicit type selection commits with capture. Scope `e` to a selected task in Normal mode. Preserve the current `g d` Next Day default and user remaps. In Week, `o` targets the selected day.
- **Arrival order must converge.** Completion before classification produces the same eligible prompts as classification before completion. Persist skip per task and prompt until the user explicitly restores it. Late workers check input generation, installation epoch, and manual field decisions before writing. Keep undo history for automatic changes. Reverting a value that has since changed uses the same conflict check as editing it.
- **Separate intent from recorded outcomes.** A type match makes capabilities available. Each plugin declares the evidence or user action needed to record an outcome. A planned purchase, run, or study block alone establishes only intent. The plugin owns its outcome semantics. The editor owns rendering and dispatch.
- **Review protects the accepted plan.** Use the existing authenticated Flue conversation and OpenAPI-derived MCP catalog. Give model-originated actions read/propose capability. Enforce allowed operations on discovery and invocation, including indirect writes such as day saves with embedded tasks. Keep approval on the user route. Accept atomically checks the affected fields, applies the planner operation, and records a receipt. An unrelated title edit survives. A changed schedule requires a fresh diff. Reject closes the proposal. Undo an accepted edit against its applied revision.
- **Roll out by operation.** Start with rescheduling. Inventory the existing Copilot write tools and migrate meaningful task, notebook, and dependency changes to reviewable operations before switching existing chats to the new policy. Keep manual editing paths available throughout. Update the existing Copilot conflict eval alongside each affected tool. A failed migration or smoke test holds that slice at the last passing integration revision.

## Release evidence

1. **Navigation and capture.** Open `/app` and land in Week. Switch to Month and back with the selected date intact. Open an existing focused-day Week link. Capture on a day other than today, type the next note, then drop and replay the save response. One task and one reference land on the intended day.
2. **Inference under delay.** Run a task with no match, an ambiguous match, and multiple matches. Release provider results while typing or composing text with an IME. Same active element, selection, mode, viewport, and note text. Fail the provider and retry. Capture remains usable throughout.
3. **Plugin portability and user control.** Run the matrix above. Register the Study fixture using only its declaration and handler. Confirm that Week, inspector, and commands expose it without a frontend change. Run its pre-session prompt and Nutrition’s post-completion prompt. Deliver a stale result after a manual rename, type removal, or field edit. The user’s choice survives reload. Undo a title normalization and inspect the original.
4. **Review with plugins disabled.** Propose moving an existing fixed event from 18:00–19:00 to 19:00–20:00. Week and Month still show the original interval. Reject it. Make a fresh proposal and approve twice. Both views move once. Repeat with a concurrent schedule edit, another planner identity, and a direct model attempt to approve.
5. **Visual and accessibility pass.** Exercise screenshot 2’s slash picker inside Week, screenshots 1/3’s row and side inspector with the same saved field, and screenshot 4’s before/after diff inside the inbox panel. Check narrow width, keyboard-only entry/edit/skip/accept, Vim disabled, and Escape returning to the originating row or Month cell. Check a seven-day Week issues a bounded summary read per refresh.
6. **Compatibility and build.** Migrate a populated planner containing Meal data, manual rejections, task/graph references, and existing day revisions. Replay a lost day save. Re-run graph, calendar, chat isolation, and plugin tests. Run the repository migration drift check, `npm run openapi` after contract edits, `npm run openapi:check`, `npm run typecheck`, `npm test`, and `npm run build`. The OpenAPI document, MCP catalog, and browser types move together. Report deterministic tests, local integration, and live model verification separately.
