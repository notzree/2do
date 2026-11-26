Linear for Life
Technical proposal for a personal planning system
Status · Proposed design for a Cloudflare backend with one planner per user. Sections 7–11 specify deployment, state transitions, plugin contracts, persistence, and acceptance traces.

A to-do list can remember “study for Friday.” Its owner still has to notice when Friday moves, find an evening to study, negotiate a dinner invitation, and decide which calendar entries to change. Linear for Life would take on that coordination work. It would maintain a cross-day plan, interpret new context with domain plugins, and bring the user one recommended revision they can inspect, amend in ordinary language, and authorize where necessary.

The hypothesis is that the unit of review should be a decision (“How should I rearrange Thursday?”). One decision may affect several entries and draw on several sources. A successful day can produce many observations, a handful of internal proposals, and no request for the user's attention.
1. The plan and its evidence
Record	Meaning	Example
Input	A source item with identity, revision, origin, and timestamps. Explicit user input and connector input use the same envelope.	A meal photo, a quiz date change in email, or a correction typed by the user.
Claim	A plugin's typed interpretation, linked to evidence. It can be estimated, disputed, superseded, or unknown.	Estimated protein for a plate is 25–35 g. Whether the user ate the whole plate is unknown.
Accepted plan	A versioned directed acyclic graph (DAG) of intended activities and milestones. Today is a time-filtered view.	Two study sessions across different days, a fixed dinner, and a Friday quiz.
Proposal	A suggested graph edit, question, or advisory finding, with a reason, dependencies, and a decision window.	Move a study session before Thursday dinner. Ask about portion size only if it changes the recommendation.
Change set	The net edits from the accepted plan to the current draft, including their consequences and any choices still open.	Move a study session and keep a dinner hold in the personal plan.


User preferences and standing permissions are explicit inputs to planning with a scope, such as tonight or every weekday. A one-time override expires with its scope. Persistent rules remain inspectable and revocable. Facts can update immediately as sources change. A pending change set remains hypothetical until accepted or covered by an existing delegation.

Graph semantics. A hard edge from A to B means A must finish before B can start. Nodes can carry duration, a fixed interval or allowable time window, completion state, and a reference to their owner or source. An externally scheduled event anchors the plan. Only its source or an authorized external change can move the actual event. A plugin can assert that studying supports a quiz without making the exam depend on completed study. Competing options, evidence links, and domain relationships live alongside the DAG. Recurring routines generate dated occurrences within the planning horizon. To seed the first version, import fixed obligations from enabled sources, then let the user describe flexible work, priorities, and any protected time. Every accepted revision retains stable node identities. A graph validator checks cycles and a scheduling validator checks time and resource feasibility. A source can create a real conflict by moving a fixed event. Record both facts and flag the conflict. Independent decisions can still proceed while the affected part of the plan awaits resolution.
2. Plugin and agent contracts
Input connectors read email, messages, calendar entries and other permitted sources as evidence. A receipt can establish that a purchase happened independently. V1 also lets the user link an individual 2do event to a writable calendar. The [connector implementation plan](docs/connectors.md) defines consent, supported fields and conflict handling for that exception.
Contract	Input and result	Responsibility
Interpret	Input plus permitted context → claims and candidate follow-up questions	Route by media type, source, or topic. Plugins register the input types and triggers they handle. Multiple plugins may interpret one item. Preserve uncertainty and source references.
Assess	Current claims, candidate plan, preferences, and clock → findings and proposed changes	Run a domain check on the accepted plan or a hypothetical revision. Return evidence, affected objects, expiry, and a reason the result matters.


Interpretation and assessment produce data and never send messages, schedule notifications, or modify source records. A coordinator gathers plugin findings. A planning agent can propose a combined patch or invent a feasible alternative that no single plugin considered. Its output uses a small vocabulary of edits to add, move, update, or retire nodes and add or remove prerequisite edges. Human-readable explanations link to typed operations. The same validator checks plugin and agent proposals.

