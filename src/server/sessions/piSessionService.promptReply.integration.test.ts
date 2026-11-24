import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "pi-web-typebox";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSession, DefaultResourceLoader, defineTool, SessionManager, SettingsManager,
  type AgentSession, type ExtensionContext, type InlineExtension, type SessionBoundaryDraft,
} from "../../piSdk.js";
import type { PromptReplyLink } from "../../shared/apiTypes.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService, type PiSessionServiceDependencies } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, testModel } from "./piSessionService.testSupport.js";

// Real SDK dispatch, persistence and run ordering; only runtime construction,
// model transport and one extension are substituted. The link needs an SDK
// whose preflightResult passes the dispatched user message (the p5yr hook);
// with any other SDK the same submissions must stay silent.
const sdkReportsPromptMessages = await withHostedSession([reply([{ type: "text", text: "Probe" }])], [], async ({ session }) => {
  let reported: unknown;
  await session.prompt("Probe", { preflightResult: (_disposition, message?: unknown) => { reported = message; } });
  return typeof reported === "object" && reported !== null;
});

describe.runIf(sdkReportsPromptMessages)("prompt reply link with an SDK that reports prompt messages", () => {
  it("links the run's settled final to its request once, after a tool round", async () => {
    await withHostedSession([
      reply([{ type: "toolCall", id: "lookup-call", name: "lookup", arguments: {} }]),
      reply([{ type: "text", text: "Final" }]),
      reply([{ type: "text", text: "Unrequested" }]),
    ], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "Look it up", undefined, undefined, { requestId: "voice-1" });
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      const final = session.sessionManager.getBranch().at(-1);
      expect(final?.type === "message" && final.message.role === "assistant" && final.message.stopReason).toBe("stop");
      expect(promptReplies(hub)).toEqual([{ requestId: "voice-1", entryId: final?.id }]);
      // Both assistant entries were linked to their streams; only the final answers the request.
      expect(hub.sessionEvents.filter(({ event }) => event.type === "assistant.saved").map(({ event }) => event.type === "assistant.saved" && event.entryId))
        .toEqual([expect.any(String), final?.id]);

      // A later run without a request ID is never attributed to the earlier one.
      await service.prompt(ref, "Again");
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(2); });
      expect(promptReplies(hub)).toHaveLength(1);
    });
  });

  const continuations: { change: string; drafts: (ctx: ExtensionContext) => SessionBoundaryDraft[]; input: string }[] = [
    {
      change: "a hidden custom message",
      drafts: () => [{ type: "custom_message", customType: "prompt-reply-test", content: "Keep going", display: false }],
      input: "Keep going",
    },
    {
      change: "a compaction",
      drafts: () => [{ type: "compaction", summary: "Extension summary", firstKeptEntryId: null }],
      input: "Extension summary",
    },
    {
      change: "a rewrite of the requested message",
      drafts: (ctx) => [
        { type: "context_edit", targetId: lastMessageEntryId(ctx, "user"), replacement: { content: "Rewritten request" } },
        // Omitting the first stop lets the run continue from the rewritten request.
        { type: "context_edit", targetId: lastMessageEntryId(ctx, "assistant"), replacement: null },
      ],
      input: "Rewritten request",
    },
  ];

  it.each(continuations)("stays silent when an extension continues the run with $change", async ({ drafts, input }) => {
    await withHostedSession([
      reply([{ type: "text", text: "First stop" }]),
      reply([{ type: "text", text: "Continued final" }]),
    ], [continueOnceBeforeSettle(drafts)], async ({ service, ref, hub, modelRequests }) => {
      await service.prompt(ref, "Answer", undefined, undefined, { requestId: "voice-1" });
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelRequests[1]).toContain(input);
      expect(hub.sessionEvents.filter(({ event }) => event.type === "assistant.saved")).toHaveLength(2);
      expect(promptReplies(hub)).toEqual([]);
    });
  });

  it("stays silent for both requests when a queued prompt joins the run", async () => {
    const firstRequest = latch();
    const firstAnswer = latch();
    await withHostedSession([
      (abort) => {
        firstRequest.resolve();
        return reply([{ type: "text", text: "Answer to first" }], firstAnswer.promise)(abort);
      },
      reply([{ type: "text", text: "Answer to both" }]),
    ], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "First", undefined, undefined, { requestId: "voice-1" });
      await firstRequest.promise;
      await service.prompt(ref, "Second", undefined, undefined, { requestId: "voice-2" });
      await vi.waitFor(() => { expect(session.getFollowUpMessages()).toEqual(["Second"]); });
      firstAnswer.resolve();
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(session.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(2);
      expect(promptReplies(hub)).toEqual([]);
    });
  });

  it("stays silent when a steered prompt joins a run that a custom message started", async () => {
    const holding = latch();
    const release = latch();
    await withHostedSession([reply([{ type: "text", text: "Answer to both" }])], [holdFirstRunStart(holding.resolve, release.promise)], async ({ service, ref, session, hub }) => {
      const foreignRun = session.sendCustomMessage({ customType: "foreign", content: "Foreign work", display: true }, { triggerTurn: true });
      await holding.promise;
      await service.prompt(ref, "Steered", "steer", undefined, { requestId: "voice-1" });
      await vi.waitFor(() => { expect(session.getSteeringMessages()).toEqual(["Steered"]); });
      release.resolve();
      await foreignRun;
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      // The steered prompt reached the model before the run's only reply.
      expect(modelInputKinds(session)).toEqual(["custom_message", "user", "assistant"]);
      expect(promptReplies(hub)).toEqual([]);
    });
  });

  it("stays silent when a custom message is steered into the prompt's run before its reply", async () => {
    const holding = latch();
    const release = latch();
    await withHostedSession([reply([{ type: "text", text: "Answer to both" }])], [holdFirstRunStart(holding.resolve, release.promise)], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "Answer", undefined, undefined, { requestId: "voice-1" });
      await holding.promise;
      await session.sendCustomMessage({ customType: "foreign", content: "Foreign work", display: true }, { deliverAs: "steer" });
      release.resolve();
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(modelInputKinds(session)).toEqual(["user", "custom_message", "assistant"]);
      expect(promptReplies(hub)).toEqual([]);
    });
  });

  it("stays silent when the run is aborted", async () => {
    const pending = latch();
    await withHostedSession([
      reply([{ type: "toolCall", id: "lookup-call", name: "lookup", arguments: {} }]),
      replyUntilAborted(pending.resolve),
    ], [], async ({ service, ref, hub }) => {
      await service.prompt(ref, "Look it up", undefined, undefined, { requestId: "voice-1" });
      await pending.promise;
      await service.abort(ref);
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      expect(promptReplies(hub)).toEqual([]);
    });
  });

  it("stays silent when the final reply is a provider error", async () => {
    await withHostedSession([failedReply("Provider unavailable")], [], async ({ service, ref, session, hub }) => {
      await service.prompt(ref, "Answer", undefined, undefined, { requestId: "voice-1" });
      await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

      const final = session.sessionManager.getBranch().at(-1);
      expect(final?.type === "message" && final.message.role === "assistant" && final.message.stopReason).toBe("error");
      expect(promptReplies(hub)).toEqual([]);
    });
  });
});

