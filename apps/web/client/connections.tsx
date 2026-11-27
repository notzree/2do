import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { paths } from "./openapi.d.ts";
import { api } from "./query.ts";
import { connectorKind, connectorLabels, type ConnectorKind as Kind } from "@2do/api/connectors";

type Status =
  paths["/api/connections/{kind}"]["get"]["responses"][200]["content"]["application/json"];
type Directions = Status["directions"];
const initial: Directions = { importEvents: true, exportEvents: false };
const key = (kind: Kind) => ["planner", "connections", kind];
async function authorize(kind: Kind, options: Directions) {
  const { data } = await api.POST("/api/connections/{kind}/authorize", {
    params: { path: { kind } },
    body: kind === "google-calendar" ? options : {},
  });
  if (!data) throw new Error("Could not start Google sign-in.");
  window.location.assign(data.url);
}
function useConnection(kind: Kind) {
  return useQuery({
    queryKey: key(kind),
    queryFn: async () =>
      (await api.GET("/api/connections/{kind}", { params: { path: { kind } } })).data!,
    refetchInterval: (query) => (query.state.data?.account ? 30_000 : false),
  });
}

function RecentWorkouts() {
  const { data, error } = useQuery({
    queryKey: ["planner", "connections", "google-health", "workouts"],
    queryFn: async () => (await api.GET("/api/connections/google-health/workouts")).data!,
    refetchInterval: 30_000,
  });
  if (error) return <p role="alert">{error.message}</p>;
  if (!data?.length) return null;
  return (
    <div>
      <h3>Recent workouts</h3>
      <ul>
        {data.map((row, index) => (
          <li key={row.start + row.activity + index}>
            {new Date(row.start).toLocaleDateString()} · {row.activity} · {Number(row.minutes.toFixed(1))} min
            {row.km !== null && ` · ${Number(row.km.toFixed(2))} km`}
          </li>
        ))}
      </ul>
    </div>
  );
}

const descriptions: Record<Kind, string> = {
  gmail: "Track new inbox messages. You can enable task suggestions for this account.",
  "google-calendar": "Import your primary calendar and publish selected events to a dedicated 2do calendar.",
  "google-health": "With Fitness enabled, 2do stores your Fitbit and Pixel Watch workout type, time, minutes and distance for activity reports and goals. Copilot and your connected planner tools can read those totals. Import starts 30 days back and checks every 15 minutes. Disconnecting removes the imported workouts and their goal credit.",
};

function Connection({ kind }: { kind: Kind }) {
  const client = useQueryClient();
  const query = useConnection(kind);
  const [requested, setRequested] = useState(initial);
  const mutation = useMutation({
    mutationFn: async (action: "connect" | "disconnect" | Directions) => {
      if (action === "disconnect")
        await api.DELETE("/api/connections/{kind}", { params: { path: { kind } } });
      else if (action === "connect")
        await authorize(kind, query.data?.account ? query.data.directions : requested);
      else {
        const { data } = await api.PUT("/api/connections/google-calendar/options", {
          body: action,
        });
        if (!data?.authorized) await authorize(kind, action);
      }
    },
    onSettled: () => {
      if (kind === "google-health") void client.invalidateQueries({ queryKey: ["planner", "reports"] });
      return client.invalidateQueries({ queryKey: key(kind) });
    },
  });
  const suggestions = useMutation({
    mutationFn: (enabled:boolean) => api.PUT("/api/connections/gmail/suggestions", {body:{enabled}}),
    onSuccess: () => client.invalidateQueries({queryKey:key(kind)}),
  });
  const status = query.data;
  return (
    <section className="connection-card" id={"connection-" + kind} tabIndex={-1}>
      <h2>{connectorLabels[kind]}</h2>
      <p>{descriptions[kind]}</p>
      {status?.account && kind === "google-health" && <RecentWorkouts />}
      {status?.account && (
        <p>
          <strong>{status.account}</strong> ·{" "}
          {status.lastSync
            ? "Last synced " + new Date(status.lastSync).toLocaleTimeString()
            : "Waiting for first sync"}
        </p>
      )}
      {status?.account && kind === "gmail" && <label>
        <input type="checkbox" id="gmail-suggestions" checked={!!status.mailSuggestions} disabled={suggestions.isPending}
          onChange={event => suggestions.mutate(event.target.checked)} />
        Use Workers AI to suggest tasks from new email subjects and short excerpts in Needs attention
      </label>}
      {suggestions.error && <p role="alert">{suggestions.error.message}</p>}
      {status && kind === "google-calendar" && (
        <fieldset disabled={mutation.isPending}>
          <legend>Sync directions</legend>
          {(["importEvents", "exportEvents"] as const).map((field) => (
            <label key={field}>
              <input
                type="checkbox"
                checked={(status.account ? status.directions : requested)[field]}
                onChange={(e) =>
                  status.account
                    ? mutation.mutate({ ...status.directions, [field]: e.target.checked })
                    : setRequested({ ...requested, [field]: e.target.checked })
                }
              />
              {field === "importEvents"
                ? "Google Calendar to 2do"
                : "Selected 2do events to Google Calendar"}
            </label>
          ))}
        </fieldset>
      )}
      {status && !status.configured && <p>Google credentials are required on the API Worker.</p>}
      <div className="connection-actions">
        <button
          type="button"
          disabled={
            !status?.configured ||
            mutation.isPending ||
            (!status.account &&
              kind === "google-calendar" &&
              !requested.importEvents &&
              !requested.exportEvents)
          }
          onClick={() => mutation.mutate("connect")}
        >
          {status?.account ? "Reconnect Google" : "Connect with Google"}
        </button>
        {status?.account && (
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("disconnect")}
          >
            Disconnect
          </button>
        )}
      </div>
      {(mutation.error || query.error || status?.error) && (
        <p role="alert">{mutation.error?.message ?? query.error?.message ?? status?.error}</p>
      )}
    </section>
  );
}
export function Connections() {
  return (
    <div className="connections">
      {connectorKind.options.map((kind) => <Connection key={kind} kind={kind} />)}
    </div>
  );
}

