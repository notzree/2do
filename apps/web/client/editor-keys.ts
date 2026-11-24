import {NodeSelection,Selection,TextSelection} from "@tiptap/pm/state";
import type {EditorView} from "@tiptap/pm/view";
import {undo,redo} from "@tiptap/pm/history";

export function lineStart(view:EditorView){
	const sel=view.state.selection;
	return sel instanceof NodeSelection ? sel.from : sel.$from.before(1);
}
export function selectLine(view:EditorView,pos:number,end=false){
	const node=view.state.doc.nodeAt(pos);
	if(!node)return;
	const selection=node.isTextblock ? TextSelection.create(view.state.doc,pos+1+(end?node.content.size:0)) : NodeSelection.create(view.state.doc,pos);
	view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
}
export function stepLine(view:EditorView,direction:1|-1){
	const pos=lineStart(view),node=view.state.doc.nodeAt(pos)!;
	const dest=direction===1?pos+node.nodeSize:pos-(view.state.doc.resolve(pos).nodeBefore?.nodeSize??0);
	if(dest===pos || dest>=view.state.doc.content.size)return false;
	selectLine(view,dest);return true;
}
export function addLine(view:EditorView,above=false){
	const pos=lineStart(view),at=above?pos:pos+view.state.doc.nodeAt(pos)!.nodeSize;
	const tr=view.state.tr.insert(at,view.state.schema.nodes.paragraph.create());
	view.dispatch(tr.setSelection(TextSelection.create(tr.doc,at+1)).scrollIntoView());
}
export function moveLine(view:EditorView,direction:1|-1){
	const pos=lineStart(view),node=view.state.doc.nodeAt(pos)!;
	const sibling=direction===-1?view.state.doc.resolve(pos).nodeBefore:view.state.doc.resolve(pos+node.nodeSize).nodeAfter;
	if(!sibling)return;
	const at=pos+direction*sibling.nodeSize;
	const tr=view.state.tr.delete(pos,pos+node.nodeSize).insert(at,node);
	view.dispatch(tr);selectLine(view,at);
}
export function motion(view:EditorView,key:string){
	const {state}=view,sel=state.selection;
	if(key==="u")return undo(state,view.dispatch);
	if(key==="redo")return redo(state,view.dispatch);
	const pos=lineStart(view),node=state.doc.nodeAt(pos)!;
	if(key==="gg" || key==="G"){selectLine(view,key==="gg"?0:state.doc.content.size-state.doc.lastChild!.nodeSize);return true;}
	if(key==="dd"){
		const tr=state.tr.delete(pos,pos+node.nodeSize);
		view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(Math.min(pos,tr.doc.content.size)))).scrollIntoView());return true;
	}
	if(!node.isTextblock)return false;
	const col=sel.from-pos-1, text=node.textContent;
	const words=Array.from(text.matchAll(/\S+/g),m=>m.index!);
	let next:number;
	switch(key){
		case "h":next=col-1;break; case "l":next=col+1;break;
		case "0":next=0;break;case "$":next=text.length;break;
		case "w":next=words.find(n=>n>col)??text.length;break;
		case "b":next=words.filter(n=>n<col).at(-1)??0;break;
		default:return false;
	}
	view.dispatch(state.tr.setSelection(TextSelection.create(state.doc,pos+1+Math.max(0,Math.min(text.length,next)))).scrollIntoView());return true;
}