Use cheap extraction models for routine classification, dates, quantities, and candidate entity matches. Invoke a more capable agent for ambiguous requests or cross-domain tradeoffs that survive basic filtering. Cache context-free extraction by source revision and plugin version. For interpretations that also depend on context, record and check the versions of referenced inputs, such as timezone or entity matches, and recheck the right to use them. Rerun affected assessments after a claim changes, a user edits a preference, or a decision deadline arrives. The core understands shared scheduling quantities such as time windows, durations, and resource reservations. Plugins own terms such as protein, portions, quiz coverage, and study progress.
3. How proposals become one recommendation
1. Collect. Read both the accepted head and the latest pending draft. Batch evidence until the next review window or an earlier decision deadline. Every proposal identifies the event occurrence and fields it changes.
2. Normalize. Match proposals by affected entity, intended effect, and occurrence. Collapse duplicate effects, retain independent supporting reasons, and retire proposals whose premise has changed. Preserve mutually exclusive options as alternatives.
3. Compose. Build a candidate patch. Group changes when accepting one affects the value or feasibility of another, such as a dinner hold and moving a conflicting study block. Arrival in the same batch gives two proposals no special relationship. Simulate the patch and reassess affected plugins so individually reasonable edits cannot double-book time or consume the same resource twice.
4. Select. Include keeping the current plan as a candidate. Enforce hard constraints first. Among feasible options, use the user's established preferences and favor fewer disruptions to accepted plans. Recommend the changes supported by the available evidence. If the remaining choice depends on a preference the user has never expressed, keep the recommendation conditional and show what turns on that choice. If all options conflict with fixed obligations, explain what is blocked and who could resolve it.
5. Present the net result. State what changed, why now, what it displaces, and the latest useful decision time. Show the consequential alternative if one exists. Independent decisions due at the same review remain separately selectable. Keep unrelated, nonurgent findings out of the decision summary. If the user accepts a subset, reassess its dependents before commit. For example, declining dinner removes the reason to move a study block that only conflicted with dinner.
The coordinator can defer a question when plausible answers lead to the same recommendation. A ready-to-expire invitation can bring review forward. An expiring opportunity never silently converts into an acceptance. If the user takes no action, the candidate expires or returns for reassessment under the user's review preferences.
4. Natural language and consent
A reply can correct evidence (“I ate half”), impose a temporary constraint (“keep Thursday evening free”), establish a standing preference (“always leave 20 minutes before class”), or accept part of a patch. The dialogue agent resolves the reply against the revision the user saw. A broad “looks good” selects only the recommended groups in that revision. Newly inferred edits remain proposals until authorized.

The user can delegate bounded internal edits such as moving flexible personal study blocks within the same day. An invitation can produce a personal hold and a reminder to reply. The user sends their own RSVP. Plugin reads and displayed explanations inherit source audience restrictions.

Applying a decision. In one DO transaction, check the disposition of the reviewed group and its material preconditions, apply the accepted personal-plan edits once, advance the accepted head, record the receipt, and rebase or retire the residual draft. A repeated command returns the recorded result. A later command can observe that the group was already applied or superseded.
5. Worked example
Accepted plan, Tuesday afternoon. The user has two one-hour study sessions booked before a Friday afternoon quiz: Thursday 6–7 p.m. and Friday 9–10 a.m. A course email moves the quiz to Friday at 9 a.m. In a text, Sam offers dinner on Thursday at 6 and asks for an answer by Wednesday noon. A photo also arrives, with the user's note “Log my lunch.”

What changed. The Friday session now overlaps the quiz. Moving it to Tuesday 7–8 p.m. would preserve both hours with one edit. Dinner poses a separate choice that would affect the same study plan. Accepting would require moving Thursday's session to an available hour. The nutrition plugin logs lunch and finds no time-sensitive choice. Its output stays out of this review.
Recommended revision. Your quiz moved to Friday at 9, when you planned to study. Move that session to tonight, 7–8. Keep Thursday's 6–7 session unless you want dinner with Sam. If you do, Thursday 4–5 is free for studying. Sam needs a reply by Wednesday noon.

User. “Keep tonight free. Move Friday's session to Wednesday 1–2 and Thursday's to 4–5. Put dinner with Sam on my plan for 6. I'll text him myself.”

