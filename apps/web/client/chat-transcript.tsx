import { contextMatches } from "@2do/api/agents-workspace";
import type { WorkspaceEvent } from "@2do/api/agents-workspace";
import { agentsHref, chatLocation, openAgents, type AgentLocation } from "./agents-navigation.ts";
import { cleanMessage } from "./conversation-controls.tsx";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import type { FlueConversationMessage, FlueConversationPart } from "@flue/sdk";
import { InboxCardById } from "./review-inbox.tsx";
import { toolInboxItem } from "./agent-inbox-api.ts";
import { resolveDeviceChange, useDeviceReceipts } from "./agent-workspace.ts";
import {
  ArrowDown,
  Check,
  CircleAlert,
  Wrench,
  GitBranch,
  CornerUpLeft,
  Sparkles,
} from "lucide-react";

// Only the appended delta fades in. Already readable text stays at full opacity.
function LiveText({ text }: { text: string }) {
  const [chunk, setChunk] = useState({ text, prefix: "" });
  if (chunk.text !== text) {
    setChunk({ text, prefix: text.startsWith(chunk.text) ? chunk.text : "" });
  }
  return (
    <>
      {chunk.prefix}
      <span key={chunk.prefix.length} className="chat-delta">
        {text.slice(chunk.prefix.length)}
      </span>
      <i className="chat-cursor" aria-hidden="true" />
    </>
  );
}

