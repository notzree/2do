import { useEffect, useState } from "react";

/** A null term pauses the server query while the user is still typing. */
export function useSearchTerm(input: string) {
  const term = input.trim();
  const [settled, setSettled] = useState(term);
  useEffect(() => {
    if (term === settled) return;
    const timer = window.setTimeout(() => setSettled(term), 250);
    return () => window.clearTimeout(timer);
  }, [term, settled]);
  return term === "" || term === settled ? term : null;
}