The agent interprets “tonight” as a one-evening constraint, checks Wednesday and Thursday availability and records all three authorized edits in one new personal-plan revision. The user's instruction selects exact times and assigns the reply to them. This path needs no second approval.
Applied. Study Wednesday 1–2 and Thursday 4–5. Dinner with Sam is on your personal plan for Thursday at 6. Your reply to Sam is still due Wednesday at noon.

If Wednesday 1–2 fills before commit, the requested group fails its availability check. The agent offers the closest feasible substitute and identifies which other edits can proceed independently. A later message from Sam canceling dinner can propose retiring the hold and prompt reassessment of the Thursday move. It carries no authority to reverse completed work.

Two smaller cases exercise the same contracts. For adaptive sleep, a plugin derives a wind-down time from the earliest fixed obligation, preparation and travel, the user's sleep target, and any user-enabled adjustment based on sleep data. Moving the first class shifts the reminder only if that class determined wake time. For nutrition, suppose the user marks today’s meals complete, the logged total is 95–105 g, and their chosen target is 120 g. The plugin can report the estimated 15–25 g gap and offer a snack option. Asking about the photo’s exact portion would add work without changing the conclusion. If plausible totals straddle the target and the user is deciding what to eat, “Did you eat the whole plate?” could resolve a real choice.
6. Prototype and evaluation
Build one complete loop before adding broad connector coverage. Start with direct text and images, one read-only calendar, and forwarded course or invitation messages. Implement study scheduling and meal assessment, a versioned personal plan, one natural-language review, and internal plan commits. Add read-only purchase receipts to exercise optional plugin enrichment.

Primary test. Compare the same person's existing manual routine with assisted planning over comparable stretches of school or work. Record active minutes spent coordinating or correcting the system, unsolicited interruptions, review turns per decision, and missed commitments. A short daily rating captures perceived effort. Fewer prompts count as progress only if outcomes hold up and the user spends less time correcting the plan. Replay representative days with user-judged acceptable outcomes, including days when keeping the accepted plan is best. Sample suppressed findings after the fact to catch missed opportunities and count actionable items that expired before presentation. Log model cost and time to produce a review separately from user effort.

Release checks for the prototype. Replay a source change twice, reverse arrival order, and restore a canceled event while the cancellation is pending. Check the net diff and dependent edits. Reject cyclic or infeasible patches. Accept part of a bundle and recompute its dependents. Apply one logical approval across two requests. Correct a meal estimate without duplicating an entry.

Open decisions. How long can batching wait before opportunities are missed? When does a clarification save more effort than it costs? Which previously accepted edits deserve a suggestion of standing delegation? Tune these using observed decisions and user feedback. A proposed standing permission always has a visible scope and requires an explicit choice.

