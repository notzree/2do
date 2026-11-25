import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FlueConversationMessage, FlueConversationPart } from "@flue/sdk";
import { ArrowDown, Check, CircleAlert, Wrench } from "lucide-react";

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

function ToolActivity({ part }: { part: Extract<FlueConversationPart, { type: "dynamic-tool" }> }) {
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
			<span>{failed ? "Failed" : pending ? "Running" : "Done"}</span>
		</span>
	);
}

function Message({ message, settled }: { message: FlueConversationMessage; settled: boolean }) {
	if (!message.parts.some((p) => (p.type === "text" && p.text) || p.type === "dynamic-tool"))
		return null;
	return (
		<div className="chat-message" data-role={message.role}>
			<span className="chat-author">{message.role === "user" ? "You" : "Agent"}</span>
			{message.parts.map((part, i) => {
				if (part.type === "dynamic-tool") return <ToolActivity key={part.toolCallId} part={part} />;
				if (part.type !== "text" || !part.text) return null;
				return (
					<p key={i}>
						{message.role === "assistant" && !settled && part.state === "streaming" ? (
							<LiveText text={part.text} />
						) : message.role === "user" ? (
							part.text.replace(/^\[Planner date \d{4}-\d{2}-\d{2}, [^\]\n]+\]\n\n/, "")
						) : (
							part.text
						)}
					</p>
				);
			})}
		</div>
	);
}

export function ChatTranscript({
	messages,
	settled,
	busy,
	status,
	stopped,
	children,
}: {
	messages: FlueConversationMessage[];
	settled: Set<string>;
	busy: boolean;
	status?: string;
	stopped: boolean;
	children: ReactNode;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
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
						{messages.map((m) => (
							<Message
								key={m.id}
								message={m}
								settled={Boolean(m.submissionId && settled.has(m.submissionId))}
							/>
						))}
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
}
