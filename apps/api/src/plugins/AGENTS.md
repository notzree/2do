# Authoring a 2do task plugin

Start here when adding a built-in plugin to the planner. The smallest change is one module in this directory and one registration in `UserPlanner`. Nutrition is the shipped example. Its subtype attaches to a normal task and can coexist with other subtypes on the same task. [Meal implementation](./meal.ts) · [Runtime registration](../user-planner.ts)

For the design and acceptance scenarios behind stateful plugins, see the [implementation plan](../../../../docs/plugin-workflows.md). The [meal workflow](./meal-workflow.ts) is the working reference for guarded commands, async effects and daily metrics.

## Who owns what

| Interface or method | Responsibility |
| --- | --- |
| `TaskPlugin` | Groups a stable plugin ID, label, description, subtype definitions and optional metrics, facts or features. The compiled registry determines availability. Each user enables plugins in their own planner. |
| `TaskSubtypeDefinition<Data, View>` | The author supplies the subtype ID, label, version, Zod schema, valid initial data, classification rule and typed `view(task, data)`. Editor groups, prompts, icon, capture command, migrations and a workflow are optional. Put meaning here, including units, domain validation and pure calculations. |
| `PluginWorkflow.describe() / transition() / measure()` | Advertise currently available commands, decide the next private state, and project observations. The host validates commands, commits state, leases effects, and replaces metric observations in the caller's planner. |
| `MetricDefinition` and `PluginReports` | The plugin declares metric ID, version, label, unit and reducer. Core provides day/week/month buckets and effective-dated daily goal history. A second plugin publishing a metric appears in the same reports and goal editor. |
| `asTaskSubtype(details, definition)` | The typed read path. Checks ID, non-null data, exact schema version and successful parse before calling `view`. The view is computed in memory and has no persistence callback. |
| `TaskPlugins.installations() / setEnabled() / enabledTypes()` | Publish client-safe descriptors, change one planner's installation, and provide current definitions and installation epochs for background work. |
| `TaskPlugins.details() / write() / attachAtCapture()` | Read visible records, attach/replace/reject one subtype with revision checking, or attach its initial data in the notebook save. `store()` is a lower-level validated upsert. Its caller owns the concurrency checks. Use `write()` for user edits. |
| `TaskClassification.enqueue() / request() / processDue()` | Schedule work on create/rename, request a manual recheck, and claim and settle eligible work. The injected `TaskClassifier.classify(inputs, signal)` returns scores by task and subtype. Core applies the plugin's threshold. |
| `eligibleTaskPrompts() / TaskSummaries.read() / setSkipped()` | Compute hints from current task and subtype data, batch row chips/inlays/hints, and save skip/restore preferences. A prompt trigger describes the task's current completion flag. No callback runs when a hint appears. |
| `PluginFact / PluginFeature / PluginFactAccess` | Describe a versioned fact, a contextual action that consumes it, and the host's grants/readers. `featureActions()` discovers authorized actions. `runFeature()` reads, checks authorization again and filters by scope. Production registers Nutrition with no fact-access adapter or feature route. Test fixtures exercise this seam. |

The Zod wire types and author interfaces live in [interfaces/task-plugins.ts](../interfaces/task-plugins.ts). The host owns transactions, revisions and installation checks in [core/task-plugins.ts](../core/task-plugins.ts), job orchestration in [core/task-classification.ts](../core/task-classification.ts), and SQLite access in [db/task-plugins.ts](../db/task-plugins.ts). Hono handlers translate requests to core operations. React renders the public editor description. [Task routes](../routes/tasks.ts) · [Summary projection](../core/task-summaries.ts) · [Web editor](../../../web/client/task-subtypes.tsx)

## Add a subtype

1. Choose stable IDs. A plugin ID starts with a lowercase letter and uses lowercase letters, digits and hyphens, up to 64 characters. A subtype ID has exactly two such segments, `plugin-id.local-id`. Keep persisted subtype IDs and prompt IDs stable across label changes.
2. Write a strict schema and an initial value that parses. An automatic match writes that initial value. Make fields the user will answer later optional. Use `numberField()` or `textListField()` to derive the schema and editor descriptor together. Add optionality and domain refinements to the returned schema. Registration checks the field paths, field kinds, prompt references and classifier threshold. [Field builders](../interfaces/plugin-fields.ts) The two built-in field kinds are `number` and `text-list`. Editor groups support one level of nesting.
3. Declare the matching question and a probability threshold. Give examples on both sides of a plausible ambiguity. Set the prompt trigger to `task.open` for an incomplete task or `task.completed` for a completed one. Its `field` must match an editor path, such as `pagesRead` or `target.topics`. Choose `inlayLabel` when a saved value belongs on the notebook row.
4. Export the plugin and add it to the array passed to `new TaskPlugins(...)` in [user-planner.ts](../user-planner.ts). The settings list, inspector and slash catalog consume descriptors from the server. If enabled plugins share a shortcut or collide with a built-in, the client uses the qualified subtype ID. [Command resolution](../../../web/client/commands.ts)
5. Exercise it through the normal write and read paths below. A new plugin that fits the existing descriptor needs no new route, table, React switch or MCP tool. A new **field kind** changes the shared contract, field codec, renderer, inlay formatting and their tests. [Field codec](../../../web/client/subtype-fields.ts) · [Contract generation](../../../../scripts/openapi.mjs)

