import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices, createEventBus, SessionManager, SettingsManager, type ExtensionAPI } from "../../piSdk.js";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionEventConnections } from "./piSessionEventConnections.js";
import { PiSessionService } from "./piSessionService.js";
import { isRecord } from "./sessionFileFormat.js";
import { sessionLivenessRegistry } from "./sessionLivenessRegistry.js";
import { createTestModelRuntime, emptyArchiveStore, testModel } from "./piSessionService.testSupport.js";

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: testModel().provider, model: testModel().id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  };
}

const goal = { id: "goal-1", text: "Ship", startedAt: 1, updatedAt: 1, iteration: 0, tokensUsed: 0, timeUsedSeconds: 0, baselineTokens: 0 };

/**
 * Mirrors what pi-subagents 0.90.0 documents and does for a pi-web host: one
 * liveness provider per session that stays live through queued and running
 * runs, finished runs whose result is not delivered, and accepted wakes until
 * their message starts; `subagent:jobs-changed` on job changes, and
 * `subagent:async-complete` after a delivery is accepted.
 */
class SubagentsFixture {
  private pi: ExtensionAPI | undefined;
  private readonly runs = new Map<string, "queued" | "running" | "complete" | "stopped">();
  private readonly owed = new Set<string>();
  private readonly unstartedWakes: string[] = [];
  retainedRoute = false;
  private release: (() => void) | undefined;

  install(pi: ExtensionAPI): void {
    this.pi = pi;
    pi.on("session_start", (_event, ctx) => {
      // The package reports its restored jobs before registering its provider.
      pi.events.emit("subagent:jobs-changed", { version: 1 });
      const registry = sessionLivenessRegistry();
      if (registry === undefined) throw new Error("pi-web host registry is missing");
      this.release = registry.register({ name: "pi-subagents", sessionId: ctx.sessionManager.getSessionId(), isActive: () => this.isActive() });
    });
    pi.on("message_start", (event) => {
      const content = event.message.role === "custom" ? event.message.content : undefined;
      const index = typeof content === "string" ? this.unstartedWakes.indexOf(content) : -1;
      if (index >= 0) this.unstartedWakes.splice(index, 1);
    });
    pi.on("session_shutdown", () => { this.release?.(); });
  }

  private isActive(): boolean {
    return this.retainedRoute || [...this.runs.values()].some((state) => state === "queued" || state === "running") || this.owed.size > 0 || this.unstartedWakes.length > 0;
  }

  set(id: string, state: "queued" | "running" | "complete" | "stopped"): void {
    this.runs.set(id, state);
    // A run that ends owes its result to the parent; a stopped one that never ran has none.
    if (state === "complete") this.owed.add(id);
    this.api().events.emit("subagent:jobs-changed", { version: 1 });
  }

  finishRetainedRoute(): void {
    this.retainedRoute = false;
    this.api().events.emit("subagent:jobs-changed", { version: 1 });
  }

  /** The completion notifier: the wake is recorded before sending, the hold released after acceptance. */
  deliver(ids: string[], triggerTurn: boolean): void {
    const content = `results of ${ids.join(", ")}`;
    if (triggerTurn) this.unstartedWakes.push(content);
    this.api().sendMessage({ customType: "subagent-notify", content, display: true }, { triggerTurn });
    for (const id of ids) {
      this.owed.delete(id);
      this.api().events.emit("subagent:async-complete", { id, runId: id });
    }
  }

  private api(): ExtensionAPI {
    if (this.pi === undefined) throw new Error("subagents fixture is not loaded");
    return this.pi;
  }
}

