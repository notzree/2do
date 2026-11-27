import {inboxPage} from "@2do/api/agent-inbox";
import {api} from "./query.ts";
import {useConversationActivity} from "./agent-activity.ts";
import {BranchDialog,ConversationReferences,WorkspaceItemPicker} from "./conversation-controls.tsx";
import {openAgents, type AgentLocation} from "./agents-navigation.ts";
import type {FlueConversationMessage} from "@flue/sdk";
import { setActivePanel, useWorkspacePanels } from "./workspace-panels.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useFlueAgent } from "@flue/react";
import {
	AtSign, Link2,
	ArrowUp,
	Paperclip,
	Inbox,
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
	setAttachment, setChatScope,
	setChatReplyTarget,
	setDraft,
	useChats,
} from "./chats.ts";
import { decideItem, defaultReplyTarget, itemReplyTarget, routeChatReply, toolInboxItem, type ChatDecision } from "./agent-inbox-api.ts";
import { ConversationInbox, useConversationCards } from "./conversation-inbox.ts";
import { uploadImage } from "./upload-image.ts";
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

export function Chatbar({route}:{route?:AgentLocation}={}) {
	const id = useChats((s) => s.selected);
	const chat=route?(route.page==="chat"?route.id!:"me"):id;
	return <ChatPanel key={chat} id={chat} route={route} />;
}

