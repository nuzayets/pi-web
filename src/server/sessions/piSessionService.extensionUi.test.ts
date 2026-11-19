import { describe, expect, it } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

describe("extension statuses and widgets", () => {
  it("reach the session's browsers and its transcript snapshot", async () => {
    const hub = new CapturingSessionEventHub();
    const fake = fakeRuntime("ui");
    const service = new PiSessionService(hub, {
      agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime,
      sessionManager: sessionGateway([sessionRecord("ui")]),
      createAgentRuntime: runtimeCreator(fake.runtime), heartbeatIntervalMs: 60_000,
    });
    try {
      await service.status(sessionRef("ui"));
      const ui = fake.session.extensionRunner.getUIContext();
      ui.setStatus("goal", "active 3m");
      const expected = { statuses: { goal: "active 3m" }, widgets: [] };
      expect(hub.sessionEvents).toContainEqual({ sessionId: "ui", event: { type: "extension.ui", ui: expected } });
      expect(hub.globalEvents.some((event) => JSON.stringify(event).includes("active 3m"))).toBe(false);
      const snapshot = await service.transcriptSnapshot(sessionRef("ui"));
      expect(snapshot.extensionUi).toEqual(expected);
    } finally { await service.dispose(); }
  });

  it("do not outlive the runtime that set them, even when set during its shutdown", async () => {
    const hub = new CapturingSessionEventHub();
    const first = fakeRuntime("ui");
    const second = fakeRuntime("ui");
    const runtimes = [first.runtime, second.runtime];
    const service = new PiSessionService(hub, {
      agentDir: "/tmp/pi-web-test-agent", modelRuntime: testModelRuntime,
      sessionManager: sessionGateway([sessionRecord("ui")]),
      createAgentRuntime: () => { const runtime = runtimes.shift(); return runtime === undefined ? Promise.reject(new Error("unexpected runtime")) : Promise.resolve(runtime); },
      heartbeatIntervalMs: 60_000,
    });
    try {
      await service.status(sessionRef("ui"));
      const oldUi = first.session.extensionRunner.getUIContext();
      oldUi.setWidget("btw", ["before"]);
      const disposeFirst = first.runtime.dispose.bind(first.runtime);
      first.runtime.dispose = async () => {
        oldUi.setWidget("btw", ["during shutdown"]);
        await disposeFirst();
      };
      await service.reload(sessionRef("ui"));
      expect((await service.transcriptSnapshot(sessionRef("ui"))).extensionUi).toEqual({ statuses: {}, widgets: [] });
    } finally { await service.dispose(); }
  });
});
