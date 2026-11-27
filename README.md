# 2do

A personal planner built around the accepted task graph in [plan.md](./plan.md). A public React Worker serves the landing page, weekly notebook with a focused-day mode, and monthly calendar. Its service binding forwards same-origin API requests to a private Hono Worker. The API verifies the Cloudflare Access assertion and selects one SQLite-backed Durable Object per verified issuer and subject.

The agent panel opens on a durable main chat. Each side chat has its own Flue conversation and shares access to the same user's planner tools. Flue stores history in its conversation Durable Objects and automatically compacts older model context. The planner stores the side-chat directory in SQLite.

## Run locally

Use Node 24 from `.nvmrc`.

```sh
nvm install
npm ci
npm run dev
```

Open http://localhost:5173 and select **Sign in**. The development build uses one local planner on loopback hosts. Production builds require a valid Access JWT. Local state persists between dev-server restarts. The API dev server reads `apps/api/.dev.vars`; copy `apps/api/.dev.vars.example` there once to enable the shared local planner.

Local inference uses your Cloudflare account through the API Worker's remote `AI` binding. SQLite and R2 use local storage. From `apps/api`, run `npx wrangler whoami` to check which account the dev server can use. If you need to sign in, run `npx wrangler login` there and restart `npm run dev` from the repository root. Enable **Nutrition** under **Settings → Plugins**, then capture `/task Have dinner at Nuri Village`. A winning Clef match adds the Meal chip while you keep typing. [Cloudflare local binding behavior](https://developers.cloudflare.com/workers/local-development/#remote-bindings)

Week is the default planner view. With the default bindings, `g w` opens Week, `g c` opens Month, and `g d` advances one day. Use `j` and `k` to focus tasks, `h` and `l` to fold and unfold subtasks, `o` to add a task, and `x` to toggle completion. Press `?` for your current shortcuts.

In Normal mode, `j` and `k` traverse text, embedded tasks, and scheduled rows across day boundaries. `/link task` places another reference to an existing task. Pressing `dd` on a task deletes that task by ID throughout the planner, including notebook links and graph embeds on other days. Separate tasks can share a title. On prose or a graph block, `dd` removes the selected notebook block and `u` restores it.

Type `/ta` in a day of Week and press Space, Tab, or Enter to complete `/task `. Use the arrow keys or Ctrl-n / Ctrl-p to choose another suggestion. Escape dismisses suggestions and keeps what you typed. Write the task and press Enter. The row appears immediately and the caret moves to the next paragraph while the page saves. Click a Week task title to rename it in place. With Vim shortcuts enabled, use `i` or `Shift+I` to edit from the start of a task title and `a` or `Shift+A` to append. Enter saves the title and Escape cancels. In prose, `Shift+I` starts at the first nonblank character and `Shift+A` appends at the end of the block. Use `Ctrl+]` on a focused task in Week or Month to open its inspector. Notebook captures show the original wording even after a title edit. Escape in the inspector returns focus to the planner.

`/note` switches the current block to a paragraph. Enabled plugins can also contribute capture commands. With Nutrition enabled, `/meal Bibimbap with friends` saves the task and your Meal selection together.

Open an existing task and choose **Classify task** or **Recheck types** to run Clef on demand. The inspector records when Clef checked and which enabled types matched. A completed check with zero matches appears in Activity. The Commands button or ⌘K / Ctrl+K opens notebook commands and task search.

Use `/agent` for the main chat and `/side` for a new side chat. Press Enter on the command to open its sidebar composer, or press Space, write your message inline, and press Enter to send. The first message names a side chat. Press `g a` or choose **Agents** in the notebook sidebar to open the Agents workspace. Press `g q` or choose **Quick chat** to open the current conversation beside the notebook.

Open a task to edit its schedule, nest it under a parent, or add prerequisites. The Graph tab follows prerequisites from top to bottom across dates. A task's optional `parentId` controls its place in the outline. Deleting a parent promotes its direct children one level.

## Google connectors

