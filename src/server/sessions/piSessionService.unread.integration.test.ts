import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "pi-web-typebox";
import { describe, expect, it, vi } from "vitest";
import { createAgentSession, DefaultResourceLoader, defineTool, SessionManager, SettingsManager, type AgentSession } from "../../piSdk.js";
import type { SessionUiEvent } from "../../shared/apiTypes.js";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService, type PiSessionServiceDependencies } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime, emptyArchiveStore, testModel } from "./piSessionService.testSupport.js";
import { SessionUnreadStore } from "./sessionUnreadStore.js";

// Real SDK persistence and turn ordering. Only runtime construction and model
// transport are substituted; all files belong to this test.
describe("unread completion replies with native Pi", () => {
  it("names only a run's final saved reply in the transcript, live stream, and catalog", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-unread-reply-"));
    const agentDir = join(directory, "agent");
    let service: PiSessionService | undefined;
    let nativeSession: AgentSession | undefined;
    try {
      const modelRuntime = await createTestModelRuntime();
      await modelRuntime.setRuntimeApiKey("anthropic", "isolated-test-key");
      const tool = (name: string, terminate: boolean) => defineTool({
        name, label: name, description: "Return a fixed result.", parameters: Type.Object({}),
        execute: () => Promise.resolve({ content: [{ type: "text" as const, text: "Done" }], details: {}, terminate }),
      });
      const replies: AssistantMessage["content"][] = [
        [{ type: "toolCall", id: "lookup-call", name: "lookup", arguments: {} }],
        [{ type: "text", text: "Final answer" }],
        [{ type: "toolCall", id: "finish-call", name: "finish", arguments: {} }],
        [{ type: "text", text: "Answer after the tool-ended run" }],
      ];
      const createAgentRuntime: NonNullable<PiSessionServiceDependencies["createAgentRuntime"]> = async (_factory, options) => {
        if (!(options.sessionManager instanceof SessionManager)) throw new Error("Expected a file-backed SessionManager");
        const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
        const resourceLoader = new DefaultResourceLoader({
          cwd: directory, agentDir, settingsManager,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
          agentsFilesOverride: () => ({ agentsFiles: [] }),
        });
        await resourceLoader.reload();
        const { session } = await createAgentSession({
          cwd: directory, agentDir, sessionManager: options.sessionManager, settingsManager, resourceLoader,
          modelRuntime, model: testModel(), noTools: "builtin", customTools: [tool("lookup", false), tool("finish", true)],
        });
        nativeSession = session;
        session.agent.streamFunction = () => {
          const content = replies.shift();
          if (content === undefined) throw new Error("Unexpected model request");
          const stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
          const message: AssistantMessage = {
            role: "assistant", content,
            api: "anthropic-messages", provider: "anthropic", model: testModel().id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason, timestamp: Date.now(),
          };
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: stopReason, message });
          stream.end(message);
          return stream;
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
        unreadStore: new SessionUnreadStore(),
      });
      const started = await service.start(directory);
      const ref = { id: started.id, cwd: directory };
      if (nativeSession === undefined) throw new Error("Expected the hosted SDK session");
      const session = nativeSession;
      const sessionFile = session.sessionFile;
      if (sessionFile === undefined) throw new Error("Expected a persistent session path");
      const prompt = vi.spyOn(session, "prompt");
      const completedRow = async (completionOrder: number) => {
        const hosted = service;
        if (hosted === undefined) throw new Error("Expected the hosted session service");
        return vi.waitFor(async () => {
          const [row] = (await hosted.unreadCatalog()).sessions;
          expect(row).toMatchObject({ sessionId: started.id, completionOrder });
          return row;
        });
      };

      await service.prompt(ref, "Look it up");
      await prompt.mock.results[0]?.value;
      const firstRow = await completedRow(1);
      const [toolRound, finalReply] = savedAssistantEntryIds(sessionFile);
      const [toolRoundStream, finalStream] = endedStreamIds(hub.sessionEvents);
      expect(firstRow).toMatchObject({ replyEntryId: finalReply });
      expect(replyLinks(hub.sessionEvents)).toEqual([
        { streamId: toolRoundStream, entryId: toolRound, afterEnd: true },
        { streamId: finalStream, entryId: finalReply, afterEnd: true },
      ]);

      await service.acknowledgeUnread(started.id, { cwd: directory, catalogId: (await service.unreadCatalog()).catalogId, throughCompletionOrder: 1 });
      await service.prompt(ref, "Finish with a tool");
      await prompt.mock.results[1]?.value;
      const secondRow = await completedRow(2);
      const finishRound = savedAssistantEntryIds(sessionFile)[2];
      // The tool round was saved and linked live, but its tool result followed it.
      expect(replyLinks(hub.sessionEvents).at(-1)).toEqual({ streamId: endedStreamIds(hub.sessionEvents)[2], entryId: finishRound, afterEnd: true });
      expect(secondRow).not.toHaveProperty("replyEntryId");

      // That unread completion, still unacknowledged, does not hold the next observed reply.
      await service.prompt(ref, "Answer now");
      await prompt.mock.results[2]?.value;
      const thirdRow = await completedRow(3);
      const answer = savedAssistantEntryIds(sessionFile)[3];
      expect(replyLinks(hub.sessionEvents).at(-1)).toEqual({ streamId: endedStreamIds(hub.sessionEvents)[3], entryId: answer, afterEnd: true });
      expect(thirdRow).toMatchObject({ replyEntryId: answer });
    } finally {
      await service?.dispose();
      nativeSession?.dispose();
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

/** Assistant entry IDs read back from the transcript file, oldest first. */
function savedAssistantEntryIds(sessionFile: string): string[] {
  return SessionManager.open(sessionFile).getBranch()
    .flatMap((entry) => entry.type === "message" && entry.message.role === "assistant" ? [entry.id] : []);
}

/** Streams of assistant messages ended live, oldest first. */
function endedStreamIds(events: readonly { event: SessionUiEvent }[]): string[] {
  return events.flatMap(({ event }) => {
    const streamId = event.type === "message.end" ? streamIdOf(event.message) : undefined;
    return streamId === undefined ? [] : [streamId];
  });
}

/** Live links in publication order, noting whether their stream's message.end came first. */
function replyLinks(events: readonly { event: SessionUiEvent }[]): { streamId: string; entryId: string; afterEnd: boolean }[] {
  const ended = new Set<string | undefined>();
  const links: { streamId: string; entryId: string; afterEnd: boolean }[] = [];
  for (const { event } of events) {
    if (event.type === "message.end") ended.add(streamIdOf(event.message));
    if (event.type === "assistant.saved") links.push({ streamId: event.streamId, entryId: event.entryId, afterEnd: ended.has(event.streamId) });
  }
  return links;
}

function streamIdOf(message: unknown): string | undefined {
  return typeof message === "object" && message !== null && "streamId" in message && typeof message.streamId === "string"
    ? message.streamId
    : undefined;
}
