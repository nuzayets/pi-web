import type { AskUserOutcome, AskUserRequest } from "../../shared/apiTypes";
import { chatFallbackParts, type ChatLine } from "./chatTypes";

export interface QuestionTailContext {
  historyReady: boolean;
  messageEnd: number;
  messageTotal: number;
  writable: boolean;
  /** The server's open question, for when it precedes the loaded messages. */
  earlierAsk?: AskUserRequest | undefined;
}

/**
 * The latest question stays open until it is answered or skipped, or a newer question replaces it,
 * so a goal continuation or background notice doesn't discard it.
 * The last visible page is not necessarily the active conversation's tail.
 */
export function openTranscriptQuestion(messages: readonly ChatLine[], context: QuestionTailContext): AskUserRequest | undefined {
  if (!context.historyReady || !context.writable || context.messageEnd < context.messageTotal) return undefined;
  const answered = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const line = messages[index];
    if (line === undefined) continue;
    const parts = chatFallbackParts(line.parts);
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part?.type === "askUserRecord") answered.add(part.outcome.askId);
      if (part?.type === "askUserQuestion") return answered.has(part.ask.askId) ? undefined : part.ask;
    }
  }
  const earlier = context.earlierAsk;
  return earlier === undefined || answered.has(earlier.askId) ? undefined : earlier;
}

/** Responses remain separate transcript facts; none is treated as stale. */
export function transcriptQuestionOutcomes(messages: readonly ChatLine[]): ReadonlyMap<string, AskUserOutcome[]> {
  const outcomes = new Map<string, AskUserOutcome[]>();
  for (const message of messages) {
    for (const part of chatFallbackParts(message.parts)) {
      if (part.type !== "askUserRecord") continue;
      const replies = outcomes.get(part.outcome.askId) ?? [];
      replies.push(part.outcome);
      outcomes.set(part.outcome.askId, replies);
    }
  }
  return outcomes;
}
