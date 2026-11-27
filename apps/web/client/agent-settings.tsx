import { rememberPushScope } from "./push-scope.ts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import type { ApprovalPolicy } from "@2do/api/agent-inbox";
import { api, queryClient, getVerifiedScope } from "./query.ts";
import { usePlan } from "./use-plan.ts";
import type {
  ReminderRule,
  ReminderInput as RuleInput,
  ReminderSettings,
} from "@2do/api/reminders";

const remindersKey = ["planner", "reminders"] as const;
const policyKey = ["planner", "agent-approval"] as const;

const effectLabels = {
  "local-edit": "Edit planner records",
  "local-create": "Create planner records",
  "local-delete": "Delete planner records",
  workflow: "Run plugin workflows",
  settings: "Change settings",
  external: "Change connected accounts",
} as const;
type PolicyRule = ApprovalPolicy["rules"][number];
function isScoped(rule: PolicyRule) {
  return Boolean(
    rule.account ||
    rule.operations?.length ||
    rule.resourceIds?.length ||
    rule.maxResources ||
    rule.reversibleOnly,
  );
}
function ScopedApprovalRules({
  rules,
  save,
  busy,
}: {
  rules: PolicyRule[];
  save: (rules: PolicyRule[]) => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const tasks = usePlan().data?.tasks ?? [];
  const [effect, setEffect] = useState<PolicyRule["effect"]>("local-edit");
  const [message, setMessage] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const values = (key: string) => [
      ...new Set(
        String(fields.get(key) ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    const operations = values("operations"),
      resourceIds = fields.getAll("resource").map(String),
      max = String(fields.get("max") || "");
    const account = String(fields.get("account") ?? "").trim();
    const rule: PolicyRule = {
      effect,
      origin: fields.get("origin") === "scheduled" ? "scheduled" : "chat",
      mode: fields.get("mode") === "allow" ? "allow" : "ask",
      ...(operations.length ? { operations } : {}),
      ...(resourceIds.length ? { resourceIds } : {}),
      ...(max ? { maxResources: Number(max) } : {}),
      ...(fields.has("reversible") ? { reversibleOnly: true } : {}),
      ...(account ? { account } : {}),
    };
    if (!isScoped(rule)) return setMessage("Choose at least one limit for this rule.");
    save([...rules, rule]);
    setMessage("");
    setEditing(false);
  }
  return (
    <div className="rule-fields">
      <h3>Scoped rules</h3>
      {rules.map(
        (rule, i) =>
          isScoped(rule) && (
            <div key={JSON.stringify(rule)}>
              <strong>
                {effectLabels[rule.effect]} ·{" "}
                {rule.mode === "allow" ? "Apply automatically" : "Ask"}
              </strong>
              <p>
                {[
                  rule.origin === "chat" ? "User request" : "Scheduled",
                  rule.operations?.join(", "),
                  rule.resourceIds
                    ?.map((id) => tasks.find((t) => t.id === id)?.title ?? id)
                    .join(", "),
                  rule.account,
                  rule.maxResources && "Up to " + rule.maxResources + " records",
                  rule.reversibleOnly && "Reversible changes",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => save(rules.filter((_, index) => index !== i))}
              >
                Remove rule
              </button>
            </div>
          ),
      )}
      {editing ? (
        <form onSubmit={submit}>
          <label>
            Type of change
            <select
              aria-label="Type of change"
              value={effect}
              onChange={(e) => setEffect(e.target.value as PolicyRule["effect"])}
            >
              {(Object.keys(effectLabels) as Array<keyof typeof effectLabels>).map((key) => (
                <option value={key} key={key}>
                  {effectLabels[key]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Origin
            <select name="origin">
              <option value="chat">User request</option>
              <option value="scheduled">Scheduled request</option>
            </select>
          </label>
          <label>
            Decision
            <select name="mode">
              <option value="ask">Ask for approval</option>
              <option value="allow">Apply automatically</option>
            </select>
          </label>
          <label>
            Operations (optional, comma-separated)
            <input name="operations" placeholder="updateTask, writePage" />
          </label>
          <label>
            Limit to tasks (optional)
            <select multiple name="resource">
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Maximum affected records
            <input name="max" type="number" min="1" max="10000" />
          </label>
          {effect === "external" && (
            <label>
              Connected account
              <input name="account" />
            </label>
          )}
          <label>
            <span>
              <input name="reversible" type="checkbox" /> Reversible changes only
            </span>
          </label>
          {message && <p role="alert">{message}</p>}
          <div className="actions">
            <button type="submit" disabled={busy}>
              Save rule
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" disabled={busy} onClick={() => setEditing(true)}>
          New scoped rule
        </button>
      )}
    </div>
  );
}
function ApprovalSettings() {
  const query = useQuery({
    queryKey: policyKey,
    queryFn: async ({ signal }) => {
      const { data } = await api.GET("/api/agent/approval", { signal });
      if (!data) throw new Error("Approval settings unavailable.");
      return data;
    },
  });
  const save = useMutation({
    mutationFn: async (body: ApprovalPolicy) => {
      await api.PUT("/api/agent/approval", { body });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: policyKey }),
  });
  const origin = "chat";
  const policy = query.data;
  return (
    <section className="setting-row">
      <div>
        <h2>Approval rules</h2>
        <p>
          Choose which changes the agent can apply automatically. Other changes go to your inbox.
        </p>
      </div>
      <div>
        {policy && (
          <fieldset disabled={save.isPending}>
            <legend>When I ask in chat</legend>
            {(Object.keys(effectLabels) as Array<keyof typeof effectLabels>).map((effect) => {
              const current = policy.rules.filter(
                (r) => !isScoped(r) && r.effect === effect && r.origin === origin,
              );
              const allowed =
                current.some((r) => r.mode === "allow") && !current.some((r) => r.mode === "ask");
              return (
                <label key={effect}>
                  <span>{effectLabels[effect]}</span>
                  <select
                    aria-label={effectLabels[effect]}
                    value={allowed ? "allow" : "ask"}
                    onChange={(e) => {
                      const rules = policy.rules.filter(
                        (r) => isScoped(r) || r.effect !== effect || r.origin !== origin,
                      );
                      save.mutate({
                        ...policy,
                        rules: [
                          ...rules,
                          { effect, origin, mode: e.target.value === "allow" ? "allow" : "ask" },
                        ],
                      });
                    }}
                  >
                    <option value="ask">Ask for approval</option>
                    <option value="allow">Apply automatically</option>
                  </select>
                </label>
              );
            })}
          </fieldset>
        )}
        {policy && (
          <ScopedApprovalRules
            rules={policy.rules}
            busy={save.isPending}
            save={(rules) => save.mutate({ ...policy, rules })}
          />
        )}
        {(query.error || save.error) && <p role="alert">{(query.error ?? save.error)?.message}</p>}
      </div>
    </section>
  );
}

function DeliverySettings({ settings }: { settings: ReminderSettings }) {
  const save = useMutation({
    mutationFn: async (body: ReminderSettings) => {
      await api.PUT("/api/reminders/settings", { body });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: remindersKey }),
  });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    save.mutate({
      ...settings,
      timeZone: String(form.get("zone")).trim(),
      paused: form.has("paused"),
      dayTime: String(form.get("day")),
      quietStart: String(form.get("start") || "") || null,
      quietEnd: String(form.get("end") || "") || null,
    });
  }
  return (
    <section className="setting-row">
      <div>
        <h2>Reminder delivery</h2>
        <p>Set local delivery times for reminders and briefs.</p>
      </div>
      <form onSubmit={submit}>
        <label>
          Time zone
          <input name="zone" defaultValue={settings.timeZone} required />
        </label>
        <label>
          Time for all-day tasks
          <input type="time" name="day" defaultValue={settings.dayTime} required />
        </label>
        <label>
          Quiet hours start
          <input type="time" name="start" defaultValue={settings.quietStart ?? ""} />
        </label>
        <label>
          Quiet hours end
          <input type="time" name="end" defaultValue={settings.quietEnd ?? ""} />
        </label>
        <label>
          <span>
            <input type="checkbox" name="paused" defaultChecked={settings.paused} /> Pause reminders
          </span>
        </label>
        <button type="submit" disabled={save.isPending}>
          Save delivery settings
        </button>
        {save.isSuccess && <span role="status">Saved</span>}
        {save.isError && <p role="alert">{save.error.message}</p>}
      </form>
    </section>
  );
}

function localInput(instant: string) {
  const date = new Date(instant);
  return new Date(+date - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function RuleEditor({ rule, close }: { rule?: ReminderRule; close: () => void }) {
  const plan = usePlan().data;
  const [kind, setKind] = useState<RuleInput["trigger"]["kind"]>(rule?.trigger.kind ?? "at");
  const [error, setError] = useState("");
  const [id] = useState(() => rule?.id ?? crypto.randomUUID());
  const save = useMutation({
    mutationFn: async (body: RuleInput) => {
      await api.PUT("/api/reminders/{id}", { params: { path: { id } }, body });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: remindersKey });
      close();
    },
  });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const taskId = String(form.get("task") || "");
    const at = new Date(String(form.get("at")));
    if (kind === "at" && !Number.isFinite(+at)) return setError("Choose a valid date and time.");
    const trigger: RuleInput["trigger"] =
      kind === "at"
        ? { kind, at: at.toISOString() }
        : kind === "routine"
          ? {
              kind,
              time: String(form.get("time")),
              instruction: String(form.get("instruction") ?? "").trim(),
            }
          : kind === "daily"
            ? {
                kind,
                time: String(form.get("time")),
                summary: form.get("summary") === "blocked" ? "blocked" : "agenda",
                synthesize: form.has("synthesize"),
              }
            : kind === "due-tasks"
              ? { kind, minutes: Number(form.get("minutes")) }
              : {
                  kind,
                  anchor: form.get("anchor") === "due" ? "due" : "start",
                  minutes: Number(form.get("minutes")),
                };
    setError("");
    save.mutate({
      title: String(form.get("title")).trim(),
      enabled: form.has("enabled"),
      ...((kind === "at" || kind === "before") && taskId ? { taskId } : {}),
      trigger,
    });
  }
  return (
    <form onSubmit={submit}>
      <label>
        Reminder title
        <input name="title" defaultValue={rule?.title} maxLength={240} required />
      </label>
      <label>
        When
        <select
          aria-label="When"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="at">Specific time</option>
          <option value="before">Before a task</option>
          <option value="due-tasks">Before every due task</option>
          <option value="daily">Daily brief</option>
          <option value="routine">Scheduled agent routine</option>
        </select>
      </label>
      {(kind === "at" || kind === "before") && (
        <label>
          Task
          <select
            aria-label="Task"
            name="task"
            defaultValue={rule?.taskId ?? ""}
            required={kind === "before"}
          >
            <option value="">{kind === "before" ? "Choose a task" : "No task"}</option>
            {plan?.tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === "at" && (
        <label>
          Local date and time
          <input
            type="datetime-local"
            name="at"
            required
            defaultValue={rule?.trigger.kind === "at" ? localInput(rule.trigger.at) : undefined}
          />
        </label>
      )}
      {kind === "before" && (
        <>
          <label>
            Relative to
            <select
              name="anchor"
              defaultValue={rule?.trigger.kind === "before" ? rule.trigger.anchor : "start"}
            >
              <option value="start">Task start</option>
              <option value="due">Due date</option>
            </select>
          </label>
        </>
      )}
      {(kind === "before" || kind === "due-tasks") && (
        <label>
          Minutes before
          <input
            type="number"
            min="0"
            name="minutes"
            max="43200"
            defaultValue={
              rule?.trigger.kind === "before" || rule?.trigger.kind === "due-tasks"
                ? rule.trigger.minutes
                : 15
            }
            required
          />
        </label>
      )}
      {kind === "routine" && (
        <>
          <label>
            Time
            <input
              type="time"
              name="time"
              required
              defaultValue={rule?.trigger.kind === "routine" ? rule.trigger.time : "09:00"}
            />
          </label>
          <label>
            Agent instruction
            <textarea
              name="instruction"
              maxLength={2000}
              required
              defaultValue={rule?.trigger.kind === "routine" ? rule.trigger.instruction : ""}
            />
          </label>
        </>
      )}
      {kind === "daily" && (
        <>
          <label>
            Time
            <input
              type="time"
              name="time"
              required
              defaultValue={rule?.trigger.kind === "daily" ? rule.trigger.time : "09:00"}
            />
          </label>
          <label>
            Include
            <select
              name="summary"
              defaultValue={rule?.trigger.kind === "daily" ? rule.trigger.summary : "agenda"}
            >
              <option value="agenda">Agenda</option>
              <option value="blocked">Blocked tasks</option>
            </select>
          </label>
          <label>
            <span>
              <input
                type="checkbox"
                name="synthesize"
                defaultChecked={rule?.trigger.kind === "daily" && rule.trigger.synthesize}
              />{" "}
              Prioritize this brief with the agent
            </span>
          </label>
        </>
      )}
      <label>
        <span>
          <input type="checkbox" name="enabled" defaultChecked={rule?.enabled ?? true} /> Enabled
        </span>
      </label>
      <div className="actions">
        <button type="submit" disabled={save.isPending}>
          Save reminder
        </button>
        <button type="button" onClick={close}>
          Cancel
        </button>
      </div>
      {(error || save.error) && <p role="alert">{error || save.error?.message}</p>}
    </form>
  );
}

function ReminderList({ rules }: { rules: ReminderRule[] }) {
  const [editing, setEditing] = useState<string>();
  const remove = useMutation({
    mutationFn: async (id: string) => {
      await api.DELETE("/api/reminders/{id}", { params: { path: { id } } });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: remindersKey }),
  });
  return (
    <section className="setting-row">
      <div>
        <h2>Reminders</h2>
        <p>Schedule an update for a task or a daily brief.</p>
      </div>
      <div>
        {rules.map((rule) => (
          <div key={rule.id} className="rule-fields">
            {editing === rule.id ? (
              <RuleEditor rule={rule} close={() => setEditing(undefined)} />
            ) : (
              <>
                <strong>{rule.title}</strong>
                <small>
                  {rule.enabled
                    ? rule.nextAt
                      ? new Date(rule.nextAt).toLocaleString()
                      : "Waiting for a matching time"
                    : "Paused"}
                </small>
                <div className="actions">
                  <button type="button" onClick={() => setEditing(rule.id)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(rule.id)}
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        {editing === "new" ? (
          <RuleEditor close={() => setEditing(undefined)} />
        ) : (
          <button type="button" onClick={() => setEditing("new")}>
            New reminder
          </button>
        )}
        {remove.error && <p role="alert">{remove.error.message}</p>}
      </div>
    </section>
  );
}

function supportsPush() {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}
function subscriptionKey(key: string) {
  const value = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}
function PushSettings({ publicKey }: { publicKey: string | null }) {
  const prefix = "2do.push.";
  const owner = getVerifiedScope();
  const [device, setDevice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const supported = supportsPush();
  useEffect(() => {
    let active = true;
    async function check() {
      if (!supported || !owner) return;
      const record = localStorage.getItem(prefix + owner);
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (active && sub) setDevice(record);
    }
    void check()
      .catch(() => {})
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, [supported, owner]);
  const toggle = useMutation({
    mutationFn: async () => {
      if (!owner) throw new Error("Reopen settings after signing in.");
      if (device) {
        await api.DELETE("/api/reminders/push/{id}", { params: { path: { id: device } } });
        localStorage.removeItem(prefix + owner);
        setDevice(null);
        const reg = await navigator.serviceWorker.getRegistration("/");
        await (await reg?.pushManager.getSubscription())?.unsubscribe();
        return;
      }
      if (!publicKey || !supported) throw new Error("Push delivery is unavailable.");
      if ((await Notification.requestPermission()) !== "granted")
        throw new Error("Your browser has disabled notifications for 2do.");
      await navigator.serviceWorker.register("/agent-worker.js", { scope: "/" });
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      // Switching planners rotates the endpoint so the previous planner cannot deliver here.
      if (sub && !localStorage.getItem(prefix + owner)) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: subscriptionKey(publicKey),
      });
      const json = sub.toJSON();
      if (!json.endpoint || !json.keys?.auth || !json.keys.p256dh)
        throw new Error("The browser returned an incomplete subscription.");
      const id = localStorage.getItem(prefix + owner) ?? crypto.randomUUID();
      await rememberPushScope(owner);
      await api.PUT("/api/reminders/push/{id}", {
        params: { path: { id } },
        body: {
          endpoint: json.endpoint,
          keys: { auth: json.keys.auth, p256dh: json.keys.p256dh },
          expirationTime: sub.expirationTime,
        },
      });
      for (const name of Object.keys(localStorage))
        if (name.startsWith(prefix)) localStorage.removeItem(name);
      localStorage.setItem(prefix + owner, id);
      setDevice(id);
    },
  });
  return (
    <section className="setting-row">
      <div>
        <h2>Device notifications</h2>
        <p>
          {!supported
            ? "This browser does not support Web Push."
            : !publicKey
              ? "Push delivery is not configured."
              : "Receive reminders when 2do is closed."}
        </p>
      </div>
      <div>
        <button
          type="button"
          disabled={toggle.isPending || !ready || !owner || !supported || (!publicKey && !device)}
          onClick={() => toggle.mutate()}
        >
          {device ? "Disable on this device" : "Enable on this device"}
        </button>
        {toggle.error && <p role="alert">{toggle.error.message}</p>}
      </div>
    </section>
  );
}

export function AgentSettings() {
  const query = useQuery({
    queryKey: remindersKey,
    queryFn: async ({ signal }) => {
      const { data } = await api.GET("/api/reminders", { signal });
      if (!data) throw new Error("Reminders unavailable.");
      return data;
    },
  });
  return (
    <div className="agent-settings">
      <ApprovalSettings />
      {query.isError ? (
        <p role="alert">
          {query.error.message}{" "}
          <button type="button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      ) : (
        query.data && (
          <>
            <DeliverySettings
              key={JSON.stringify(query.data.settings)}
              settings={query.data.settings}
            />
            <ReminderList rules={query.data.rules} />
            <PushSettings publicKey={query.data.pushPublicKey} />
          </>
        )
      )}
    </div>
  );
}
