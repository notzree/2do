import { FitnessImports } from "./db/fitness-import.ts";
import type { RecordedWorkout } from "./interfaces/connectors.ts";
import type { WorkspaceInput } from './agents/workspace-runtime.ts';
import type { reportMilestone } from './interfaces/agents-workspace.ts';
import type { z as workspaceZod } from 'zod';
import {WorkspaceDelivery} from './core/workspace-delivery.ts';
import { AgentsWorkspace } from './core/agents-workspace.ts';
import { agentsWorkspaceRoutes } from './routes/agents-workspace.ts';
import { Temporal } from "@js-temporal/polyfill";
import { chatCalendar } from "./agents/chat-calendar.ts";
import {plannerOwner} from "./agents/chat-identity.ts";
import { connectionGuide, guideTool } from "./connectors/connection-guide.ts";
import { runElicitingTool, UnsupportedElicitation } from "./mcp/elicitation-client.ts";
import type { ConnectorKind } from "./interfaces/connectors.ts";
import { stableInboxKey, digestUuid as taskUuid } from "./core/agent-keys.ts";
import type { ConnectorEnv } from "./connectors/connection.ts";
import { PlannerReminders } from "./core/reminders.ts";
import { reminderRoutes } from "./routes/reminders.ts";
import { agentInboxRoutes, type InboxCaller } from "./routes/agent-inbox.ts";
import {
  AgentInbox,
  publicInboxItem,
  type AgentContext,
  type Execution,
} from "./core/agent-inbox.ts";
import { operationEffect, resolvedEffects } from "./core/agent-approval.ts";
import { installChangeCapture, beginChangeCapture, endChangeCapture } from "./db/agent-diff.ts";
import type { InboxCommand } from "./db/schema.ts";
import type { GroupedChanges, InboxChange, InboxItem } from "./interfaces/agent-inbox.ts";
import { connectorAgentToolNames, executeInboxConnector } from "./connectors/inbox-actions.ts";
import { HTTPException } from "hono/http-exception";
import { Carryover } from "./core/carryover.ts";
import { carryoverRoutes } from "./routes/carryover.ts";
import { PlannerGoals } from "./core/goals.ts";
import { GoalDatabase } from "./db/goals.ts";
import { goalRoutes } from "./routes/goals.ts";
import { clairicExtractor, type TitleExtractor } from "./extractors/clairic.ts";
import { ExtractionQueue } from "./db/subtype-extraction.ts";
import { SubtypeExtraction } from "./core/subtype-extraction.ts";
import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migratePlanner } from "./db/migrate.ts";
import { ClefTaskClassifier } from "./classifiers/clef.ts";
import { Notebook } from "./core/notebook.ts";
import { AgentCalendarReceipts, type CalendarExpectation } from "./core/agent-calendar-receipts.ts";
import { fieldsFor, PlannerCalendars, type ExportResult } from "./core/calendar-sync.ts";
import type { Task, CreateTask } from "./interfaces/plan.ts";
import type { CalendarEvent } from "./interfaces/connectors.ts";
import { Planner, PlannerError } from "./core/planner.ts";
import { TaskClassification } from "./core/task-classification.ts";
import { TaskPlugins } from "./core/task-plugins.ts";
import { TaskSummaries } from "./core/task-summaries.ts";
import { Review } from "./core/review.ts";
import { SqlitePlannerDatabase } from "./db/planner.ts";
import { PlannerImages } from "./db/planner-images.ts";
import { inboxRows, sideChats, taskCaptures } from "./db/schema.ts";
import { SqliteTaskPluginDatabase } from "./db/task-plugins.ts";
import type { CommitTaskWrite } from "./interfaces/database.ts";
import type { TaskClassifier } from "./interfaces/task-classifier.ts";
import { plannerScopeHeader } from "./interfaces/notebook.ts";
import { plannerMcpHandler, plannerToolRequest } from "./mcp/server.ts";
import { budgetingPlugin } from "./plugins/budgeting.ts";
import { fitnessPlugin } from "./plugins/fitness.ts";
import { productivityPlugin } from "./plugins/productivity.ts";
import { nutritionPlugin } from "./plugins/meal.ts";
import { mealEstimator } from "./plugins/meal-workflow.ts";
import type { EffectHandler } from "./interfaces/plugin-workflows.ts";
import { PluginReports } from "./core/plugin-reports.ts";
import { pluginReportRoutes } from "./routes/plugin-reports.ts";
import { chatRoutes } from "./routes/chats.ts";
import { imageRoutes } from "./routes/images.ts";
import { notebookRoutes } from "./routes/notebook.ts";
import { plannerApi } from "./routes/planner-api.ts";
import { plannerRoutes } from "./routes/tasks.ts";
import { taskSummaryRoutes } from "./routes/task-summaries.ts";
import { reviewRoutes } from "./routes/review.ts";

const calendarDeleteRequest = "calendar:delete:";
const calendarDeletionLock = "calendar:deleting:";

