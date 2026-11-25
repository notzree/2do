import { setActivePanel, useWorkspacePanels } from "./workspace-panels.ts";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useFlueAgent } from "@flue/react";
import {
	ArrowUp,
	Check,
	ChevronDown,
	CornerDownLeft,
	History,
	ListChecks,
	MessageCircle,
	NotebookPen,
	Square,
	SquarePen,
	Sun,
	X,
} from "lucide-react";
import {
	chatClient,
	chatsQuery,
	emptyComposer,
	newSideChat,
	selectChat,
	sendChat,
	setChatError,
	setDraft,
	useChats,
} from "./chats.ts";
import { ChatTranscript } from "./chat-transcript.tsx";
import "./chatbar.css";

function AgentMark() {
	return (
		<span className="agent-mark" aria-hidden="true">
			2
		</span>
	);
}

function ChatPicker({ id, options }: { id: string; options: { id: string; title: string }[] }) {
	const title = options.find((chat) => chat.id === id)?.title ?? "Side chat";
	return (
		<Menu.Root modal={false}>
			<Menu.Trigger
				className="chat-picker"
				aria-label={`Switch conversation, current conversation: ${title}`}
			>
				<History size={16} />
				<span>{title}</span>
				<ChevronDown size={15} />
			</Menu.Trigger>
			<Menu.Content
				className="chat-menu"
				align="start"
				sideOffset={6}
				collisionPadding={12}
				aria-label="Conversations"
			>
				<Menu.Label className="chat-menu-label">Conversations</Menu.Label>
				<Menu.RadioGroup value={id} onValueChange={selectChat}>
					{options.map((chat) => (
						<Menu.RadioItem
							key={chat.id}
							value={chat.id}
							textValue={chat.title}
							className="chat-menu-item"
						>
							{chat.id === "me" ? <NotebookPen size={15} /> : <MessageCircle size={15} />}
							<span>{chat.title}</span>
							<Menu.ItemIndicator>
								<Check size={15} />
							</Menu.ItemIndicator>
						</Menu.RadioItem>
					))}
				</Menu.RadioGroup>
			</Menu.Content>
		</Menu.Root>
	);
}

function EmptyChat({
	main,
	suggest,
	hasDraft,
}: {
	main: boolean;
	suggest: (text: string) => void;
	hasDraft: boolean;
}) {
	return (
		<div className="chat-empty">
			<div className="chat-paper-stack" aria-hidden="true">
				<div className="chat-paper-back" />
				<div className="chat-paper-note">
					<div className="chat-binding">
						<i />
						<i />
						<i />
					</div>
					<span className="chat-note-line">
						<Check />
						<i />
					</span>
					<span className="chat-note-line">
						<span />
						<i />
					</span>
				</div>
			</div>
			<h2>{main ? "What’s on for today?" : "A fresh conversation"}</h2>
			<p>
				{main
					? "Ask about your tasks or sketch out a plan."
					: "Work through an idea in its own chat."}
			</p>
			<div className="chat-starters">
				<button disabled={hasDraft} onClick={() => suggest("Help me plan my day.")}>
					<Sun size={15} />
					Plan my day
				</button>
				<button disabled={hasDraft} onClick={() => suggest("Which tasks are still open?")}>
					<ListChecks size={15} />
					Find open tasks
				</button>
			</div>
		</div>
	);
}

export function Chatbar() {
	const id = useChats((s) => s.selected);
	return <ChatPanel key={id} id={id} />;
}

