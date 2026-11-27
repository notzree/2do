import { SavedProposalChanges } from "./proposal-changes.tsx";
import { resolveDeviceChange, useDeviceReceipts, useDeviceErrors } from "./agent-workspace.ts";
import { ProviderQuestion } from "./provider-question.tsx";
import { useContext, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ConversationInbox } from "./conversation-inbox.ts";
import {
  Archive,
  CalendarClock,
  Check,
  Ellipsis,
  Mail,
  MailOpen,
  MessageCircle,
} from "lucide-react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import type { Task } from "@2do/api/plan";
import { api, queryClient } from "./query.ts";
import { reviewKey } from "./planner-cache.ts";
import { localTime } from "./task-edits.ts";
import type { InboxItem } from "@2do/api/agent-inbox";
import {
  gmailSourceLink,
  decideItem,
  inboxKey,
  markItem,
  type InboxDecision,
} from "./agent-inbox-api.ts";
import { selectChat, setDraft } from "./chats.ts";
import { openAgents } from "./agents-navigation.ts";
import "./review-inbox.css";

export function ProposeTime({ task }: { task: Task }) {
  const [draft, setDraft] = useState<{
    start: string;
    end: string;
    reason: string;
    revision: number;
    id: string;
  }>();
  const save = useMutation({
    mutationFn: async (input: NonNullable<typeof draft>) =>
      api.POST("/api/review", {
        body: {
          id: input.id,
          revision: input.revision,
          taskId: task.id,
          reason: input.reason.trim() || "Proposed time change",
          after: {
            type: "fixed",
            start: new Date(input.start).toISOString(),
            end: new Date(input.end).toISOString(),
          },
        },
      }),
    onSuccess: () => {
      setDraft(undefined);
      void queryClient.invalidateQueries({ queryKey: reviewKey });
      void queryClient.invalidateQueries({ queryKey: inboxKey });
    },
  });
  const schedule = task.schedule;
  if (schedule?.type !== "fixed" || task.completed) return null;
  function edit(patch: Partial<NonNullable<typeof draft>>) {
    setDraft((current) => current && { ...current, ...patch, id: crypto.randomUUID() });
    save.reset();
  }
  const valid =
    draft &&
    Date.parse(draft.end) > Date.parse(draft.start) &&
    (draft.start !== localTime(schedule.start) || draft.end !== localTime(schedule.end));
  return (
    <section className="propose-time">
      {!draft ? (
        <button
          type="button"
          onClick={() => {
            save.reset();
            setDraft({
              id: crypto.randomUUID(),
              revision: task.revision,
              reason: "",
              start: localTime(schedule.start),
              end: localTime(schedule.end),
            });
          }}
        >
          <CalendarClock size={14} /> Propose new time
        </button>
      ) : (
        <form
          className="editor"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate(draft);
          }}
        >
          <label>
            Proposed start
            <input
              type="datetime-local"
              required
              value={draft.start}
              onChange={(e) => {
                const start = e.target.value;
                const duration = Date.parse(draft.end) - Date.parse(draft.start);
                edit(
                  Number.isFinite(Date.parse(start)) && duration > 0
                    ? {
                        start,
                        end: localTime(new Date(Date.parse(start) + duration).toISOString()),
                      }
                    : { start },
                );
              }}
            />
          </label>
          <label>
            Proposed end
            <input
              type="datetime-local"
              required
              min={draft.start}
              value={draft.end}
              onChange={(e) => edit({ end: e.target.value })}
            />
          </label>
          <label>
            Reason (optional)
            <input
              maxLength={500}
              value={draft.reason}
              onChange={(e) => edit({ reason: e.target.value })}
            />
          </label>
          <div className="actions">
            <button type="submit" disabled={!valid || save.isPending}>
              Send for review
            </button>
            <button type="button" disabled={save.isPending} onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {save.isSuccess && (
        <small role="status">
          {save.data.data?.status === "pending"
            ? "Added to Needs attention"
            : "This proposal has already been reviewed."}
        </small>
      )}
      {save.isError && <small role="alert">{save.error.message}</small>}
    </section>
  );
}

