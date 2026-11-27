import { create } from "zustand";

type WorkspacePanel =
  | { kind: "chat" }
  | { kind: "task"; id: string; graph: boolean };

export const useWorkspacePanels = create<{ activePanel: WorkspacePanel | null }>(() => ({
  activePanel: null,
}));

export function setActivePanel(activePanel: WorkspacePanel | null) {
  useWorkspacePanels.setState({ activePanel });
}

export function closeNotebookPanel() {
  if (useWorkspacePanels.getState().activePanel?.kind !== "chat") setActivePanel(null);
}