function ChatPanel({ id }: { id: string }) {
	const list = useQuery(chatsQuery);
	const composers = useChats((s) => s.composers);
	const focus = useChats((s) => s.focus);
	const composer = composers[id] ?? emptyComposer;
	const [client] = useState(() => chatClient(id));
	const agent = useFlueAgent({ client: composer.isNew ? undefined : client, live: "sse" });
	const { refresh } = agent;
	const input = useRef<HTMLTextAreaElement>(null);
	// A send outside this hook can create a previously absent conversation.
	useEffect(() => {
		if (composer.version) refresh();
	}, [composer.version, refresh]);
	useEffect(() => {
		input.current?.focus({ preventScroll: true });
	}, [focus]);

	const messages = agent.messages.filter(
		(m) => m.display === "visible" && (m.purpose === "user" || m.purpose === "assistant"),
	);
	const settlements = agent.settlements;
	const settled = new Set(settlements.map((s) => s.submissionId));
	const busy = Boolean(
		composer.busy || agent.status === "submitted" || agent.status === "streaming",
	);
	const lastSettlement = settlements.at(-1);
	const error =
		composer.error ||
		agent.error?.message ||
		(lastSettlement?.outcome === "failed" && !busy
			? "The agent could not complete its last response."
			: undefined);
	const sides = list.data ?? [];
	const pending = Object.keys(composers).filter(
		(key) =>
			key !== "me" && !sides.some((c) => c.id === key) && (composers[key].isNew || key === id),
	);
	const options = [
		{ id: "me", title: "Main chat" },
		...pending.map((id) => ({
			id,
			title: composers[id].draft.trim() || "New side chat",
		})),
		...sides,
	];
	const loading = !composer.isNew && !agent.historyReady && !error;
	const empty = !messages.length && !busy && !loading && !error;
	const last = messages.at(-1);
	const showingReply =
		last?.role === "assistant" &&
		last.submissionId &&
		!settled.has(last.submissionId) &&
		last.parts.some((part) => (part.type === "text" && part.text) || part.type === "dynamic-tool");
	function close() {
		setActivePanel(null);
		requestAnimationFrame(() => {
			if (useWorkspacePanels.getState().activePanel) return;
			document.querySelector<HTMLButtonElement>("[data-chat-launch]")?.focus({ preventScroll: true });
		});
	}
	function suggest(text: string) {
		setDraft(id, text);
		input.current?.focus();
	}
	return (
		<aside
			className="copilot"
			aria-label="Agent chat"
			onKeyDown={(event) => {
				if (
					event.key === "Escape" &&
					!event.defaultPrevented &&
					!event.nativeEvent.isComposing &&
					!event.currentTarget.querySelector('[data-state="open"]')
				) {
					event.stopPropagation();
					close();
				}
			}}
		>
			<header className="copilot-head">
				<div className="chat-identity">
					<AgentMark />
					<strong>Agent</strong>
				</div>
				<button
					className="chat-icon"
					title="New side chat"
					aria-label="New side chat"
					onClick={newSideChat}
				>
					<SquarePen size={17} />
				</button>
				<button
					className="chat-icon"
					title="Close chat"
					aria-label="Close the chat"
					onClick={close}
				>
					<X size={18} />
				</button>
			</header>
			<div className="chat-switcher">
				<ChatPicker id={id} options={options} />
				{list.error && (
					<p className="chat-error" role="alert">
						Could not load chats. <button onClick={() => void list.refetch()}>Retry</button>
					</p>
				)}
			</div>
			<ChatTranscript
				messages={messages}
				busy={busy}
				settled={settled}
				stopped={!busy && lastSettlement?.outcome === "aborted"}
				status={
					busy && !showingReply
						? composer.admitting
							? "Sending"
							: "Thinking"
						: loading
							? "Loading conversation"
							: undefined
				}
			>
				{empty && (
					<EmptyChat
						main={id === "me"}
						hasDraft={Boolean(composer.draft.trim())}
						suggest={suggest}
					/>
				)}
			</ChatTranscript>
			<footer className="chat-dock">
				{error && (
					<p className="chat-error" role="alert">
						{error}
					</p>
				)}
				<form
					className="chat-composer"
					onSubmit={(e) => {
						e.preventDefault();
						if (!busy) void sendChat(id, composer.draft);
					}}
				>
					<textarea
						ref={input}
						value={composer.draft}
						maxLength={2000}
						rows={2}
						placeholder="Message your agent…"
						aria-label="Message the agent"
						readOnly={composer.admitting}
						onChange={(e) => setDraft(id, e.target.value)}
						onKeyDown={(e) => {
							if (
								e.key === "Enter" &&
								!e.shiftKey &&
								!e.nativeEvent.isComposing &&
								e.nativeEvent.keyCode !== 229
							) {
								e.preventDefault();
								if (!busy && !e.repeat) e.currentTarget.form?.requestSubmit();
							}
						}}
					/>
					<div className="chat-composer-bar">
						<span className="chat-key-hint">
							<CornerDownLeft size={12} /> Send <span>·</span> Shift + Enter for a new line
						</span>
						{composer.draft.length >= 1800 && <small>{composer.draft.length}/2000</small>}
						{busy ? (
							<button
								className="chat-send"
								type="button"
								title="Stop response"
								aria-label="Stop the agent"
								disabled={composer.admitting}
								onClick={() => void client.abort().catch((e) => setChatError(id, e))}
							>
								<Square size={13} fill="currentColor" />
							</button>
						) : (
							<button
								className="chat-send"
								type="submit"
								title="Send message"
								aria-label="Send message"
								disabled={!composer.draft.trim()}
							>
								<ArrowUp size={18} />
							</button>
						)}
					</div>
				</form>
			</footer>
		</aside>
	);
}
