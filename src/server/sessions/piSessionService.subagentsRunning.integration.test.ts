import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices, createEventBus, SessionManager, SettingsManager, type ExtensionContext } from "../../piSdk.js";
import { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import { MachineStatusService } from "../status/machineStatusService.js";
import { CORE_STATUS_FLAGS, type MachineStatusSnapshot } from "../../shared/machineStatus.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, testModel } from "./piSessionService.testSupport.js";

function assistant(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: testModel().provider, model: testModel().id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp,
  };
}

/** The `subagent-async` widget line pi-subagents 0.90.0 renders in RPC mode for one top-level job. */
function subagentsWidget(state: string): string[] {
  const generatedAt = Date.now();
  return [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify({
    kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt,
    caps: { maxRuns: 20, maxChildrenPerNode: 8, maxDepth: 3, maxStringLength: 160, maxSerializedBytes: 32_768 },
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [{ id: "run-1", kind: "subagent", label: "worker", state, startedAt: 1_000, updatedAt: generatedAt }],
  })}`];
}

// Real SDK runtime, extension runner and fake model transport. The fixture
// extension mirrors how pi-subagents 0.90.0 renders: it keeps the
// session_start context and keeps setting its widget after the parent turn ends.
describe("running subagents of an idle parent across a real Pi runtime", () => {
  it("reaches machine status from the extension widget and clears on completion, reload, clone and stop", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-web-subagents-running-")));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const agentDir = join(directory, "agent");
    const sessionDir = join(directory, "sessions");
    const transcript = SessionManager.create(directory, sessionDir);
    transcript.appendMessage({ role: "user", content: "Plan the work", timestamp: 1 });
    transcript.appendMessage(assistant("Planned", 2));
    const ref = { id: transcript.getSessionId(), cwd: directory };
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
    let lastUiContext: ExtensionContext | undefined;
    const renderSubagents = (lines: string[] | undefined): void => {
      if (lastUiContext?.mode !== "rpc" || !lastUiContext.hasUI) throw new Error("subagents fixture has no RPC UI context");
      lastUiContext.ui.setWidget("subagent-async", lines);
    };

    const events = new CapturingSessionEventHub();
    const workspaceActivity = new WorkspaceActivityService(() => { machineStatus.notifyChanged(); });
    const machineStatus = new MachineStatusService({
      activity: workspaceActivity,
      unread: { catalogSnapshot: () => ({ sessions: [] }) },
      attribution: { attribute: (cwds) => Promise.resolve(new Map([...cwds].filter((cwd) => cwd === directory).map((cwd) => [cwd, { projectId: "p1", workspaceId: "w1" }]))) },
      publisher: { publish: () => undefined },
      logger: { warn: () => undefined },
    });
    const service = new PiSessionService(events, {
      agentDir, modelRuntime, workspaceActivity, archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000,
      sessionManager: createPiSessionManagerGateway({ agentDir, env: { PI_CODING_AGENT_SESSION_DIR: sessionDir } }),
      createRuntime: async ({ cwd, sessionManager, sessionStartEvent }) => {
        const services = await createAgentSessionServices({
          cwd, agentDir, modelRuntime,
          settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
          resourceLoaderOptions: {
            eventBus: createEventBus(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
            agentsFilesOverride: () => ({ agentsFiles: [] }),
            extensionFactories: [(pi) => {
              pi.on("session_start", (_event, ctx) => { lastUiContext = ctx; });
            }],
          },
        });
        const result = await createAgentSessionFromServices({
          services, sessionManager, ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
          model: testModel(), thinkingLevel: "off", noTools: "all",
        });
        // The parent's only turn launches a background subagent and ends.
        result.session.agent.streamFunction = () => {
          renderSubagents(subagentsWidget("running"));
          const message = assistant("Launched a worker", Date.now());
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
          return stream;
        };
        return { ...result, services, diagnostics: services.diagnostics };
      },
    });
    onTestFinished(() => service.dispose());

    const running = { [CORE_STATUS_FLAGS.subagentsRunning]: true };
    const expectMachineStatus = (expected: Pick<MachineStatusSnapshot, "sessions" | "workspaces" | "projects" | "machine">) => vi.waitFor(async () => {
      await machineStatus.refresh();
      const { sessions, workspaces, projects, machine } = machineStatus.snapshot();
      expect({ sessions, workspaces, projects, machine }).toEqual(expected);
    }, { timeout: 5_000 });
    const idleParentWithRunningSubagents = (sessionId: string) => ({ sessions: { [sessionId]: running }, workspaces: { w1: running }, projects: { p1: running }, machine: running });
    const noFlags = { sessions: {}, workspaces: {}, projects: {}, machine: {} };

    await service.prompt(ref, "Run a worker in the background");
    expect(await service.status(ref)).toMatchObject({ isStreaming: false, isCompacting: false });
    await expectMachineStatus(idleParentWithRunningSubagents(ref.id));

    renderSubagents(subagentsWidget("complete"));
    await expectMachineStatus(noFlags);
    renderSubagents(subagentsWidget("running"));
    await expectMachineStatus(idleParentWithRunningSubagents(ref.id));

    await service.reload(ref);
    await expectMachineStatus(noFlags);
    renderSubagents(subagentsWidget("running"));
    await expectMachineStatus(idleParentWithRunningSubagents(ref.id));

    // /clone and /fork rebind the runtime under a new id; the replaced id must not keep the mark.
    const cloned = await service.runCommand(ref, "/clone");
    if (cloned.type !== "done" || cloned.session === undefined) throw new Error("/clone did not replace the session");
    const cloneRef = { id: cloned.session.id, cwd: directory };
    expect(cloneRef.id).not.toBe(ref.id);
    await expectMachineStatus(noFlags);
    renderSubagents(subagentsWidget("running"));
    await expectMachineStatus(idleParentWithRunningSubagents(cloneRef.id));

    await service.stop(cloneRef);
    expect(service.activeCount()).toBe(0);
    await expectMachineStatus(noFlags);
  }, 30_000);
});