it.runIf(!sdkReportsPromptMessages)("sends no prompt reply link when the SDK does not report prompt messages", async () => {
  await withHostedSession([reply([{ type: "text", text: "Final" }])], [], async ({ service, ref, hub }) => {
    await service.prompt(ref, "Answer", undefined, undefined, { requestId: "voice-1" });
    await vi.waitFor(() => { expect(settledCount(hub)).toBe(1); });

    expect(hub.sessionEvents.filter(({ event }) => event.type === "assistant.saved")).toHaveLength(1);
    expect(promptReplies(hub)).toEqual([]);
  });
});

interface HostedSession {
  service: PiSessionService;
  ref: { id: string; cwd: string };
  session: AgentSession;
  hub: CapturingSessionEventHub;
  /** Each model request's context messages, serialized when it was made. */
  modelRequests: string[];
}

type ModelReply = (abort: AbortSignal | undefined) => ReturnType<typeof createAssistantMessageEventStream>;

function settledCount(hub: CapturingSessionEventHub): number {
  return hub.sessionEvents.filter(({ event }) => event.type === "pi.event" && event.eventType === "agent_settled").length;
}

function promptReplies(hub: CapturingSessionEventHub): PromptReplyLink[] {
  return hub.sessionEvents.flatMap(({ event }) => event.type === "pi.event" && event.promptReply !== undefined ? [event.promptReply] : []);
}

/** Branch messages and custom messages, without system messages. */
function modelInputKinds(session: AgentSession): string[] {
  return session.sessionManager.getBranch().flatMap((entry) => {
    if (entry.type === "custom_message") return ["custom_message"];
    const role: string | undefined = entry.type === "message" ? entry.message.role : undefined;
    return role === undefined || role === "system" ? [] : [role];
  });
}

