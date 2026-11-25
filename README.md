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

Local inference uses your Cloudflare account through the API Worker's remote `AI` binding. SQLite and R2 use local storage. From `apps/api`, run `npx wrangler whoami` to check which account the dev server can use. If you need to sign in, run `npx wrangler login` there and restart `npm run dev` from the repository root. Enable **Nutrition** under **Settings → Plugins**, then capture `/task Have dinner at Nuri Village`. A high-confidence Clef match adds the Meal chip while you keep typing. [Cloudflare local binding behavior](https://developers.cloudflare.com/workers/local-development/#remote-bindings)

Week is the default planner view. With the default bindings, `g w` opens Week, `g c` opens Month, and `g d` advances one day. Use `j` and `k` to focus tasks, `h` and `l` to fold and unfold subtasks, `o` to add a task, and `x` to toggle completion. Press `?` for your current shortcuts.

In Normal mode, `j` and `k` traverse text, embedded tasks, and scheduled rows across day boundaries. `/link task` places another reference to an existing task. Pressing `dd` on a task deletes that task by ID throughout the planner, including notebook links and graph embeds on other days. Separate tasks can share a title. On prose or a graph block, `dd` removes the selected notebook block and `u` restores it.

Type `/ta` in a day of Week and press Space, Tab, or Enter to complete `/task `. Use the arrow keys or Ctrl-n / Ctrl-p to choose another suggestion. Escape dismisses suggestions and keeps what you typed. Write the task and press Enter. The row appears immediately and the caret moves to the next paragraph while the page saves. Click a task title in Week or Month to open its inspector. Notebook captures show the original wording even after a title edit. Escape in the inspector returns focus to the planner.

`/note` switches the current block to a paragraph. Enabled plugins can also contribute capture commands. With Nutrition enabled, `/meal Bibimbap with friends` saves the task and your Meal selection together.

Open an existing task and choose **Classify task** or **Recheck types** to run Clef on demand. The inspector records when Clef checked and which enabled types matched. A completed check with zero matches appears in Activity. The Commands button or ⌘K / Ctrl+K opens notebook commands and task search.

Use `/agent` for the main chat and `/side` for a new side chat. Press Enter on the command to open its sidebar composer, or press Space, write your message inline, and press Enter to send. The first message names a side chat. Open the panel with `g a` and use its conversation selector to revisit a thread.

Open a task to edit its schedule, nest it under a parent, or add prerequisites. The Graph tab follows prerequisites from top to bottom across dates. A task's optional `parentId` controls its place in the outline. Deleting a parent promotes its direct children one level.

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

Task schedules support a floating calendar date, a fixed interval, a flexible window or an unscheduled task. Intervals use ISO timestamps with offsets and exclusive ends. The client projects them onto the viewer's local calendar. From an open fixed-time task, **Propose new time** sends a before/after diff to **Review**. Copilot can propose a move through the same inbox. Acceptance updates the schedule. Recent decisions offers Undo while the task remains at its accepted revision.

### Task plugins

Enable Nutrition under **Settings → Plugins**. Create or rename a task to classify it in the background, or add Meal manually in the inspector. A matching Week row shows a Meal chip. Complete the task to make the optional foods hint available. Expand the hint with the pointer or `e` on the selected task, then enter foods or skip the prompt. Saved foods appear on the row. The inspector can restore skipped hints.

Task subtypes are plugin-owned records attached to the same task ID. The API enables Nutrition with `PUT /api/task-plugins/nutrition` and `{"enabled":true}`. Read `GET /api/tasks/{id}/details` for subtype data and classification status. A Meal match starts with empty data. Use `PUT /api/tasks/{id}/subtypes/nutrition.meal` with its current `revision` and `{"foods":["Bibimbap"]}` in `data` to record what you ate. Use a null revision to attach a subtype for the first time, or null data to reject a subtype. The details response includes the revision of rejected entries so they can be reattached explicitly.

The planner accepts any implementation of `TaskClassifier`. The Workers AI adapter sends each eligible subtype’s matching rule directly to Clef as a yes/no question. Each request contains one task’s current capture text or title. Its eligible subtypes share the request, split into groups of up to 64 questions when necessary. `TASK_CLASSIFICATION_BATCH_SIZE` controls how many tasks one planner alarm can claim (default 8). Each task gets its own result and retry. Automatic matches are tied to the task title examined by the classifier. Re-enabling a plugin queues outdated matches for reclassification. Manual entries and rejections survive these changes.

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

Task, dependency, and day-page operations are enabled. To add a JSON planner operation to the agent, set `"x-mcp": true` on its Hono route definition in [routes](./apps/api/src/routes) and run `npm run openapi` to refresh the API document, browser types, and Worker tool catalog. CI checks all three for drift. The agent uses Flue’s MCP discovery inside the Worker and calls the planner selected by the authenticated conversation. It uses `searchTasks` for bounded lookups and receives the local date and IANA time zone with each message sent by the web client. Flue tracing excludes content, and Copilot requests disable AI Gateway log collection and caching. Account-level Logpush exports have separate controls.

For external stdio clients, run `npm run mcp:build` and restart the client connection. This regenerates both catalogs and replaces the build in `.generated/mcp`.

### Copilot evaluations

Run `npm run eval:copilot -w @2do/api` with Wrangler authenticated to a Workers AI account. The command starts the built Worker with temporary SQLite and R2 storage and uses live model calls for three cases: planning ideas without writes, clarification for duplicate titles, and a rename that gets a real 409 because another editor changed the schedule between the agent’s read and write. The tests check tool calls, a fresh read before the retry, and stored planner state. Append `-- --case conflict` to run only the concurrent edit. Use `npm run eval:copilot -w @2do/api -- --smoke` to check the built Worker, planner fixtures and conversation routing locally.

### Code layout

- `apps/api/src/interfaces/` contains runtime-neutral Zod schemas, derived TypeScript types, the graph read contract and the injected database interface. The web client imports the plan schemas through `@2do/api/plan`.
- `routes/` owns HTTP parsing, response mapping and the OpenAPI contract. `core/` owns graph operations and transaction boundaries. `agents/` holds the Flue agent, mounted from `src/app.ts` behind the Access check.
- `db/` contains the SQLite schema and task repositories. `user-planner.ts` connects the repository, planner and routes inside each object. `plugins/` contains plugin definitions, including Nutrition.

## Access and deployment

Use a hostname in a Cloudflare-managed zone and an existing Zero Trust team with a sign-in method configured. Apply [the Access configuration](./infra/access/main.tf) first. It provisions one reusable email allow policy and one self-hosted application covering `/app`, `/api` and their children. The landing page at `/` stays public. Both Workers disable workers.dev and preview URLs.

Set `CLOUDFLARE_API_TOKEN` for Terraform to an account-scoped token that can manage Access apps and policies. Supply your account ID, planner hostname and allowed email addresses using the Terraform variables `account_id`, `hostname` and `allowed_emails`. Keep the state in persistent private storage.

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

To verify a live deployment, open the root in a signed-out browser, sign in, add a task, and check it in all three planner views. A second allowed account should see its own empty plan.

```sh
npm run openapi:check
npm run typecheck
npm test
npm run build
```
