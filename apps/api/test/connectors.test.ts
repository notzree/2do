import { env, runInDurableObject, SELF } from "cloudflare:test";
import { expect, it, vi } from "vite-plus/test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { OAuth2Client } from "google-auth-library";
import { EmailCursorExpired } from "../src/interfaces/connectors.ts";
import { readMailPage } from "../src/connectors/mail-intake.ts";
import { googleCalendar, googleEvent, gmailInbox } from "../src/connectors/google.ts";
import type { ConnectorEnv, GoogleConnection } from "../src/connectors/connection.ts";
import type { Calendar, Email, CalendarEvent, EventFields } from "../src/interfaces/connectors.ts";
import { reconcileExport, type ExportRow } from "../src/core/calendar-sync.ts";
import { scopes } from "../src/connectors/auth.ts";
import { connectors } from "../src/connectors/router.ts";
import { task } from "../src/interfaces/plan.ts";

const bindings = env as unknown as ConnectorEnv;
const disabled = { importEvents: false, exportEvents: false };
const both = { importEvents: true, exportEvents: true };
const primary: EventFields = {
  title: "Appointment",
  schedule: { type: "day", date: "2026-12-03" },
};
const other: EventFields = { ...primary, schedule: { type: "day", date: "2026-12-04" } };

it("installs Gmail using PKCE and receives individual, deduplicated inbox IDs through signed Pub/Sub delivery", async () => {
  const planner = bindings.USER_PLANNER.idFromName("dev:local").toString();
  const stub = bindings.GOOGLE_CONNECTION.getByName("gmail/" + planner);
  const owner = "inbox@example.com";
  const sender = "push@test.example";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const sign = (email: string, aud: string) =>
    new SignJWT({ email, email_verified: true })
      .setSubject(email)
      .setIssuer("https://accounts.google.com")
      .setAudience(aud)
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  const idToken = await sign(owner, "test-client");
  const push = await sign(sender, "https://twodo.example/hooks/gmail");
  const keys = { keys: [{ ...jwk, kid: "fixture", alg: "RS256" }] };
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.includes("/certs")) return Response.json(keys);
    if (url.host === "oauth2.googleapis.com") {
      if (!String(init?.body).includes("refresh_token"))
        expect(String(init?.body)).toContain("code_verifier");
      return Response.json({
        access_token: "fixture-access",
        expires_in: 3600,
        token_type: "Bearer",
        refresh_token: "fixture-refresh",
        id_token: idToken,
        scope: scopes("gmail", disabled).join(" "),
      });
    }
    if (url.pathname.endsWith("/watch"))
      return Response.json({ historyId: "100", expiration: String(Date.now() + 86_400_000) });
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [] });
    if (url.pathname.endsWith("/history"))
      return Response.json({
        historyId: "101",
        history: [
          {
            messagesAdded: [
              { message: { id: "one", threadId: "thread", labelIds: ["INBOX"] } },
              { message: { id: "two", labelIds: ["INBOX"] } },
            ],
          },
        ],
      });
    if (url.pathname.endsWith("/stop")) return new Response(null, { status: 204 });
    throw new Error("Unexpected fixture request " + url.pathname);
  });
  try {
    const testEnv = {
      ...env,
      ...bindings,
      LOCAL_PLANNER: "enabled" as const,
      GOOGLE_CONNECTOR_ORIGIN: "https://twodo.example",
      GMAIL_PUSH_SERVICE_ACCOUNT: sender,
      GMAIL_PUSH_SUBSCRIPTION: "projects/test/subscriptions/2do",
    };
    const start = await connectors.request(
      "http://localhost/api/connections/gmail/authorize",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(disabled),
      },
      testEnv,
    );
    expect(start.status).toBe(200);
    const consent = new URL((await start.json<{ url: string }>()).url);
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
    expect(consent.searchParams.get("scope")).not.toContain("gmail.send");
    const state = consent.searchParams.get("state")!;
    const callback = "http://localhost/api/connections/gmail/callback?code=fixture&state=" + state;
    expect((await connectors.request(callback, {}, testEnv)).status).toBe(303);
    expect((await connectors.request(callback, {}, testEnv)).status).toBe(400);
    const tick = () =>
      runInDurableObject(stub, async (instance) => {
        await (instance as GoogleConnection).alarm();
      });
    await tick();
    expect(await bindings.GMAIL_DIRECTORY.getByName(owner).owner()).toBe(stub.id.toString());
    const body = JSON.stringify({
      subscription: testEnv.GMAIL_PUSH_SUBSCRIPTION,
      message: { data: btoa(JSON.stringify({ emailAddress: owner, historyId: "99999" })) },
    });
    const post = (token: string) =>
      connectors.request(
        "https://twodo.example/hooks/gmail",
        {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body,
        },
        testEnv,
      );
    expect(
      (await post(await sign("someone@example.com", "https://twodo.example/hooks/gmail"))).status,
    ).toBe(403);
    expect((await post(await sign(sender, "wrong-audience"))).status).toBe(401);
    expect((await post(push)).status).toBe(204);
    await tick();
    expect((await post(push)).status).toBe(204);
    await tick();
    await runInDurableObject(stub, async (_, ctx) => {
      expect(Array.from(ctx.storage.kv.list({ prefix: "received:" }), ([k]) => k)).toEqual([
        "received:one",
        "received:two",
      ]);
      expect(ctx.storage.kv.get<{ cursor: string }>("mail")?.cursor).toBe("101");
      expect(ctx.storage.kv.get<{ token: string }>("grant")?.token).not.toBe("fixture-refresh");
    });
    await stub.disconnect();
    expect(await bindings.GMAIL_DIRECTORY.getByName(owner).owner()).toBeNull();
  } finally {
    fetchSpy.mockRestore();
  }
});