function ChatPanel({ id,route }: { id: string;route?:AgentLocation }) {
  const [branch,setBranch]=useState<FlueConversationMessage>();
  const [picker,setPicker]=useState<"context"|"proposal">();
  const composers = useChats((s) => s.composers);
  const composer = composers[id] ?? emptyComposer;
  const timelineEvents = useConversationActivity(id, route?.event, !composer.isNew);
	const list = useQuery(chatsQuery);
	const focus = useChats((s) => s.focus);
	const [client] = useState(() => chatClient(id));
	const agent = useFlueAgent({ client: composer.isNew ? undefined : client, live: "sse" });
	const { refresh } = agent;
	const input = useRef<HTMLTextAreaElement>(null);
	// A send outside this hook can create a previously absent conversation.
	useEffect(() => {
		if (composer.version) refresh();
	}, [composer.version, refresh]);
	const focusComposer = !route || composer.isNew;
	useEffect(() => {
		if (focusComposer) input.current?.focus({ preventScroll: true });
	}, [focus, focusComposer]);

	const anchor=route?.message ?? route?.item;
  const older=useQuery({queryKey:["planner","conversation-window",id,anchor,route?.generation],enabled:!!anchor && !composer.isNew,
    queryFn:async({signal})=>{
      const head=await client.history({limit:80,signal});
      if(route?.generation && String(head.incarnation)!==route.generation)return [];
      const found=(ms:FlueConversationMessage[])=>ms.some(m=>m.id===route?.message||m.parts.some(p=>toolInboxItem(p)===route?.item && !!route?.item));
      if(found(head.messages))return head.messages;
      let cursor=head.before;
      while(cursor){const page=await client.historyBefore(cursor,{limit:80,signal});if(found(page.messages))return page.messages;if(page.before===cursor)break;cursor=page.before;}
      return [];
    }});
  const messages = useMemo(() => {
    const liveIds = new Set(agent.messages.map(m => m.id));
    return [...(older.data ?? []).filter(m => !liveIds.has(m.id)), ...agent.messages].filter(
      m => m.display === "visible" && (m.purpose === "user" || m.purpose === "assistant"),
    );
  }, [agent.messages, older.data]);
  const { cards, items } = useConversationCards(messages, timelineEvents, route?.item);
  const pendingQuery=useInfiniteQuery({queryKey:["planner","inbox","conversation",id],initialPageParam:undefined as string|undefined,
    enabled:!composer.isNew,queryFn:async({pageParam,signal})=>inboxPage.parse((await api.GET("/api/agent/inbox",{params:{query:{chat:id,view:"action",cursor:pageParam,limit:100}},signal})).data),
    getNextPageParam:page=>page.nextCursor??undefined,refetchInterval:10000});
  const visibleItems = [...new Map([...items.flatMap(card => card?.item ? [card.item] : []),...pendingQuery.data?.pages.flatMap(p=>p.items)??[]].map(item=>[item.id,item])).values()];
	const pendingTargets = visibleItems.filter(item => item.status === "pending" && !item.elicitation && item.source!=="device" && (item.conversation === id || item.references?.includes(id)) && item.kind !== "notification");
	const targetsLoading=!composer.isNew && !pendingQuery.isSuccess || items.some(card => !card?.item || !!card.error);
	const replyTarget = composer.replyTarget ?? (targetsLoading ? {kind:"choose" as const} : defaultReplyTarget(visibleItems,id));
	const replying = replyTarget.kind === "question";
	const boundItem = replying || replyTarget.kind === "proposal";
	const decide = useMutation({mutationFn:async (decision:ChatDecision) => {
		await decideItem(decision.id,decision.body);
	},onSuccess:() => {setDraft(id,""); setChatReplyTarget(id,undefined); void refresh();}});
	const attach = useMutation({mutationFn:async (file:File) => ({id:await uploadImage(file),name:file.name}),
		onSuccess:(file) => setAttachment(id,file)});
	const fileInput = useRef<HTMLInputElement>(null);
	const settlements = agent.settlements;
	const settled = useMemo(() => new Set(settlements.map(s => s.submissionId)), [settlements]);
	const busy = Boolean(
		composer.busy || agent.status === "submitted" || agent.status === "streaming",
	);
	const lastSettlement = settlements.at(-1);
	const error =
		decide.error?.message || attach.error?.message || composer.error ||
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
		...sides.filter(s=>!s.archivedAt),
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
		if(route)return;
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
			className={route?"copilot workspace-conversation":"copilot"}
			aria-label="Agent chat"
			onKeyDown={(event) => {
				if (
					event.key === "Escape" &&
					!event.defaultPrevented &&
					!event.nativeEvent.isComposing &&
					!event.currentTarget.querySelector('[data-state="open"]')
				) {
					event.stopPropagation();
					if (route) event.currentTarget.closest("main")?.focus({ preventScroll: true });
					else close();
				}
			}}
		>
			{!route && <header className="copilot-head">
				<div className="chat-identity">
					<AgentMark />
					<strong>Agent</strong>
				</div>
				<button type="button" className="chat-icon" title="Open Agents" aria-label="Open Agents" onClick={() => openAgents(id==="me"?{page:"main"}:{page:"chat",id})}><Inbox size={17}/></button>
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
			</header>}
			{!route && <div className="chat-switcher">
				<ChatPicker id={id} options={options} />
				{list.error && (
					<p className="chat-error" role="alert">
						Could not load chats. <button onClick={() => void list.refetch()}>Retry</button>
					</p>
				)}
			</div>}
      {branch&&<BranchDialog message={branch} previous={branch.role==="assistant"?messages.slice(0,messages.findIndex(m=>m.id===branch.id)).findLast(m=>m.role==="user"):undefined} close={()=>setBranch(undefined)}/>}
      {picker==="context"&&<ConversationReferences id={id} chats={sides} scope={composer.scope??[]} onClose={()=>setPicker(undefined)}/>}
      {picker==="proposal"&&<WorkspaceItemPicker chat={id} close={()=>setPicker(undefined)}/>}
			<ConversationInbox.Provider value={cards}>
			<ChatTranscript
				messages={messages} route={route} chat={id} events={timelineEvents} resolvingSource={!!route?.message && older.isPending} unavailableSource={!!route?.message && (older.isError || older.isSuccess && !older.data?.length)}
        branch={id==="me"?setBranch:undefined}
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
				{empty && !route?.item && !timelineEvents.length && (
					<EmptyChat
						main={id === "me"}
						hasDraft={Boolean(composer.draft.trim())}
						suggest={suggest}
					/>
				)}
			</ChatTranscript>
			</ConversationInbox.Provider>
			{pendingQuery.hasNextPage&&<button onClick={()=>void pendingQuery.fetchNextPage()}>Load more pending decisions</button>}
      {sides.some(c=>c.id===id&&c.archivedAt)?<p className="archived-notice">Archived conversation</p>:<footer className="chat-dock">
				{error && (
					<p className="chat-error" role="alert">
						{error}
					</p>
				)}
				<form
					className="chat-composer"
					onSubmit={(e) => {
						e.preventDefault();
						if (busy) {
							if (/^(?:stop|cancel)(?: the)?(?: response| run)?[.!]?$/i.test(composer.draft.trim()) && !composer.admitting)
								void client.abort().then(() => setDraft(id,"")).catch((e) => setChatError(id,e));
							return;
						}
						if (attach.isPending || decide.isPending) return;
						const ready = !targetsLoading;
						const bypass = composer.replyTarget?.kind === "message";
						if (!ready && !bypass) {
							setChatError(id,new Error("Loading the latest inbox items. Retry, or start a new message."));
							return;
						}
						const reply = routeChatReply(composer.draft,visibleItems,id,replyTarget);
						if (reply.kind === "blocked") {setChatError(id,new Error(reply.reason)); return;}
						if (reply.kind === "decision") {
							if (composer.attachment) {setChatError(id,new Error("Remove the attachment or start a new message.")); return;}
							decide.mutate(reply.value); return;
						}
						void sendChat(id, composer.draft);
					}}
				>
					{(pendingTargets.length > 0 || boundItem || replyTarget.kind === "choose" || items.some(card => card?.error)) &&
						<label className="chat-reply-target">Reply to
							<select aria-label="Reply target" disabled={decide.isPending}
								value={boundItem ? replyTarget.id : replyTarget.kind === "choose" ? "" : "message"}
								onChange={e => {
									const selected = pendingTargets.find(item => item.id === e.target.value);
									setChatReplyTarget(id, selected ? itemReplyTarget(selected) : {kind:"message"});
									input.current?.focus();
								}}>
								{replyTarget.kind === "choose" && <option value="" disabled>Choose an inbox item</option>}
								{boundItem && !pendingTargets.some(item => item.id === replyTarget.id && item.version === replyTarget.version) &&
									<option value={replyTarget.id} disabled>{replyTarget.title} (changed)</option>}
								{pendingTargets.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
								<option value="message">New message</option>
							</select>
						</label>}
					{!!composer.scope?.length && <div className="context-chips">{composer.scope.map(source=><button key={source} type="button" title="Remove conversation reference" onClick={()=>setChatScope(id,composer.scope!.filter(c=>c!==source))}>@{source==="me"?"Main chat":source==="active-sides"?"Active side chats":sides.find(s=>s.id===source)?.title??"Side chat"} ×</button>)}</div>}
          <textarea
            ref={input}
						value={composer.draft}
						maxLength={2000}
						rows={2}
						placeholder={replying ? "Answer this question…" : replyTarget.kind==="proposal" ? "Approve, reject, or describe your changes…" : "Message your agent…"}
						aria-label={replying ? "Reply to " + replyTarget.title : "Message the agent"}
						readOnly={composer.admitting || decide.isPending}
						onChange={(e) => {
							if(e.target.value.endsWith("@") && (e.target.value.length===1 || /\s@$/.test(e.target.value))){
                setDraft(id,e.target.value.slice(0,-1),{kind:"message"});setPicker("context");return;
              }
              // Lock the displayed question and its revision when the user begins an answer.
							// Later updates or another tab's decision cannot redirect their draft.
							setDraft(id,e.target.value,replyTarget);
						}}
						onKeyDown={(e) => {
							if (
								e.key === "Enter" &&
								!e.shiftKey &&
								!e.nativeEvent.isComposing &&
								e.nativeEvent.keyCode !== 229
							) {
								e.preventDefault();
								if (!e.repeat) e.currentTarget.form?.requestSubmit();
							}
						}}
					/>
					{composer.attachment && <div className="chat-attachment">{composer.attachment.name}
						<button type="button" aria-label="Remove attached image" onClick={() => setAttachment(id)}>×</button>
					</div>}
					<div className="chat-composer-bar">
						<button type="button" className="chat-icon" aria-label="Reference a conversation" title="Reference a conversation" onClick={()=>setPicker("context")}><AtSign size={16}/></button>
            {<button type="button" className="chat-icon" aria-label="Link a workspace proposal" title="Link a workspace proposal" onClick={()=>setPicker("proposal")}><Link2 size={16}/></button>}
            <input type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" ref={fileInput}
							onChange={event => {const file=event.currentTarget.files?.[0]; event.currentTarget.value=""; if(file) attach.mutate(file);}}/>
						<button className="chat-icon" type="button" aria-label="Attach a notebook image" disabled={attach.isPending || busy || replying}
							onClick={() => fileInput.current?.click()}><Paperclip size={16}/></button>
						{attach.isPending && <small role="status">Uploading image…</small>}
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
								disabled={(!composer.draft.trim() && !composer.attachment) || decide.isPending || attach.isPending}
							>
								<ArrowUp size={18} />
							</button>
						)}
					</div>
				</form>
			</footer>}
		</aside>
	);
}
