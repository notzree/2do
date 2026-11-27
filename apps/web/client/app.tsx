import { StrictMode, useEffect, useLayoutEffect, useRef, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { currentAgents } from "./agents-navigation.ts";
import { subscribePreferenceChanges, usePreferences } from "./preference-store.ts";
import type { Preferences } from "./preferences.ts";
import "./style.css";

function Landing() {
  const scene = useRef<HTMLElement>(null);
  const oStart = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const sceneNode = scene.current!;
    const marker = oStart.current!;
    const wordmark = marker.parentElement!;

    window.scrollTo(0, 0);
    function alignReveal() {
      // The marker starts at the o and spans its x-height above the baseline.
      // Layout offsets stay in the wordmark's initial, unscaled coordinates.
      const oWidth = wordmark.offsetWidth - marker.offsetLeft;
      const centerX = marker.offsetLeft + oWidth / 2 - wordmark.offsetWidth / 2;
      const centerY = marker.offsetTop + marker.offsetHeight / 2 - wordmark.offsetHeight / 2;
      sceneNode.style.setProperty("--landing-mask-start-x", `calc(50vw + ${centerX}px)`);
      sceneNode.style.setProperty("--landing-mask-start-y", `calc(50svh + ${centerY}px)`);
      // Extend the photo under the stroke so the glyph defines the visible edge.
      sceneNode.style.setProperty("--landing-mask-start-rx", `${oWidth * 0.36}px`);
      sceneNode.style.setProperty("--landing-mask-start-ry", `${marker.offsetHeight * 0.49}px`);
    }

    alignReveal();
    const observer = new ResizeObserver(alignReveal);
    observer.observe(wordmark);
    observer.observe(marker);
    return () => observer.disconnect();
  }, []);

  return (
    <main className="landing">
      <div className="landing-scroll" aria-hidden="true" />
      <section className="landing-scene" aria-label="twodo" ref={scene}>
        <div className="landing-image-reveal" aria-hidden="true">
          <img src="/coast-sheep.jpg" alt="" fetchPriority="high" />
        </div>
        <a className="landing-brand" href="/" aria-label="twodo home">
          <span className="landing-wordmark">
            twod<span className="landing-o-start" ref={oStart} aria-hidden="true" />o
          </span>
        </a>
        <a className="landing-signin" href="/app">
          Sign in
        </a>
      </section>
    </main>
  );
}

function applyAppearance({ theme, mode }: Preferences) {
  const root = document.documentElement;
  root.dataset.palette = theme;
  root.dataset.mode = mode;
  const color = getComputedStyle(root).backgroundColor;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
}

applyAppearance(usePreferences.getState());

type Page = ComponentType<{ prefs: Preferences; change: (patch: Partial<Preferences>) => void }>;

function App({ Page }: { Page: Page }) {
  const prefs = usePreferences();
  useEffect(subscribePreferenceChanges, []);
  useLayoutEffect(() => {
    const update = () => applyAppearance(prefs);
    update();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [prefs]);
  return <Page prefs={prefs} change={usePreferences.setState} />;
}

const root = createRoot(document.getElementById("root")!);
function mount(Page: Page) {
  root.render(<StrictMode><App Page={Page} /></StrictMode>);
}
const path = location.pathname.replace(/\/$/, "");
if (currentAgents() || ["/app", "/app/day", "/app/week", "/app/calendar", "/app/settings"].includes(path)) {
  void import("./main.tsx").then(({ default: Planner }) => mount(Planner)).catch(() => {
    root.render(<main role="alert">Couldn’t load the planner. <button type="button" onClick={() => location.reload()}>Reload</button></main>);
  });
} else {
  mount(Landing);
}
