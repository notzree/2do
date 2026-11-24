import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
	createFlueClient,
	type FlueConversationMessage,
	type FlueConversationSettlement,
	type FlueConversationPart,
} from "@flue/sdk";
import { MessageCircle, Square, X } from "lucide-react";

// One conversation per signed-in user. The "me" alias is rewritten to the
// caller's verified identity by the API worker, so this client never needs
// to know — or guess — who is signed in.
const client = createFlueClient({ url: "/api/agents/copilot/me" });

function textOf(message: FlueConversationMessage) {
	return message.parts
		.filter((part): part is Extract<FlueConversationPart, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function ToolChips({ message }: { message: FlueConversationMessage }) {
	const tools = message.parts.filter(
		(part): part is Extract<FlueConversationPart, { type: "dynamic-tool" }> =>
			part.type === "dynamic-tool",
	);
	if (!tools.length) return null;
	return (
		<span className="copilot-tools">
			{tools.map((tool) => (
				<span key={tool.toolCallId} className="copilot-tool">
					{tool.toolName}
					{tool.state === "input-available" ? "…" : tool.state === "output-error" ? " ✕" : ""}
				</span>
			))}
		</span>
	);
}

export function Chatbar() {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const [notice, setNotice] = useState("");
	const [pending, setPending] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const observation = useRef(client.observe({ live: "sse", limit: 200 }));
	const snapshot = useSyncExternalStore(
		observation.current.subscribe,
		observation.current.getSnapshot,
	);
	const conversation = snapshot.conversation;
	const messages = (conversation?.messages ?? []).filter(
		(message) => message.display === "visible" && (message.purpose === "user" || message.purpose === "assistant"),
	);
	const busy =
		pending !== null &&
		!(conversation?.settlements ?? []).some(
			(settlement: FlueConversationSettlement) => settlement.submissionId === pending,
		);

	// The plan changes when Copilot's tools run; the agenda refreshes with it.
	useEffect(() => {
		if (pending !== null && !busy) {
			setPending(null);
			window.dispatchEvent(new Event("notebook-tasks-created"));
			input.current?.focus();
		}
	}, [busy, pending]);

	useEffect(() => {
		const show = () => {
			setOpen(true);
		};
		window.addEventListener("notebook-copilot", show);
		return () => window.removeEventListener("notebook-copilot", show);
	}, []);

	useEffect(() => {
		if (!open) return;
		const frame = requestAnimationFrame(() => input.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [open]);

	useEffect(() => {
		if (open) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
	}, [open, messages.length]);

	async function send() {
		const body = draft.trim();
		if (!body || busy) return;
		setNotice("");
		setDraft("");
		try {
			const admission = await client.send({ message: { kind: "user", body } });
			setPending(admission.submissionId);
		} catch (error) {
			setNotice(error instanceof Error ? error.message : "Could not reach the Copilot.");
			setDraft(body);
		}
	}

	if (!open)
		return (
			<button className="copilot-fab" aria-label="Open the Copilot chat" onClick={() => setOpen(true)}>
				<MessageCircle size={17} />
				Copilot
			</button>
		);
	return (
		<section className="copilot" aria-label="Copilot chat">
			<header className="copilot-head">
				<strong>Copilot</strong>
				{busy ? (
					<button
						className="plain"
						aria-label="Stop the Copilot"
						onClick={() => void client.abort().catch(() => {})}
					>
						<Square size={13} />
					</button>
				) : (
					<small>{snapshot.phase === "live" ? "Ready" : snapshot.phase}</small>
				)}
				<button
					className="plain"
					aria-label="Close the chat"
					onClick={() => {
						setOpen(false);
						document.querySelector<HTMLElement>("main")?.focus();
					}}
				>
					<X size={15} />
				</button>
			</header>
			<div className="copilot-messages" ref={scroller}>
				{messages.map((message) => (
					<div key={message.id} className={"copilot-row " + message.role}>
						{textOf(message)}
						<ToolChips message={message} />
					</div>
				))}
				{pending !== null &&
					!messages.some((message) => message.submissionId === pending) &&
					busy && <div className="copilot-row user muted">Sending…</div>}
				{busy && <div className="copilot-row assistant muted">Thinking…</div>}
				{!messages.length && !busy && (
					<p className="muted">Ask Copilot to plan or check off your tasks.</p>
				)}
			</div>
			<form
				className="copilot-form"
				onSubmit={(event) => {
					event.preventDefault();
					void send();
				}}
			>
				<input
					ref={input}
					value={draft}
					maxLength={2000}
					placeholder={busy ? "Copilot is working…" : "Ask about your plan…"}
					aria-label="Message the Copilot"
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.stopPropagation();
							setOpen(false);
							document.querySelector<HTMLElement>("main")?.focus();
						}
					}}
				/>
				<button disabled={busy || !draft.trim()}>Send</button>
			</form>
			{notice && <p className="error" role="alert">{notice}</p>}
		</section>
	);
}
