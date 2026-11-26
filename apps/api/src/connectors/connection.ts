import { CalendarWatches } from "./calendar-watches.ts";
import { DurableObject } from "cloudflare:workers";
import { CalendarDestinationMissing } from "../interfaces/connectors.ts";
import type {
  Calendar,
  ConnectorKind,
  Directions,
  Email,
  EmailReceiver,
} from "../interfaces/connectors.ts";
import {
  configured,
  consent,
  oauth,
  scopes,
  seal,
  unseal,
  verifiedGoogleIdentity,
  type GoogleSecrets,
} from "./auth.ts";
import { gmailInbox, googleCalendar, httpStatus } from "./google.ts";
import { readMailPage, type MailProgress } from "./mail-intake.ts";
import { reconcileExport } from "../core/calendar-sync.ts";
import type { UserPlanner } from "../user-planner.ts";

export type ConnectorEnv = GoogleSecrets & {
  USER_PLANNER: DurableObjectNamespace<UserPlanner>;
  GOOGLE_CONNECTION: DurableObjectNamespace<GoogleConnection>;
  GMAIL_DIRECTORY: DurableObjectNamespace<GmailDirectory>;
};
const disabled = { importEvents: false, exportEvents: false };
const minute = 60_000;
const day = 86_400_000;
interface Pending {
  state: string;
  codeVerifier: string;
  expires: number;
  planner: string;
  kind: ConnectorKind;
  options: Directions;
}
interface Grant {
  kind: ConnectorKind;
  planner: string;
  email: string;
  sub: string;
  token: string;
  permissions: string[];
  options: Directions;
  installed: number;
  destination?: string;
  lastSync?: number;
  error?: string;
  failures?: number;
  retryAt?: number;
}
type Scan = {
  id: string;
  start: string;
  end: string;
  page?: string;
  stage: "import" | "sweep" | "export";
  after: string;
};
export class GmailDirectory extends DurableObject {
  claim(connection: string) {
    const owner = this.owner();
    if (owner && owner !== connection) return false;
    this.ctx.storage.kv.put("owner", connection);
    return true;
  }
  owner() {
    return this.ctx.storage.kv.get<string>("owner") ?? null;
  }
  release(connection: string) {
    if (this.owner() === connection) this.ctx.storage.kv.delete("owner");
  }
}

