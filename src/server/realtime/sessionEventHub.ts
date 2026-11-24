import type { GlobalSessionEvent, RealtimeEvent, SessionNotificationSummaryEvent, SessionStatus, SessionUiEvent } from "../../shared/apiTypes.js";
import { isSessionActive } from "../../shared/activity.js";
import { projectBrowserSessionEvent } from "../browserMessageProjection.js";
import { SESSION_MEDIA_MODE } from "../../shared/sessionMedia.js";
import { SESSION_TOOL_TEXT_DERIVED, toolTextFromContent } from "../../shared/sessionToolText.js";
import { SessionMediaIndex, type SessionMediaScope } from "../sessions/sessionMediaIndex.js";

export interface RealtimeSocket {
  readonly OPEN: number;
  readyState: number;
  send(payload: string): void;
  terminate(): void;
  on(event: "close", listener: () => void): unknown;
}

/** Each subscriber's tool text opt-in, keyed by its socket. */
type SessionSubscribers = Map<RealtimeSocket, typeof SESSION_TOOL_TEXT_DERIVED | undefined>;

export class SessionEventHub {
  private readonly socketsBySession = new Map<string, { inline: SessionSubscribers; reference: SessionSubscribers }>();
  private readonly globalSockets = new Set<RealtimeSocket>();
  private readonly seqBySession = new Map<string, number>();
  /** Last published active status JSON per session, tracked separately per channel. */
  private readonly sessionActiveStatuses = new Map<string, string>();
  private readonly globalActiveStatuses = new Map<string, string>();
  private globalJoinFrame: (() => RealtimeEvent) | undefined;

  /** The service and routes use this same owned index; service disposal clears it. */
  constructor(readonly mediaIndex = new SessionMediaIndex()) {}

  add(sessionId: string, socket: RealtimeSocket, mediaMode?: typeof SESSION_MEDIA_MODE, toolText?: typeof SESSION_TOOL_TEXT_DERIVED): void {
    let subscribers = this.socketsBySession.get(sessionId);
    if (!subscribers) {
      subscribers = { inline: new Map(), reference: new Map() };
      this.socketsBySession.set(sessionId, subscribers);
    }
    const sockets = mediaMode === SESSION_MEDIA_MODE ? subscribers.reference : subscribers.inline;
    sockets.set(socket, toolText);
    socket.on("close", () => {
      sockets.delete(socket);
      if (subscribers.inline.size === 0 && subscribers.reference.size === 0) this.socketsBySession.delete(sessionId);
    });
    // A joining subscriber has seen no status yet, so the next one is not a repeat.
    this.sessionActiveStatuses.delete(sessionId);
  }

  /**
   * Frame sent to each global subscriber the moment it joins, before any live
   * event. It closes the join race for state the browser would otherwise only
   * fetch over HTTP: with two proxy hops in federation, that fetch can resolve
   * before the upstream subscription exists and then be clobbered by a stale
   * value.
   */
  setGlobalJoinFrame(frame: () => RealtimeEvent): void {
    this.globalJoinFrame = frame;
  }

  addGlobal(socket: RealtimeSocket): void {
    this.globalSockets.add(socket);
    socket.on("close", () => this.globalSockets.delete(socket));
    // A joiner has seen no status yet, and sidebar statuses arrive only on this channel.
    this.globalActiveStatuses.clear();
    const joinFrame = this.globalJoinFrame?.();
    if (joinFrame !== undefined) this.sendToSocket(this.globalSockets, socket, JSON.stringify(joinFrame));
  }

