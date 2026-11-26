import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, planKey, queryClient } from "./query.ts";
import { dayBuffer } from "./day-buffer.ts";
import { dayKey, offsetDay } from "./calendar.ts";

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export async function carryOver(date: string) {
  const source = dayBuffer(dayKey(offsetDay(new Date(date + "T12:00:00"), -1)));
  await source.flush();
  if (source.get().error) throw new Error("Save the previous day before carrying its tasks over.");
  const { data } = await api.POST("/api/days/{date}/carryover", {
    params: { path: { date }, query: { timeZone: zone() } },
  });
  await queryClient.invalidateQueries({ queryKey: planKey });
  return data!.moved;
}

export function CarryoverSettings() {
  const client = useQueryClient();
  const queryKey = ["planner", "carryover-settings"];
  const settings = useQuery({
    queryKey,
    queryFn: async () => (await api.GET("/api/settings/carryover")).data!,
  });
  const change = useMutation({
    mutationFn: async (enabled: boolean) =>
      (
        await api.PUT("/api/settings/carryover", {
          body: { enabled, timeZone: enabled ? zone() : settings.data!.timeZone },
        })
      ).data!,
    onSuccess: (data) => client.setQueryData(queryKey, data),
  });
  return (
    <section className="setting-row">
      <div>
        <h2>Automatic carryover</h2>
        <p>
          Move yesterday’s unfinished tasks at 6 AM (
          {settings.data?.enabled ? settings.data.timeZone : zone()}). Applies across devices.
        </p>
        {(settings.error || change.error) && (
          <p role="alert">{(settings.error ?? change.error)?.message}</p>
        )}
      </div>
      <label className="toggle">
        <input
          type="checkbox"
          aria-label="Automatic carryover"
          checked={settings.data?.enabled ?? false}
          disabled={!settings.data || change.isPending}
          onChange={(event) => change.mutate(event.target.checked)}
        />
        <span aria-hidden="true" />
      </label>
    </section>
  );
}
