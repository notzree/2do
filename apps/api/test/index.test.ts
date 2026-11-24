import { env, SELF } from "cloudflare:test";
import { expect, it } from "vite-plus/test";
import { checkAccess, checkPlanner } from "./scenarios.ts";

it("serves the API health check", async () => {
	const response = await SELF.fetch("https://example.com/api/health");
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ status: "ok" });
});

it("returns a JSON 404 for unknown routes", async () => {
	const response = await SELF.fetch("https://example.com/api/missing");
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ error: "Not found" });
});

it("rejects writes to the health endpoint", async () => {
	const response = await SELF.fetch("https://example.com/api/health", { method: "POST" });
	expect(response.status).toBe(405);
	expect(response.headers.get("Allow")).toBe("GET");
});

it("enforces the per-user graph and atomic edit semantics", () => checkPlanner(env));
it("accepts only verified Access identities", checkAccess);
it("rejects an anonymous task read", async () => {
	const response = await SELF.fetch("https://example.com/api/tasks");
	expect([401, 503]).toContain(response.status);
});

it("saves document and task together, rejects stale revisions, and replays the last save",async()=>{
	const planner=env.USER_PLANNER.getByName(crypto.randomUUID());
	const url="https://test/api/days/2026-11-23";
	const id=crypto.randomUUID();
	const doc={type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"Field notes",marks:[{type:"em"}]}]},{type:"taskRef",attrs:{id}}]};
	const write=(revision:number,content:unknown,newTasks:unknown[]=[])=>planner.fetch(url,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({version:1,revision,doc:content,newTasks})});
	expect(await (await planner.fetch(url)).json()).toMatchObject({version:1,revision:0});
	expect((await write(0,doc,[{id,title:"Check the results"}])).status).toBe(200);
	expect((await write(0,doc,[{id,title:"Check the results"}])).status).toBe(200);
	expect((await write(0,{type:"doc",content:[{type:"paragraph"}]})).status).toBe(409);
	const badId=crypto.randomUUID();
	expect((await write(1,{type:"doc",content:[{type:"taskRef",attrs:{id:badId}},{type:"graphRef",attrs:{id:crypto.randomUUID()}}]},[{id:badId,title:"Rollback"}])).status).toBe(404);
	expect((await planner.fetch("https://test/api/tasks/"+badId)).status).toBe(404);
	expect(await (await planner.fetch(url)).json()).toMatchObject({revision:1,doc});
	const other=env.USER_PLANNER.getByName(crypto.randomUUID());
	expect(await (await other.fetch(url)).json()).toMatchObject({revision:0});
});

it("stores pasted images privately in R2 and checks image references per planner",async()=>{
	const alice=env.USER_PLANNER.getByName(crypto.randomUUID()),bob=env.USER_PLANNER.getByName(crypto.randomUUID());
	const bytes=Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6XkAAAAASUVORK5CYII="),c=>c.charCodeAt(0));
	const url="https://test/api/images";
	const uploaded=await alice.fetch(url,{method:"POST",headers:{"Content-Type":"image/png"},body:bytes});
	expect(uploaded.status).toBe(201);
	const {id}=await uploaded.json<{id:string}>();
	const image=await alice.fetch(url+"/"+id);
	expect(image.headers.get("Content-Type")).toBe("image/png");
	expect(new Uint8Array(await image.arrayBuffer())).toEqual(bytes);
	expect((await bob.fetch(url+"/"+id)).status).toBe(404);
	for(const [actor,status] of [[alice,200],[bob,404]] as const){
		const result=await actor.fetch("https://test/api/days/2026-11-24",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({version:1,revision:0,newTasks:[],doc:{type:"doc",content:[{type:"image",attrs:{id,alt:"Photo"}}]}})});
		expect(result.status).toBe(status);
	}
	expect((await alice.fetch(url,{method:"POST",headers:{"Content-Type":"image/png"},body:"plain text"})).status).toBe(415);
});
