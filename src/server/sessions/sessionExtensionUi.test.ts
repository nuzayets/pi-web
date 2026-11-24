import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionExtensionUi } from "../../shared/apiTypes.js";
import { extensionWidget, SessionExtensionUiState } from "./sessionExtensionUi.js";

const ESC = String.fromCharCode(27);

function fixture() {
  let now = 1_000;
  const published: { sessionId: string; ui: SessionExtensionUi }[] = [];
  const state = new SessionExtensionUiState((sessionId, ui) => { published.push({ sessionId, ui }); }, 500, () => now);
  return { state, published, advance: (ms: number) => { now += ms; vi.advanceTimersByTime(ms); } };
}

describe("SessionExtensionUiState", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("publishes the first change at once, then at most one coalesced state per interval", () => {
    vi.useFakeTimers();
    const { state, published, advance } = fixture();
    state.setStatus("s", "goal", "active");
    expect(published).toEqual([{ sessionId: "s", ui: { statuses: { goal: "active" }, widgets: [] } }]);
    for (let turn = 1; turn <= 5; turn += 1) state.setStatus("s", "turns", String(turn));
    expect(published).toHaveLength(1);
    advance(500);
    expect(published.at(-1)?.ui.statuses).toEqual({ goal: "active", turns: "5" });
    expect(published).toHaveLength(2);
  });

  it("skips publications that would not change what browsers show", () => {
    vi.useFakeTimers();
    const { state, published, advance } = fixture();
    state.setWidget("s", "w", ["one"], undefined);
    advance(500);
    state.setWidget("s", "w", ["one"], undefined);
    state.setStatus("s", "blank", `${ESC}[31m ${ESC}[0m`);
    advance(500);
    expect(published).toHaveLength(1);
  });

  it("strips terminal colors and removes cleared statuses and widgets", () => {
    vi.useFakeTimers();
    const { state, advance } = fixture();
    state.setStatus("s", "usage", `${ESC}[32m5h 40%${ESC}[0m`);
    state.setWidget("s", "w", [`${ESC}[1mbold${ESC}[0m`], undefined);
    advance(500);
    expect(state.snapshot("s")).toEqual({ statuses: { usage: "5h 40%" }, widgets: [{ key: "w", lines: ["bold"] }] });
    state.setStatus("s", "usage", undefined);
    state.setWidget("s", "w", undefined, undefined);
    advance(500);
    expect(state.snapshot("s")).toEqual({ statuses: {}, widgets: [] });
  });

  it("snapshots what browsers were last sent, so a reverted pending change cannot strand them", () => {
    vi.useFakeTimers();
    const { state, published, advance } = fixture();
    state.setStatus("s", "goal", "A");
    state.setStatus("s", "goal", "B");
    expect(state.snapshot("s").statuses).toEqual({ goal: "A" });
    state.setStatus("s", "goal", "A");
    advance(500);
    expect(published).toHaveLength(1);
    expect(state.snapshot("s").statuses).toEqual({ goal: "A" });
  });

  it("sends a widget's request ID in one live publication, never in later ones or snapshots", () => {
    vi.useFakeTimers();
    const { state, published, advance } = fixture();
    state.setWidget("s", "w", ["answer"], { requestReply: "btw" }, "voice-1");
    expect(published.at(-1)?.ui.widgets).toEqual([{ key: "w", lines: ["answer"], requestId: "voice-1" }]);
    expect(state.snapshot("s").widgets).toEqual([{ key: "w", lines: ["answer"] }]);
    advance(500);
    state.setStatus("s", "goal", "active");
    expect(published).toHaveLength(2);
    expect(published.at(-1)?.ui.widgets).toEqual([{ key: "w", lines: ["answer"] }]);
    // A link replaced before it was published is never sent.
    state.setWidget("s", "w", ["answer"], undefined, "voice-2");
    state.setWidget("s", "w", ["closing"], undefined);
    advance(500);
    expect(published).toHaveLength(3);
    expect(published.flatMap(({ ui }) => ui.widgets).filter((widget) => widget.requestId !== undefined)).toHaveLength(1);
  });

  it("sends no request ID with a widget cut to the length limit, whose reply may be lost", () => {
    vi.useFakeTimers();
    const { state, published, advance } = fixture();
    // Like /btw: recent tool calls with their arguments, then the answer.
    const panel = (pattern: string) => `\`\`\`\n→ grep ${JSON.stringify({ pattern })}\n\`\`\`\n\nThe answer`;
    const overlarge = panel("x".repeat(200_000));
    state.setWidget("s", "w", [overlarge], { requestReply: "btw" }, "voice-1");
    expect(published.at(-1)?.ui.widgets).toEqual([{ key: "w", lines: [overlarge.slice(0, 200_000)] }]);
    advance(500);
    state.setWidget("s", "w", ["x".repeat(200_000), "The answer"], undefined, "voice-2");
    expect(published.at(-1)?.ui.widgets).toEqual([{ key: "w", lines: ["x".repeat(200_000)] }]);
    // A widget at the limit is whole.
    advance(500);
    const whole = panel("x".repeat(200_000 - panel("").length));
    state.setWidget("s", "w", [whole], undefined, "voice-3");
    expect(published.at(-1)?.ui.widgets).toEqual([{ key: "w", lines: [whole], requestId: "voice-3" }]);
  });

  it("clears a forgotten session's browsers once", () => {
    const { state, published } = fixture();
    state.forget("never-set");
    expect(published).toEqual([]);
    state.setStatus("s", "goal", "active");
    state.forget("s");
    expect(published.at(-1)).toEqual({ sessionId: "s", ui: { statuses: {}, widgets: [] } });
    expect(state.snapshot("s")).toEqual({ statuses: {}, widgets: [] });
  });
});

describe("extensionWidget", () => {
  it("keeps PI WEB options and drops invalid actions", () => {
    expect(extensionWidget("btw", ["**answer**"], {
      placement: "aboveEditor",
      title: "btw · why?",
      markdown: true,
      actions: [{ label: "×", title: "Close", command: "/btw-close" }, { label: "bad", command: "rm -rf" }, "junk"],
    })).toEqual({ key: "btw", lines: ["**answer**"], title: "btw · why?", markdown: true, actions: [{ label: "×", title: "Close", command: "/btw-close" }] });
  });

  it("treats TUI component factories and empty content as no widget", () => {
    expect(extensionWidget("w", () => undefined, undefined)).toBeUndefined();
    expect(extensionWidget("w", [], undefined)).toBeUndefined();
    expect(extensionWidget("w", [1, 2], undefined)).toBeUndefined();
  });
});
