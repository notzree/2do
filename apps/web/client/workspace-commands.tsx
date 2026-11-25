import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CheckSquare, ChevronRight, CornerDownLeft, Search, X } from "lucide-react";
import type { Task } from "@2do/api/plan";
import { commands, type Command, type Preferences } from "./preferences.ts";

export type CommandScope = "commands" | "tasks";

type Option = { id: string; name: string; keys?: string; run: () => void };

export function WorkspaceCommands({ scope, tasks, prefs, run, capture, inspect, review, help, close }: {
  scope: CommandScope;
  tasks: Task[];
  prefs: Preferences;
  run: (command: Command) => void;
  capture: () => void;
  inspect: (task: Task) => void;
  review: () => void;
  help: () => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [taskSearch, setTaskSearch] = useState(scope === "tasks");
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const needle = query.trim().toLocaleLowerCase();
  function execute(action: () => void) {
    dialog.current?.close();
    close();
    action();
  }
  const items: Option[] = [
    { id: "capture", name: "Capture a task", keys: "/task", run: () => execute(capture) },
    { id: "inspect", name: "Inspect a task", run: () => {
      setTaskSearch(true); setQuery(""); setIndex(0); input.current?.focus();
    } },
    { id: "keymap", name: "Keyboard shortcuts", keys: prefs.keysEnabled ? "?" : undefined, run: () => execute(help) },
    { id: "review", name: "Open Review inbox", run: () => execute(review) },
    ...commands.map(({ id, name }) => ({
      id, name, keys: prefs.keysEnabled ? "g " + prefs.bindings[id] : undefined,
      run: () => execute(() => run(id)),
    })),
  ];
  const taskOptions = (needle || taskSearch ? tasks : []).filter((task) => task.title.toLocaleLowerCase().includes(needle)).map((task) => ({
    id: task.id, name: task.title, run: () => execute(() => inspect(task)),
  }));
  const options: Option[] = taskSearch ? taskOptions : [
    ...items.filter(({ name }) => name.toLocaleLowerCase().includes(needle)),
    ...(needle ? taskOptions : []),
  ];
  const selected = Math.min(index, Math.max(0, options.length - 1));
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    input.current?.focus();
    return () => element.close();
  }, []);
  useEffect(() => {
    dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected, query, taskSearch]);
  return (
    <dialog className="workspace-commands" ref={dialog} aria-label="Commands"
      onCancel={(event) => { event.preventDefault(); close(); }}>
      <div className="command-search">
        <Search size={18} aria-hidden="true" />
        <input ref={input} role="combobox" aria-expanded="true" aria-controls="workspace-options"
          aria-activedescendant={options.length ? "workspace-option-" + selected : undefined}
          aria-label={taskSearch ? "Find a task to inspect" : "Find a command or task"}
          placeholder={taskSearch ? "Find a task to inspect…" : "Find a command or task…"} value={query}
          onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (options.length) setIndex((selected + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
            } else if (event.key === "Enter") {
              event.preventDefault(); options[selected]?.run();
            } else if (taskSearch && !query && event.key === "Backspace") {
              setTaskSearch(false); setIndex(0);
            }
          }} />
        <button type="button" aria-label="Close commands" onClick={close}><X size={15} /></button>
      </div>
      <div className="command-category">{taskSearch ? "Task inspector" : "Commands"}</div>
      <div role="listbox" aria-label={taskSearch ? "Matching tasks" : "Matching commands and tasks"} id="workspace-options">
        {options.map((item, i) => <button type="button" role="option" tabIndex={-1} key={item.id}
          id={"workspace-option-" + i} aria-selected={selected === i}
          onMouseMove={() => setIndex(i)} onClick={item.run}>
          {taskSearch ? <CheckSquare size={14} /> : <ChevronRight size={14} />}
          <span>{item.name}</span>{item.keys && <kbd>{item.keys}</kbd>}
        </button>)}
      </div>
      {!options.length && <p role="status">{taskSearch && !query ? "No tasks yet." : "No matches."}</p>}
      <footer><span><ArrowUp size={12}/><ArrowDown size={12}/> Navigate</span><span><CornerDownLeft size={12}/> Select</span></footer>
    </dialog>
  );
}