### Example module

Save this example alongside `meal.ts` as `reading.ts`, then register `readingPlugin`. The schema enforces whole pages even if a client sends a fractional number.

```ts
import { z } from "zod";
import type { TaskPlugin, TaskSubtypeDefinition } from "../interfaces/task-plugins.ts";
import { numberField } from "../interfaces/plugin-fields.ts";

const pages = numberField({ key: "pagesRead", label: "Pages read", inlayLabel: "Pages", min: 0 });
const readingData = z.strictObject({ pagesRead: pages.schema.int().optional() });
type Reading = { taskId: string; pagesRead: number | undefined };

export const readingSession: TaskSubtypeDefinition<z.infer<typeof readingData>, Reading> = {
  id: "reading.session",
  label: "Reading session",
  icon: "book",
  captureCommand: "read",
  schemaVersion: 1,
  schema: readingData,
  initialData: {},
  classification: {
    instructions: "Is the user planning or logging a reading session? Include reading a chapter. Exclude buying, borrowing or returning a book.",
    threshold: 0.9,
  },
  editor: [{ fields: [pages.field] }],
  prompts: [
    { id: "pages", field: "pagesRead", label: "How many pages did you read?", trigger: "task.completed" },
  ],
  view: (task, data) => ({ taskId: task.id, pagesRead: data.pagesRead }),
};

export const readingPlugin: TaskPlugin = {
  id: "reading",
  label: "Reading",
  description: "Track pages read in each session.",
  subtypes: [readingSession],
};
```

### Trace one write

1. Enable Reading under **Settings → Plugins** or send `PUT /api/task-plugins/reading` with `{"enabled":true}`. Capture `/read Chapter 2`. The notebook saves the task, reference and manual subtype together. Ordinary `/task Read chapter 2` can reach the same subtype via Clef if configured. Each eligible subtype gets its own decision.
2. Complete the task, then read `GET /api/tasks/{id}/details`. The active record contains `typeId`, `schemaVersion`, `source`, a UUID `revision` and `data`. If completion happened before the match arrived, the missing-pages hint still appears on the next summary read.
3. Send `PUT /api/tasks/{id}/subtypes/reading.session` with `{"revision":"<subtype UUID from details>","data":{"pagesRead":12}}`. This replaces the entire payload and marks it manual. Preserve other fields when editing one field. The returned record has a fresh revision. A stale revision gets HTTP 409. Reload before reconciling the edit.
4. Read the summary with `POST /api/tasks/summaries` and `{"ids":["<task UUID>"]}`. Expect the Reading chip, Pages inlay and no missing-pages hint. Saving zero also answers the prompt. Skipping an eligible hint persists a preference for this task and prompt ID. It leaves the data untouched.

## Add state, custom commands and metrics

1. Choose which values are public subtype fields and which decisions need private state. For meals, foods and a draft estimate are editable through the subtype endpoint. The confirmed day, accepted values and estimate provenance belong to the workflow. A manual `/meal` record can have empty data.
2. Add a `workflow` to the subtype with its own positive integer `version`, Zod `schema`, valid `initial` state and `commands`. Declare each command's local ID, label and fields. Supported kinds are `date`, `number`, `text` (with `maxLength`) and `image`. Use `required: true` for mandatory inputs. Core derives strict validation and the inspector form from these descriptors. Settings shows declared fields even for disabled plugins. [Workflow interface](../interfaces/plugin-workflows.ts) · [Reference commands](./meal-workflow.ts)
3. Implement `describe(current, state, pending, effects)`. Return a status, available command IDs and form defaults. Meal accepts a photo or portion note before a completed task has any listed foods. Its estimator combines supplied context with saved foods. Advertise an external action when its handler is registered. Run this function without writes.
4. Implement `transition(previous, current, state, event)`. Return the complete next `state` and an optional `effect: {id, input}`. Check domain invariants on the server. A `changed` event reconciles task/subtype edits. A `resumed` event can include task fields changed during suspension. A `command` event carries validated input. An `effect` event carries a result or failure. Keep this function synchronous. To perform external I/O, register a namespaced handler through `UserPlanner.createEffects()` and pass its abort signal to the provider. [Dispatch and retries](../core/plugin-workflows.ts) · [Storage](../db/plugin-workflows.ts)
5. Publish `metrics` on the plugin. An example is `{ id: "reading.pages", label: "Pages read", version: 1, unit: "pages", reducer: "sum" }`. Implement `measure(current, state)` to return the complete observation set for one task/subtype. Each row has a stable `sourceKey`, `metricId`, `metricVersion`, civil `day`, and numeric `value` or null. Emit zero for a known zero, null for missing coverage, and an empty array when this source should contribute nothing. Returning an updated day or value replaces the prior source contributions. [Report contract](../interfaces/plugin-reports.ts)
6. Read `GET /api/tasks/{id}/details` and select the matching entry in `workflows`. To invoke a command, send `POST /api/tasks/{id}/subtypes/{typeId}/actions/{actionId}` with `commandId` (a fresh UUID), the returned `installationEpoch`, `taskRevision`, `subtypeRevision`, nullable `workflowRevision` and `input`. For example, the Nutrition confirm input can be `{"day":"2026-11-24","proteinGrams":25}`. Reuse the complete request and command ID after a lost response. On HTTP 409, reload the current guards and revisions before issuing a new command.
7. Verify the projection with `GET /api/plugin-metrics/reading.pages/series?from=2026-11-01&to=2026-12-01&bucket=week&weekStart=1`. The end date is exclusive. Users set daily targets in **Settings → Goals**. Core compares the daily logged total to the effective target and exposes the counts through `GET /api/goals/{id}/history`. It keeps partial/empty days distinct from measured zero and uses the goal's zone to identify the current day. [Report routes](../routes/plugin-reports.ts)

