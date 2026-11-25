// @vitest-environment happy-dom
import { installNativeDialogFake } from "./nativeDialog.testSupport";
installNativeDialogFake();
import { expect, it } from "vitest";
import { settleDeferredContent, useDeferredContent } from "../formatting/deferredContent.testSupport";
import { ChatView } from "./ChatView";

useDeferredContent();

it("renders a lone leading assistant tab as prose without stripping other indentation", async () => {
  const view = new ChatView();
  view.behaviors = { ...view.behaviors, followTail: false, rememberPosition: false };
  const raw = "\tProgress report.\n\n```text\n\tkeep this\n```";
  view.messages = [
    { role: "user", parts: [{ type: "text", text: "\tUser code" }] },
    { role: "assistant", parts: [
      { type: "text", text: raw },
      { type: "text", text: "\t\tDouble-tab code" },
    ] },
  ];
  document.body.append(view);
  await settleDeferredContent(view);
  const root = view.shadowRoot;
  const assistant = root?.querySelectorAll(".assistant formatted-text");
  const user = root?.querySelector(".user formatted-text");
  expect(assistant).toHaveLength(2);
  expect(assistant?.[0]?.shadowRoot?.querySelector("p")?.textContent).toBe("Progress report.");
  expect(assistant?.[0]?.shadowRoot?.querySelector("pre code")?.textContent).toContain("\tkeep this");
  expect(assistant?.[1]?.shadowRoot?.querySelector("pre code")?.textContent).toContain("Double-tab code");
  expect(user?.shadowRoot?.querySelector("pre code")?.textContent).toContain("User code");
  expect(view.messages[1]?.parts[0]).toEqual({ type: "text", text: raw });
});
