# 2do

A personal planner built around the accepted task graph in [plan.md](./plan.md). A public React Worker serves the landing page, day agenda, rolling seven-day agenda and monthly calendar. Its service binding forwards same-origin API requests to a private Hono Worker. The API verifies the Cloudflare Access assertion and selects one SQLite-backed Durable Object per verified issuer and subject.

A Flue Copilot agent shares the same API Worker: one durable conversation per verified account, mounted at `/api/agents/copilot`, keyless through a Workers AI binding. The chatbar in the planner streams its replies; the agent discovers its tools through a private MCP connection to the same per-user planner object.

## Run locally

Use Node 24 from `.nvmrc`.

```sh
nvm install
npm ci
npm run dev
```

Open http://localhost:5173 and select **Sign in**. The development build uses one local planner on loopback hosts. Production builds require a valid Access JWT. Local state persists between dev-server restarts. The API dev server reads `apps/api/.dev.vars`; copy `apps/api/.dev.vars.example` there once to enable the shared local planner.

In the planner, press `?` for Vim shortcuts. Use `j` and `k` to focus tasks, `h` and `l` to fold and unfold subtasks, `o` to add a task, and `x` to toggle completion. Press `g` followed by `d`, `w` or `c` to switch views while keeping the selected date.

Press `g a` to open the Copilot chat. Ask it to read your plan, add or schedule tasks, or check them off; it acts through the same verified planner API, streams its reply into the panel, and refreshes the agenda when its changes land.

Open a task to edit its schedule, nest it under a parent, or add prerequisites. The Graph tab follows prerequisites from top to bottom across dates. A task's optional `parentId` controls its place in the outline. Deleting a parent promotes its direct children one level.

## Planner API

The [OpenAPI 3.1 specification](./apps/api/openapi.json) is ready for client generation. The running Worker serves the same document at `GET /api/openapi.json`. Run `npm run openapi` after changing a contract. CI checks for drift.

| Operation | Endpoint |
| --- | --- |
| Read the accepted plan, including revision, tasks in topological order, and direct edges | `GET /api/tasks` |
| Create a task, event, meal or milestone | `POST /api/tasks` |
| Read, patch or delete a task | `GET / PATCH / DELETE /api/tasks/{id}` |
| Traverse all prerequisites or dependents | `GET /api/tasks/{id}/traverse/{ancestors\|descendants}` |
| Add or remove a direct prerequisite | `PUT / DELETE /api/dependencies/{from}/{to}` |
| Check the API | `GET /api/health` |

The Copilot agent lives beside these routes at `POST /api/agents/copilot/me` (the `me` alias resolves server-side to the caller's verified identity). It is a Flue conversation, not part of the OpenAPI contract: one `POST` per message returns `202`, and `GET` with `?view=history` or the updates stream reads it back.

For an existing lunch event, submit a task like this to `POST /api/tasks`. Replace the example anchor with the event ID.

```json
{
  "title": "Prepare lunch",
  "durationMinutes": 20,
  "placement": { "side": "before", "anchor": "b8c58fd3-6aa1-4a98-bfec-dafec4419d0b" }
}
```

An edge `A → B` means A must finish before B can start. Inserting X **before** B moves every immediate incoming edge to X and adds `X → B`. Inserting X **after** A moves every immediate outgoing edge to X and adds `A → X`. Use the dependency endpoint to add a single constraint while preserving the other edges. An attempted cycle returns 409. A missing anchor returns 404. Failed edits roll back the task, edges and revision together. Deleting a task removes its incident edges. Repeating an edge addition or removal preserves the revision.

Task schedules support a floating calendar date, a fixed interval, a flexible window or an unscheduled task. Intervals use ISO timestamps with offsets and exclusive ends. The client projects them onto the viewer's local calendar. This stage records scheduling intent. It does not resolve conflicting time windows or run the proposal and plugin lifecycle described in the design.

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

Task, dependency, and day-page operations are enabled. To add a JSON planner operation to Copilot, mark it `mcp: true` in [the route contract](./apps/api/src/routes/contract.ts) and run `npm run openapi` to refresh the Worker’s tool catalog. CI checks the catalog for drift. Copilot uses Flue’s MCP discovery inside the Worker and calls the planner selected by the authenticated conversation.

For external stdio clients, run `npm run mcp:build` and restart the client connection. This regenerates both catalogs and replaces the build in `.generated/mcp`.

### Code layout

- `apps/api/src/interfaces/` contains runtime-neutral Zod schemas, derived TypeScript types, the graph read contract and the injected database interface. The web client imports the plan schemas through `@2do/api/plan`.
- `routes/` owns HTTP parsing, response mapping and the OpenAPI contract. `core/` owns graph operations and transaction boundaries. `agents/` holds the Flue Copilot agent, mounted from `src/app.ts` behind the Access check.
- `db/` contains the SQLite schema and all parameterized queries. `user-planner.ts` connects the repository, planner and routes inside each object. `plugins/` is reserved for future implementations.

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

The API deploys through Wrangler, which takes the Access values from the `ACCESS_ISSUER` and `ACCESS_AUD` environment variables (`wrangler deploy --var …`, see the `deploy` script in `apps/api/package.json`). Wrangler owns the API Worker's ordered Durable Object migration history: the first deploy after the move from the `cf` CLI appends the `FlueCopilotAgent` class as a new migration tag — if Wrangler reports a mismatch with the tags the `cf` CLI shipped for `UserPlanner`, rename the `v1` tag in `apps/api/wrangler.jsonc` to the one it lists before deploying.

Pull requests run contract checks, type checks, tests, both builds and Terraform validation. After a merge or direct push to `main` passes those checks, the workflow deploys `2do-api` with the Flue copilot Durable Object, then `2do-web` with the React/Vite assets and API service binding. The copilot uses the Worker's AI binding for inference. The API also binds the `2do-notebook-images` R2 bucket.

Both jobs use GitHub-hosted Ubuntu while this repository is personally owned. For an organization-owned repository they use `blacksmith-2vcpu-ubuntu-2404`. Enable the repository in the organization's [Blacksmith GitHub integration](https://docs.blacksmith.sh/introduction/quickstart) before running the workflow there.

To verify a live deployment, open the root in a signed-out browser, sign in, add a task, and check it in all three planner views. A second allowed account should see its own empty plan.

```sh
npm run openapi:check
npm run typecheck
npm test
npm run build
```