type RequestedInboxAction = "read" | "unread" | "archive" | "undoTime";
function DeviceControls({ item }: { item: InboxItem }) {
  const id = item.deviceCallId;
  const local = useDeviceReceipts((s) => s.receipts[id ?? ""]);
  const error = useDeviceErrors((s) => s.errors[id ?? ""]);
  if (!id || local?.status !== "waiting")
    return <small>Open the original browser tab to review this preview.</small>;
  return (
    <div className="actions">
      <button onClick={() => void resolveDeviceChange(id, true)}>Apply on this device</button>
      <button onClick={() => void resolveDeviceChange(id, false)}>Decline</button>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
function DecisionControls({
  item,
  feedback,
}: {
  item: InboxItem;
  feedback: (value: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [revising, setRevising] = useState(false);
  const decide = useMutation({
    mutationFn: (body: InboxDecision) => decideItem(item.id, body),
    onSuccess: (_, { decision }) =>
      feedback(
        decision === "approve"
          ? "Approved."
          : decision === "answer"
            ? "Answer saved."
            : decision === "revise"
              ? "Changes requested."
              : "Rejected.",
      ),
  });
  return (
    <>
      {item.elicitation && (
        <ProviderQuestion
          key={item.id + ":" + item.version}
          busy={decide.isPending}
          request={item.elicitation}
          respond={(elicitation) =>
            decide.mutate({ decision: "answer", version: item.version, elicitation })
          }
        />
      )}
      {item.kind === "question" && !item.elicitation && (
        <form
          className="inbox-answer"
          onSubmit={(e) => {
            e.preventDefault();
            if (answer.trim())
              decide.mutate({ decision: "answer", version: item.version, answer: answer.trim() });
          }}
        >
          {item.choices.length ? (
            <label>
              Answer
              <select
                aria-label="Answer"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                required
              >
                <option value="">Choose an answer</option>
                {item.choices.map((choice) => (
                  <option key={choice}>{choice}</option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              Answer
              <input
                aria-label="Answer"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                required
                maxLength={1000}
              />
            </label>
          )}
          <button type="submit" disabled={!answer.trim() || decide.isPending}>
            Send answer
          </button>
          <button
            type="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ decision: "reject", version: item.version })}
          >
            Decline
          </button>
        </form>
      )}
      {revising && (
        <form
          className="inbox-answer"
          onSubmit={(e) => {
            e.preventDefault();
            if (answer.trim())
              decide.mutate({ version: item.version, decision: "revise", answer: answer.trim() });
          }}
        >
          <label>
            Requested changes
            <input
              autoFocus
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              maxLength={2000}
              required
            />
          </label>
          <button type="submit" disabled={!answer.trim() || decide.isPending}>
            Send revision request
          </button>
        </form>
      )}
      {item.source === "device" && <DeviceControls item={item} />}
      {item.kind === "proposal" && item.source !== "device" && (
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ version: item.version, decision: "approve" })}
          >
            Approve
          </button>
          <button
            type="button"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ version: item.version, decision: "reject" })}
          >
            Reject
          </button>
          <button type="button" disabled={decide.isPending} onClick={() => setRevising(true)}>
            Request changes
          </button>
        </div>
      )}
      {decide.error && <p role="alert">{decide.error.message}</p>}
    </>
  );
}
function OutcomeActions({ item, feedback }: { item: InboxItem; feedback: (text: string) => void }) {
  const reminder = useMutation({
    mutationFn: async (action: "snooze" | "dismiss") => {
      if (!item.reminderId) return;
      const params = { path: { id: item.reminderId } };
      if (action === "snooze")
        await api.POST("/api/reminders/{id}/snooze", {
          params,
          body: { occurrence: item.id, minutes: 10 },
        });
      else await api.POST("/api/reminders/{id}/dismiss", { params, body: { occurrence: item.id } });
      await queryClient.invalidateQueries({ queryKey: inboxKey });
    },
    onSuccess: (_, action) =>
      feedback(action === "snooze" ? "Snoozed for 10 minutes." : "Reminder dismissed."),
  });
  const undo = useMutation({
    mutationFn: async () => {
      await api.POST("/api/review/{id}/undo", { params: { path: { id: item.id } } });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["planner"] }),
  });
  const error = reminder.error ?? undo.error;
  return (
    <>
      {item.reminderId && !reminder.isSuccess && (
        <>
          <button
            type="button"
            disabled={reminder.isPending}
            onClick={() => reminder.mutate("snooze")}
          >
            Snooze 10 min
          </button>
          <button
            type="button"
            disabled={reminder.isPending}
            onClick={() => reminder.mutate("dismiss")}
          >
            Dismiss
          </button>
        </>
      )}
      {item.taskId && (
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("agent-workspace-command", {
                detail: {
                  action: { command: "inspectTask", taskId: item.taskId },
                  reply: (ok: boolean) => {
                    if (!ok) feedback("This task is unavailable.");
                  },
                },
              }),
            )
          }
        >
          View task
        </button>
      )}
      {item.source === "review" && item.status === "applied" && (
        <button type="button" disabled={undo.isPending} onClick={() => undo.mutate()}>
          Undo time change
        </button>
      )}
      {error && <small role="alert">{error.message}</small>}
    </>
  );
}
function ReceiptMenu({
  item,
  busy,
  onMark,
  onDiscuss,
}: {
  item: InboxItem;
  busy: boolean;
  onMark: (patch: { read?: boolean; archived?: boolean }) => void;
  onDiscuss?: () => void;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        type="button"
        className="receipt-menu-toggle"
        title="More actions"
        aria-label={"More actions for " + item.title}
      >
        <Ellipsis size={17} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="receipt-menu" align="end" sideOffset={4} collisionPadding={8}>
          {onDiscuss && (
            <Menu.Item onSelect={onDiscuss}>
              <MessageCircle size={14} />
              Discuss
            </Menu.Item>
          )}
          <Menu.Item disabled={busy} onSelect={() => onMark({ read: !item.read })}>
            {item.read ? <Mail size={14} /> : <MailOpen size={14} />}{" "}
            {item.read ? "Mark unread" : "Mark read"}
          </Menu.Item>
          {item.status !== "pending" && !item.archived && (
            <Menu.Item disabled={busy} onSelect={() => onMark({ archived: true })}>
              <Archive size={14} /> Archive
            </Menu.Item>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

// Only shorten generated titles whose named task appears in the receipt below.
function receiptHeading(item: InboxItem) {
  for (const { field, before, after } of item.changes) {
    if (!/^task [\da-f-]{36}$/i.test(field)) continue;
    const task = before ?? after;
    if (!task || typeof task !== "object" || !("title" in task)) continue;
    if (before === null && item.title === "Create Task · " + task.title) return "Create task";
    if (after === null && item.title === "Delete Task · " + task.title) return "Delete task";
  }
  return item.title;
}

export function InboxCard({
  item,
  detailed = false,
  inChat = false,
  requestedAction,
}: {
  item: InboxItem;
  detailed?: boolean;
  inChat?: boolean;
  requestedAction?: RequestedInboxAction;
}) {
  const [expanded, setExpanded] = useState(detailed || inChat);
  const [receipt, setReceipt] = useState("");
  const mark = useMutation({
    mutationFn: (body: { read?: boolean; archived?: boolean }) => markItem(item.id, body),
  });
  const sourceLink = gmailSourceLink(item.source);
  const pending = item.status === "pending";
  const error = mark.error;
  function toggle() {
    if (!expanded && !item.read) mark.mutate({ read: true });
    setExpanded(!expanded);
  }
  function discuss(revise = false) {
    const id = item.conversation ?? "me";
    selectChat(id);
    if (revise) setDraft(id, "Revise “" + item.title + "” (" + item.id + "): ");
    else setDraft(id, "About “" + item.title + "” (" + item.id + "): ");
  }
  return (
    <article data-item-id={item.id} className="proposal-card inbox-card" data-unread={!item.read}>
      <header>
        <button
          className="inbox-card-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={toggle}
        >
          {receiptHeading(item)}
        </button>
        <small className="receipt-status">
          {item.status === "applied" && <Check size={13} aria-hidden="true" />}
          {pending
            ? item.kind === "question"
              ? "Question"
              : "For approval"
            : item.kind === "notification"
              ? "Update"
              : item.status}
        </small>
        <ReceiptMenu
          item={item}
          busy={mark.isPending}
          onMark={mark.mutate}
          onDiscuss={inChat ? undefined : () => discuss()}
        />
      </header>
      {expanded && (
        <>
          {item.body &&
            item.body !== "Requested planner changes" &&
            (!item.elicitation || item.body !== item.elicitation.message) && (
              <p className="receipt-reason">{item.body}</p>
            )}
          {sourceLink && (
            <a href={sourceLink} target="_blank" rel="noopener noreferrer">
              Open source email in Gmail
            </a>
          )}
          {requestedAction && (
            <p role="status">
              {
                {
                  read: "Mark this item as read?",
                  unread: "Mark this item as unread?",
                  archive: "Archive this item?",
                  undoTime: "Restore the previous time?",
                }[requestedAction]
              }
            </p>
          )}
          {item.changes.length > 0 && <SavedProposalChanges item={item} />}
          {item.answer && <p>Your answer · {item.answer}</p>}
          {pending && (
            <DecisionControls
              key={item.id + ":" + item.version}
              item={item}
              feedback={setReceipt}
            />
          )}
          {item.nextItemId && (
            <button type="button" onClick={() => openAgents({ page: "item", id: item.nextItemId })}>
              Continue with provider
            </button>
          )}
          {item.replacementId && (
            <button
              type="button"
              onClick={() => openAgents({ page: "item", id: item.replacementId })}
            >
              View revised proposal
            </button>
          )}
          <div className="actions inbox-item-actions">
            <OutcomeActions item={item} feedback={setReceipt} />
            {requestedAction === "archive" && !pending && !item.archived && (
              <button disabled={mark.isPending} onClick={() => mark.mutate({ archived: true })}>
                Archive
              </button>
            )}
            {(requestedAction === "read" || requestedAction === "unread") &&
              item.read !== (requestedAction === "read") && (
                <button disabled={mark.isPending} onClick={() => mark.mutate({ read: !item.read })}>
                  {item.read ? "Mark unread" : "Mark read"}
                </button>
              )}
          </div>
        </>
      )}
      {error && <p role="alert">{error.message}</p>}
      {receipt && <p role="status">{receipt}</p>}
    </article>
  );
}

export function InboxCardById({
  id,
  inChat,
  requestedAction,
}: {
  id: string;
  inChat?: boolean;
  requestedAction?: RequestedInboxAction;
}) {
  const card = useContext(ConversationInbox).get(id);
  if (card?.error)
    return (
      <p role="alert">
        {card.error}{" "}
        <button type="button" onClick={card.retry}>
          Retry
        </button>
      </p>
    );
  if (!card?.item) return <p role="status">Loading inbox item…</p>;
  return <InboxCard item={card.item} inChat={inChat} requestedAction={requestedAction} detailed />;
}
