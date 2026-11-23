import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices, createEventBus, SessionManager, SettingsManager } from "../../piSdk.js";
import { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import { MachineStatusService } from "../status/machineStatusService.js";
import { CORE_STATUS_FLAGS } from "../../shared/machineStatus.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, testModel } from "./piSessionService.testSupport.js";

const activeGoal = { id: "goal-1", text: "Ship the release", status: "active", startedAt: 1, updatedAt: 1, iteration: 0, tokensUsed: 0, timeUsedSeconds: 0, baselineTokens: 0 };
const waitingGoal = { ...activeGoal, waiting: { reason: "Waiting for CI" } };

// Real SDK runtime, extension runner, session file and listing scanner. The
// fixture extension mirrors pi-goal 0.55.4 persistence only: every Goal change,
// and session_shutdown, append the whole Goal as a `goal-state` entry.
describe("Goal waiting across a real Pi runtime", () => {
  it("publishes a wait from the extension, keeps it after Stop and a daemon restart, and clears it on wake", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-web-goal-wait-")));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const agentDir = join(directory, "agent");
    const sessionDir = join(directory, "sessions");
    const transcript = SessionManager.create(directory, sessionDir);
    transcript.appendMessage({ role: "user", content: "Work on this", timestamp: 1 });
    transcript.appendMessage({
      role: "assistant", content: [{ type: "text", text: "Working" }], api: "anthropic-messages", provider: testModel().provider, model: testModel().id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: 2,
    });
    const ref = { id: transcript.getSessionId(), cwd: directory };
    const modelRuntime = await createTestModelRuntime();
    const modelCall = vi.fn(() => { throw new Error("Goal waiting must not call a model"); });
    let goal: unknown = activeGoal;
    let persistGoal: ((next: unknown) => void) | undefined;
    let waitsDuringShutdown: unknown;
    const setGoal = (next: unknown) => {
      if (persistGoal === undefined) throw new Error("Goal fixture extension is not loaded");
      persistGoal(next);
    };

    function daemon() {
      const events = new CapturingSessionEventHub();
      const workspaceActivity = new WorkspaceActivityService();
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
                persistGoal = (next) => {
                  goal = next;
                  pi.appendEntry("goal-state", { goal: next });
                };
                pi.on("session_shutdown", () => {
                  waitsDuringShutdown = workspaceActivity.snapshot().goalWaitingSessions;
                  pi.appendEntry("goal-state", { goal });
                });
              }],
            },
          });
          const result = await createAgentSessionFromServices({
            services, sessionManager, ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
            model: testModel(), thinkingLevel: "off", noTools: "all",
          });
          result.session.agent.streamFunction = modelCall;
          return { ...result, services, diagnostics: services.diagnostics };
        },
      });
      onTestFinished(() => service.dispose());
      const machineFlags = async () => {
        await machineStatus.refresh();
        return machineStatus.snapshot().sessions?.[ref.id];
      };
      const listedGoalWaiting = async () => (await service.list(directory)).find((session) => session.id === ref.id)?.goalWaiting;
      const lastStatus = () => events.globalEvents.filter((event) => event.type === "status.update").at(-1);
      return { service, machineFlags, listedGoalWaiting, lastStatus };
    }
    const waiting = { [CORE_STATUS_FLAGS.goalWaiting]: true };

    const first = daemon();
    expect((await first.service.status(ref)).goalWaiting).toBe(false);
    setGoal(waitingGoal);
    expect(first.lastStatus()).toMatchObject({ status: { sessionId: ref.id, goalWaiting: true } });
    expect(await first.machineFlags()).toEqual(waiting);

    await first.service.stop(ref);
    expect(first.service.activeCount()).toBe(0);
    expect(waitsDuringShutdown).toEqual([]);
    expect(await first.machineFlags()).toEqual(waiting);
    await first.service.dispose();

    const restarted = daemon();
    expect(await restarted.listedGoalWaiting()).toBe(true);
    expect(await restarted.machineFlags()).toEqual(waiting);
    expect(restarted.service.activeCount()).toBe(0);

    expect((await restarted.service.status(ref)).goalWaiting).toBe(true);
    setGoal(activeGoal);
    expect(restarted.lastStatus()).toMatchObject({ status: { sessionId: ref.id, goalWaiting: false } });
    await restarted.service.stop(ref);
    expect(await restarted.machineFlags()).toBeUndefined();
    expect(await restarted.listedGoalWaiting()).toBeUndefined();
    expect(modelCall).not.toHaveBeenCalled();
  }, 30_000);
});