Open **Settings → Connections** to install read-only Gmail intake, choose Google Calendar sync directions, or import Fitbit Air workouts into Fitness goals through Google Health. Publish individual scheduled events from their inspector. [OAuth, webhook setup and sync behavior](docs/google-connectors.md)

## Planner API

The [OpenAPI 3.1 specification](./apps/api/openapi.json) is ready for client generation. The running Worker serves the same document at `GET /api/openapi.json`. Run `npm run openapi` after changing a contract. CI checks for drift.

| Operation | Endpoint |
| --- | --- |
| Read the accepted plan, including revision, tasks in topological order, and direct edges | `GET /api/tasks` |
| Search tasks by title, completion, calendar day or overlapping interval, with cursor pagination | `POST /api/tasks/search` |
| Create a task, event or milestone | `POST /api/tasks` |
| Read, patch or delete a task | `GET / PATCH / DELETE /api/tasks/{id}` |
| Traverse all prerequisites or dependents | `GET /api/tasks/{id}/traverse/{ancestors\|descendants}` |
| Add or remove a direct prerequisite | `PUT / DELETE /api/dependencies/{from}/{to}` |
| Check the API | `GET /api/health` |

Task PATCH requests require the task’s current `revision` plus the fields to change. A stale revision returns 409. Read the task again and compare the fields you intend to change before retrying. A day-page save also checks its revision. Retrying the same document and embedded task commands after a lost response returns the saved page. Changing the embedded tasks on that retry returns 409.

Flue accepts messages at `POST /api/agents/copilot/me` for the main chat and `POST /api/agents/copilot/{id}` for a registered side chat. Both return a `202` receipt and support reading history or following the updates stream. The authenticated planner exposes `GET /api/chats` and idempotent `PUT /api/chats/{id}` for the side-chat directory.

Planner tables are defined in `apps/api/src/db/schema.ts`. After editing the schema, run `npm run db:generate -w @2do/api` and commit the changes under `apps/api/drizzle/`, including the SQL, snapshots, journal and generated `migrations.js` manifest. Review the generated SQL against a populated database before committing. CI runs generation again to catch drift. Add a forward migration for a released schema change. Each planner applies pending migrations before serving requests. The initial migration expects an empty planner database. It creates the current tables, indexes and initial revision in one transaction.

For an existing lunch event, submit a task like this to `POST /api/tasks`. Replace the example anchor with the event ID.

```json
{
  "title": "Prepare lunch",
  "durationMinutes": 20,
  "placement": { "side": "before", "anchor": "b8c58fd3-6aa1-4a98-bfec-dafec4419d0b" }
}
```

An edge `A → B` means A must finish before B can start. Inserting X **before** B moves every immediate incoming edge to X and adds `X → B`. Inserting X **after** A moves every immediate outgoing edge to X and adds `A → X`. Use the dependency endpoint to add a single constraint while preserving the other edges. An attempted cycle returns 409. A missing anchor returns 404. Failed edits roll back the task, edges and revision together. Deleting a task removes its incident edges. Repeating an edge addition or removal preserves the revision.

Task schedules support a floating calendar date, a fixed interval, a flexible window or an unscheduled task. Intervals use ISO timestamps with offsets and exclusive ends. The client projects them onto the viewer's local calendar. From an open fixed-time task, **Propose new time** sends a before/after diff to **Agent Inbox**. Copilot can propose a move through the same inbox. Acceptance updates the schedule. Recent decisions offers Undo while the task remains at its accepted revision.

### Task plugins

To build a plugin, follow the [agent authoring guide](apps/api/src/plugins/AGENTS.md). The [workflow design](docs/plugin-workflows.md) explains state transitions, period reports and daily goals.

Open **Settings → Plugins** to inspect a plugin's types, fields, commands and metrics before enabling it. With Nutrition enabled, capture a meal and complete it. In the task inspector, **Estimate nutrients** accepts a meal photo, a note such as “I ate half this bowl,” or both. It also uses any saved foods. The photo goes to the vision model when you submit the estimate. Review the suggested values and choose **Confirm meal** to record the consumption day and nutrients. You can also enter foods and confirm values manually. **Correct meal** updates an existing entry. Reopening the task or changing its foods retracts the logged totals until you confirm again.