/** Holds the first run in before_agent_start, where the SDK already counts it as streaming, until `release`. */
function holdFirstRunStart(onHold: () => void, release: Promise<void>): InlineExtension {
  return (pi) => {
    let held = false;
    pi.on("before_agent_start", async () => {
      if (held) return;
      held = true;
      onHold();
      await release;
    });
  };
}

/** Appends `drafts` and requests one more model turn, without user input, the first time the run would settle. */
function continueOnceBeforeSettle(drafts: (ctx: ExtensionContext) => SessionBoundaryDraft[]): InlineExtension {
  return (pi) => {
    let continued = false;
    pi.on("agent_before_settle", (_event, ctx) => {
      if (continued) return undefined;
      continued = true;
      return { entries: drafts(ctx), continue: true };
    });
  };
}

function lastMessageEntryId(ctx: ExtensionContext, role: "user" | "assistant"): string {
  const entry = ctx.sessionManager.getBranch().filter((candidate) => candidate.type === "message" && candidate.message.role === role).at(-1);
  if (entry === undefined) throw new Error(`No ${role} message on the branch`);
  return entry.id;
}

async function withHostedSession<T>(replies: ModelReply[], extensionFactories: InlineExtension[], scenario: (hosted: HostedSession) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-prompt-reply-"));
  const agentDir = join(directory, "agent");
  let service: PiSessionService | undefined;
  let nativeSession: AgentSession | undefined;
  const modelRequests: string[] = [];
  try {
    const modelRuntime = await createTestModelRuntime();
    await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
    const lookup = defineTool({
      name: "lookup", label: "lookup", description: "Return a fixed result.", parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text" as const, text: "Done" }], details: {} }),
    });
    const createAgentRuntime: NonNullable<PiSessionServiceDependencies["createAgentRuntime"]> = async (_factory, options) => {
      if (!(options.sessionManager instanceof SessionManager)) throw new Error("Expected a file-backed SessionManager");
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      const resourceLoader = new DefaultResourceLoader({
        cwd: directory, agentDir, settingsManager, extensionFactories,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
      });
      await resourceLoader.reload();
      const { session } = await createAgentSession({
        cwd: directory, agentDir, sessionManager: options.sessionManager, settingsManager, resourceLoader,
        modelRuntime, model: testModel(), noTools: "builtin", customTools: [lookup],
      });
      nativeSession = session;
      session.agent.streamFunction = (_model, context, streamOptions) => {
        modelRequests.push(JSON.stringify(context.messages));
        const next = replies.shift();
        if (next === undefined) throw new Error("Unexpected model request");
        return next(streamOptions?.signal);
      };
      return {
        cwd: directory, session, setRebindSession: () => undefined,
        fork: () => Promise.resolve({ cancelled: true }),
        dispose: () => { session.dispose(); return Promise.resolve(); },
      };
    };
    const hub = new CapturingSessionEventHub();
    service = new PiSessionService(hub, {
      agentDir, modelRuntime, createAgentRuntime, archiveStore: emptyArchiveStore(), heartbeatIntervalMs: 60_000,
      sessionManager: createPiSessionManagerGateway({ agentDir, env: { PI_CODING_AGENT_SESSION_DIR: join(directory, "sessions") } }),
    });
    const started = await service.start(directory);
    if (nativeSession === undefined) throw new Error("Expected the hosted SDK session");
    return await scenario({ service, ref: { id: started.id, cwd: directory }, session: nativeSession, hub, modelRequests });
  } finally {
    await service?.dispose();
    nativeSession?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant", content,
    api: "anthropic-messages", provider: "anthropic", model: testModel().id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}

/** Completes with `content` once `release` settles. */
function reply(content: AssistantMessage["content"], release: Promise<void> = Promise.resolve()): ModelReply {
  return () => {
    const stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
    const message = assistantMessage(content, stopReason);
    const stream = createAssistantMessageEventStream();
    void release.then(() => {
      stream.push({ type: "done", reason: stopReason, message });
      stream.end(message);
    });
    return stream;
  };
}

function failedReply(errorMessage: string): ModelReply {
  return () => {
    const message = { ...assistantMessage([], "error"), errorMessage };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
    });
    return stream;
  };
}

/** Streams nothing until the run aborts, calling `onRequest` once the request is made. */
function replyUntilAborted(onRequest: () => void): ModelReply {
  return (abort) => {
    const stream = createAssistantMessageEventStream();
    abort?.addEventListener("abort", () => {
      const message = assistantMessage([], "aborted");
      stream.push({ type: "error", reason: "aborted", error: message });
      stream.end(message);
    }, { once: true });
    onRequest();
    return stream;
  };
}

function latch(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}
