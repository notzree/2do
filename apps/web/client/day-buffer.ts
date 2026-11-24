import {dayPage, type DayPage, type NewTask, type NotebookDoc} from "@2do/api/notebook";

type Snapshot={page?:DayPage; status:"Loading"|"Saved"|"Saving"|"Unsaved"|"Conflict";error?:string};
export class DayBuffer {
	private state:Snapshot={status:"Loading"};
	private listeners=new Set<()=>void>();
	private timer:ReturnType<typeof setTimeout>|undefined;
	private pending=new Map<string,NewTask>();
	private revision=0;
	private dirty=false;
	private running=false;
	private loading=false;
	private retryBody?:{doc:NotebookDoc;newTasks:NewTask[];revision:number;version:1};
	constructor(readonly date:string){}
	get=()=>this.state;
	subscribe=(listener:()=>void)=>{this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};};
	private publish(next:Snapshot){this.state=next;for(const listener of this.listeners) listener();}
	get hasChanges(){return this.dirty || this.running;}
	taskTitle(id:string){return this.pending.get(id)?.title;}
	async load(discard=false){
		if(this.loading || this.running || (this.state.page && !discard)) return;
		this.loading=true;
		try{
			const response=await fetch("/api/days/"+this.date,{redirect:"error"});
			if(!response.ok) throw new Error("Could not load this day.");
			const page=dayPage.parse(await response.json());
			this.revision=page.revision;this.dirty=false;this.retryBody=undefined;this.pending.clear();
			this.publish({page,status:"Saved"});
		}catch{this.publish({...this.state,status:this.dirty?"Conflict":"Unsaved",error:"Could not load this day."});}
		finally{this.loading=false;}
	}
	change(doc:NotebookDoc,task?:NewTask){
		if(task)this.pending.set(task.id,task);
		this.dirty=true;
		const page:DayPage={version:1,revision:this.revision,doc};
		if(this.state.status==="Conflict"){this.publish({...this.state,page});return;}
		this.publish({page,status:"Saving"});
		clearTimeout(this.timer);this.timer=setTimeout(()=>void this.flush(),350);
	}
	async flush(){
		clearTimeout(this.timer);
		if(this.running || !this.dirty || this.state.status==="Conflict")return;
		this.running=true;
		try{
			while(this.dirty && this.state.page){
				const doc=this.state.page.doc;
				const ids=new Set(doc.content.flatMap(n=>n.type==="taskRef"||n.type==="graphRef"?[n.attrs.id]:[]));
				const body=this.retryBody ?? {version:1 as const,revision:this.revision,doc,newTasks:[...this.pending.values()].filter(t=>ids.has(t.id))};
				this.retryBody=body;
				const r=await fetch("/api/days/"+this.date,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),redirect:"error"});
				if(!r.ok){
					const error=(await r.json().catch(()=>({}))).error ?? "Could not save this day.";
					if(r.status<500) this.retryBody=undefined;
					this.publish({...this.state,status:r.status===409?"Conflict":"Unsaved",error});return;
				}
				const saved=dayPage.parse(await r.json());
				this.revision=saved.revision;this.retryBody=undefined;
				this.dirty=this.state.page.doc!==body.doc;
				for(const t of body.newTasks)this.pending.delete(t.id);
				this.publish({page:{...this.state.page,revision:this.revision},status:this.dirty?"Saving":"Saved"});
				if(body.newTasks.length)window.dispatchEvent(new Event("notebook-tasks-created"));
			}
		}catch{this.publish({...this.state,status:"Unsaved",error:"Connection lost. Your changes are still open."});}
		finally{this.running=false;}
	}
}
const days=new Map<string,DayBuffer>();
export function dayBuffer(date:string){
	let buffer=days.get(date);
	if(!buffer){buffer=new DayBuffer(date);days.set(date,buffer);}
	return buffer;
}
window.addEventListener("beforeunload",event=>{if([...days.values()].some(d=>d.hasChanges))event.preventDefault();});
document.addEventListener("visibilitychange",()=>{if(document.hidden)for(const day of days.values())void day.flush();});
