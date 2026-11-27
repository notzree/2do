// Main keeps its original Access identity. Access identities start with https://
// (or dev: locally), so the side namespace is disjoint even for unusual subjects.
export function sideConversation(owner: string, chatId: string) {
	return "side:" + chatId + ":" + owner;
}

export function plannerOwner(conversation: string) {
	if (conversation.startsWith("routine:")) return conversation.slice(conversation.indexOf(":",8)+1);
	return conversation.startsWith("side:")
		? conversation.slice(conversation.indexOf(":", 5) + 1)
		: conversation;
}

export function publicChat(conversation?: string) {
  return conversation?.startsWith("side:") ? conversation.slice(5,41) : "me";
}