it("re-baselines expired Gmail history and resumes the saved page before draining new history", async () => {
  const expired = new EmailCursorExpired();
  const email: Email = {
    changes: vi
      .fn()
      .mockRejectedValueOnce(expired)
      .mockResolvedValue({ messages: [], cursor: "52" }),
    start: vi.fn(async () => ({ cursor: "50", renewAt: 1000 })),
    renew: vi.fn(async () => 1000),
    inboxSince: vi
      .fn()
      .mockResolvedValueOnce({ messages: [{ id: "a" }], nextPage: "second" })
      .mockResolvedValueOnce({ messages: [{ id: "b" }] }),
    stop: vi.fn(),
  };
  const received = vi.fn(async () => {});
  const first = await readMailPage(
    email,
    "me",
    { cursor: "1", since: 5, renewAt: 999 },
    received,
    100,
  );
  const second = await readMailPage(email, "me", first, received, 101);
  expect(second).toMatchObject({ cursor: "50", recovering: false });
  expect(email.inboxSince).toHaveBeenCalledWith(5, "second");
  expect((await readMailPage(email, "me", second, received, 102)).cursor).toBe("52");
  expect(received.mock.calls).toHaveLength(2);
});
it("routes mailbox notifications only to the installed planner and rejects anonymous controls", async () => {
  const dir = bindings.GMAIL_DIRECTORY.getByName("unique@example.test");
  expect(await dir.claim("first")).toBe(true);
  expect(await dir.claim("second")).toBe(false);
  await dir.release("second");
  expect(await dir.owner()).toBe("first");
  const response = await SELF.fetch("https://app.example/api/connections/google-calendar");
  expect([401, 503]).toContain(response.status);
});

