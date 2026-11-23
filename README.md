# 2do

A phone-first personal planner based on [Linear for Life](./plan.md).

| Workspace | Responsibility |
| --- | --- |
| `apps/web` | React and TypeScript on Vite. The public Worker serves the app and forwards same-origin `/api/*` requests through its `API` service binding. |
| `apps/api` | Private API Worker with a health endpoint and the SQLite-backed `UserPlanner` Durable Object class. |

## Local development

From the repository root, use the Node version in `.nvmrc` and install the workspace dependencies.

```sh
nvm install
npm install
npm run dev
```

Open http://localhost:5173. The dev command starts both projects with their local `cf dev` executables. The page checks the API through the web Worker. To exercise the same route directly, run `curl http://localhost:5173/api/health` and expect `{"status":"ok"}`.

## Verify and deploy

```sh
npm run typecheck
npm test
npm run build
```

Both projects use the Cloudflare Vite plugin and `cloudflare.config.ts`. When ready to publish, run `npm exec -w @2do/api -- cf auth login`, then `npm run deploy` from the root. Deployment creates the API first so the web Worker's service binding has a target.

The starter exposes only the health endpoint. User authentication, plan reads, capture, and review commands are next steps in the design. Route those commands to the planner object using the verified internal user ID.