export function EventCalendarLink({
  id,
  revision,
  scheduled,
}: {
  id: string;
  revision: number;
  scheduled: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const client = useQueryClient();
  const connection = useConnection("google-calendar");
  const queryKey = ["planner", "calendar-link", id];
  const query = useQuery({
    queryKey,
    enabled: !!connection.data?.account,
    queryFn: async () =>
      (await api.GET("/api/events/{id}/calendar-link", { params: { path: { id } } })).data!.status,
    refetchInterval: 30_000,
  });
  const mutation = useMutation({
    mutationFn: async (enabled: boolean) =>
      (
        await api.PUT("/api/events/{id}/calendar-link", {
          params: { path: { id } },
          body: { enabled },
        })
      ).data!.status,
    onSuccess: (status) => client.setQueryData(queryKey, status),
  });
  const deletion = useMutation({
    mutationFn: async () => {
      await api.DELETE("/api/events/{id}/calendar-link", {
        params: { path: { id }, query: { revision } },
      });
    },
    onSettled: () => {
      setConfirmDelete(false);
      return client.invalidateQueries({ queryKey: ["planner"] });
    },
  });
  if (
    !connection.data?.account ||
    !query.data ||
    (query.data === "unlinked" && (!scheduled || !connection.data.directions.exportEvents))
  )
    return null;
  if (query.data === "imported")
    return <p>Imported from Google Calendar. Edit its title and time in Google.</p>;
  const linked = query.data !== "unlinked";
  return (
    <section aria-label="Google Calendar sync">
      {query.data === "conflict" && (
        <p role="status">
          Calendar edits conflict. Match the title and time in both apps to resume, or stop syncing
          to keep separate copies.
        </p>
      )}
      <button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate(!linked)}>
        {linked ? "Stop syncing to Google Calendar" : "Sync to Google Calendar"}
      </button>
      {linked && connection.data.directions.exportEvents && (
        <button
          type="button"
          disabled={deletion.isPending}
          onClick={() => (confirmDelete ? deletion.mutate() : setConfirmDelete(true))}
        >
          {confirmDelete ? "Confirm delete from both" : "Delete from 2do and Google"}
        </button>
      )}
      {confirmDelete && (
        <button type="button" onClick={() => setConfirmDelete(false)}>
          Cancel
        </button>
      )}
      {deletion.isSuccess && (
        <small role="status">
          Deletion queued. Both copies will be removed if they still match.
        </small>
      )}
      {deletion.error && <p role="alert">{deletion.error.message}</p>}
      {mutation.error && <p role="alert">{mutation.error.message}</p>}
    </section>
  );
}