it("imports a recurring occurrence once, moves it, protects source fields, and removes its schedule on cancellation", async () => {
  const planner = bindings.USER_PLANNER.getByName(crypto.randomUUID());
  const event = (fields: EventFields): CalendarEvent => ({
    id: "meeting/instance",
    version: "v",
    fields,
    personal: false,
  });
  const titled = { ...primary, title: "Report due Friday" };
  await planner.importCalendar("account", "scan1", [event(titled)]);
  await planner.importCalendar("account", "scan1", [event(titled)]);
  const list = async () =>
    (
      await (
        await planner.fetch("https://test/api/tasks")
      ).json<{ tasks: ReturnType<typeof task.parse>[] }>()
    ).tasks;
  const [before] = await list();
  expect(before.due).toBeUndefined();
  expect(await list()).toHaveLength(1);
  const edit = await planner.fetch("https://test/api/tasks/" + before.id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "wrong", revision: before.revision }),
  });
  expect(edit.status).toBe(409);
  await planner.importCalendar("account", "scan2", [
    event({ ...other, title: "Report due Monday" }),
  ]);
  const [moved] = await list();
  expect(moved).toMatchObject({ id: before.id, schedule: other.schedule });
  expect(moved.due).toBeUndefined();
  // Seed a deadline that earlier title extraction could have left on this import.
  await planner.fetch("https://test/api/tasks/" + moved.id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: moved.revision, due: { type: "day", date: "2026-12-07" } }),
  });
  expect((await list())[0].due).toEqual({ type: "day", date: "2026-12-07" });
  expect(await planner.finishCalendarImport("account", "scan3")).toBe(false);
  expect(await list()).toMatchObject([{ id: before.id, schedule: null, due: null }]);
  const [canceled] = await list();
  await planner.fetch("https://test/api/tasks/" + canceled.id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      revision: canceled.revision,
      due: { type: "day", date: "2026-12-07" },
    }),
  });
  expect(await planner.finishCalendarImport("account", "scan4")).toBe(false);
  expect(await list()).toMatchObject([{ id: before.id, schedule: null, due: null }]);
  await planner.importCalendar("account", "scan5", [event(primary)]);
  expect(await list()).toMatchObject([{ id: before.id, schedule: primary.schedule }]);
});
it("merges independent local and remote changes, flags collisions and adopts a retried create", async () => {
  const id = crypto.randomUUID();
  const row: ExportRow = {
    link: {
      taskId: id,
      account: "me",
      remoteId: "remote",
      origin: "planner",
      base: primary,
      conflict: false,
      seen: null,
    },
    task: task.parse({
      id,
      kind: "event",
      title: "Renamed",
      schedule: primary.schedule,
      completed: false,
      parentId: null,
      durationMinutes: null,
      revision: 1,
    }),
  };
  const remote = {
    id: "remote",
    version: "etag",
    personal: true,
    ownerTag: "owner",
    fields: other,
  };
  const api: Calendar = {
    get: vi.fn(async () => remote),
    create: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
    destination: vi.fn(),
    occurrences: vi.fn(),
  };
  expect(await reconcileExport(api, "dest", "owner", both, row)).toMatchObject({
    kind: "sync",
    written: true,
    apply: true,
    fields: { title: "Renamed", schedule: other.schedule },
  });
  expect(api.update).toHaveBeenCalledWith("dest", "remote", "etag", {
    title: "Renamed",
    schedule: other.schedule,
  });
  remote.fields = { ...other, title: "Remote rename" };
  expect(await reconcileExport(api, "dest", "owner", both, row)).toEqual({ kind: "conflict" });
  remote.fields = { ...primary, title: "Renamed" };
  row.link.base = null;
  expect(await reconcileExport(api, "dest", "owner", both, row)).toMatchObject({
    kind: "sync",
    written: false,
  });
  expect(api.create).not.toHaveBeenCalled();
});
it("rechecks the local edit during lookup and blocks changes during paired deletion", async () => {
  const planner = bindings.USER_PLANNER.getByName(crypto.randomUUID());
  const origin = "https://test/api/tasks";
  const made = task.parse(
    await (
      await planner.fetch(origin, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "event", ...primary }),
      })
    ).json(),
  );
  const url = origin + "/" + made.id;
  const rename = (revision: number, title: string) =>
    planner.fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, title }),
    });
  const account = "account";
  expect(await planner.publishCalendar(made.id, account, true)).toBe(true);
  const [{ link }] = await planner.calendarExports(account, "");
  await planner.finishCalendarExport(made.id, link.remoteId, made, {
    kind: "sync",
    fields: primary,
    apply: false,
    written: true,
  });

  const remote: CalendarEvent = {
    id: link.remoteId,
    fields: primary,
    personal: true,
    version: "v1",
    ownerTag: "owner",
  };
  const api: Calendar = {
    get: vi
      .fn()
      .mockImplementationOnce(async () => {
        expect((await rename(made.revision, "Edited during Google lookup")).status).toBe(200);
        return remote;
      })
      .mockResolvedValue(remote),
    create: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
    destination: vi.fn(),
    occurrences: vi.fn(),
  };
  const begin = (id: string, remoteId: string, revision: number) =>
    planner.beginCalendarDeletion(id, remoteId, revision);
  expect(await planner.requestCalendarDeletion(made.id, account, made.revision)).toBe(true);
  const [stale] = await planner.calendarExports(account, "");
  const conflict = await reconcileExport(api, "dest", "owner", both, stale, begin);
  expect(conflict).toEqual({ kind: "conflict" });
  expect(api.remove).not.toHaveBeenCalled();
  await planner.finishCalendarExport(made.id, link.remoteId, stale.task, conflict!);

  const current = task.parse(await (await planner.fetch(url)).json());
  expect(current.title).toBe("Edited during Google lookup");
  expect(await planner.requestCalendarDeletion(current.id, account, current.revision)).toBe(true);
  const [fresh] = await planner.calendarExports(account, "");
  vi.mocked(api.remove).mockImplementationOnce(async () => {
    expect((await rename(current.revision, "Edited during Google deletion")).status).toBe(409);
    expect((await planner.fetch(url, { method: "DELETE" })).status).toBe(409);
    throw new Error("Connection lost after remote delete");
  });
  await expect(reconcileExport(api, "dest", "owner", both, fresh, begin)).rejects.toThrow(
    "Connection lost",
  );
  expect(api.remove).toHaveBeenCalledWith("dest", link.remoteId, "v1");
  expect((await rename(current.revision, "Edited before retry")).status).toBe(409);
  vi.mocked(api.get).mockResolvedValueOnce(null);
  const retry = await reconcileExport(api, "dest", "owner", both, fresh, begin);
  expect(retry).toEqual({ kind: "deleted" });
  await planner.finishCalendarExport(current.id, link.remoteId, fresh.task, retry!);
  expect((await planner.fetch(url)).status).toBe(404);
});