function retrievedSources(raw: unknown) {
  try {
    if (typeof raw === "string") raw = JSON.parse(raw);
    if (raw && typeof raw === "object" && "content" in raw && Array.isArray(raw.content))
      raw = JSON.parse(raw.content[0]?.text ?? "null");
    return contextMatches.safeParse(raw).data;
  } catch {
    return undefined;
  }
}
function RetrievedSources({ output }: { output: unknown }) {
  const sources = retrievedSources(output);
  if (!sources) return <span>Search completed</span>;
  if (!sources.length) return <span>No matches</span>;
  return (
    <div className="context-results">
      {sources.map((m) => {
        const to = chatLocation(m.chat, { message: m.messageId, generation: m.generation });
        return (
          <a
            key={m.chat + m.messageId}
            href={agentsHref(to)}
            onClick={(e) => {
              if (!e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                openAgents(to);
              }
            }}
          >
            {m.title} · {m.excerpt} ↗
          </a>
        );
      })}
    </div>
  );
}
function ToolActivity({
  part,
  deviceItem,
}: {
  deviceItem?: string;
  part: Extract<FlueConversationPart, { type: "dynamic-tool" }>;
}) {
  const receipt = useDeviceReceipts((state) => state.receipts[part.toolCallId]);
  const itemId = toolInboxItem(part) ?? deviceItem;
  if (itemId) return <InboxCardById id={itemId} inChat />;
  if (receipt)
    return (
      <div className="proposal-card">
        <strong>{receipt.label}</strong>
        {receipt.changes?.map((change) => (
          <div key={change.field}>
            {change.field} · {change.before} → {change.after}
          </div>
        ))}
        {receipt.status === "waiting" && (
          <div className="actions">
            <button type="button" onClick={() => resolveDeviceChange(part.toolCallId, true)}>
              Apply on this device
            </button>
            <button type="button" onClick={() => resolveDeviceChange(part.toolCallId, false)}>
              Decline
            </button>
          </div>
        )}
      </div>
    );
  if (part.state === "output-available" && part.toolName.endsWith("searchConversationContext"))
    return <RetrievedSources output={part.output} />;

  const label = part.toolName
    .replace(/^mcp__.+?__/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  const failed = part.state === "output-error";
  const pending = part.state === "input-available";
  const Icon = failed ? CircleAlert : pending ? Wrench : Check;
  return (
    <span className="chat-tool" data-state={part.state} title={part.toolName}>
      <Icon size={12} />
      <span>{label}</span>
      <span>
        {failed
          ? "Failed"
          : pending
            ? "Running"
            : part.toolName === "showWorkspace"
              ? "Requested"
              : "Done"}
      </span>
    </span>
  );
}

function Message({
  message,
  settled,
  branch,
  devices,
}: {
  devices: Map<string, string>;
  message: FlueConversationMessage;
  settled: boolean;
  branch?: (message: FlueConversationMessage) => void;
}) {
  const parts = message.parts;
  const operations = parts.filter(
    (p) => p.type === "dynamic-tool" && !toolInboxItem(p) && p.toolName !== "showWorkspace",
  );
  if (!parts.some((p) => p.type === "dynamic-tool" || (p.type === "text" && p.text))) return null;
  return (
    <article className="chat-message" data-message-id={message.id} data-role={message.role}>
      <div className="timeline-byline">
        <span className="chat-author">{message.role === "user" ? "You" : "Assistant"}</span>
        {message.timestamp && (
          <time dateTime={message.timestamp}>
            {new Date(message.timestamp).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        )}
      </div>
      {parts.map((part, i) => {
        if (part.type === "dynamic-tool") {
          if (!toolInboxItem(part) && part.toolName !== "showWorkspace")
            return part !== operations[0] ? null : (
              <details className="operation-group" key={part.toolCallId}>
                <summary>
                  <Wrench size={13} />
                  {operations.length} {operations.length === 1 ? "operation" : "operations"}
                </summary>
                {operations.map(
                  (p) => p.type === "dynamic-tool" && <ToolActivity key={p.toolCallId} part={p} />,
                )}
              </details>
            );
          return (
            <ToolActivity
              key={part.toolCallId}
              part={part}
              deviceItem={devices.get(part.toolCallId)}
            />
          );
        }
        if (part.type !== "text" || !part.text) return null;
        return (
          <p key={i}>
            {message.role === "assistant" && !settled && part.state === "streaming" ? (
              <LiveText text={part.text} />
            ) : message.role === "user" ? (
              cleanMessage(part.text)
            ) : (
              part.text
            )}
          </p>
        );
      })}
      {branch && parts.some((p) => p.type === "text" && p.text) && (
        <button className="message-branch" type="button" onClick={() => branch(message)}>
          <GitBranch size={13} /> Continue in side chat
        </button>
      )}
    </article>
  );
}

function RelatedConversationLink({ event }: { event: WorkspaceEvent }) {
  const dest =
    event.relatedChat &&
    chatLocation(
      event.relatedChat,
      event.kind === "branch" && event.relatedChat === "me" && event.messageId
        ? { message: event.messageId, generation: event.generation ?? undefined }
        : {},
    );
  if (!dest) return null;
  return (
    <a
      href={agentsHref(dest)}
      onClick={(e) => {
        if (!e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          openAgents(dest);
        }
      }}
    >
      <CornerUpLeft size={13} /> View {event.relatedChat === "me" ? "Main chat" : "conversation"}
    </a>
  );
}
function EventEntry({ event }: { event: WorkspaceEvent }) {
  return (
    <article className="timeline-event" data-event-id={event.id}>
      <div className="timeline-byline">
        {event.kind === "branch" ? <GitBranch size={16} /> : <Sparkles size={16} />}
        <strong>
          {event.kind === "milestone"
            ? event.chat === "me"
              ? "Update from " + (event.relatedTitle ?? "side chat")
              : "Reported to Main"
            : event.title}
        </strong>
        <time>
          {new Date(event.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </time>
      </div>
      {event.kind === "milestone" && <h3>{event.title}</h3>}
      <p>{event.body}</p>
      {event.deliveryStatus && (
        <small className="timeline-delivery">
          {
            (
              {
                queued: "Queued for delivery",
                admitted: "Delivered",
                completed: "Acknowledged",
                failed: "Acknowledgement failed",
                aborted: "Response stopped",
              } as Record<string, string>
            )[event.deliveryStatus]
          }
        </small>
      )}
      <RelatedConversationLink event={event} />
      {event.notebookDay && (
        <a href={"/app/week?date=" + event.notebookDay + "&focus=1"}>View notebook page ↗</a>
      )}
      {event.itemId && <InboxCardById id={event.itemId} inChat />}
    </article>
  );
}

function timelineEntries(
  messages: FlueConversationMessage[],
  events: WorkspaceEvent[],
  settled: Set<string>,
  branch: ((m: FlueConversationMessage) => void) | undefined,
  eventId?: string,
) {
  const devices = new Map(
    events.flatMap((e) =>
      e.deviceCallId && e.itemId ? [[e.deviceCallId, e.itemId] as const] : [],
    ),
  );
  const shownItems = new Set(
    messages
      .flatMap((m) =>
        m.parts.map(
          (p) =>
            toolInboxItem(p) ?? (p.type === "dynamic-tool" ? devices.get(p.toolCallId) : undefined),
        ),
      )
      .filter(Boolean),
  );
  const extras = events
    .filter((e) => {
      if (e.kind === "milestone" || e.kind === "branch" || (!e.itemId && e.id === eventId))
        return true;
      if (!e.itemId || shownItems.has(e.itemId)) return false;
      shownItems.add(e.itemId);
      return true;
    })
    .reverse();
  const conversationEntries: ReactNode[] = [];
  const addEvent = (e: WorkspaceEvent) =>
    conversationEntries.push(
      e.itemId && e.kind !== "milestone" ? (
        <InboxCardById key={e.id} id={e.itemId} inChat />
      ) : (
        <EventEntry key={e.id} event={e} />
      ),
    );
  let next = 0;
  for (const m of messages) {
    while (next < extras.length && m.timestamp && extras[next].at <= m.timestamp)
      addEvent(extras[next++]);
    conversationEntries.push(
      <Message
        key={m.id}
        message={m}
        settled={Boolean(m.submissionId && settled.has(m.submissionId))}
        branch={branch}
        devices={devices}
      />,
    );
  }
  for (; next < extras.length; next++) addEvent(extras[next]);
  return { conversationEntries, shownItems };
}

export const ChatTranscript = memo(function ChatTranscript({
  messages,
  settled,
  busy,
  status,
  stopped,
  children,
  route,
  events,
  branch,
  unavailableSource,
  resolvingSource,
}: {
  messages: FlueConversationMessage[];
  settled: Set<string>;
  busy: boolean;
  status?: string;
  stopped: boolean;
  children: ReactNode;
  route?: AgentLocation;
  events: WorkspaceEvent[];
  unavailableSource?: boolean;
  resolvingSource?: boolean;
  chat: string;
  branch?: (m: FlueConversationMessage) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(!route?.item && !route?.message);
  const anchored = useRef("");
  const anchor = route?.item || (!unavailableSource && route?.message) || route?.event;
  useEffect(() => {
    if (!anchor || resolvingSource) return;
    follow.current = false;
    const selector = route?.item
      ? "[data-item-id]"
      : !unavailableSource && route?.message
        ? "[data-message-id]"
        : "[data-event-id]";
    const key = selector + anchor;
    const container = content.current;
    const focus = () => {
      const el = Array.from(container?.querySelectorAll<HTMLElement>(selector) ?? []).find(
        (el) => el.getAttribute(selector.slice(1, -1)) === anchor,
      );
      if (el && (anchored.current !== key || !el.hasAttribute("data-target"))) {
        el.dataset.target = "";
        el.tabIndex = -1;
        el.scrollIntoView({ block: "center" });
        el.focus({ preventScroll: true });
        anchored.current = key;
      }
    };
    focus();
    const observer = new MutationObserver(focus);
    if (container) observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      container
        ?.querySelectorAll("[data-target]")
        .forEach((el) => el.removeAttribute("data-target"));
    };
  }, [anchor, route?.item, route?.message, unavailableSource, resolvingSource]);
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    const viewport = scroller.current!;
    const observer = new ResizeObserver(() => {
      if (follow.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content.current!);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  const { conversationEntries, shownItems } = timelineEntries(
    messages,
    events,
    settled,
    branch,
    route?.event,
  );
  return (
    <div className="chat-body">
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(event) => {
          const viewport = event.currentTarget;
          follow.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 32;
          setAtBottom(follow.current);
        }}
      >
        <div className="chat-content" ref={content}>
          {children}
          <div
            role="log"
            aria-label="Messages"
            aria-busy={busy}
            aria-relevant="additions text"
            className="chat-log"
          >
            {conversationEntries}
            {unavailableSource && <small role="status">Original message unavailable.</small>}
            {route?.item && !shownItems.has(route.item) && (
              <InboxCardById id={route.item} inChat requestedAction={route.action} />
            )}
          </div>
          {stopped && (
            <p className="chat-status" role="status">
              Response stopped.
            </p>
          )}
          {status && (
            <div className="chat-status" role="status">
              <span className="chat-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {status}…
            </div>
          )}
        </div>
      </div>
      {!atBottom && (
        <button
          className="chat-latest"
          onClick={() => {
            follow.current = true;
            const viewport = scroller.current!;
            viewport.scrollTop = viewport.scrollHeight;
          }}
        >
          <ArrowDown size={14} />
          Latest message
        </button>
      )}
    </div>
  );
});