export class GoogleConnection extends DurableObject<ConnectorEnv> {
  private get kv() {
    return this.ctx.storage.kv;
  }
  private get id() {
    return this.ctx.id.toString();
  }
  private grant() {
    return this.kv.get<Grant>("grant");
  }
  private readonly watches = new CalendarWatches(this.ctx.storage.kv, this.ctx.id.toString());
  private tail: Promise<unknown> = Promise.resolve();
  // Serialize provider state changes for this connection only. Webhook admission is independent.
  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => {});
    return next;
  }
  status(kind: ConnectorKind) {
    const grant = this.grant();
    return {
      configured: configured(this.env, kind),
      account: grant?.email ?? null,
      directions: grant?.options ?? disabled,
      lastSync: grant?.lastSync ?? null,
      error: grant?.error ?? null,
    };
  }
  begin(planner: string, kind: ConnectorKind, options: Directions) {
    return this.run(async () => {
      if (this.kv.get("closing"))
        return { error: "Disconnect is still completing.", status: 409 } as const;
      if (!configured(this.env, kind))
        return { error: "Google connector credentials are missing.", status: 503 } as const;
      const { state, codeVerifier, url } = await consent(
        oauth(this.env, kind),
        scopes(kind, options),
      );
      this.kv.put("pending", {
        state,
        codeVerifier,
        expires: Date.now() + 10 * minute,
        planner,
        kind,
        options,
      } satisfies Pending);
      return { url } as const;
    });
  }
  complete(state: string, code: string) {
    return this.run(async () => {
      const p = this.kv.get<Pending>("pending");
      if (!p || p.state !== state || p.expires < Date.now())
        return "Invalid or expired consent. Start again in Settings.";
      this.kv.delete("pending");
      const client = oauth(this.env, p.kind);
      const { tokens } = await client.getToken({ code, codeVerifier: p.codeVerifier });
      const identity = await verifiedGoogleIdentity(
        tokens.id_token ?? "",
        this.env.GOOGLE_CLIENT_ID!,
      );
      const previous = this.grant();
      if (previous && (previous.sub !== identity.sub || previous.email !== identity.email))
        return "Disconnect the current account before choosing another.";
      const permissions = (tokens.scope ?? "").split(" ");
      if (!scopes(p.kind, p.options).every((s) => permissions.includes(s)))
        return "The selected feature permissions were not granted.";
      const token = tokens.refresh_token
        ? await seal(tokens.refresh_token, this.env.GOOGLE_TOKEN_KEY!, this.id)
        : previous?.token;
      if (!token) return "Offline access was not granted. Reconnect Google.";
      const grant: Grant = {
        ...previous,
        kind: p.kind,
        planner: p.planner,
        email: identity.email,
        sub: identity.sub,
        installed: previous?.installed ?? Date.now(),
        token,
        permissions,
        options: p.options,
        error: undefined,
        failures: 0,
        retryAt: undefined,
      };
      if (previous?.options.exportEvents && !grant.options.exportEvents)
        await this.cancelDeletions(grant);
      // Persist setup intent before the cross-object mailbox claim. On a crash the alarm retries it.
      await this.ctx.storage.transaction(async (tx) => {
        this.kv.put("grant", grant);
        this.kv.delete("scan");
        await tx.setAlarm(Date.now());
      });
      return null;
    });
  }
  private cachedAuth?: { token: string; client: ReturnType<typeof oauth> };
  private async auth(g: Grant) {
    if (this.cachedAuth?.token === g.token) return this.cachedAuth.client;
    const client = oauth(this.env, g.kind);
    client.setCredentials({
      refresh_token: await unseal(g.token, this.env.GOOGLE_TOKEN_KEY!, this.id),
    });
    this.cachedAuth = { token: g.token, client };
    return client;
  }
  private cancelDeletions(g: Grant) {
    return this.env.USER_PLANNER.get(
      this.env.USER_PLANNER.idFromString(g.planner),
    ).cancelCalendarDeletions();
  }
  options(options: Directions) {
    return this.run(async () => {
      const g = this.grant();
      if (!g || !scopes("google-calendar", options).every((s) => g.permissions.includes(s)))
        return false;
      if (g.options.exportEvents && !options.exportEvents) await this.cancelDeletions(g);
      await this.ctx.storage.transaction(async (tx) => {
        this.kv.put("grant", { ...g, options });
        this.kv.delete("scan");
        await tx.setAlarm(Date.now());
      });
      return true;
    });
  }
  disconnect() {
    return this.run(async () => {
      await this.ctx.storage.transaction(async (tx) => {
        this.kv.put("closing", true);
        this.kv.delete("pending");
        await tx.setAlarm(Date.now() + minute);
      });
      await this.finishDisconnect();
    });
  }
  private async finishDisconnect() {
    const g = this.grant();
    if (g?.kind === "google-calendar") {
      await this.cancelDeletions(g);
      try {
        const api = googleCalendar(await this.auth(g));
        if (api.notifications) await this.watches.refresh(api.notifications, "", []);
      } catch {
        /* An unusable or revoked credential must still be removable. */
      }
    }
    if (g?.kind === "gmail") {
      const directory = this.env.GMAIL_DIRECTORY.getByName(g.email);
      if ((await directory.owner()) === this.id) {
        try {
          await gmailInbox(await this.auth(g), this.env.GMAIL_PUBSUB_TOPIC!).stop();
        } catch {
          /* Unrouted watches expire. */
        }
        await directory.release(this.id);
      }
    }
    this.cachedAuth = undefined;
    await this.ctx.storage.deleteAll();
  }
  async calendarNotice(channel: string, secret: string, resource: string) {
    if (
      !this.watches.matches(channel, secret, resource) ||
      this.grant()?.kind !== "google-calendar"
    )
      return false;
    await this.wake();
    return true;
  }
  async wake(email?: string) {
    const g = this.grant();
    if (this.kv.get("closing") || !g || (email && (g.kind !== "gmail" || g.email !== email)))
      return;
    await this.ctx.storage.transaction(async (tx) => {
      this.kv.put("wake", crypto.randomUUID());
      await tx.setAlarm(Math.max(Date.now(), g.retryAt ?? 0));
    });
  }
  // Future agent delivery attaches here. The initial implementation retains message IDs only.
  protected receiveEmail: EmailReceiver = async () => {};
  private async mail(g: Grant, email: Email) {
    const directory = this.env.GMAIL_DIRECTORY.getByName(g.email);
    if (!(await directory.claim(this.id))) throw new Error("Mailbox already connected");
    const now = Date.now();
    let progress = this.kv.get<MailProgress>("mail");
    if (!progress) {
      const watch = await email.start();
      progress = { ...watch, since: g.installed, recovering: true };
      this.kv.put("mail", progress);
    }
    const next = await readMailPage(
      email,
      g.email,
      progress,
      async (mailbox, message) => {
        const key = "received:" + message.id;
        if (this.kv.get(key)) return;
        await this.receiveEmail(mailbox, message);
        this.kv.put(key, true);
      },
      now,
    );
    this.kv.put("mail", next);
    return next.page || next.recovering ? 1 : 5 * minute;
  }
  private async calendars(g: Grant, calendar: Calendar) {
    if (!this.kv.get("scan") && calendar.notifications) {
      const ids = [
        g.options.importEvents ? "primary" : null,
        g.options.importEvents || g.options.exportEvents ? g.destination : null,
      ].filter((id): id is string => !!id);
      await this.watches.refresh(
        calendar.notifications,
        new URL("/hooks/google-calendar", this.env.GOOGLE_CONNECTOR_ORIGIN).href,
        ids,
      );
    }
    if (!g.options.importEvents && !g.options.exportEvents) return null;
    const planner = this.env.USER_PLANNER.get(this.env.USER_PLANNER.idFromString(g.planner));
    const now = Date.now();
    const scan = this.kv.get<Scan>("scan") ?? {
      id: crypto.randomUUID(),
      start: new Date(now - 30 * day).toISOString(),
      end: new Date(now + 90 * day).toISOString(),
      stage: g.options.importEvents ? "import" : "export",
      after: "",
    };
    if (scan.stage === "import") {
      const page = await calendar.occurrences(scan.start, scan.end, scan.page);
      await planner.importCalendar(g.sub, scan.id, page.events);
      scan.page = page.nextPage;
      if (!scan.page) scan.stage = "sweep";
    } else if (scan.stage === "sweep") {
      if (!(await planner.finishCalendarImport(g.sub, scan.id))) scan.stage = "export";
    } else {
      const rows = await planner.calendarExports(g.sub, scan.after);
      if (!rows.length) {
        this.kv.delete("scan");
        return 5 * minute;
      }
      if (!g.destination && g.options.exportEvents) {
        g.destination = await calendar.destination(this.id);
        this.kv.put("grant", g);
      }
      if (g.destination) {
        for (const row of rows) {
          let result;
          try {
            result = await reconcileExport(
              calendar,
              g.destination,
              this.id,
              g.options,
              row,
              (id, remoteId, revision) => planner.beginCalendarDeletion(id, remoteId, revision),
            );
          } catch (e) {
            if (e instanceof CalendarDestinationMissing) {
              // The missing copy no longer proves its last version, so preserve the local event.
              await planner.cancelCalendarDeletions();
              delete g.destination;
              this.kv.delete("scan");
              return 1;
            }
            // Skip an invalid or concurrently modified event; unrelated links still progress.
            // Transient service and quota errors back off the connection.
            if (![400, 404, 409, 410, 412].includes(httpStatus(e) ?? 0)) throw e;
            result = { kind: "conflict" } as const;
          }
          if (result)
            await planner.finishCalendarExport(
              row.link.taskId,
              row.link.remoteId,
              row.task,
              result,
            );
          scan.after = row.link.taskId;
          this.kv.put("scan", scan);
        }
      }
      scan.after = rows[rows.length - 1].link.taskId;
    }
    this.kv.put("scan", scan);
    return 1;
  }
  async alarm() {
    await this.run(async () => {
      if (this.kv.get("closing")) {
        await this.finishDisconnect();
        return;
      }
      const g = this.grant();
      if (!g) return;
      const wake = this.kv.get<string>("wake");
      // Recover after interruption even if the platform exhausts its short retry window.
      await this.ctx.storage.setAlarm(Date.now() + 5 * minute);
      let delay: number | null;
      try {
        const auth = await this.auth(g);
        delay =
          g.kind === "gmail"
            ? await this.mail(g, gmailInbox(auth, this.env.GMAIL_PUBSUB_TOPIC!))
            : await this.calendars(g, googleCalendar(auth));
        g.error = undefined;
        g.failures = 0;
        g.retryAt = undefined;
        if (delay !== 1) g.lastSync = Date.now();
      } catch (err) {
        g.failures = (g.failures ?? 0) + 1;
        const status = httpStatus(err);
        g.error =
          err instanceof Error && err.message === "Mailbox already connected"
            ? err.message
            : status === 401 ||
                status === 403 ||
                (err as { response?: { data?: { error?: string } } })?.response?.data?.error ===
                  "invalid_grant"
              ? "Google access needs attention. Reconnect or check provider permissions."
              : "Sync interrupted. Retrying automatically.";
        if (g.kind === "google-calendar" && (status === 410 || status === 400))
          this.kv.delete("scan");
        const retryAfter = (err as { response?: { headers?: Headers } })?.response?.headers?.get?.(
          "Retry-After",
        );
        const wait = retryAfter
          ? /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Date.parse(retryAfter) - Date.now()
          : 0;
        delay = Math.max(
          Number.isFinite(wait) ? wait : 0,
          Math.min(60 * minute, 5000 * 2 ** Math.min(g.failures, 10)),
        );
        g.retryAt = Date.now() + delay;
      }
      await this.ctx.storage.transaction(async (tx) => {
        this.kv.put("grant", g);
        if (this.kv.get("wake") !== wake && !g.retryAt) delay = 1;
        if (delay === null) await tx.deleteAlarm();
        else await tx.setAlarm(Date.now() + delay);
      });
    });
  }
  deleteEvent(taskId: string, revision: number) {
    return this.run(async () => {
      const g = this.grant();
      if (!g?.options.exportEvents || this.kv.get("closing")) return false;
      const planner = this.env.USER_PLANNER.get(this.env.USER_PLANNER.idFromString(g.planner));
      if (!(await planner.requestCalendarDeletion(taskId, g.sub, revision))) return false;
      await this.wake();
      return true;
    });
  }
  link(taskId: string, enabled: boolean) {
    return this.run(async () => {
      const g = this.grant();
      if (!g || (enabled && !g.options.exportEvents)) return false;
      const planner = this.env.USER_PLANNER.get(this.env.USER_PLANNER.idFromString(g.planner));
      if (!(await planner.publishCalendar(taskId, g.sub, enabled))) return false;
      await this.wake();
      return true;
    });
  }
}
