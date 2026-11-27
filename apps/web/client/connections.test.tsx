import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { Connections } from "./connections.tsx";

it("shows Fitbit workouts only on the connected Google Health card", () => {
  const client = new QueryClient();
  const key = ["planner", "connections", "google-health"];
  const status = {
    configured: true,
    account: "tracker@example.test",
    directions: { importEvents: false, exportEvents: false },
    error: null,
    lastSync: 1000,
  };
  client.setQueryData(key, status);
  client.setQueryData(
    [...key, "workouts"],
    [{ activity: "running", start: "2026-11-25T12:00:00Z", minutes: 28, km: 4.2 }],
  );
  const render = () =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Connections />
      </QueryClientProvider>,
    );
  const html = render();
  const health = html.slice(html.indexOf('id="connection-google-health"'));
  expect(health).toContain("Google Health (Fitbit)");
  expect(health).toContain("4.2 km");
  expect(health).toContain("28 min");
  expect(health).not.toContain("Sync directions");
  expect(health).not.toContain("gmail-suggestions");
  client.setQueryData(key, { ...status, account: null });
  expect(render()).not.toContain("4.2 km");
});
