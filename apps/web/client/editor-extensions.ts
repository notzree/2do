import { Node, type Extensions } from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import Document from "@tiptap/extension-document";
import History from "@tiptap/extension-history";
import Italic from "@tiptap/extension-italic";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Underline from "@tiptap/extension-underline";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { NotebookReference } from "./notebook-reference.tsx";

const Strong = Bold.extend({ name: "strong" });
const Em = Italic.extend({ name: "em" });

function referenceNode(name: "taskRef" | "graphRef" | "goalRef") {
	return Node.create({
		name,
		group: "block",
		atom: true,
		selectable: true,
		draggable: true,

		addAttributes() {
			return { id: { default: null } };
		},

		parseHTML() {
			return [
				{
					tag: `div[data-ref="${name}"]`,
					getAttrs: (element) => ({
						id: (element as HTMLElement).dataset.id,
					}),
				},
			];
		},

		renderHTML({ node }) {
			return ["div", { "data-ref": name, "data-id": node.attrs.id }];
		},

		addNodeView() {
			return ReactNodeViewRenderer(NotebookReference, {
				stopEvent: ({ event }) =>
					event.target instanceof Element &&
					!!event.target.closest("button,input,textarea,select,label,form,summary,a[href]") &&
					!event.type.startsWith("drag"),
			});
		},
	});
}

export function editorExtensions(): Extensions {
	const Heading = Node.create({
		name: "heading",
		group: "block",
		content: "text*",
		parseHTML: () => [{ tag: "h3" }, { tag: "h2" }],
		renderHTML: () => ["h3", 0],
	});

	const Image = Node.create({
		name: "image",
		group: "block",
		atom: true,
		draggable: true,

		addAttributes() {
			return {
				id: { default: null },
				alt: { default: "" },
			};
		},

		parseHTML() {
			return [
				{
					tag: "img[data-asset]",
					getAttrs: (element) => {
						const image = element as HTMLImageElement;
						return { id: image.dataset.asset, alt: image.alt };
					},
				},
			];
		},

		renderHTML({ node }) {
			return [
				"img",
				{
					"data-asset": node.attrs.id,
					alt: node.attrs.alt,
					src: `/api/images/${node.attrs.id}`,
				},
			];
		},
	});

	return [
		Document,
		Paragraph,
		Text,
		Heading,
		Strong,
		Em,
		Underline,
		referenceNode("taskRef"),
		referenceNode("graphRef"),
		referenceNode("goalRef"),
		Image,
		History,
	];
}

export function notebookDocument(doc: ProseMirrorNode) {
	return doc.toJSON();
}
