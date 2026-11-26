# Fitness, Budgeting, and Productivity plugin scope

First-release design for 2do. See the [current capture commands and goal rules](../README.md#goals-and-task-plugins) for the implemented behavior. Ship three independently enabled plugins and four primary capture commands. Fitness answers “what training did I actually do?”, Budgeting answers “what did I spend and how much is left this month?”, and Productivity answers “when will I work on this and when must it be finished?”

| Plugin | Subtype | Command | Example |
| --- | --- | --- | --- |
| Fitness | `fitness.activity` | `/activity` | Run 5 km tomorrow at 7am for 30 minutes |
| Budgeting | `budgeting.expense` | `/expense` | Paid CAD 18.50 for lunch at Nuri |
| Productivity | `productivity.work-session` | `/work` | Spend 45 minutes outlining the ECE 356 report |
| Productivity | `productivity.deadline` | `/deadline` | Send the client proposal by Friday at 5pm |

## Fitness

Use one `fitness.activity` subtype for v1. Strength sessions, runs, and sports practice all use the same sequence: schedule the session, log what happened, then correct the log if needed. “Basketball for 45 minutes” could reasonably score highly for workout, cardio, and sport. Give Clef one participation question. In the second pass extract an activity name such as “basketball” and an optional, editable `activityKind` from `strength`, `cardio`, `sport`, `mobility`, `mixed`, or `other`. Leave the kind unset when the title is just “workout”. A named sport can default to sport, and a title that explicitly combines kinds can use mixed. The user can change the kind without losing the log or changing subtype identity.

Use `/activity` as the primary shortcut. If direct shortcuts are wanted, let `/cardio` and `/sport` create the same subtype with an explicit kind, and let `/workout` open it without a preset. The command catalog currently supports one capture command per subtype. Aliases would need a command descriptor carrying preset data, validation on capture, and a rule that extraction fills only missing fields. Keep those aliases optional for the first release.

Show the activity and planned distance on the row when supplied. **Log activity** opens a short form for the activity date, actual minutes, and optional actual distance. Reports count logged sessions, active minutes, and distance in a canonical unit. Revisit a separate Fitness subtype when a distinct record and workflow earn it, such as logging successive sets with reps and load, or recording a match score and opponent.

**Acceptance.** “Play basketball Friday for 45 minutes” creates one Activity with kind sport. “Watch basketball Friday” does not qualify. “Lift then run” creates one mixed session. Logging a planned 5 km run as 4 km and correcting it to 4.2 km leaves one session and 4.2 km in the report. Changing the kind preserves the recorded date, minutes, and distance.

## Budgeting

Use one Expense subtype for a planned purchase and its eventual payment. Extract the stated amount, currency, and merchant when present. Let the user choose a category or keep it uncategorized. A price ceiling in “find shoes under $100” must not prefill a paid amount. “Lunch with Sam” alone gives Budgeting no evidence of spending.

**Record payment** confirms the paid amount, currency, and transaction date. Store amounts as integer minor units with a currency code. For v1 use one user-selected budget currency. A bare dollar sign can default to that currency when appropriate. Show the currency in the confirmation form. Keep a foreign-currency payment in its own currency and exclude it from the budget-currency total. A task completion, estimate, or repeated confirmation cannot create a second payment.

Ship a **monthly spending limit** with the expense log so the plugin answers an actual budgeting question. Store the limit by planner, calendar month, and currency. Show limit, confirmed spend, and remaining amount, including negative remaining balances. Month boundaries use the reporting timezone and transaction date. Start with one overall limit. Category-level limits, subscriptions, split transactions, receipt scanning, and bank imports can follow.

**Acceptance.** Set a CAD 300 monthly limit. Plan a CAD 75 purchase, then record CAD 62.40 paid. Remaining goes from CAD 300 to CAD 237.60. Correct the payment to CAD 60 and remaining becomes CAD 240. Moving its transaction date into the next month updates both months.

## Productivity

Use the same vocabulary for school and work. An optional free-text project or course label such as “ECE 356” or “Client onboarding” supplies context without requiring an up-front taxonomy.

**Work session** means time spent doing focused work. “Review indexing for 45 minutes” and “Draft the release notes from 2–3pm” qualify. “Email Alex” can stay an ordinary task. Extract the shared schedule and planned duration, plus an explicitly named project or course. Reuse the task title for the activity itself. **Log session** confirms the date and actual minutes. Report logged focus minutes and session count. An optional completion prompt can ask how long the session took. Start with manual logging; a live timer can follow.

**Deliverable deadline** represents an outcome with a due date, optionally a time. “Submit Lab 3 by Friday at 5pm” and “Send the proposal by Friday” qualify. Keep the deliverable in the title. The row shows the due date and, if supplied, the local time. Use the task’s existing completion control. Move the deadline by editing the due field. A date-only deadline becomes overdue on the following local day. A timed deadline becomes overdue after its instant. For an explicit `/deadline` with no identifiable date, ask for the missing date in the inspector.

Use existing parent-child tasks to connect work to delivery. For example, “Submit Lab 3 by Friday 5pm” can have separate “Draft results Thursday 2–3pm” and “Proofread Friday 10am” work sessions. Completing a session records progress independently of submitting the deliverable. A single task can also carry both a scheduled block and a due date when its title gives both.

### What a deadline completes

For `/deadline Submit Lab 3 by Friday 5pm`, the outcome is “Lab 3 submitted.” The task owns the title and completion checkbox; its shared `due` field owns the deadline. Child work sessions can contribute toward the outcome. Finishing the last session leaves submission open until the user marks the deliverable complete. With a shared due field, a task can carry a deadline even when another subtype wins classification.

The existing Goals feature evaluates a numeric metric for each reporting day, with comparators such as “at least” and effective-dated target changes. It fits “at least 30 active minutes a day.” A monthly spending cap needs a month-long period, and a submission needs a one-time completion decision. Ship the deliverable using the existing task lifecycle. If a later feature needs “Finish the semester project” to track several independently delivered outcomes, scope an objective with linked deliverables and an explicit completion rule. The first deadline release has no dependency on that broader goal model.

**Acceptance.** Capture “Draft the proposal Thursday 2–3pm, due Friday 5pm.” Week shows one Thursday work block and a Friday due marker for the same task ID. Moving the block preserves the deadline. “Proposal due Friday” shows a date-only marker and allocates zero calendar time. Logging 40 minutes against the planned hour records 40 minutes in reports.

## Implementation order

1. **Shared task deadline.** Add nullable `due` to `interfaces/plan.ts` with date-only and timed variants. Preserve the civil date or the timed instant and its display timezone. Read older task documents with a null default. Extend `extractors/task-time.ts` to identify due phrases and parse the remaining scheduling phrase independently. Use the capture date, notebook day, timezone, and existing DST handling. The current parser skips deadline phrases and returns early on multiple time expressions. Define how the explicit deadline command interprets an unqualified date as due. Expose edits through the existing task API and inspector. Include due-only tasks in date queries and display compact Week/Month markers without duplicating task records or exporting markers as fixed events.
2. **Shared field and extraction support.** The subtype editor and Clairic adapter currently handle numbers and text lists. Add scalar text end-to-end for merchant and project. Support an optional validated choice in the subtype schema, editor, and extractor for activity kind. Validate category and currency selections in Budgeting. Add a choice control where a finite list is needed. Reuse `interfaces/plugin-fields.ts`, `extractors/clairic.ts`, the shared field codec, and the inspector renderer. Parse explicit money and distance with units before storing canonical values. A plugin can reuse an extracted task duration without asking the model to extract it again.
3. **Activity and Work Session.** Add subtype definitions and workflow modules under `apps/api/src/plugins/` and register the plugins in `user-planner.ts`. Use the existing revision-checked workflow commands, civil-day observations, and sum reports. Keep planned values on the task or editable subtype and confirmed actuals in workflow state. Add `productivity.deadline` once the shared due field is available. Start with the shared inspector and reports.
4. **Expense and monthly budget.** Add the Budgeting plugin, payment workflow, currency-aware aggregation, and a small period-limit store and Settings editor. The reports already aggregate by month, but the goal evaluator currently targets individual days. Model the monthly allowance explicitly. Test correction, replay, foreign currency, and month rollover through the public API.
5. **Cross-plugin evaluation before enabling the release.** Keep one Clef question per enabled subtype and the existing single automatic winner strictly above 0.5. Automatic matching uses the winning subtype’s extraction; explicit capture also runs its selected subtype’s extraction. Manual choices and rejections survive rechecks. Run live synthetic titles with Nutrition and all three proposed plugins together, each plugin alone, and the best candidate disabled. Record per-subtype misses, false positives, wrong winners, and incorrect extracted fields. Evaluate date, timezone, currency, and units independently of getting the subtype right. Regenerate the OpenAPI and web contracts and exercise capture, inspector edits, reports, and reload in the running app.

| Synthetic input | Expected behavior with all plugins enabled |
| --- | --- |
| “Paid CAD 18.50 for lunch” | Expense is the intended winner. Confirming it records one payment. |
| “Lunch with Alex at noon” | Meal is the intended winner. The task starts at noon. |
| “Buy running shoes” | No Activity match. A planned Expense may match; confirmed spending stays zero. |
| “Study training data for 45 minutes” | Work Session is the intended winner. |
| “Submit the fitness report by Monday” | Deadline is the intended winner; the subject alone cannot establish a workout. |
| “Pick up the keys” | Ordinary task. No plugin should clear the threshold. |
| “Work on Lab 3 Thursday at 2pm, due Friday at 5pm” | One automatic subtype. Both task-level time facts are preserved regardless of the winner. |