Set the reporting time zone and create a target in **Settings → Goals**. Open the month calendar's **Reports** view for daily, weekly and monthly totals and goal outcomes. A missing nutrient contributes unknown coverage. An explicitly logged zero counts as a measured value.

### Goals and task plugins

Capture `/goal Feel ready for interviews` in the notebook or choose **Goals → New goal**. Add a target date or next check-in when useful. A goal can link to several tasks and a task can support several goals. **Contributes** records work toward the goal. **Completes goal** makes the goal satisfied while that task is complete. You can also mark a goal achieved manually. Opening a notebook goal or the Goals panel shows links and dated check-in notes.

Enable the plugins you want under **Settings → Plugins**.

| Plugin | Capture | Logging and goal rules |
| --- | --- | --- |
| Fitness | `/activity`, `/workout`, `/cardio`, `/sport` | Record actual activity, minutes and optional distance. Track sessions per Monday–Sunday week or a distance and time reached on one run. |
| Budgeting | `/expense` | Confirm the amount, currency and payment date. Set a monthly spending-limit goal in CAD, USD, EUR, GBP or JPY. Corrections replace the original payment. |
| Productivity | `/work`, `/deadline` | Record focus minutes and weekly sessions. Deliverables use the task completion checkbox and a separate optional due date or instant. |
| Nutrition | `/meal` | Confirm meal intake and track existing daily metric targets. |

For example, `Draft proposal Thursday 2–3pm, due Friday 5pm` can have a scheduled work block and a distinct due marker. `/deadline Submit Lab 3 Friday` creates a date-only deadline. Use the task inspector to edit the due date or optional local time. Confirmed session and payment logs support corrections and removal, independently of planned duration or price.

Core goals are available at `/api/planner-goals`. The existing `/api/goals` daily metric API retains its target history and maps each target to the same core goal ID. Use `npm run eval:plugins -w @2do/api` to run the labeled synthetic Clef evaluation with the Cloudflare CLI.

Enable Nutrition under **Settings → Plugins**. Create or rename a task to classify it in the background, or add Meal manually in the inspector. A matching Week row shows a Meal chip. Complete the task to make the optional foods hint available. Expand the hint with the pointer or `e` on the selected task, then enter foods or skip the prompt. Saved foods appear on the row. The inspector can restore skipped hints.

Task subtypes are plugin-owned records attached to the same task ID. The API enables Nutrition with `PUT /api/task-plugins/nutrition` and `{"enabled":true}`. Read `GET /api/tasks/{id}/details` for subtype data and classification status. A Meal match starts with empty data. Use `PUT /api/tasks/{id}/subtypes/nutrition.meal` with its current `revision` and `{"foods":["Bibimbap"]}` in `data` to record what you ate. Use a null revision to attach a subtype for the first time, or null data to reject a subtype. The details response includes the revision of rejected entries so they can be reattached explicitly.

Task creation asks Workers AI Clairic for typed dates, clock times, deadlines, and durations from the title or full notebook capture. Saving continues without inferred fields if the model is unavailable. For example, `/task Dinner at 7pm for 45 minutes: salmon and rice` starts at 7pm on the notebook day in the capture timezone. A date such as “tomorrow” uses the local capture date. A start time alone gets a one-hour calendar block and leaves the duration field empty. Explicit task fields take priority. A rename can fill a missing duration or add a clock time to an unscheduled or all-day task. The original wording stays intact.

Once a subtype wins, a separate durable job uses Clairic to fill the subtype’s opted-in fields. With `/meal`, the planner extracts the task’s date, time, and duration during the save, attaches Meal as the chosen subtype, and queues food extraction. Both `/task` and explicit plugin commands also run Clef against every subtype from every enabled plugin, including the one chosen at capture. Meal extracts named foods, leaving nutrient estimation and confirmation in the existing workflow. The inspector and notebook summaries refresh while extraction is pending.