describe("background work beside isStreaming across a real Pi runtime", () => {
  it("stays busy from the parent's stop through child completion, result delivery and its wake, and clears once", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-web-background-work-")));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const agentDir = join(directory, "agent");
    const sessionDir = join(directory, "sessions");
    const transcript = SessionManager.create(directory, sessionDir);
    transcript.appendMessage({ role: "user", content: "Start", timestamp: 1 });
    transcript.appendMessage(assistant("Ok"));
    const ref = { id: transcript.getSessionId(), cwd: directory };
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");

    // Global frames as one browser's socket receives them.
    const statuses: { isStreaming: boolean; hasBackgroundWork: boolean | null | undefined }[] = [];
    const hub = new SessionEventHub();
    hub.addGlobal({ OPEN: 1, readyState: 1, terminate: () => undefined, on: () => undefined, send: (payload: string) => {
      const frame: unknown = JSON.parse(payload);
      const status = isRecord(frame) && frame["type"] === "status.update" ? frame["status"] : undefined;
      if (isRecord(status) && status["sessionId"] === ref.id) {
        const hasBackgroundWork = status["hasBackgroundWork"];
        statuses.push({ isStreaming: status["isStreaming"] === true, hasBackgroundWork: typeof hasBackgroundWork === "boolean" || hasBackgroundWork === null ? hasBackgroundWork : undefined });
      }
    } });
    const subagents = new SubagentsFixture();
    let pi: ExtensionAPI | undefined;
    let onModel: () => void = () => undefined;
    let modelCalls = 0;
    let onSettled: () => void = () => undefined;
    let continuations = 0;
    let goalStatus: string | undefined;
    const setGoal = (status: string | undefined, waiting?: { reason: string }) => {
      goalStatus = status;
      pi?.appendEntry("goal-state", { goal: status === undefined ? null : { ...goal, status, ...(waiting === undefined ? {} : { waiting }) } });
    };

    const sessionEvents = new PiSessionEventConnections();
    const service = new PiSessionService(hub, {
      agentDir, modelRuntime, archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000, sessionEvents,
      sessionManager: createPiSessionManagerGateway({ agentDir, env: { PI_CODING_AGENT_SESSION_DIR: sessionDir } }),
      createRuntime: async ({ cwd, sessionManager, sessionStartEvent }) => {
        const eventBus = createEventBus();
        const services = await createAgentSessionServices({
          cwd, agentDir, modelRuntime,
          settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
          resourceLoaderOptions: {
            eventBus, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
            agentsFilesOverride: () => ({ agentsFiles: [] }),
            extensionFactories: [(api) => {
              pi = api;
              subagents.install(api);
              // pi-goal 0.55.4 continues an active, non-waiting Goal from agent_settled.
              api.on("agent_settled", (_event, ctx) => {
                onSettled();
                if (goalStatus === "active" && continuations > 0 && ctx.isIdle()) {
                  continuations -= 1;
                  api.sendUserMessage("continue the Goal", { deliverAs: "followUp" });
                }
              });
            }],
          },
        });
        const result = await createAgentSessionFromServices({
          services, sessionManager, ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
          model: testModel(), thinkingLevel: "off", noTools: "all",
        });
        result.session.agent.streamFunction = () => {
          modelCalls += 1;
          onModel();
          const message = assistant("done");
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
          return stream;
        };
        sessionEvents.register(result.session, eventBus);
        return { ...result, services, diagnostics: services.diagnostics };
      },
    });
    onTestFinished(() => service.dispose());

    const idle = () => vi.waitFor(async () => {
      const status = await service.status(ref);
      if (status.isStreaming || status.pendingMessageCount > 0) throw new Error("still running");
    }, { timeout: 5_000 });
    /** Busy runs of the frames since the mark: a whole-session stop is each busy → idle step. */
    const busyRuns = (from: number) => statuses.slice(from)
      .map((status) => status.isStreaming || status.hasBackgroundWork === true ? "busy" : "idle")
      .filter((state, index, all) => index === 0 || all[index - 1] !== state);

    await service.status(ref);
    expect(statuses.at(-1)).toEqual({ isStreaming: false, hasBackgroundWork: false });

    // A same-session reload must not claim the restored runner stopped before registration.
    subagents.set("restored", "running");
    let mark = statuses.length;
    await service.reload(ref);
    // The restored job's pre-registration report is explicit unknown, never idle.
    expect(statuses.slice(mark).some((status) => status.hasBackgroundWork === false)).toBe(false);
    expect(statuses.slice(mark).some((status) => status.hasBackgroundWork === null)).toBe(true);
    expect(statuses.at(-1)).toEqual({ isStreaming: false, hasBackgroundWork: true });
    expect(await service.status(ref)).toMatchObject({ isStreaming: false, hasBackgroundWork: true });
    subagents.set("restored", "stopped");

    // A turn launches a child and ends; the child finishes before its result is delivered.
    mark = statuses.length;
    onModel = () => { subagents.set("r1", "running"); };
    await service.prompt(ref, "launch a child");
    await idle();
    onModel = () => undefined;
    expect(statuses.at(-1)).toEqual({ isStreaming: false, hasBackgroundWork: true });
    subagents.set("r1", "complete");
    expect((await service.status(ref)).hasBackgroundWork).toBe(true);
    subagents.deliver(["r1"], true);
    await idle();
    expect(busyRuns(mark)).toEqual(["busy", "idle"]);
    expect(statuses.at(-1)).toEqual({ isStreaming: false, hasBackgroundWork: false });

    // Two children: the first result wakes the parent while the second still runs.
    mark = statuses.length;
    onModel = () => { subagents.set("r2", "running"); subagents.set("r3", "running"); };
    await service.prompt(ref, "launch two children");
    await idle();
    onModel = () => undefined;
    subagents.set("r2", "complete");
    subagents.deliver(["r2"], true);
    await idle();
    expect(statuses.at(-1)).toEqual({ isStreaming: false, hasBackgroundWork: true });
    subagents.set("r3", "complete");
    subagents.deliver(["r3"], true);
    await idle();
    expect(busyRuns(mark)).toEqual(["busy", "idle"]);

    // A result delivered as the parent settles queues its wake past agent_settled.
    mark = statuses.length;
    onModel = () => { subagents.set("r4", "running"); subagents.set("r4", "complete"); };
    onSettled = () => {
      onSettled = () => undefined;
      onModel = () => undefined;
      subagents.deliver(["r4"], true);
    };
    const callsBefore = modelCalls;
    await service.prompt(ref, "launch a quick child");
    // The prompt's turn, then the wake's.
    await vi.waitFor(() => { expect(modelCalls).toBe(callsBefore + 2); });
    await idle();
    expect(busyRuns(mark)).toEqual(["busy", "idle"]);

    // A queued child keeps the idle parent busy; stopping it clears with no session event.
    mark = statuses.length;
    subagents.set("r5", "queued");
    subagents.set("r5", "stopped");
    expect(statuses.slice(mark)).toEqual([{ isStreaming: false, hasBackgroundWork: true }, { isStreaming: false, hasBackgroundWork: false }]);

    // A retained descendant can clear after the foreground turn with no new message.
    mark = statuses.length;
    onModel = () => { subagents.retainedRoute = true; };
    await service.prompt(ref, "launch a foreground route with a descendant");
    await idle();
    expect(statuses.at(-1)).toEqual({ isStreaming: false, hasBackgroundWork: true });
    subagents.finishRetainedRoute();
    expect(statuses.at(-1)).toEqual({ isStreaming: false, hasBackgroundWork: false });
    expect(busyRuns(mark)).toEqual(["busy", "idle"]);

    // A result delivered without a wake, as for a parent the user stopped, clears on delivery.
    mark = statuses.length;
    subagents.set("r6", "running");
    subagents.set("r6", "complete");
    subagents.deliver(["r6"], false);
    await idle();
    expect(busyRuns(mark)).toEqual(["busy", "idle"]);
    expect(statuses.at(-1)).toEqual({ isStreaming: false, hasBackgroundWork: false });

    // An active Goal continues across its turn boundary, and waits while armed.
    mark = statuses.length;
    continuations = 1;
    let turns = 0;
    onModel = () => {
      turns += 1;
      if (turns === 1) setGoal("active");
      if (turns === 2) setGoal("active", { reason: "CI" });
    };
    await service.prompt(ref, "work on the Goal");
    await vi.waitFor(() => { expect(turns).toBe(2); });
    await idle();
    expect(statuses.at(-1)).toEqual({ isStreaming: false, hasBackgroundWork: true });
    onModel = () => { setGoal("complete"); };
    setGoal("active");
    pi?.sendUserMessage("resume the Goal");
    await idle();
    expect(busyRuns(mark)).toEqual(["busy", "idle"]);
    expect(statuses.at(-1)).toEqual({ isStreaming: false, hasBackgroundWork: false });
  }, 30_000);
});
