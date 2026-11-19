// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { ExtensionWidgets, formatElapsed } from "./ExtensionWidgets";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

const subagents = {
  key: "subagent-async",
  lines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    runs: [
      { id: "a", label: "worker", agent: "worker", model: "poros/anthropic/claude", state: "complete", startedAt: 0, endedAt: 65_000, activity: { turnCount: 2 } },
      { id: "b", label: "oracle", state: "failed", startedAt: 0, endedAt: 5_000 },
    ],
  })}`],
};

async function mount(widgets: ExtensionWidgets["widgets"]) {
  const element = new ExtensionWidgets();
  element.widgets = widgets;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

it("hides itself without widgets", async () => {
  const element = await mount([]);
  expect(element.hidden).toBe(true);
  element.widgets = [subagents];
  await element.updateComplete;
  expect(element.hidden).toBe(false);
});

it("renders pi-subagents' snapshot as a collapsible run list", async () => {
  const element = await mount([subagents]);
  const root = element.shadowRoot;
  expect(root?.querySelector(".summary")?.textContent).toBe("1 done · 1 failed");
  expect([...root?.querySelectorAll(".row .detail") ?? []].map((detail) => detail.textContent)).toEqual(["claude · 2 turns · 1m 5s", "5s"]);
  root?.querySelector<HTMLButtonElement>(".header-toggle")?.click();
  await element.updateComplete;
  expect(root?.querySelector(".rows")).toBeNull();
  expect(localStorage.getItem("pi-web:subagents-collapsed")).toBe("1");
});

it("renders Markdown widgets with buttons that run the extension's commands", async () => {
  const element = await mount([{ key: "btw", lines: ["**answer**"], title: "btw · why?", markdown: true, actions: [{ label: "×", title: "Close", command: "/btw-close" }] }]);
  const onRunCommand = vi.fn();
  element.onRunCommand = onRunCommand;
  const root = element.shadowRoot;
  expect(root?.querySelector(".title")?.textContent).toBe("btw · why?");
  expect(root?.querySelector("formatted-text")).toHaveProperty("text", "**answer**");
  root?.querySelector<HTMLButtonElement>("button.action")?.click();
  expect(onRunCommand).toHaveBeenCalledWith("/btw-close");
});

it("renders plain line widgets as preformatted text", async () => {
  const element = await mount([{ key: "todo", lines: ["- one", "- two"] }]);
  expect(element.shadowRoot?.querySelector("pre")?.textContent).toBe("- one\n- two");
  expect(element.shadowRoot?.querySelector("header")).toBeNull();
});

it("formats compact elapsed times", () => {
  expect(formatElapsed(59_400)).toBe("59s");
  expect(formatElapsed(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m");
});
