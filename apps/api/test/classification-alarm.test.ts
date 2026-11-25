import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vite-plus/test";
import { task } from "../src/interfaces/plan.ts";
import { taskDetails } from "../src/interfaces/task-plugins.ts";
import { ClefTaskClassifier } from "../src/classifiers/clef.ts";

const dinner = "Get dinner at Nuri Village";
async function fixture(mode: "hold" | "pass" | "fail") {
	const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
	const id = crypto.randomUUID(), path = "tasks/" + id;
	const call = (path: string, method = "GET", body?: object) => stub.fetch("https://planner.test/api/" + path, {
		method, ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	});
	const provider = (mode: string) => runInDurableObject(stub, (_, state) => { state.storage.kv.put("test:provider", mode); });
	await provider(mode);
	const enable = (enabled: boolean) => call("task-plugins/nutrition", "PUT", {enabled});
	const capture = () => call("days/2026-11-24", "PUT", {
		version:1, revision:0, doc:{type:"doc",content:[{type:"taskRef",attrs:{id}}]},
		newTasks:[{id, title:dinner,rawInput:dinner}],
	});
	const read = async () => taskDetails.parse(await (await call(path+"/details")).json());
	const stats = () => runInDurableObject(stub, async (_,ctx)=>({
		job:ctx.storage.sql.exec<{ due: number | null; attempts: number; token: string }>("SELECT due, attempts, token FROM task_classification WHERE taskId=?",id).toArray()[0],
		calls:ctx.storage.kv.get<number>("test:calls") ?? 0,
		alarm:await ctx.storage.getAlarm(),
	}));
	// Stage a queued job far in the future, so the test controls delivery and lease expiry.
	const stage = async (due: number, attempts = 0) => {
		await runInDurableObject(stub, async (_, ctx)=>{
			ctx.storage.sql.exec("INSERT INTO task_classification (taskId,token,due,attempts) VALUES (?,?,?,?) ON CONFLICT(taskId) DO UPDATE SET due=excluded.due, attempts=excluded.attempts",id,crypto.randomUUID(),due,attempts);
			await ctx.storage.setAlarm(due);
		});
	};
	const deliver = async () => {
		await runInDurableObject(stub, async (_,ctx)=>{
			ctx.storage.sql.exec("UPDATE task_classification SET due=0 WHERE taskId=? AND due IS NOT NULL",id);
			await ctx.storage.setAlarm(Date.now()+120_000);
		});
		expect(await runDurableObjectAlarm(stub)).toBe(true);
	};
	return {stub,id,path,call,enable,capture,read,stats,stage,deliver,provider};
}

it("delivers captured notebook work after the HTTP response and permits writes while inference is held", async () => {
	const f = await fixture("hold");
	await f.enable(true);
	const saved = await f.capture();
	expect(saved.status).toBe(200);
	expect(await saved.json()).toMatchObject({revision:1});
	try {
		// No test helper invokes the handler. Wait for workerd's own alarm delivery.
		await expect.poll(async ()=>(await f.stats()).calls,{timeout:6000}).toBe(1);
		const inflight = await f.stats();
		expect(inflight.job?.attempts).toBe(1);
		expect(inflight.alarm).toBe(inflight.job?.due);
		const current = await f.read();
		expect(current).toMatchObject({classification:"pending",subtypes:[]});
		expect((await f.call(f.path,"PATCH",{revision:current.task.revision,completed:true})).status).toBe(200);
		expect((await f.call(f.path+"/subtypes/nutrition.meal","PUT",{revision:null,data:null})).status).toBe(200);
	} finally { await f.provider("pass"); }
	await expect.poll(async ()=>(await f.read()).classification).toBe("idle");
	expect(await f.read()).toMatchObject({task:{completed:true},subtypes:[{source:"manual",data:null}]});
	expect(await f.stats()).toMatchObject({alarm:null,calls:1});
});

it("keeps an existing wake on cold start and recovers a missing wake from durable jobs", async () => {
	const f = await fixture("pass");
	const created = await f.call("tasks","POST",{id:f.id,title:dinner});
	expect(created.status).toBe(201);
	// Consume each response before eviction so its stream no longer holds the object active.
	await created.arrayBuffer();
	const enabled = await f.enable(true);
	expect(enabled.status).toBe(200);
	await enabled.arrayBuffer();
	const due=Date.now()+600_000, existing=due+60_000;
	await f.stage(due,1);
	await runInDurableObject(f.stub,async (_,ctx)=>{ await ctx.storage.setAlarm(existing); });
	await evictDurableObject(f.stub);
	expect(await f.stats()).toMatchObject({job:{due,attempts:1},alarm:existing, calls:0});
	await runInDurableObject(f.stub,async (_,ctx)=>{ await ctx.storage.deleteAlarm(); });
	await evictDurableObject(f.stub);
	expect(await f.stats()).toMatchObject({job:{due,attempts:1},alarm:due});
	await f.deliver();
	expect(await f.read()).toMatchObject({classification:"idle",subtypes:[{typeId:"nutrition.meal",source:"automatic"}]});
	expect(await f.stats()).toMatchObject({calls:1,alarm:null});
}, 35_000);