it("uses Google SDK requests under workerd for inbox history and multi-day calendar events", async () => {
  const auth = new OAuth2Client({
    transporterOptions: {
      fetchImplementation: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/history")) {
          expect(url.searchParams.get("startHistoryId")).toBe("10");
          return Response.json({
            historyId: "11",
            history: [{ messagesAdded: [{ message: { id: "mail" } }] }],
          });
        }
        expect(url.searchParams.get("singleEvents")).toBe("true");
        return Response.json({
          items: [
            {
              id: "stay",
              etag: "v",
              summary: "Trip",
              start: { date: "2026-03-07" },
              end: { date: "2026-03-10" },
            },
          ],
        });
      },
    },
  });
  auth.setCredentials({ access_token: "test" });
  expect((await gmailInbox(auth, "topic").changes("10")).messages).toEqual([
    { id: "mail", threadId: undefined },
  ]);
  const { events } = await googleCalendar(auth).occurrences(
    "2026-03-01T00:00:00Z",
    "2026-04-01T00:00:00Z",
  );
  expect(events[0].fields?.schedule).toEqual({
    type: "day",
    date: "2026-03-07",
    endDateExclusive: "2026-03-10",
  });
  expect(googleEvent({ id: "meeting", attendees: [{}] }).personal).toBe(false);
});