The planner accepts any implementation of `TaskClassifier`. The Workers AI adapter sends each eligible subtype’s matching rule directly to Clef as a yes/no question. Each request contains one task’s current capture text or title. Its eligible subtypes share the request, split into groups of up to 64 questions when necessary. `TASK_CLASSIFICATION_BATCH_SIZE` controls how many tasks one planner alarm can claim (default 8). The highest-scoring eligible subtype wins if its score is strictly above 0.5. Equal scores use plugin and subtype registration order. Each task gets its own result and retry. Automatic matches are tied to the task title examined by the classifier. Re-enabling a plugin rechecks outdated or competing automatic matches. Manual entries and rejections survive these changes.

Run `npm run eval:meal -w @2do/api` with an authenticated `cf` CLI to score 24 synthetic meal and errand entries using the production prompt and adapter. The report lists each probability, missed meals and false positives at the plugin’s cutoff.

### Local MCP server

Run `npm run mcp:build` from the repo root to generate and compile the stdio server. Keep `npm run dev` running with the local planner enabled as described above. Add the following entry to your MCP client, replacing the placeholder with your absolute checkout path.

```json
{
  "mcpServers": {
    "2do": {
      "command": "node",
      "args": ["/absolute/path/to/2do/.generated/mcp/build/index.js"],
      "env": {
        "API_BASE_URL": "http://127.0.0.1:5174",
        "MCP_ALLOW_MISSING_CREDENTIALS": "true"
      }
    }
  }
}
```

The loopback API accepts requests without an Access cookie when `LOCAL_PLANNER=enabled`. The client setting above lets the generated server make those requests. Call `listTasks` to read the same plan as the local UI.

Planner reads, reviewed planner changes, reminders, inbox interactions and selected Google operations are enabled. To add a JSON planner operation to the agent, set `"x-mcp": true` on its Hono route definition in [routes](./apps/api/src/routes) and register the effects of a mutation in the agent approval policy. Run `npm run openapi` to refresh the API document, browser types, and Worker tool catalog. CI checks all three for drift. The agent uses Flue’s MCP discovery inside the Worker and calls the planner selected by the authenticated conversation. It uses `searchTasks` for bounded lookups and receives the local date and IANA time zone with each message sent by the web client. Flue tracing excludes content, and Copilot requests disable AI Gateway log collection and caching. Account-level Logpush exports have separate controls.

For external stdio clients, run `npm run mcp:build` and restart the client connection. This regenerates both catalogs and replaces the build in `.generated/mcp`.

### Agent Inbox and reminders

Ordinary todos captured in chat go on the local day of the request. Ask for a different day or the backlog to override the default. When scheduling a timed event, Copilot asks for a missing start time.

Open **Agents** for Main chat, Needs attention, All activity, side chats and archived objectives. Every fresh chat can search active workspace proposals and link an existing decision by ID. Open a queue row to review its saved diff or answer its question. The record survives its originating chat. Use **Continue in side chat** to branch from a Main exchange, **@** to reference other conversations for a turn, and **Report back to Main** in conversation settings to publish a milestone. Use **Settings → Agent** for approval rules, reminder schedules and device notifications.

The planner alarm handles time-based reminders even with no open browser. Web Push requires `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY` and `WEB_PUSH_SUBJECT` on the API Worker, plus a browser subscription. The application can still deliver in-app notices with push disabled. Calendar and Gmail setup is documented in the [connector guide](docs/google-connectors.md). The [implementation plan](docs/agent-overhaul.md) records file ownership, integration order and release scenarios.

### Copilot evaluations

Run `npm run eval:copilot -w @2do/api` with Wrangler authenticated to a Workers AI account. The command starts the built Worker with temporary SQLite and R2 storage and uses live model calls for three cases: planning ideas without writes, clarification for duplicate titles, and a rename that gets a real 409 because another editor changed the schedule between the agent’s read and write. The tests check tool calls, a fresh read before the retry, and stored planner state. Append `-- --case conflict` to run only the concurrent edit. Use `npm run eval:copilot -w @2do/api -- --smoke` to check the built Worker, planner fixtures and conversation routing locally.