export class UserPlanner extends DurableObject<Env> {
  private readonly store = drizzle(this.ctx.storage);
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      await migratePlanner(this.store);
      this.reminders.migrate();
      installChangeCapture(this.ctx.storage);
      this.plugins.workflows.migrate();
      // A cold start may precede delivery of an existing alarm or its platform retry.
      if ((await this.ctx.storage.getAlarm()) === null) {
        const due = this.nextDue();
        if (due !== null) await this.ctx.storage.setAlarm(due);
      }
    });
  }
  private readonly workspace = new AgentsWorkspace(this.ctx.storage.sql);
  private readonly db = new SqlitePlannerDatabase(this.store);
  private readonly images = new PlannerImages(
    this.store,
    this.env.NOTEBOOK_IMAGES,
    this.ctx.id.toString(),
  );
  private readonly pluginDb = new SqliteTaskPluginDatabase(this.store);
  private readonly plugins = new TaskPlugins(
    this.db,
    this.pluginDb,
    [nutritionPlugin, fitnessPlugin, budgetingPlugin, productivityPlugin],
    undefined,
    this.createEffects(),
    (task, definition, subtype, text) => this.extraction?.enqueue(task, definition, subtype, text),
  );
  private readonly extractor = this.createExtractor();
  private readonly extraction: SubtypeExtraction | undefined =
    this.extractor &&
    new SubtypeExtraction(new ExtractionQueue(this.store), this.db, this.plugins, this.extractor);
  private readonly classifier = this.createClassifier();
  private readonly classification =
    this.classifier &&
    new TaskClassification(this.db, this.plugins, this.classifier, this.classificationBatchSize());
  private readonly planner = new Planner(
    this.db,
    (task, previous, rawInput) => {
      if (previous) this.guardCalendarDeletion(task.id);
      this.reminders.taskChanged(task);
      this.calendars.guard(task, previous);
      this.plugins.workflows.taskChanged(task, previous);
      if (this.calendars.processingImport) return;
      if (task.title === previous?.title) return;
      if (previous) this.extraction?.queue.cancelTask(task.id);
      if (previous)
        this.store
          .update(taskCaptures)
          .set({ currentInput: false })
          .where(eq(taskCaptures.taskId, task.id))
          .run();
      if (this.classification) this.classification.enqueue(task, Date.now(), rawInput);
      else if (previous) this.pluginDb.supersedeCaptureInput(task.id);
    },
    (id) => {
      const capture =
        id && this.store.select().from(taskCaptures).where(eq(taskCaptures.taskId, id)).get();
      return (capture && capture.document.timeZone) || this.pluginDb.reports.timeZone();
    },
    (id) => this.guardCalendarDeletion(id),
  );
  private readonly fitnessImports = new FitnessImports(this.store);

  fitnessImportEpoch() {
    return this.pluginDb.installations().get("fitness") ?? null;
  }
  applyWorkoutPage(account: string, epoch: string, scan: string, rows: RecordedWorkout[], complete: boolean) {
    return this.db.transaction(() => {
      if (this.fitnessImportEpoch() !== epoch) return false;
      if (this.fitnessImports.apply(account, scan, rows, complete, this.pluginDb.reports.timeZone()))
        this.db.advanceRevision();
      return true;
    });
  }
  recentWearableWorkouts() {
    return this.fitnessImportEpoch() ? this.fitnessImports.recent() : [];
  }
  clearWearableWorkouts(account: string) {
    this.db.transaction(() => {
      if (this.fitnessImports.clear(account)) this.db.advanceRevision();
    });
  }

  private readonly calendars: PlannerCalendars = new PlannerCalendars(this.store, this.planner);

  private guardCalendarDeletion(id: string) {
    if (this.ctx.storage.kv.get<number>(calendarDeletionLock + id) !== undefined)
      throw new PlannerError(409, "This event is being deleted from 2do and Google Calendar.");
  }

  calendarLinkStatus(id: string) {
    return this.calendars.status(id);
  }
  async publishCalendar(
    id: string,
    account: string,
    enabled: boolean,
    expected?: { revision: number; status: string },
    receiptId?: string,
  ) {
    try {
      await this.commitTaskWrite(() => {
        if (receiptId && this.calendarReceipts.state(receiptId)) return;
        if (
          expected &&
          (this.db.task(id)?.revision !== expected.revision ||
            this.calendars.status(id) !== expected.status)
        )
          throw new PlannerError(409, "This calendar event changed.");
        const link = this.calendars.link(id);
        this.calendars.publish(id, account, enabled);
        if (enabled) this.ctx.storage.kv.put("agent-calendar:enabled:" + account, true);
        if (receiptId && enabled) {
          const current = this.calendars.link(id)!;
          this.calendarReceipts.remember({
            receiptId,
            taskId: id,
            remoteId: current.remoteId,
            account,
            expected: fieldsFor(this.db.task(id))!,
            revision: this.db.task(id)?.revision,
          });
        }
        if (link && !enabled) {
          this.calendarReceipts.cancel(account, link.remoteId);
          this.ctx.storage.kv.delete(calendarDeleteRequest + link.remoteId);
          this.ctx.storage.kv.delete(calendarDeletionLock + id);
        }
      });
      return true;
    } catch (error) {
      if (error instanceof PlannerError) return false;
      throw error;
    }
  }
  async importCalendar(account: string, generation: string, events: CalendarEvent[]) {
    await this.commitTaskWrite(() => this.calendars.importPage(account, generation, events));
  }
  finishCalendarImport(account: string, generation: string) {
    return this.commitTaskWrite(() => this.calendars.finishImport(account, generation));
  }
  async cancelCalendarDeletions(account?: string) {
    await this.commitTaskWrite(() => {
      this.calendarReceipts.cancel(account);
      for (const prefix of [calendarDeleteRequest, calendarDeletionLock])
        for (const [key] of this.ctx.storage.kv.list({ prefix })) this.ctx.storage.kv.delete(key);
    });
  }
  private async requireCalendarExport(account: string) {
    const key = "agent-calendar:enabled:" + account;
    let enabled = this.ctx.storage.kv.get<boolean>(key);
    if (enabled === undefined) {
      const binding = (this.env as unknown as ConnectorEnv).GOOGLE_CONNECTION;
      const state = await binding
        .getByName("google-calendar/" + this.ctx.id.toString())
        .calendarExportState();
      // A concurrent disconnect or authorization change wins over this first-read backfill.
      enabled =
        this.ctx.storage.kv.get<boolean>(key) ?? (state?.account === account && !!state.enabled);
      this.ctx.storage.kv.put(key, enabled);
    }
    if (!enabled)
      throw new PlannerError(
        409,
        "Calendar export is disabled. Enable export or unlink the event first.",
      );
  }
  async setCalendarExportEnabled(account: string, enabled: boolean) {
    await this.commitTaskWrite(() => {
      this.ctx.storage.kv.put("agent-calendar:enabled:" + account, enabled);
      if (!enabled) this.calendarReceipts.cancel(account);
    });
  }
  async requestCalendarDeletion(id: string, account: string, revision: number, receiptId?: string) {
    return this.commitTaskWrite(() => {
      if (receiptId && this.calendarReceipts.state(receiptId)) return true;
      const link = this.calendars.link(id);
      if (
        !link?.base ||
        link.account !== account ||
        link.origin !== "planner" ||
        this.db.task(id)?.revision !== revision
      )
        return false;
      if (receiptId)
        this.calendarReceipts.remember({
          receiptId,
          taskId: id,
          remoteId: link.remoteId,
          account,
          expected: null,
        });
      this.ctx.storage.kv.put(calendarDeleteRequest + link.remoteId, revision);
      return true;
    });
  }
  async beginCalendarDeletion(id: string, remoteId: string, revision: number) {
    return this.commitTaskWrite(() => {
      if (
        this.calendars.link(id)?.remoteId !== remoteId ||
        this.ctx.storage.kv.get<number>(calendarDeleteRequest + remoteId) !== revision ||
        this.db.task(id)?.revision !== revision
      )
        return false;
      // Keep the revision stable across the Google DELETE and any retry after a lost response.
      this.ctx.storage.kv.put(calendarDeletionLock + id, revision);
      return true;
    });
  }
  calendarExports(account: string, after: string) {
    return this.calendars.exportPage(account, after).map((row) => ({
      ...row,
      deleteRevision: this.ctx.storage.kv.get<number>(calendarDeleteRequest + row.link.remoteId),
    }));
  }
  async finishCalendarExport(
    id: string,
    remoteId: string,
    before: Task | null,
    result: ExportResult,
  ) {
    await this.commitTaskWrite(() => {
      const link = this.calendars.link(id);
      if (link?.remoteId !== remoteId) return;
      if (
        result.kind === "deleted" &&
        (!before || this.ctx.storage.kv.get<number>(calendarDeletionLock + id) !== before.revision)
      )
        throw new PlannerError(409, "The calendar deletion is no longer reserved.");
      this.ctx.storage.kv.delete(calendarDeletionLock + id);
      this.calendars.settle(id, remoteId, before, result);
      this.calendarReceipts.resolve(
        id,
        remoteId,
        link.account,
        result,
        this.calendars.status(id) === "conflict",
        before?.revision,
      );
      this.ctx.storage.kv.delete(calendarDeleteRequest + remoteId);
    });
  }
  private readonly commitTaskWrite: CommitTaskWrite = (write) => this.transaction(write);
  private async transaction<T>(write: () => T | Promise<T>): Promise<T> {
    return this.ctx.storage.transaction(async (txn) => {
      const armed = await txn.getAlarm();
      const previousDue = armed === null ? null : this.nextDue();
      const result = await write();
      const due = this.nextDue();
      // An unrelated task edit must not pull forward a platform retry already in flight.
      if (due !== armed && (armed === null || due === null || due !== previousDue)) {
        if (due === null) await txn.deleteAlarm();
        else await txn.setAlarm(due);
      }
      return result;
    });
  }
  private readonly workspaceDelivery = new WorkspaceDelivery(this.workspace,this.ctx.storage,this.commitTaskWrite,this.env);
  private readonly carryover = new Carryover(this.store, this.planner, this.ctx.storage.kv, () =>
    this.pluginDb.reports.timeZone(),
  );
  private readonly goals = new PlannerGoals(new GoalDatabase(this.store), this.db, this.plugins);
  private readonly review = new Review(
    this.store,
    this.planner,
    (id) => {
      const link = this.calendars.link(id);
      if (!link) return;
      return {
        account: link.account,
        remoteId: link.remoteId,
        status: link.origin === "google" ? "imported" : link.conflict ? "conflict" : "linked",
      };
    },
    (proposal, task) => {
      const target = proposal.calendarTarget!;
      if (this.ctx.storage.kv.get<boolean>("agent-calendar:enabled:" + target.account) !== true)
        throw new PlannerError(409, "Calendar export changed. Review current export settings.");
      this.calendarReceipts.remember({
        receiptId: proposal.id,
        taskId: task.id,
        account: target.account,
        remoteId: target.remoteId,
        expected: fieldsFor(task)!,
        revision: task.revision,
      });
      this.store
        .update(inboxRows)
        .set({ status: "queued", due: null })
        .where(eq(inboxRows.id, proposal.id))
        .run();
    },
  );
  private readonly inbox: AgentInbox = new AgentInbox(this.store, this.ctx.storage, this.review, {
    transaction: (write) => this.transaction(write),
    run: (command, preview) => this.runAgentChange(command, preview),
    trackCalendar: (receiptId, expectations) => {
      for (const item of expectations) this.calendarReceipts.remember({ ...item, receiptId });
    },
    group: (input, context) => this.groupAgentChanges(input, context),
    deliver: async (row) => {
      const continuation = row.document.continuation;
      if (row.status === "queued" && continuation && row.document.providerAnswer) {
        try {
          if (row.document.expiresAt && Date.parse(row.document.expiresAt) <= Date.now())
            throw new UnsupportedElicitation(
              "This connector interaction expired. Start a new connection request.",
            );
          const result = await runElicitingTool(this.googleGuide(), continuation, {
            continuation,
            reply: row.document.providerAnswer,
          });
          await this.commitTaskWrite(() => this.inbox.finishElicitation(row.id, result));
        } catch (error) {
          if (!(error instanceof UnsupportedElicitation)) throw error;
          await this.commitTaskWrite(() => this.inbox.failElicitation(row.id, error.message));
        }
        return "awaiting-provider";
      }
      if (row.status === "queued") {
        const command = row.document.command!;
        return executeInboxConnector(
          this.env,
          this.ctx.id.toString(),
          command.operation,
          command.args,
          row.id,
        );
      } else if (row.document.conversation) {
        const { resumeInboxConversation } = await import("./agents/inbox-resume.ts");
        await resumeInboxConversation({
          ...publicInboxItem(row),
          conversation: row.document.conversation,
        }, async (target,input)=>{
          const owner=plannerOwner(target);
          const chat=target.startsWith("routine:")?target.slice(0,target.indexOf(":",8)):target.startsWith("side:")?target.slice(5,41):"me";
          await this.workspaceDelivery.admit(owner,chat,input);
        });
      }
    },
  });
  private readonly calendarReceipts = new AgentCalendarReceipts(
    this.ctx.storage.kv,
    (id, ok, reason) => this.inbox.settleProvider(id, ok, reason),
  );
  calendarActionReceipt(id: string) {
    return this.calendarReceipts.state(id);
  }
  private readonly reminders = new PlannerReminders(
    this.ctx.storage,
    this.db,
    (input) => {
      this.inbox.publish("notification", input);
    },
    this.env,
    this.ctx.id.toString(),
    undefined,
    async(owner,id,instruction,day,zone)=>{
      await this.commitTaskWrite(()=>this.workspaceDelivery.remember(owner));
      await this.workspaceDelivery.admit(owner,"routine:"+id,{idempotencyKey:id,message:{kind:"signal",type:"planner_routine",body:instruction,attributes:{localDate:day,timeZone:zone}}});
    },
  );
  private buildRoutes(commit: CommitTaskWrite, extractor?: TitleExtractor) {
    return plannerApi<InboxCaller>()
      .route("/", agentInboxRoutes(this.inbox))
      .route("/", agentsWorkspaceRoutes(this.workspace,this.store,this.inbox,commit,(id,owner)=>this.workspaceDelivery.requireMainMessage(id,owner)))
      .route("/", reminderRoutes(this.reminders, commit))
      .route("/", carryoverRoutes(this.carryover, commit))
      .route("/", goalRoutes(this.goals))
      .route(
        "/",
        reviewRoutes(
          this.review,
          commit,
          (id) => this.inbox.markStale(id),
          async (taskId) => {
            const link = this.calendars.link(taskId);
            if (link?.origin === "planner") await this.requireCalendarExport(link.account);
          },
        ),
      )
      .route(
        "/",
        pluginReportRoutes(new PluginReports(this.plugins.workflows.reports, this.plugins)),
      )
      .route("/", taskSummaryRoutes(new TaskSummaries(this.plugins)))
      .route(
        "/",
        plannerRoutes(
          this.planner,
          this.plugins,
          commit,
          this.classification,
          (id) => this.calendars.status(id),
          extractor,
        ),
      )
      .route("/", chatRoutes(this.store,this.workspace))
      .route(
        "/",
        notebookRoutes(
          new Notebook(this.store, this.planner, commit, this.plugins, this.goals, extractor),
        ),
      )
      .route("/", imageRoutes(this.images));
  }
  private readonly routes = this.buildRoutes(this.commitTaskWrite, this.extractor);
  // Both preview and commit use the same validated route with all its domain hooks.
  // This route set runs inside the caller's transaction. Inference, provider I/O and
  // storage alarms run outside rehearsal, so a displayed edit has reproducible effects.
  private readonly changeRoutes = this.buildRoutes(async (write) => write());

  private async runAgentChange(command: InboxCommand, preview: boolean): Promise<Execution> {
    const execute = async () => {
      const changes: InboxChange[] = [];
      const taskTitles: Record<string, string> = {};
      const calendars = new Map<string, CalendarExpectation>();
      const required = new Set<Execution["effects"][number]>();
      let needsReview = false;
      for (const step of command.steps ?? [command]) {
        const result = await this.runAgentStep(step, preview);
        changes.push(...result.changes);
        for (const [id, title] of Object.entries(result.taskTitles ?? {})) taskTitles[id] ??= title;
        for (const calendar of result.calendars ?? []) calendars.set(calendar.remoteId, calendar);
        for (const effect of result.effects) required.add(effect);
        if (result.review) needsReview = true;
      }
      return {
        changes,
        ...(Object.keys(taskTitles).length && { taskTitles }),
        effects: Array.from(required).sort(),
        review: needsReview,
        calendars: [...calendars.values()],
      };
    };
    if (!preview) return execute();
    const previewed = await this.ctx.storage.transaction(async (txn) => {
      const result = await execute();
      txn.rollback();
      return result;
    });
    for (const account of new Set(previewed.calendars.map((c) => c.account)))
      await this.requireCalendarExport(account);
    return previewed;
  }

  private async runAgentStep(command: InboxCommand, preview: boolean): Promise<Execution> {
    const effect = operationEffect(command.operation);
    if (!effect || !command.url || !command.method)
      throw new PlannerError(409, "Unknown planner change.");
    const settings = () =>
      command.operation === "setCarryoverSettings"
        ? this.carryover.settings()
        : command.operation === "setReminderSettings"
          ? this.reminders.settings()
          : ["setReminder", "deleteReminder", "snoozeReminder", "dismissReminder"].includes(
                command.operation,
              )
            ? this.reminders.reviewState(
                String(command.args.id),
                (command.args.requestBody as { occurrence?: string } | undefined)?.occurrence,
              )
            : undefined;
    const before = settings() ?? null;
    const taskId = typeof command.args.id === "string" ? command.args.id : undefined;
    const existingTask = taskId && this.db.task(taskId);
    // Rebase on unrelated task edits. The transaction compares the actual changed fields
    // with the stored preview before it can commit, including their old values.
    const requestBody =
      !preview && command.operation === "updateTask" && existingTask
        ? {
            ...(command.args.requestBody as Record<string, unknown>),
            revision: existingTask.revision,
          }
        : command.args.requestBody;
    beginChangeCapture(this.ctx.storage);
    const response = await this.changeRoutes.fetch(
      new Request(command.url, {
        method: command.method,
        headers: { "content-type": "application/json" },
        ...(requestBody !== undefined && { body: JSON.stringify(requestBody) }),
      }),
      { viewerConversation: this.ctx.storage.kv.get<string>("agent:routing-owner"), captureDate: command.captureDate },
    );
    if (!response.ok) {
      const { error } = await response.json<{ error?: string }>();
      throw new HTTPException(response.status as 409, {
        message: error ?? "Planner change failed.",
      });
    }
    const { changes, taskTitles } = endChangeCapture(this.ctx.storage);
    const after = settings() ?? null;
    if (JSON.stringify(before) !== JSON.stringify(after))
      changes.push({ field: command.operation, before, after });
    const effects = resolvedEffects(effect, changes, (id) =>
      ["linked", "conflict"].includes(this.calendars.status(id)),
    );
    const calendars: CalendarExpectation[] = [];
    const ids = new Set(
      changes.flatMap(({ field }) => {
        const match = /^task ([^ ]+)(?: · (title|kind|schedule))?$/.exec(field);
        return match ? [match[1]] : [];
      }),
    );
    for (const id of ids) {
      const link = this.calendars.link(id);
      if (link?.origin !== "planner") continue;
      if (this.ctx.storage.kv.get("agent-calendar:enabled:" + link.account) === false)
        throw new PlannerError(
          409,
          "Calendar export is disabled. Enable export or unlink the event first.",
        );
      const task = this.db.task(id),
        expected = fieldsFor(task);
      if (task && !expected)
        throw new PlannerError(409, "Unlink the event before removing its calendar schedule.");
      const previous: Record<string, unknown> = { ...task };
      for (const change of changes) {
        if (change.field === "task " + id && change.before) Object.assign(previous, change.before);
        else if (change.field.startsWith("task " + id + " · "))
          previous[change.field.split(" · ")[1]] = change.before;
      }
      const destination = { account: link.account, event: link.remoteId };
      changes.push({
        field: "Linked calendar event " + id,
        before: { ...destination, title: previous.title, schedule: previous.schedule },
        after: expected
          ? { ...destination, ...expected }
          : { ...destination, sync: "detached", providerEvent: "retained" },
      });
      calendars.push({
        account: link.account,
        remoteId: link.remoteId,
        taskId: id,
        expected: expected ?? null,
        detach: !task,
        revision: task?.revision,
      });
    }
    const fixed =
      existingTask &&
      existingTask.schedule?.type === "fixed" &&
      command.operation === "updateTask" &&
      (command.args.requestBody as Record<string, unknown>)?.schedule !== undefined;
    return { changes, taskTitles, effects, calendars, review: !!fixed || effects.includes("external") || (command.operation==="setReminder" && (requestBody as {trigger?:{kind?:string}})?.trigger?.kind==="routine") };
  }
  private prepareTaskCreate(args: Record<string, unknown>, digest: string, context: AgentContext) {
    const body = args.requestBody as Partial<CreateTask>;
    body.id ??= taskUuid(digest);
    if (!context.conversation || context.conversation.startsWith("routine:")) return;

    // Freeze the capture day at admission. Approval and retries may happen on another day.
    const zone = context.calendar?.timeZone ?? this.planner.titleZone();
    const day = context.calendar?.date ?? Temporal.Now.plainDateISO(zone).toString();
    body.titleContext = { timeZone: zone, referenceDate: day, ...body.titleContext };
    if ((body.kind ?? "task") === "task" && body.schedule === undefined && !body.due) {
      body.schedule = { type: "day", date: body.titleContext.defaultDate ?? day };
    }
    return day;
  }

  private async groupAgentChanges(
    input: GroupedChanges,
    context: AgentContext,
  ): Promise<InboxItem> {
    const steps: InboxCommand[] = [];
    for (const [index, step] of input.steps.entries()) {
      if (!operationEffect(step.operation))
        throw new HTTPException(400, {
          message: "This operation cannot run in a local change group.",
        });
      let request;
      try {
        request = plannerToolRequest(step.operation, step.args);
      } catch {
        throw new HTTPException(400, { message: "Invalid arguments for " + step.operation });
      }
      const captureDate = step.operation === "createTask"
        ? this.prepareTaskCreate(step.args, await stableInboxKey([input.id, index]), context)
        : undefined;
      steps.push({ ...step, method: request.method, url: request.url, captureDate });
    }
    const key = await stableInboxKey(["group", input.id, context.conversation]);
    return this.inbox.request(
      "group-" + key,
      { operation: "proposeChanges", args: {}, steps },
      context,
      { title: input.title, body: input.reason, expiresAt: input.expiresAt },
    );
  }
  async finishReminderBrief(jobId: string, order: number[]) {
    return this.commitTaskWrite(() => this.reminders.finishBrief(jobId, order));
  }

  private googleGuide() {
    const env = this.env as unknown as ConnectorEnv;
    return connectionGuide(env.GOOGLE_CONNECTOR_ORIGIN, (kind) =>
      env.GOOGLE_CONNECTION.getByName(kind + "/" + this.ctx.id.toString()).status(kind),
    );
  }
  async startConnectionGuide(
    workflow: string,
    args: { kind?: ConnectorKind },
    conversation?: string,
  ) {
    const id = await stableInboxKey([workflow, conversation, args]);
    const replay = this.inbox.published("mcp-" + id + "-1");
    if (replay) return replay;
    let result;
    try {
      result = await runElicitingTool(this.googleGuide(), { workflow: id, tool: guideTool, args });
    } catch (error) {
      if (error instanceof UnsupportedElicitation) throw new PlannerError(409, error.message);
      throw error;
    }
    if (result.kind === "complete") return { status: "complete" as const, text: result.text };
    return this.commitTaskWrite(() => this.inbox.elicitationQuestion(result, conversation));
  }
  proposeConnector(input: Parameters<AgentInbox["external"]>[0]) {
    return this.inbox.external(input);
  }
  async proposeMailTask(input: { id: string; title: string; body: string; source: string }) {
    const digest = await stableInboxKey(["mail", input.id]);
    const taskId = taskUuid(digest);
    return this.inbox.request(
      "mail-" + digest,
      {
        operation: "createTask",
        method: "POST",
        url: "https://planner.internal/api/tasks",
        args: { requestBody: { id: taskId, title: input.title } },
      },
      {},
      { title: input.title, body: input.body, source: input.source },
    );
  }

  private async agentFetch(request: Request) {
    const chat = request.headers.get("x-2do-agent-chat");
    const origin = request.headers.get("x-2do-agent-origin");
    const context: AgentContext = {
      calendar: chatCalendar.safeParse({
        date: request.headers.get("x-2do-agent-date"),
        timeZone: request.headers.get("x-2do-agent-zone"),
      }).data,
      conversation: chat ? decodeURIComponent(chat) : undefined,
      replaces: request.headers.get("x-2do-agent-replaces") ?? undefined,
      submission: request.headers.get("x-2do-agent-submission") ?? undefined,
      origin: origin === "chat" || origin === "scheduled" ? origin : undefined,
    };
    // Provider and timer callbacks later address this planner by its opaque ID.
    // Only persist an authenticated name that actually derives this object's ID.
    if (context.conversation) {
      const owner=plannerOwner(context.conversation);
      if (this.env.USER_PLANNER.idFromName(owner).toString() !== this.ctx.id.toString())
        return Response.json({error:"Conversation belongs to another planner."},{status:403});
      if (this.ctx.storage.kv.get("agent:routing-owner") !== owner) this.ctx.storage.kv.put("agent:routing-owner",owner);
    }
    const mcp = plannerMcpHandler(
      async (req, operation, args) => {
        if (
          (context.conversation?.startsWith("routine:") || context.origin === "scheduled") &&
          (context.origin !== "scheduled" ||
            !this.reminders.authorizesRoutine(context.conversation, context.submission))
        )
          return Response.json(
            { error: "This scheduled routine is no longer active." },
            { status: 403 },
          );
        try {
          if (
            req.method === "GET" ||
            [
              "searchTasks",
              "readTaskSummaries",
              "linkWorkspaceItem",
              "askUser",
              "notifyUser",
              "proposeTime",
              "proposeChanges",
            ].includes(operation)
          ) {
            const resp = await this.routes.fetch(req, { fromAgent: true, ...context });
            if (operation === "proposeTime" && context.conversation && resp.ok) {
              const proposal = await resp.clone().json<{ id: string }>();
              this.inbox.attachReview(proposal.id, context.conversation, context.replaces);
              return Response.json({ ...proposal, inboxItemId: proposal.id });
            }
            return resp;
          }
          if (!operationEffect(operation))
            return Response.json(
              { error: "This capability has no registered change policy." },
              { status: 403 },
            );
          const digest = await stableInboxKey([
            context.conversation,
            context.submission ?? crypto.randomUUID(),
            operation,
            args,
          ]);
          const id = "change-" + digest;
          if (
            operation === "updateTask" &&
            (args.requestBody as { schedule?: unknown })?.schedule !== undefined &&
            this.db.task(String(args.id))?.schedule?.type === "fixed"
          )
            return Response.json(
              { error: "Use proposeTime for a fixed event. Its schedule requires user review." },
              { status: 409 },
            );
          const captureDate = operation === "createTask" ? this.prepareTaskCreate(args, digest, context) : undefined;
          const target = typeof args.id === "string" ? this.db.task(args.id)?.title : undefined;
          const name = target ?? (args.requestBody as { title?: string } | undefined)?.title;
          const description = name
            ? {
                title:
                  operation.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()) +
                  " · " +
                  name,
                body: "Requested planner changes",
              }
            : undefined;
          return Response.json(
            await this.inbox.request(
              id,
              { operation, args, url: req.url, method: req.method, captureDate },
              context,
              description,
            ),
          );
        } catch (error) {
          if (error instanceof PlannerError || error instanceof HTTPException)
            return Response.json({ error: error.message }, { status: error.status });
          throw error;
        }
      },
      (name) => !connectorAgentToolNames.has(name),
    );
    return mcp.fetch(request);
  }

  protected createExtractor(): TitleExtractor | undefined {
    return this.env.AI ? clairicExtractor(this.env.AI) : undefined;
  }

  protected createClassifier(): TaskClassifier | undefined {
    return this.env.AI ? ClefTaskClassifier.using(this.env.AI) : undefined;
  }

  protected createEffects(): ReadonlyMap<string, EffectHandler> {
    return new Map(
      this.env.AI ? [["nutrition.estimate", mealEstimator(this.env.AI, this.images)]] : [],
    );
  }
  private nextDue() {
    const classify = this.classification ? this.pluginDb.nextDue() : null;
    const effect = this.plugins.workflows.db.nextDue();
    const due = [
      classify,
      effect,
      this.carryover.nextDue(),
      this.inbox.nextDue(),
      this.workspaceDelivery.nextDue(),
      this.reminders.nextDue(),
      this.extraction?.queue.nextDue(),
    ].filter((time): time is number => time != null);
    return due.length ? Math.min(...due) : null;
  }

  private classificationBatchSize() {
    const size = Number(this.env.TASK_CLASSIFICATION_BATCH_SIZE);
    return Number.isInteger(size) && size >= 1 && size <= 64 ? size : 8;
  }

  async alarm() {
    const work: Promise<void>[] = [];
    if(this.workspaceDelivery.nextDue()!==null) work.push(this.workspaceDelivery.process());
    if (this.reminders.nextDue() !== null)
      work.push(this.reminders.processDue(this.commitTaskWrite));
    if (this.inbox.nextDue() !== null) work.push(this.inbox.processDue(this.commitTaskWrite));
    if (this.carryover.nextDue() !== null)
      work.push(this.commitTaskWrite(() => this.carryover.processDue()));
    if (this.classification && this.pluginDb.nextDue() !== null)
      work.push(this.classification.processDue(this.commitTaskWrite));
    if (this.plugins.workflows.db.nextDue() !== null)
      work.push(this.plugins.workflows.processDue(this.commitTaskWrite));
    if (this.extraction && this.extraction.queue.nextDue() !== null)
      work.push(this.extraction.processDue(this.commitTaskWrite));
    await Promise.all(work);
  }

  async admitWorkspaceTurn(owner:string,chat:string,input:WorkspaceInput,scope:string[]=[],claim?:string) {
    try{
      if(this.env.USER_PLANNER.idFromName(owner).toString()!==this.ctx.id.toString()) return Response.json({error:"Planner changed."},{status:403});
      const marker=taskUuid(await stableInboxKey([input.idempotencyKey]));
      await this.commitTaskWrite(()=>{
        this.workspaceDelivery.remember(owner);
        this.workspace.requireChat(chat,input.message instanceof Object && input.message.kind==="user");
        if(typeof input.message!=="string" && input.message.kind==="user")this.workspace.grant(chat,marker,scope);
      });
      const receipt=await this.workspaceDelivery.admit(owner,chat,input);
      if(claim){
        const hash=await stableInboxKey([claim]);
        this.workspace.sql.exec("INSERT OR IGNORE INTO agent_device_origin(chat,submission,claim) VALUES(?,?,?)",chat,receipt.submissionId,hash);
      }
      return Response.json(receipt,{status:202});
    }catch(error){
      const status=(error as {status?:number}).status;
      if(status && status>=400 && status<500)return Response.json({error:(error as Error).message},{status});
      throw error;
    }
  }
  async recordedDevicePreview(chat:string,submission:string,call:string){
    const id="device-"+taskUuid(await stableInboxKey([chat,submission,call]));
    return this.inbox.published(id)?.source==="device";
  }
  async receiveDevicePreview(owner:string,chat:string,input:workspaceZod.infer<typeof import('./agents/device-receipt.ts').deviceReceipt>){
    const stored=this.workspace.sql.exec<{claim:string}>("SELECT claim FROM agent_device_origin WHERE chat=? AND submission=?",chat,input.submissionId).toArray()[0];
    if(stored && (!input.claim || await stableInboxKey([input.claim])!==stored.claim))return Response.json({error:"This action belongs to the original tab."},{status:403});
    if(!stored && ["preview","authorize"].includes(input.status))return Response.json({error:"This device did not register this submission."},{status:409});
    const id="device-"+taskUuid(await stableInboxKey([chat,input.submissionId,input.toolCallId]));
    const {sideConversation}=await import('./agents/chat-identity.ts');
    try{
      const itemId=await this.commitTaskWrite(()=>{
        const item=this.inbox.devicePreview(id,chat==="me"?owner:sideConversation(owner,chat),input);
        if(!item && ["applied","unavailable","rejected"].includes(input.status)){
          this.workspace.addEvent({id:"device/"+id,chat,kind:"device",title:input.label,body:input.status});
        }
        return item;
      });
      return Response.json({accepted:true,itemId},{status:202});
    }catch(error){if(error instanceof PlannerError)return Response.json({error:error.message},{status:error.status});throw error;}
  }
  async publishChatMilestone(owner:string,chat:string,data:workspaceZod.infer<typeof reportMilestone>) {
    if(this.env.USER_PLANNER.idFromName(owner).toString()!==this.ctx.id.toString())throw new PlannerError(403,"Planner changed.");
    return this.commitTaskWrite(()=>{this.workspaceDelivery.remember(owner); return this.workspace.milestone(chat,data);});
  }
  hasSideChat(id: string) {
    return !!this.store
      .select({ id: sideChats.id })
      .from(sideChats)
      .where(eq(sideChats.id, id))
      .get();
  }

  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/mcp") return this.agentFetch(request);
    const scope = this.ctx.id.toString();
    const expected = request.headers.get(plannerScopeHeader);
    if (expected !== null && expected !== scope) {
      return Response.json(
        { error: "This request belongs to a different planner. Reload to verify your account." },
        {
          status: 412,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    const owner = request.headers.get("x-2do-agent-owner");
    if(owner && this.env.USER_PLANNER.idFromName(decodeURIComponent(owner)).toString()===scope && !this.ctx.storage.kv.get("workspace:seeded")){
      await this.commitTaskWrite(()=>this.workspaceDelivery.remember(decodeURIComponent(owner)));
    }
    const result = await this.routes.fetch(request, {
      viewerConversation: owner ? decodeURIComponent(owner) : undefined,
    });
    const response = new Response(result.body, result);
    response.headers.set(plannerScopeHeader, scope);
    return response;
  }
}