it("publishes a selected 2do event, receives a verified calendar notification, and imports a remote edit back into that same event", async () => {
  const planner = bindings.USER_PLANNER.getByName(crypto.randomUUID());
  const stub = bindings.GOOGLE_CONNECTION.getByName("google-calendar/" + planner.id);
  const { seal } = await import("../src/connectors/auth.ts");
  type GoogleEvent = import("@googleapis/calendar").calendar_v3.Schema$Event;
  let published: GoogleEvent | undefined;
  let destination = "destination";
  const channels: { id: string; token: string }[] = [];
  const calls: string[] = [];
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    calls.push(method + " " + url.pathname);
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "access", token_type: "Bearer", expires_in: 3600 });
    if (url.pathname.endsWith("/events/watch")) {
      const channel = JSON.parse(String(init?.body));
      channels.push(channel);
      return Response.json({
        resourceId: "resource",
        expiration: String(Date.now() + 7 * 86_400_000),
      });
    }
    if (url.pathname.endsWith("/calendars/primary/events"))
      return Response.json({
        items: [
          {
            id: "source",
            summary: "Imported",
            etag: "v1",
            start: { date: "2026-11-25" },
            end: { date: "2026-11-26" },
          },
        ],
      });
    if (url.pathname.endsWith("/calendarList")) return Response.json({ items: [] });
    const missing = () =>
      Response.json({ error: { code: 404, message: "missing" } }, { status: 404 });
    if (url.pathname.includes("/calendarList/"))
      return url.pathname.endsWith("/" + destination)
        ? Response.json({ id: destination })
        : missing();
    if (url.pathname.endsWith("/calendars") && method === "POST")
      return Response.json({ id: destination });
    if (url.pathname.endsWith("/" + destination + "/events") && method === "POST") {
      published = { ...JSON.parse(String(init?.body)), etag: "version-1" };
      return Response.json(published);
    }
    if (url.pathname.includes("/events/")) {
      if (
        !url.pathname.includes("/" + destination + "/events/") ||
        !published ||
        !url.pathname.endsWith("/" + published.id)
      )
        return missing();
      if (method === "DELETE") {
        expect(new Headers(init?.headers).get("If-Match")).toBe(published.etag);
        published = undefined;
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") {
        expect(new Headers(init?.headers).get("If-Match")).toBe(published.etag);
        published = { ...published, ...JSON.parse(String(init?.body)), etag: "version-3" };
      }
      return Response.json(published);
    }
    if (url.pathname.endsWith("/channels/stop")) return new Response(null, { status: 204 });
    throw new Error("Unmatched Google fixture " + url.pathname);
  });
  const tick = () =>
    runInDurableObject(stub, async (instance) => {
      await (instance as GoogleConnection).alarm();
    });
  const until = async (complete: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 12; i++) {
      await tick();
      const status = await stub.status("google-calendar");
      expect(status.error).toBeNull();
      if (await complete()) return;
    }
    throw new Error("Calendar sync did not converge: " + calls.join(", "));
  };
  try {
    await runInDurableObject(stub, async (_, ctx) => {
      ctx.storage.kv.put("grant", {
        planner: planner.id.toString(),
        kind: "google-calendar",
        sub: "sub",
        email: "calendar@example.com",
        options: both,
        permissions: scopes("google-calendar", both),
        installed: Date.now(),
        token: await seal(
          "refresh",
          "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          stub.id.toString(),
        ),
      });
    });
    const make = async (title: string) =>
      task.parse(
        await (
          await planner.fetch("https://test/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "event", ...primary, title }),
          })
        ).json(),
      );
    const local = await make("Publish this");
    const privateEvent = await make("Keep local");
    expect(await stub.link(local.id, true)).toBe(true);
    await until(() => published?.summary === local.title);
    expect(published?.summary).toBe(local.title);
    expect(await planner.calendarLinkStatus(privateEvent.id)).toBe("unlinked");
    expect(
      calls.filter((c) => c === "POST /calendar/v3/calendars/destination/events"),
    ).toHaveLength(1);
    expect(channels.length).toBeGreaterThan(0);
    const notify = (token: string) =>
      SELF.fetch("https://twodo.example/hooks/google-calendar", {
        method: "POST",
        headers: {
          "X-Goog-Channel-Token": token,
          "X-Goog-Channel-ID": channels[0].id,
          "X-Goog-Resource-ID": "resource",
        },
      });
    expect((await notify(stub.id.toString() + "." + crypto.randomUUID())).status).toBe(403);
    expect((await notify(channels[0].token)).status).toBe(204);
    published = { ...published, summary: "Rescheduled in Google", etag: "version-2" };
    await until(
      async () =>
        task.parse(await (await planner.fetch("https://test/api/tasks/" + local.id)).json())
          .title === "Rescheduled in Google",
    );
    const updated = task.parse(
      await (await planner.fetch("https://test/api/tasks/" + local.id)).json(),
    );
    expect(updated.title).toBe("Rescheduled in Google");
    await planner.fetch("https://test/api/tasks/" + local.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: updated.revision, title: "Edited in 2do" }),
    });
    await until(() => published?.summary === "Edited in 2do");
    expect(published.summary).toBe("Edited in 2do");
    const localUrl = "https://test/api/tasks/" + local.id;
    const latest = task.parse(await (await planner.fetch(localUrl)).json());
    expect(await stub.deleteEvent(local.id, latest.revision - 1)).toBe(false);
    expect(await stub.deleteEvent(local.id, latest.revision)).toBe(true);
    await until(async () => (await planner.fetch(localUrl)).status === 404);
    expect(published).toBeUndefined();
    expect((await planner.fetch("https://test/api/tasks/" + privateEvent.id)).status).toBe(200);
    expect(await stub.link(privateEvent.id, true)).toBe(true);
    await until(() => published?.summary === privateEvent.title);
    destination = "replacement";
    published = undefined;
    const next = await make("Export after calendar removal");
    expect(await stub.link(next.id, true)).toBe(true);
    await until(
      async () =>
        published?.summary === next.title &&
        (await planner.calendarLinkStatus(privateEvent.id)) === "unlinked",
    );
    expect(calls).toContain("POST /calendar/v3/calendars/replacement/events");
    expect((await planner.fetch("https://test/api/tasks/" + privateEvent.id)).status).toBe(200);
    expect(await stub.options(disabled)).toBe(true);
    await tick();
    const count = calls.length;
    await tick();
    expect(calls).toHaveLength(count);
    await stub.disconnect();
  } finally {
    transport.mockRestore();
  }
});