it("persists retry deadlines and terminal failures, and explicitly retries with a fresh budget", async () => {
	const f = await fixture("fail");
	await f.call("tasks","POST",{id:f.id,title:dinner});
	await f.enable(true);
	await f.stage(Date.now()+600_000);
	for (const attempts of [1,2]) {
		await f.deliver();
		const { job,alarm,calls }=await f.stats();
		expect(job?.attempts).toBe(attempts);
		expect(calls).toBe(attempts);
		expect(alarm).toBe(job?.due);
		expect(alarm).toBeGreaterThan(Date.now());
	}
	await f.deliver();
	expect(await f.read()).toMatchObject({classification:"failed",subtypes:[]});
	expect(await f.stats()).toMatchObject({job:{attempts:3,due:null},alarm:null,calls:3});
	expect(await runDurableObjectAlarm(f.stub)).toBe(false);
	await f.provider("pass");
	expect((await f.call(f.path+"/classify","POST")).status).toBe(202);
	await expect.poll(async ()=>(await f.read()).classification,{timeout:6000}).toBe("idle");
	expect(await f.read()).toMatchObject({subtypes:[{typeId:"nutrition.meal",source:"automatic"}]});
	expect(await f.stats()).toMatchObject({calls:4,alarm:null});
});

it("rejects an old provider response after deleting and recreating the same ID and title",async()=>{
	const f=await fixture("hold");
	await f.enable(true);
	await f.capture();
	try {
		await expect.poll(async ()=>(await f.stats()).calls,{timeout:6000}).toBe(1);
		const old=(await f.stats()).job!.token;
		await f.call(f.path,"DELETE");
		await f.enable(false);
		const newTask=await f.call("tasks","POST",{id:f.id,title:dinner});
		expect(task.parse(await newTask.json()).id).toBe(f.id);
		await f.enable(true);
		expect((await f.stats()).job?.token).not.toBe(old);
	} finally { await f.provider("pass"); }
	await expect.poll(async ()=>(await f.stats()).alarm,{timeout:6000}).toBe(null);
	expect(await f.read()).toMatchObject({classification:"idle",subtypes:[]});
	expect((await f.read()).lastClassification).toBeUndefined();
});

it("rolls back SQL changes when scheduling the capture or recovery alarm fails",async()=>{
	const f=await fixture("pass");
	await f.enable(true);
	async function failSetAlarm(phase:"capture"|"claim") {
		await runInDurableObject(f.stub, async(instance,ctx)=>{
			const original = ctx.storage.transaction.bind(ctx.storage);
			const storage = vi.spyOn(ctx.storage,"transaction").mockImplementation(work=>original(async txn=>{
				const set = vi.spyOn(txn,"setAlarm").mockRejectedValue(new Error("simulated alarm write failure"));
				try { return await work(txn); } finally { set.mockRestore(); }
			}));
			try {
				if(phase==="capture") {
					const r=await instance.fetch(new Request("https://test/api/tasks",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:f.id,title:dinner})}));
					expect(r.status).toBe(500);
				} else await expect(instance.alarm!()).rejects.toThrow("simulated alarm write failure");
			} finally { storage.mockRestore(); }
		});
	}
	await failSetAlarm("capture");
	expect((await f.call(f.path)).status).toBe(404);
	expect(await f.stats()).toMatchObject({calls:0,alarm:null});
	await f.enable(false);
	await f.call("tasks","POST",{id:f.id,title:dinner});
	await f.enable(true);
	const priorWake=Date.now()+600000;
	await f.stage(priorWake);
	await runInDurableObject(f.stub,(_,ctx)=>{ctx.storage.sql.exec("UPDATE task_classification SET due=0 WHERE taskId=?",f.id);});
	await failSetAlarm("claim");
	expect(await f.stats()).toMatchObject({calls:0,alarm:priorWake,job:{due:0,attempts:0}});
	await f.deliver();
	expect((await f.read()).classification).toBe("idle");
});

it("passes the attempt deadline to each Clef call and skips later chunks after abort", async () => {
	const controller=new AbortController();
	let calls=0;
	const classifier=new ClefTaskClassifier(async ({questions}, signal)=>{
		expect(signal).toBe(controller.signal);
		calls++;
		controller.abort();
		return {answers:Object.fromEntries(Object.keys(questions).map(key=>[key,{noul:.9}]))};
	});
	const candidates=Array.from({length:65},(_,i)=>({typeId:"example."+i,instructions:"Match"}));
	await expect(classifier.classify([{taskId:"one",title:"Sample",candidates}],controller.signal)).rejects.toThrow();
	expect(calls).toBe(1);
});
