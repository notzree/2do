import { lazy, Suspense } from "react";
import type { AgentLocation } from "./agents-navigation.ts";

const Chatbar = lazy(() => import("./chatbar.tsx").then(m => ({ default: m.Chatbar })));

export function LazyChatbar({ route }: { route?: AgentLocation }) {
  return (
    <Suspense fallback={<p role="status">Opening chat…</p>}>
      <Chatbar route={route} />
    </Suspense>
  );
}
