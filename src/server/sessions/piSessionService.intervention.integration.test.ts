import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices, createEventBus, SessionManager, SettingsManager, type AgentSession } from "../../piSdk.js";
import { WorkspaceActivityService } from "../activity/workspaceActivityService.js";
import { MachineStatusService } from "../status/machineStatusService.js";
import { CORE_STATUS_FLAGS } from "../../shared/machineStatus.js";
import { createAskUserRequest } from "./askUserDomain.js";
import { createAskUserToolDefinition } from "./askUserTool.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService } from "./piSessionService.js";
import { createRequestHumanInterventionToolDefinition } from "./requestHumanInterventionTool.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, testModel } from "./piSessionService.testSupport.js";

const GOAL_CONTINUATION = "Continue working toward the active Goal.";
const TYPED_PROMPT = "Use DuckDB";
const questions = [{ id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }] }];
const askOptions = { createAskId: () => "goal-ask", now: () => new Date("2026-02-01T10:00:00.000Z") };
const postedAsk = createAskUserRequest(questions, askOptions);
const askUserCall = { name: "ask_user", arguments: { questions } };
const interventionCall = { name: "request_human_intervention", arguments: { reason: "Approve the migration described above" } };
const waiting = { status: true, listed: true, session: true, workspace: true };
const coldWaiting = { listed: true, session: true, workspace: true };
const notWaiting = { status: false, listed: false, session: undefined, workspace: undefined };

// Real SDK runtime, tools, extension runner and session file; only model
// transport is scripted. The fixture extension mirrors only pi-goal 0.55.4's
// continuation dispatch, `pi.sendUserMessage(prompt, { deliverAs: "followUp" })`.
async function interventionFixture(requestCall: Pick<Extract<AssistantMessage["content"][number], { type: "toolCall" }>, "name" | "arguments">) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-web-intervention-")));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, "agent");
  const sessionDir = join(directory, "sessions");
  const transcript = SessionManager.create(directory, sessionDir);
  transcript.appendMessage({ role: "user", content: "Work on this", timestamp: 1 });
  const beforeFormId = transcript.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Working" }], api: "anthropic-messages", provider: testModel().provider, model: testModel().id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 2,
  });
  const ref = { id: transcript.getSessionId(), cwd: directory };
  const modelRuntime = await createTestModelRuntime();
  await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
  let modelCalls = 0;
  let nativeSession: AgentSession | undefined;
  let dispatchGoalContinuation: (() => void) | undefined;

  const workspaceActivity = new WorkspaceActivityService();
  const machineStatus = new MachineStatusService({
    activity: workspaceActivity,
    unread: { catalogSnapshot: () => ({ sessions: [] }) },
    attribution: { attribute: (cwds) => Promise.resolve(new Map([...cwds].filter((cwd) => cwd === directory).map((cwd) => [cwd, { projectId: "p1", workspaceId: "w1" }]))) },
    publisher: { publish: () => undefined },
    logger: { warn: () => undefined },
  });
  const service = new PiSessionService(new CapturingSessionEventHub(), {
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
            dispatchGoalContinuation = () => { pi.sendUserMessage(GOAL_CONTINUATION, { deliverAs: "followUp" }); };
          }],
        },
      });
      const result = await createAgentSessionFromServices({
        services, sessionManager, ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
        model: testModel(), thinkingLevel: "off", noTools: "builtin",
        customTools: [createAskUserToolDefinition(askOptions), createRequestHumanInterventionToolDefinition()],
      });
      result.session.setSessionName("Intervention test");
      result.session.agent.streamFunction = () => {
        modelCalls += 1;
        const requesting = modelCalls === 1;
        const stopReason = requesting ? "toolUse" : "stop";
        const message: AssistantMessage = {
          role: "assistant", content: requesting
            ? [{ type: "toolCall", id: "request-call", name: requestCall.name, arguments: requestCall.arguments }]
            : [{ type: "text", text: "Continuing" }],
          api: "anthropic-messages", provider: "anthropic", model: testModel().id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason, timestamp: Date.now(),
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: stopReason, message });
        stream.end(message);
        return stream;
      };
      nativeSession = result.session;
      return { ...result, services, diagnostics: services.diagnostics };
    },
  });
  onTestFinished(() => service.dispose());

  await service.status(ref);
  // Reopening the session after a stop replaces the hosted SDK session.
  const currentSession = () => {
    if (nativeSession === undefined) throw new Error("Expected the hosted SDK session");
    return nativeSession;
  };
  const continueGoal = () => {
    if (dispatchGoalContinuation === undefined) throw new Error("Goal continuation fixture extension is not loaded");
    dispatchGoalContinuation();
  };
  const runToIdle = async (expectedModelCalls: number) => {
    await vi.waitFor(() => { expect(modelCalls).toBe(expectedModelCalls); });
    await currentSession().waitForIdle();
  };
  // Listing row and machine flags only, so a stopped session stays closed.
  const rowAndFlags = async () => {
    const listed = (await service.list(directory)).find((entry) => entry.id === ref.id);
    await machineStatus.refresh();
    const snapshot = machineStatus.snapshot();
    return {
      listed: listed?.interventionRequired,
      session: snapshot.sessions?.[ref.id]?.[CORE_STATUS_FLAGS.interventionRequired],
      workspace: snapshot.workspaces["w1"]?.[CORE_STATUS_FLAGS.interventionRequired],
    };
  };
  const waitingSurfaces = async () => ({ status: (await service.status(ref)).interventionRequired, ...(await rowAndFlags()) });
  return { ref, beforeFormId, service, currentSession, continueGoal, runToIdle, rowAndFlags, waitingSurfaces };
}