V0 client. Ship a phone-first, installable PWA using React, TypeScript, and Vite. Serve the built app with Cloudflare Workers Static Assets and route same-origin /api/* requests to the existing API Worker. The client needs three operations visible to the user: view today's accepted plan, capture a note or photo, and review the pending net changes with a natural-language reply. Keep revision reconciliation in the user's DO. A native mobile app can reuse the API later. Cloudflare React deployment guide

Phone acceptance check. Serve over HTTPS with a web app manifest, app icons and standalone display. Install from Safari on an iPhone, launch from the Home Screen, submit a photo, then amend a pending change and see the committed result. V0 assumes connectivity for submissions and approvals. If the connection drops during approval, recover the result using the original decision ID. PWA installation guide
7. Cloudflare backend architecture
Deploy one SQLite-backed UserPlanner Durable Object (DO) per user. It owns the accepted DAG, source revisions, plugin installations, decisions, and all pending work for that user. Its database is the authority for what has been observed, proposed, approved, and committed. Workers receive commands, run agents and plugins, and deliver results. The v0 PWA and a future native mobile client use the same backend API.
Component	Owns	Calls
API and ingress Worker	Authenticate user commands, verify connector deliveries, resolve the owning account, validate the request envelope	Route to the DO named from the verified internal user ID. Return a durable receipt after acceptance.
UserPlanner DO	Apply state transitions, deduplicate inputs, validate proposals, schedule deadlines, expose plan and review projections	Lease bounded work to execution Workers. Validate their results before storing them.
Execution Workers	Route manifests, run plugin code, invoke planning and dialogue agents, validate model output shape	Use scoped snapshot reads and a model broker. Return typed results to the owning DO.
Connector Worker	Hold scoped credentials, ingest changes, and interpret provider revision ordering where available	Submit evidence with source/item identity and authored or effective time. Dispatch authorized writes for linked calendar events.


The public API needs four operations for the first implementation. Submit an input with an idempotency key, read the current plan and open review, reply with a review ID plus revision and decision ID, and read the resulting receipt or pending status. A connector webhook enters through the same input command after verification. Alarms and hook completions use internal commands. A duplicate command returns its recorded outcome. Input acceptance and plan commitment have distinct receipts. Photos can live as private R2 objects with scoped references in SQLite.

The execution Worker defaults to Workers AI through the AI binding for classification, extraction, image understanding, and planning decisions. Plugins request a task, expected response schema, and budget. The broker selects a model, checks access to its input, validates the response, and records model identity, prompt revision, usage, and latency. Compare providers on a replay set specific to each task. Switch only for a measured, material improvement in quality at comparable cost or cost per acceptable result at comparable quality, subject to the user's data permissions. Provider selection lives outside the plugin contract. Workers AI bindings · Model catalog
8. State machines and transition ownership
Use two independent domain state machines, keyed by planning run and review revision. SQLite also tracks operational jobs, timers and leases. A review can remain open while new evidence changes the draft. The connector plan specifies a durable outbox for user-authorized calendar synchronization.

A. Planning run. The DO owns these transitions. An arrow names a durable state change. The planner may finish quietly at any evaluation where there is nothing actionable.
From	Event and guard	To and durable result
—	New source revision, changed preference, timer due, or committed event matches a subscription	Queued. Record event sequence and dirty keys. Batch until the next review window or earlier decision deadline.
Queued	Batch closes	Interpreting for new source inputs, otherwise Assessing. Pin the source revisions, accepted head and current draft tip, clock, and plugin installation versions.
Interpreting	Matching interpreters finish or exhaust their retry budgets	Assessing. Accept current validated claims and questions. Preserve explicit unknowns and record missing coverage.
Assessing	Affected plugins finish their live checks	Composing if a decision remains, otherwise Finished · quiet. Apply live timer requests by stable key.
Composing	Planner assembles alternatives and affected plugins assess simulated plans	Finished · published, delegated, or quiet. Publish one immutable review revision, apply an authorized subset through the same commit path, or record why no change is useful.
Any active phase	Relevant dependency changes or an install is disabled	Discard affected outputs and queue fresh work. Superseded closes a run whose basis is obsolete. Unaffected work can finish.
Any active phase	Required assessment unavailable at deadline	Mark affected groups incomplete and withhold recommendations that rely on them. Independent groups may finish. Record a recoverable failure if no useful group can proceed.


Composition considers the unchanged plan, merges duplicate operations, and keeps mutually dependent edits selectable as a group. Run at most a configured number of simulate-and-revise rounds. Deduplicate candidate fingerprints and stop on repetition. A simulated timer, claim, or patch cannot schedule a live event. New arrivals during a run advance the inbox watermark and remain eligible for the next run.

B. Review revision. One open review per user is the proposed v1 policy. It can contain independently selectable groups. An unrelated input leaves that review intact. A replacement review carries forward pending decisions that are still relevant.

Working draft and merge rules. Store an accepted head, an active draft tip, and immutable draft history. The plan's activity DAG describes prerequisites. Revision parent pointers separately describe how proposed plans evolved. Each run pins both heads. At publish time compare both again and recompose on the new tip if another run published first. Each edit names a stable occurrence ID, fields touched, supporting evidence, and dependencies on other edits. Acceptance uses the diff from accepted head to active tip.
Evidence relative to an existing draft edit	Merge rule
Same occurrence and same value	Combine corroborating evidence.
Different fields or occurrences	Compose edits, then revalidate any shared scheduling constraints.
Contradictory values from the same authority	Use the connector's meaningful source order, such as a monotonic event revision or reliable authored update time for the same occurrence. Retain both observations. Delivery time alone cannot determine which assertion supersedes the other.
Ambiguous identity, ordering, or authority	Give the decision model the two claims, accepted value, pending edit, and consequences. It can recommend a resolution with evidence or leave the field unresolved. Surface a single question only when the ambiguity affects a decision.


Example. Accepted v10 lists office hours H as running. The organizer cancels H, creating draft v11. Before approval, the organizer explicitly reinstates H. Build draft v12 with parent v11 and accepted base v10. Both inputs target H.status. If the reinstatement wins, the net status diff against v10 is empty. Reevaluate anything that used the newly freed time. Retire a proposed study block if it now conflicts, and carry forward unrelated edits. If the whole diff disappears, close the review quietly. Version 11 remains traceable as superseded; there is only one actionable draft tip. If the cancellation had already been accepted, reinstatement would instead be a meaningful edit against the newer accepted head.
From	Event	To and consequence
—	Stable, validated recommendation needs a decision	Open with review ID, revision, base plan, affected dependencies, exact internal edits, and expiry per group.
Open	Clarification or amendment	A clarification with no material change can leave it open. A changed recommendation supersedes the old revision and opens its successor.
Open	Explicit approval, precise amended instruction, or applicable standing grant	Validate scope, expiry, dependencies, feasibility, and authorization. Atomically record applied, accepted plan edits and decision receipt. A purely advisory acceptance can leave the plan version unchanged.
Open	Partial acceptance or a material conflict	Apply only explicitly authorized, independently feasible groups. Close the old revision and issue a successor for any residual decision. Material changes outside the instruction return for review.
Open	Dismissal, withdrawal, or deadline	Mark the corresponding group dismissed, superseded, or expired. Preserve previously applied decisions. Close or revise the remaining review.


The dialogue agent returns a typed decision against the revision the user actually saw. A stale reply can still apply after revalidation if the reviewed operations, consequences, and authority match. An expired or materially changed group needs a fresh decision. A repeated decision ID returns the original receipt. The agent cannot grant itself approval.
9. Plugin interface version 1
Plugins register a versioned manifest and implement the hooks they need. A manifest declares plugin ID, build digest, protocol version, owned JSON Schemas, imported types and supported major versions, input selectors, event subscriptions, requested read/model capabilities, and execution budgets. The installed manifest and granted capabilities are separate records. Installing a type makes it available for validation. Reading another plugin's values requires permission.

The wire contract below uses schema notation. IDs are opaque strings, instants use UTC, and calendar preferences retain their IANA timezone. Every hook invocation has a stable ID, attempt generation, installation epoch, protocol version, and deadline. The host supplies a scoped snapshot and an evaluation time.
interpret(input, context) -> {
  claims: ClaimDraft[], questions: Question[]
}
assess(trigger, planView, context) -> {
  findings: Finding[], alternatives: Proposal[],
  questions: Question[], timers: TimerIntent[], derivedClaims: ClaimDraft[]
}
Payload	Required semantics
Input	Source + item ID + source revision, observed/effective time when known, media type, content reference, provenance and audience. A correction points to the input or claim it corrects.
Context and planView	Scoped reads by entity/type/time range, authorized attachment reads, and budgeted model inference. The view is either the accepted plan or a candidate overlay identified by a hash. The host records reads and inherited restrictions.
ClaimDraft	Owned schema and version, stable occurrence or subject key, typed value or explicit unknown, supporting input references, and validity interval when applicable. Include bounds or confidence when the schema supports them.
Finding and Question	Stable key, subject, evidence, reason, decision window, and the decision affected. Questions carry a resolvable target so a later text reply can update the right entity. An empty output is valid.
Proposal	Stable effect key, target occurrence, fields read and written, typed DAG edits, prerequisites, alternatives, reason and expiry. The host supplies the accepted base and pending parent and verifies references.
TimerIntent	Plugin-owned key, upsert or cancel, due time, and payload schema. A recurring rule derives its next dated occurrence. Only accepted live assessment results may change the timer table.


Lifecycle hooks. Registration and routing are declarative. An image can reach several interpreters. A food estimate with a question can be stored while scheduling continues.
Lifecycle event	Hook	Where outputs take effect
Input accepted or corrected	Optional interpret for matching selectors	Host validates and stores owned claims, tracks evidence, and offers questions to the coordinator.
Claim or preference changed, plan committed, or timer fired	Optional assess in live mode for subscribed keys	The DO accepts findings, validated derived claims in the plugin’s namespace, proposals, and timer requests.
Candidate plan under consideration	The same assess in simulation mode	Findings influence candidate selection. All changes remain hypothetical, including returned timers.
Review published, clarified, accepted, or dismissed	Core transition	The host records the decision. Subsequent relevant plan or preference changes can trigger ordinary live assessment.


Adding domain concepts. A nutrition plugin might publish nutrition.meal@1 with a meal key, estimated protein range in grams, and evidence of consumption. A study plugin might publish study.assessment@1 and a relation connecting a study objective to an exam. The core stores schema-validated values and evidence under each namespace. Another plugin can import the type or request a narrow shared projection, such as a time window. A proposed study block uses the ordinary DAG node contract. Domain relations do not acquire scheduling semantics automatically.

Optional enrichment across plugins. A grocery plugin interprets a receipt into grocery.purchaseLine@1 with a stable line ID, item, quantity, units and paid amount when known. Nutrition subscribes to that type with permission and can emit nutrition.foodEstimate@1 linked to the same line, with a protein estimate, units, basis and uncertainty. Budgeting can independently emit a spending classification or an over-budget finding. An item query joins available annotations by subject ID. The grocery record remains useful with either plugin absent. Purchased quantity can inform availability. Consumption needs a separate observation. Cross-source meal matching stays in nutrition.

Only live assessment persists derived claims. The host validates ownership and provenance, upserts by producer/type/subject, and emits a change only when the semantic value or its effective evidence changes. Simulations keep derived values in their overlay. For v1, reject cycles among declared cross-plugin derived-type dependencies. On install, optionally backfill permitted current subjects; on access loss, exclude their derived projections from reads.

For example, a nutrition plugin could register this manifest. Hook names identify implementation entry points. Type selectors determine routing before any model runs.
{
  "id": "nutrition",
  "protocol": 1,
  "build": "nutrition-2026-11-22.1",
  "exports": ["nutrition.meal@1"],
  "imports": [],
  "interpret": {"media": ["image/jpeg", "image/png"], "handler": "interpretMeal"},
  "assess": {"events": ["claim.changed:nutrition.meal@1", "preference.changed:nutrition", "timer.due:self"], "handler": "assessDay"},
  "requests": ["input.attachment.read", "own.claims.read", "own.preferences.read", "model.vision"],
  "budget": {"modelCallsPerInvocation": 1}
}
The install registry resolves the build to an immutable digest and each exported type to its full JSON Schema. On a lunch photo, interpretMeal can return a meal occurrence keyed to that photo, an estimated range, and a question about consumption. On a later correction, the dialogue layer supplies the resolved meal reference and corrected fraction as a targeted input. Corrections to owned occurrences also route to the owning interpreter regardless of media selector. The host validates the returned claim against its registered schema. The next live assessDay can return a quiet finding, a snack option, or a follow-up. A study plugin uses the same contracts to propose moving an existing block, including the block ID, proposed interval, reason, and a decision deadline.

Arbitrary logic and lifecycle. Run arbitrary plugin algorithms outside the user DO. For independently supplied code, the proposed execution environment is a Dynamic Worker with globalOutbound: null and invocation-scoped host bindings. Give it scoped reads and model access in interpretation and assessment. Keep raw DO access, provider credentials, and source access in trusted platform Workers. Enforce per-invocation CPU/time, input/output size, and model budgets. Pin builds for in-flight invocations. On disable, increment the install epoch, revoke grants, cancel owned timers, and invalidate unapproved proposals. Previously accepted facts retain provenance and become unavailable to consumers if access is revoked. A new major schema version requires an explicit migration or a compatible reader. Dynamic Worker egress control · Scoped bindings
10. Persistence and recovery
SQLite records	Key or invariant
Inputs, domain claims, installs, grants	Unique source/item/revision plus an effective source head when ordering is available. Claims have an owner, occurrence key, schema version, revision, and supporting inputs.
Plan heads, nodes, edges, decision receipts	Stable node IDs, accepted head, immutable revisions with parent/base pointers, active draft tip, unique decision ID. Check DAG and scheduling constraints before commit.
Runs, invocation jobs, outputs	Pinned basis, hook/build, stable invocation ID, attempt/lease generation, deadline, immutable accepted result.
Reviews, groups and dispositions	Carry an unchanged group's identity across draft revisions. Consume an approved group with its plan edit and decision receipt in one transaction.
Scheduled work	Indexed due time, stable owner/key, generation and occurrence. Includes evaluation windows, plugin timers, retry times, and expired leases.


Worker handoff. Persist jobs before requesting execution. For v1 the alarm handler dispatches a bounded batch via Worker service bindings after the leasing transaction commits. The DO can process other commands while those calls await results. A Worker receives a scoped job and returns the result using the lease generation. In a short SQLite transaction the DO checks that generation, install epoch, read dependencies, and prior accepted result before installing the output and creating subsequent work. Repeat completions are harmless. Expired leases recover stalled jobs. Record the first accepted model result for replay because rerunning inference may produce a different answer. Avoid holding a transaction or user-wide concurrency lock across model or provider calls. SQLite storage API · Durable Object execution guidance

Freshness includes missing data. “Wednesday 1–2 is free” depends on the calendar range read, including an empty result. For v1, increment a per-collection generation on every change and track it alongside individual record versions. Recheck a changed collection before committing and preserve a review when the actual affected result is still equivalent. Per-range versions can later reduce redundant checks.

One alarm, many timers. A DO has one native alarm with at-least-once delivery. Keep all logical timers in SQLite. Use a short storage-only asynchronous transaction to insert or update due rows and set the native alarm to the earliest outstanding due time. In the alarm handler, claim a bounded batch, persist jobs and leases, and set the next wake in the same transaction. When the due table is empty, clear the alarm. SQLite storage operations inside the transaction share its commit boundary. Reserve synchronous transactions for changes that contain only synchronous operations. Treat overdue rows as eligible immediately. Use stable occurrence IDs so duplicate wakes produce one logical event. This also avoids depending on unlimited platform retries. Durable Object alarms
11. Implementation acceptance traces
1. Meal correction during inference. An image job estimates the contents of a plate. Before it returns, the user says “I ate half.” Preserve the visual estimate if its inputs still match. Recalculate consumption using the corrected fraction. A late assessment based on a whole plate cannot overwrite it.
2. New event during review. Publish a recommendation using an empty Wednesday slot. A calendar update occupies the slot before approval. The DO detects the changed dependency, preserves independent choices, and returns the affected move for amendment.
3. Pending cancellation reversed. With accepted v10 showing H as running, create cancellation draft v11 including a dependent study block. A newer organizer correction produces draft v12. Reassess the study block, preserve unrelated edits, and present only the net diff against v10. A late approval of v11 cannot cancel H.
4. Wake without input. A sleep plugin upserts one wind-down timer. A new class time moves its due time earlier. Simulating eight schedules creates no timers. Two deliveries of the real alarm produce one occurrence for the revised schedule.
5. Plugin failure or removal. Disable an interpreter while inference is pending, or exhaust its retry budget. A result from the old installation cannot become current. The coordinator can publish a fully evaluated, independent study change while recording the missing nutrition assessment.
Implement the DO command path and atomic review merge, persisted jobs and alarms, one interpretation/assessment plugin, then optional cross-plugin enrichment. Validate the pending-reversal and simultaneous-approval traces before adding more sources.
