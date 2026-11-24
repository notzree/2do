import { useId, useLayoutEffect, useRef } from "react";
import type { Plan, Task } from "@2do/api/plan";
import { dayKey, timeRange } from "./calendar.ts";

export function DependencyGraph({
	plan,
	task,
	select,
	inline=false,
}: {
	plan: Plan;
	task: Task;
	select: (id: string) => void;
	inline?:boolean;
}) {
	// The API returns tasks in prerequisite-first order. Keep both paths through a diamond.
	const upstream = new Set([task.id]),
		downstream = new Set([task.id]);
	const inputs = new Map<string, string[]>(),
		outputs = new Map<string, string[]>();
	for (const { from, to } of plan.edges) {
		if (!inputs.has(to)) inputs.set(to, []);
		if (!outputs.has(from)) outputs.set(from, []);
		inputs.get(to)!.push(from);
		outputs.get(from)!.push(to);
	}
	for (const node of [...plan.tasks].reverse()) {
		if (upstream.has(node.id)) for (const id of inputs.get(node.id) ?? []) upstream.add(id);
	}
	for (const node of plan.tasks) {
		if (downstream.has(node.id)) for (const id of outputs.get(node.id) ?? []) downstream.add(id);
	}
	const nodes = plan.tasks.filter((t) => upstream.has(t.id) || downstream.has(t.id));
	const positions = new Map<string, { level: number; column: number }>();
	const widths: number[] = [];
	for (const node of nodes) {
		let level = 0;
		for (const id of inputs.get(node.id) ?? []) {
			const parent = positions.get(id);
			if (parent) level = Math.max(level, parent.level + 1);
		}
		const column = widths[level] ?? 0;
		positions.set(node.id, { level, column });
		widths[level] = column + 1;
	}
	const width = Math.max(...widths) * 192;
	const height = widths.length * 112 - 30;
	function point(id: string) {
		const { level, column } = positions.get(id)!;
		return { x: (width - widths[level] * 192) / 2 + column * 192 + 96, y: level * 112 + 4 };
	}
	const marker=useId();
	const current = useRef<HTMLButtonElement>(null);
	useLayoutEffect(() => {
		if(!inline) current.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [task.id,inline]);
	return (
		<div className="graph-scroll" aria-label="Dependencies, prerequisites first">
			<div className="graph" style={{ width, height }}>
				<svg width={width} height={height} aria-hidden="true">
					<defs>
						<marker
							id={marker}
							viewBox="0 0 10 10"
							refX="9"
							refY="5"
							markerWidth="6"
							markerHeight="6"
							orient="auto"
						>
							<path d="M0 0 L10 5 L0 10z" fill="currentColor" />
						</marker>
					</defs>
					{plan.edges
						.filter((e) => positions.has(e.from) && positions.has(e.to))
						.map((e) => {
							const a = point(e.from),
								b = point(e.to),
								mid = (a.y + 72 + b.y) / 2;
							return (
								<path
									key={e.from + e.to}
									d={`M ${a.x} ${a.y + 72} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${b.y - 2}`}
									stroke="currentColor"
									fill="none"
									markerEnd={`url(#${marker})`}
								/>
							);
						})}
				</svg>
				{nodes.map((node) => {
					const { x, y } = point(node.id);
					const s = node.schedule;
					const label = s
						? s.type === "day"
							? s.date
							: dayKey(new Date(s.start)) + " · " + timeRange(node)
						: "Unscheduled";
					const parents = (inputs.get(node.id) ?? []).map(
						(id) => plan.tasks.find((t) => t.id === id)?.title,
					);
					return (
						<button
							key={node.id}
							ref={node.id === task.id ? current : undefined}
							className="graph-node"
							data-node={node.id}
							onKeyDown={event=>{
								if(!["j","k","h","l","ArrowDown","ArrowUp","ArrowLeft","ArrowRight"].includes(event.key))return;
								const isDown=event.key==="j"||event.key==="ArrowDown", isUp=event.key==="k"||event.key==="ArrowUp";
								const target=isDown?outputs.get(node.id)?.find(id=>positions.has(id)):isUp?inputs.get(node.id)?.find(id=>positions.has(id)):nodes.find(t=>{
									const p=positions.get(t.id)!, here=positions.get(node.id)!;
									return p.level===here.level && p.column===here.column+(event.key==="h"||event.key==="ArrowLeft"?-1:1);
								})?.id;
								event.preventDefault();event.stopPropagation();
								if(target)event.currentTarget.closest(".graph")?.querySelector<HTMLButtonElement>(`[data-node="${target}"]`)?.focus();
							}}
							aria-current={node.id === task.id ? "true" : undefined}
							style={{ left: x - 86, top: y }}
							onClick={() => select(node.id)}
							title={node.title + (parents.length ? " · Requires " + parents.join(", ") : "")}
						>
							<strong>
								{node.completed && "✓ "}
								{node.title}
							</strong>
							<small>{label}</small>
						</button>
					);
				})}
			</div>
		</div>
	);
}