type InterventionFixture = Awaited<ReturnType<typeof interventionFixture>>;

const askContinuations: {
  input: string; text: string; send: (f: InterventionFixture) => void | Promise<void>;
  closed: string; close: (f: InterventionFixture) => Promise<unknown>;
}[] = [
  {
    input: "a Goal continuation", text: GOAL_CONTINUATION, send: (f) => { f.continueGoal(); },
    closed: "skipped", close: (f) => f.service.cancelAsk(f.ref, postedAsk.askId),
  },
  {
    input: "an ordinary typed prompt", text: TYPED_PROMPT, send: (f) => f.service.prompt(f.ref, TYPED_PROMPT),
    closed: "answered", close: (f) => f.service.submitAsk(f.ref, postedAsk.askId, { answers: [{ id: "db", values: ["pg"] }] }),
  },
];

describe("intervention through later user input on a real Pi runtime", () => {
  it.each(askContinuations)("keeps an unanswered ask_user form waiting through $input and the agent's reply, until it is $closed", async ({ text, send, close }) => {
    const f = await interventionFixture(askUserCall);
    await f.currentSession().prompt("Check with me before continuing");
    await f.runToIdle(1);
    expect(await f.waitingSurfaces()).toEqual(waiting);

    await send(f);
    await f.runToIdle(2);
    // Pi records the input as an ordinary user message, and the agent replies to it.
    expect(f.currentSession().messages.slice(-2)).toMatchObject([
      { role: "user", content: [{ type: "text", text }] },
      { role: "assistant", stopReason: "stop" },
    ]);
    // The form is still open and answerable by its ask id, so the session still waits for the user.
    expect((await f.service.transcriptSnapshot(f.ref)).openAsk).toEqual(postedAsk);
    expect(await f.waitingSurfaces()).toEqual(waiting);

    // The same saved branch still waits without a live runtime and after reopening.
    await f.service.stop(f.ref);
    expect(f.service.activeCount()).toBe(0);
    expect(await f.rowAndFlags()).toEqual(coldWaiting);
    expect(await f.waitingSurfaces()).toEqual(waiting);

    await close(f);
    await f.runToIdle(3);
    expect((await f.service.transcriptSnapshot(f.ref)).openAsk).toBeUndefined();
    expect(await f.waitingSurfaces()).toEqual(notWaiting);
  }, 30_000);

  it("ends an ask_user wait on the next message after navigating to an entry before the form", async () => {
    const f = await interventionFixture(askUserCall);
    await f.currentSession().prompt("Check with me before continuing");
    await f.runToIdle(1);
    await f.service.prompt(f.ref, TYPED_PROMPT);
    await f.runToIdle(2);
    expect(await f.waitingSurfaces()).toEqual(waiting);

    const expectedLeafId = f.currentSession().sessionManager.getLeafId();
    await f.service.navigateTree(f.ref, { targetId: f.beforeFormId, expectedLeafId, summary: { mode: "none" } });
    await f.service.prompt(f.ref, "Try another way");
    await f.runToIdle(3);
    expect((await f.service.transcriptSnapshot(f.ref)).openAsk).toBeUndefined();
    expect(await f.waitingSurfaces()).toEqual(notWaiting);
  }, 30_000);

  it("ends a non-question intervention on a Goal continuation and the agent's reply", async () => {
    const f = await interventionFixture(interventionCall);
    await f.currentSession().prompt("Check with me before continuing");
    await f.runToIdle(1);
    expect(await f.waitingSurfaces()).toEqual(waiting);

    f.continueGoal();
    await f.runToIdle(2);
    expect((await f.service.transcriptSnapshot(f.ref)).openAsk).toBeUndefined();
    expect(await f.waitingSurfaces()).toEqual(notWaiting);
  }, 30_000);
});
