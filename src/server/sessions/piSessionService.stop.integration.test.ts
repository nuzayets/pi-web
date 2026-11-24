import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices, createEventBus, SessionManager, SettingsManager } from "../../piSdk.js";
import { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import { MachineStatusService } from "../status/machineStatusService.js";
import { CORE_STATUS_FLAGS, type MachineStatusSnapshot } from "../../shared/machineStatus.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, testModel } from "./piSessionService.testSupport.js";

function assistant(text: string, stopReason: "stop" | "aborted", timestamp: number): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider: testModel().provider, model: testModel().id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp, ...(stopReason === "aborted" ? { errorMessage: "Test transport aborted" } : {}),
  };
}

// Real SDK runtime, queue and abort; only the model transport is fake, and it
// streams until Stop aborts it.
describe("stopping a working session across a real Pi runtime", () => {
  it("clears the working mark once the stopped runtime is quiescent", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-web-stop-working-")));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const agentDir = join(directory, "agent");
    const sessionDir = join(directory, "sessions");
    const transcript = SessionManager.create(directory, sessionDir);
    transcript.appendMessage({ role: "user", content: "Plan the work", timestamp: 1 });
    transcript.appendMessage(assistant("Planned", "stop", 2));
    const ref = { id: transcript.getSessionId(), cwd: directory };
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
    let streaming: () => void = () => { throw new Error("Streaming gate not initialized"); };
    const providerStreaming = new Promise<void>((resolve) => { streaming = resolve; });

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
          },
        });
        const result = await createAgentSessionFromServices({
          services, sessionManager, ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
          model: testModel(), thinkingLevel: "off", noTools: "all",
        });
        result.session.agent.streamFunction = (_model, _context, options) => {
          const signal = options?.signal;
          if (signal === undefined) throw new Error("Native run did not supply an abort signal");
          const stream = createAssistantMessageEventStream();
          const finishAborted = () => {
            const message = assistant("", "aborted", Date.now());
            stream.push({ type: "error", reason: "aborted", error: message });
            stream.end(message);
          };
          if (signal.aborted) finishAborted();
          else signal.addEventListener("abort", finishAborted, { once: true });
          streaming();
          return stream;
        };
        return { ...result, services, diagnostics: services.diagnostics };
      },
    });
    onTestFinished(() => service.dispose());

    const expectMachineStatus = (expected: Pick<MachineStatusSnapshot, "sessions" | "workspaces" | "projects" | "machine">) => vi.waitFor(async () => {
      await machineStatus.refresh();
      const { sessions, workspaces, projects, machine } = machineStatus.snapshot();
      expect({ sessions, workspaces, projects, machine }).toEqual(expected);
    }, { timeout: 5_000 });
    const working = { [CORE_STATUS_FLAGS.working]: true };

    await service.prompt(ref, "Keep working until stopped");
    await providerStreaming;
    expect(await service.status(ref)).toMatchObject({ isStreaming: true });
    await expectMachineStatus({ sessions: { [ref.id]: working }, workspaces: { w1: working }, projects: { p1: working }, machine: working });

    await service.stop(ref);
    expect(service.activeCount()).toBe(0);
    await expectMachineStatus({ sessions: {}, workspaces: {}, projects: {}, machine: {} });
  }, 30_000);
});
