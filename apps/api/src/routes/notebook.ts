import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { emptyPage, imageId, writePage, type DayPage } from "../interfaces/notebook.ts";
import { createTask } from "../interfaces/plan.ts";
import { Planner, PlannerError } from "../core/planner.ts";

function imageType(bytes:Uint8Array) {
	const prefix=String.fromCharCode(...bytes.slice(0,12));
	if(prefix.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
	if(prefix.startsWith("\xff\xd8\xff")) return "image/jpeg";
	if(prefix.startsWith("GIF89a") || prefix.startsWith("GIF87a")) return "image/gif";
	if(prefix.startsWith("RIFF") && prefix.slice(8)==="WEBP") return "image/webp";
}
export function notebookRoutes(ctx: DurableObjectState,bucket:R2Bucket,planner:Planner) {
	const sql=ctx.storage.sql;
	sql.exec(`CREATE TABLE IF NOT EXISTS day_page(day TEXT PRIMARY KEY,revision INTEGER NOT NULL,document TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS notebook_image(id TEXT PRIMARY KEY);`);
	const app=new Hono();
	app.onError((err,c)=>{
		if(err instanceof z.ZodError) return c.json({error:"Invalid day, document or reference"},400);
		if(err instanceof PlannerError) return c.json({error:err.message},err.status);
		throw err;
	});
	const read=(day:string):DayPage=>{
		const [row]=sql.exec<{revision:number;document:string}>("SELECT revision, document FROM day_page WHERE day=?",day);
		return row ? {version:1,revision:row.revision,doc:JSON.parse(row.document)} : emptyPage();
	};
	app.get("/api/days/:date",c=>c.json(read(z.iso.date().parse(c.req.param("date")))));
	app.put("/api/days/:date",bodyLimit({maxSize:1024*1024,onError:c=>c.json({error:"Day document exceeds 1 MiB"},413)}),async c=>{
		const day=z.iso.date().parse(c.req.param("date"));
		if(!c.req.header("Content-Type")?.startsWith("application/json")) return c.json({error:"Expected JSON"},415);
		const draft=writePage.parse(await c.req.json().catch(()=>null));
		return c.json(ctx.storage.transactionSync(()=>{
			const current=read(day);
			const json=JSON.stringify(draft.doc);
			if(current.revision!==draft.revision) {
				if(current.revision===draft.revision+1 && json===JSON.stringify(current.doc)) return current;
				throw new PlannerError(409,"This day changed in another editor. Your draft is still open.");
			}
			const previousRefs=new Set(current.doc.content.flatMap(n=>"attrs" in n && n.type!=="image" ? [n.attrs.id] : []));
			const refs=new Set(draft.doc.content.flatMap(n=>n.type==="taskRef" || n.type==="graphRef" ? [n.attrs.id] : []));
			for(const t of draft.newTasks) {
				if(!refs.has(t.id)) throw new PlannerError(409,"New task needs a document reference");
				planner.create(createTask.parse({...t,schedule:{type:"day",date:day}}));
			}
			for(const id of refs) if(!previousRefs.has(id)) planner.get(id);
			for(const n of draft.doc.content) if(n.type==="image" && !sql.exec("SELECT id FROM notebook_image WHERE id=?",n.attrs.id).toArray().length) throw new PlannerError(404,"Image unavailable");
			const revision=current.revision+1;
			sql.exec("INSERT INTO day_page VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET revision=excluded.revision,document=excluded.document",day,revision,json);
			return {version:1 as const,revision,doc:draft.doc};
		}));
	});
	const key=(id:string)=>ctx.id.toString()+"/"+id;
	app.post("/api/images",bodyLimit({maxSize:8*1024*1024,onError:c=>c.json({error:"Images must be 8 MiB or smaller"},413)}),async c=>{
		const bytes=new Uint8Array(await c.req.arrayBuffer());
		const type=imageType(bytes);
		if(!type || type!==c.req.header("Content-Type")) return c.json({error:"Choose a PNG, JPEG, GIF or WebP image"},415);
		const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
		const id=Array.from(hash,b=>b.toString(16).padStart(2,"0")).join("");
		await bucket.put(key(id),bytes,{httpMetadata:{contentType:type}});
		sql.exec("INSERT OR IGNORE INTO notebook_image VALUES (?)",id);
		return c.json({id},201);
	});
	app.get("/api/images/:id",async c=>{
		const id=imageId.parse(c.req.param("id"));
		const object=await bucket.get(key(id));
		if(!object) return c.json({error:"Image unavailable"},404);
		return new Response(object.body,{headers:{"Content-Type":object.httpMetadata?.contentType ?? "application/octet-stream","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
	});
	return app;
}