## Invariants to test

For image input, declare e.g. `{ kind: "image", key: "photo", label: "Meal photo" }`. The inspector uploads on submit through `POST /api/images`; an API client can upload the same way or reuse a private image ID. Pass the returned ID as `input.photo`. Core verifies the image belongs to the current planner before committing the command. Keep the ID in effect input so retries can reopen the same immutable content. Inject the planner-scoped `PlannerImages` reader into the effect handler and call `dataUrl(id)` when a model needs the bytes. A text field can use `{ kind: "text", key: "note", label: "Portion details", maxLength: 2000 }`. The host trims text and validates its declared length. [Image storage](../db/planner-images.ts) · [Meal estimator](./meal-workflow.ts)

| Scenario | Expected outcome |
| --- | --- |
| First attach, edit, reject, restore | Use `revision: null` for an absent visible record. Use the current subtype revision for edits, rejection (`data: null`) and restoration. The rejected record stays in details. It blocks later automatic matches for that type. |
| Rename or disable while classification is in flight | Automatic entries are title-bound. Stale attempts and earlier installation epochs cannot apply results. Manual answers and rejections survive renames and disable/re-enable. Disabling hides records. Enabling does not scan every old task. |
| Two subtypes on one task | Editing or rejecting one leaves the other intact. Task, plan and subtype revisions have distinct purposes. Use the token from the record being edited. |
| Bump the data version | Typed views, field editors, prompts and inlays require the matching version. Supply `migrations[oldVersion]` for each consecutive upgrade. Version private workflow state and its migrations independently. The host upgrades older rows at planner startup. Test final schema validation, rotated revisions, preserved null rejections and unknown future versions. |
| A confirm or correction is retried | Identical replay returns its receipt. A changed payload using the same command ID conflicts. Updating a confirmed source moves its observation once and corrects the corresponding goal outcome. |
| An effect races a user edit | Late responses are fenced by lease, installation epoch, subtype and workflow revisions. Task deletion cascades its state. Disable/re-enable and recreate-the-same-ID scenarios must preserve the latest answer. |
| Notebook save is retried or rejected | A replay of the same accepted capture returns its receipt. Failed capture rolls back the task and subtype. Scope all reads/writes to the authenticated planner. |
| Use a peer fact | Require both installations, exact fact version, applicable scope, a grant and a reader. `runFeature()` rechecks scope and epochs after the await and deduplicates by record ID. A fact declaration alone supplies no records. |

Extend the nearest fixture with a real public-path scenario. Use a deterministic classifier for lifecycle tests. Use separate labeled examples to evaluate whether the matching question works with real inference. The repository's examples cover [classification races](../../test/classification-alarm.test.ts), [plugin HTTP behavior](../../test/task-plugins.test.ts), [fact access](../../test/plugin-capabilities.test.ts), [prompt summaries](../../test/task-summaries.test.ts), [atomic capture](../../test/notebook-capture.test.ts), [field declarations](../../test/plugin-fields.test.ts), [version upgrades](../../test/plugin-upgrades.test.ts), [goal coverage](../../test/plugin-reports.test.ts) and [editor behavior](../../../web/client/task-subtypes.test.tsx).

Run from the repository root.

```sh
npm test -w @2do/api -- --run test/task-plugins.test.ts test/plugin-capabilities.test.ts test/classification-alarm.test.ts test/task-summaries.test.ts test/notebook-capture.test.ts test/plugin-fields.test.ts test/plugin-upgrades.test.ts test/plugin-reports.test.ts
npm test -w @2do/web -- --run client/task-subtypes.test.tsx client/subtype-fields.test.ts client/commands.test.ts client/plugin-settings.test.tsx
```

If the HTTP contract changes, update the shared schemas and Hono route metadata, run `npm run openapi`, then `npm run openapi:check`. The generator writes the OpenAPI JSON, web client declarations and opted-in MCP catalog together. Plugin labels, classification instructions and thresholds are authored domain decisions.
