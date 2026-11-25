import { useEffect, useRef } from "react";

// Spaces cut the counter and diagonal out of the character grid.
const two = [
  "   .:+%#%+.",
  "  :#@8SS8@%:",
  " +@%:    S@#",
  " :8+     %@8",
  "        +@#;",
  "       S@%:",
  "     :%@S.",
  "    +#8+",
  "  .%@S.   .:",
  " :#8+    :%8",
  " %@#8%S8#@@+",
  " ;+%#88%S+:.",
];

// Reverse-video characters give the stroke weight even at sidebar scale.
const ink: Record<string, string> = { "@": "solid", "#": "solid", "%": "mid", "8": "mid" };

const tiles = two.map((line, row) =>
  [...line].map((glyph, column) => {
    if (glyph === " ") return null;
    return (
      <span
        key={column}
        className="ascii-tile"
        data-ink={ink[glyph]}
        style={{
          gridArea: `${row + 1} / ${column + 1}`,
          animationDelay: `${(column + two.length - row) * 45}ms`,
        }}
      >{glyph}</span>
    );
  }),
);

export function NotebookBrand() {
  const mark = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = mark.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => {
      node.toggleAttribute("data-visible", entry.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <span className="notebook-brand">
      <span ref={mark} className="ascii-two" aria-hidden="true">{tiles}</span>
      <span>twodo</span>
    </span>
  );
}