### Code layout

- `apps/api/src/interfaces/` contains runtime-neutral Zod schemas, derived TypeScript types, the graph read contract and the injected database interface. The web client imports the plan schemas through `@2do/api/plan`.
- `routes/` owns HTTP parsing, response mapping and the OpenAPI contract. `core/` owns graph operations and transaction boundaries. `agents/` holds the Flue agent, mounted from `src/app.ts` behind the Access check.
- `db/` contains the SQLite schema and task repositories. `user-planner.ts` connects the repository, planner and routes inside each object. `plugins/` contains plugin definitions, including Nutrition.

## Access and deployment

Use a hostname in a Cloudflare-managed zone and enable [One-time PIN](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/) in the Zero Trust team. Anyone who verifies their email can open their own planner on first sign-in. Apply [the Access configuration](./infra/access/main.tf) first. It protects `/app`, `/api` and their children with a reusable Allow policy for the selected login methods. The landing page at `/` stays public. Both Workers disable workers.dev and preview URLs.

For Google sign-in, create a web OAuth client for the planner in Google Auth Platform. Use the Zero Trust team origin as its authorized JavaScript origin and `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` as its redirect URI. Enter the client ID and secret in the team's Google identity provider. [Cloudflare setup guide](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/)

Set `CLOUDFLARE_API_TOKEN` for Terraform to an account-scoped token that can manage Access apps and policies. Supply `account_id`, `hostname` and `login_method_ids`. Set `login_method_ids` to the Google and One-time PIN Access provider IDs. This list controls both the choices on the login page and the methods the planner accepts. Keep the state in persistent private storage.

```sh
terraform -chdir=infra/access init
terraform -chdir=infra/access plan -out=access.plan
terraform -chdir=infra/access apply access.plan
terraform -chdir=infra/access output -raw access_aud
```

Configure the GitHub **production** environment for [the Workers workflow](./.github/workflows/workers.yml).

| Setting | Value |
| --- | --- |
| Variable `CLOUDFLARE_ACCOUNT_ID` | Account that owns the Workers and Access application |
| Variable `PLANNER_HOSTNAME` | The same hostname used by Terraform |
| Variable `ACCESS_ISSUER` | Your team origin, e.g. `https://my-team.cloudflareaccess.com`, without a trailing slash |
| Variable `ACCESS_AUD` | Terraform's `access_aud` output |
| Secret `CLOUDFLARE_API_TOKEN` | Deployment token with Worker script edit and the zone permissions for attaching the custom domain |

The API deploys through Wrangler, which takes the Access values from the `ACCESS_ISSUER` and `ACCESS_AUD` environment variables (`wrangler deploy --var …`, see the `deploy` script in `apps/api/package.json`). Wrangler tracks Durable Object class migrations separately from Drizzle’s per-planner SQL history. Preserve deployed class tags and their order. Before the first Wrangler rollout of a previously deployed Worker, verify the source history against the tags already deployed through `cf`. Append new class migrations after that history.

Pull requests run contract checks, type checks, tests, both builds and Terraform validation. After a merge or direct push to `main` passes those checks, the workflow deploys `2do-api` with the Flue agent Durable Object, then `2do-web` with the React/Vite assets and API service binding. The agent uses the Worker's AI binding for inference. The API also binds the `2do-notebook-images` R2 bucket.

Both jobs use GitHub-hosted Ubuntu while this repository is personally owned. For an organization-owned repository they use `blacksmith-2vcpu-ubuntu-2404`. Enable the repository in the organization's [Blacksmith GitHub integration](https://docs.blacksmith.sh/introduction/quickstart) before running the workflow there.

To verify a live deployment, open the root in a signed-out browser, sign in, add a task, and check it in all three planner views. In a separate browser session, sign in by email PIN with a new address and verify that its planner starts empty.

```sh
npm run openapi:check
npm run typecheck
npm test
npm run build
```