  publish(sessionId: string, event: SessionUiEvent, mediaScope?: SessionMediaScope): void {
    // Checked before stamping so skipped repeats leave no sequence gap.
    if (event.type === "status.update" && isRepeatedActiveStatus(this.sessionActiveStatuses, sessionId, event.status)) return;
    const seq = (this.seqBySession.get(sessionId) ?? 0) + 1;
    this.seqBySession.set(sessionId, seq);
    // Index even without subscribers: live tool output may not be persisted yet
    // when the browser joins or requests a previously published media id.
    const referenceEvent = projectBrowserSessionEvent(event, (image) => this.mediaIndex.reference(mediaScope, image));
    const sockets = this.socketsBySession.get(sessionId);
    if (sockets !== undefined && sockets.inline.size > 0) this.sendToSubscribers(sockets.inline, projectBrowserSessionEvent(event), seq);
    if (sockets !== undefined && sockets.reference.size > 0) this.sendToSubscribers(sockets.reference, referenceEvent, seq);
  }

  /**
   * Last per-session sequence number stamped by {@link publish} (0 before any
   * event). Callers building a join-time stream snapshot read this as the
   * watermark: buffered live events with `seq <= currentSeq` are already
   * reflected in the snapshot's partial and must be dropped by the client.
   */
  currentSeq(sessionId: string): number {
    return this.seqBySession.get(sessionId) ?? 0;
  }

  publishGlobal(event: GlobalSessionEvent): void {
    if (event.type === "status.update" && isRepeatedActiveStatus(this.globalActiveStatuses, event.status.sessionId, event.status)) return;
    this.publishRealtime(event);
  }

  publishNotificationSummary(event: SessionNotificationSummaryEvent): void {
    const payload = JSON.stringify(event);
    this.sendToSockets(this.globalSockets, payload);
  }

  publishRealtime(event: RealtimeEvent): void {
    const payload = JSON.stringify(event);
    this.sendToSockets(this.globalSockets, payload);
  }

  private sendToSockets(sockets: Set<RealtimeSocket> | undefined, payload: string): void {
    if (sockets === undefined) return;
    for (const socket of sockets) this.sendToSocket(sockets, socket, payload);
  }

  /** Serializes each payload variant at most once, and only when a subscriber receives it. */
  private sendToSubscribers(subscribers: SessionSubscribers, event: SessionUiEvent, seq: number): void {
    let legacy: string | undefined;
    let derived: string | undefined;
    const legacyPayload = () => legacy ??= JSON.stringify({ ...event, seq });
    // JSON.stringify drops the undefined `text` key, leaving every other field in place.
    const derivedPayload = () => derived ??= hasDerivableToolText(event) ? JSON.stringify({ ...event, text: undefined, seq }) : legacyPayload();
    for (const [socket, toolText] of subscribers) {
      this.sendToSocket(subscribers, socket, toolText === SESSION_TOOL_TEXT_DERIVED ? derivedPayload() : legacyPayload());
    }
  }

  private sendToSocket(sockets: Pick<Set<RealtimeSocket>, "delete">, socket: RealtimeSocket, payload: string): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(payload);
    } catch {
      sockets.delete(socket);
      try {
        socket.terminate();
      } catch {
        // Removal is authoritative; cleanup failure must not block healthy sockets.
      }
    }
  }
}

function hasDerivableToolText(event: SessionUiEvent): boolean {
  return (event.type === "tool.update" || event.type === "tool.end") && toolTextFromContent(event.content) === event.text;
}

/**
 * Active work republishes its unchanged status on every agent event, so only
 * active repeats are skipped. Inactive statuses always go out: clients clear an
 * active activity label when they apply one, even an identical one. So do
 * statuses with open dialogs: a repeat restores a dialog the run waits on after
 * an older HTTP response dropped it from the browser.
 */
function isRepeatedActiveStatus(delivered: Map<string, string>, sessionId: string, status: SessionStatus): boolean {
  if (!isSessionActive(status) || (status.pendingDialogs?.length ?? 0) > 0) {
    delivered.delete(sessionId);
    return false;
  }
  const json = JSON.stringify(status);
  if (delivered.get(sessionId) === json) return true;
  delivered.set(sessionId, json);
  return false;
}
