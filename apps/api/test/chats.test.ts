import { env } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import { plannerOwner, sideConversation } from "../src/agents/chat-identity.ts";
import { chatList, sideChat } from "../src/interfaces/chats.ts";

it("registers a side chat once and scopes the directory and conversation to its owner", async () => {
	const id = crypto.randomUUID();
	const owner = "https://example.cloudflareaccess.com/user:with/separators";
	const alice = env.USER_PLANNER.getByName(owner);
	const bob = env.USER_PLANNER.getByName("another-user");
	const path = "https://test/api/chats";
	const register = async (title: string) =>
		sideChat.parse(
			await (
				await alice.fetch(path + "/" + id, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ title }),
				})
			).json(),
		);

	const chat = await register("Trip planning");
	expect(await register("Retry")).toEqual(chat);
	expect(chatList.parse(await (await alice.fetch(path)).json())).toEqual([chat]);
	expect(await (await bob.fetch(path)).json()).toEqual([]);
	expect(plannerOwner(owner)).toBe(owner);
	expect(plannerOwner(sideConversation(owner, id))).toBe(owner);
	expect(sideConversation(owner, id)).not.toBe(sideConversation("another-user", id));
});

it("reserves Flue signals for internal authenticated dispatch",async () => {
  const {default:app}=await import("../src/app.ts");
  const response=await app.request("http://localhost/api/agents/copilot/me",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({kind:"signal",type:"inbox_result",body:"approved"})
  },{...env,LOCAL_PLANNER:"enabled"});
  expect(response.status).toBe(400);
});
