import type { Editor } from "@tiptap/core";
import { undo, redo } from "@tiptap/pm/history";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import type { WorkspaceAction } from "@2do/api/workspace-command";

let lastEditor: Editor | undefined;
export function rememberChatEditor(editor: Editor) {
  lastEditor = editor;
}
export function captureDraftSelection() {
  const editor = lastEditor;
  if (!editor || editor.isDestroyed || !editor.view.dom.isConnected) return;
  const { state } = editor;
  const { from, to } = state.selection;
  return { editor, state, text: state.doc.textBetween(from, to, "\n").slice(0, 2000) };
}
export type DraftSelection = NonNullable<ReturnType<typeof captureDraftSelection>>;
export function prepareDraftEdit({ editor, state }: DraftSelection, action: WorkspaceAction) {
  if (editor.isDestroyed || !editor.view.dom.isConnected || !editor.state.doc.eq(state.doc)) return;
  let transaction: Transaction | undefined;
  const { from, to } = state.selection;
  const command = action.command;
  if (command === "undoDraft" || command === "redoDraft") {
    (command === "undoDraft" ? undo : redo)(state, (tr) => {
      transaction = tr;
    });
  } else if (
    command === "editSelection" &&
    state.selection instanceof TextSelection &&
    state.selection.$from.sameParent(state.selection.$to) &&
    from !== to
  ) {
    if (action.edit === "replace" && action.text !== undefined)
      transaction = state.tr.insertText(action.text, from, to);
    else if (action.edit) {
      const mark =
        state.schema.marks[
          { bold: "strong", italic: "em", underline: "underline", replace: "" }[action.edit]
        ];
      if (mark) transaction = state.tr.addMark(from, to, mark.create());
    }
  }
  if (!transaction?.docChanged) return;
  const tr = transaction;
  // Include marks and embedded references in the reviewed diff, including history operations.
  const start = state.doc.content.findDiffStart(tr.doc.content);
  const end = state.doc.content.findDiffEnd(tr.doc.content);
  if (start === null || end === null) return;
  const render = (doc: typeof state.doc, stop: number) => {
    const slice = doc.slice(Math.min(start, stop), stop);
    return slice.size ? JSON.stringify(slice.content.toJSON()) : "(empty)";
  };
  return {
    changes: [
      {
        field: "Notebook selection",
        before: render(state.doc, end.a),
        after: render(tr.doc, end.b),
      },
    ],
    apply: () => {
      if (editor.isDestroyed || !editor.view.dom.isConnected || editor.state !== state)
        return false;
      editor.view.dispatch(tr);
      return true;
    },
  };
}
