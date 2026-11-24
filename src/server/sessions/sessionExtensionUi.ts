import type { ExtensionWidget, ExtensionWidgetAction, SessionExtensionUi } from "../../shared/apiTypes.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const STATUS_MAX_LENGTH = 500;
const WIDGET_MAX_LENGTH = 200_000;
const ACTION_LIMIT = 4;

interface SessionEntry {
  statuses: Map<string, string>;
  widgets: Map<string, ExtensionWidget>;
  lastJson: string;
  published: SessionExtensionUi;
  lastPublishedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function plain(text: string): string {
  return text.replace(ANSI, "");
}

function widgetActions(value: unknown): ExtensionWidgetAction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const actions = value.slice(0, ACTION_LIMIT).flatMap((item: unknown): ExtensionWidgetAction[] => {
    if (typeof item !== "object" || item === null) return [];
    const label: unknown = Reflect.get(item, "label");
    const command: unknown = Reflect.get(item, "command");
    const title: unknown = Reflect.get(item, "title");
    if (typeof label !== "string" || label === "" || typeof command !== "string" || !command.startsWith("/")) return [];
    return [{ label, command, ...(typeof title === "string" && title !== "" ? { title } : {}) }];
  });
  return actions.length > 0 ? actions : undefined;
}

/** Only line content is representable in a browser; TUI component factories clear the widget. */
export function extensionWidget(key: string, content: unknown, options: unknown): ExtensionWidget | undefined {
  return browserWidget(key, content, options)?.widget;
}

/** The widget, and whether its lines were cut to the length limit. */
function browserWidget(key: string, content: unknown, options: unknown): { widget: ExtensionWidget; clipped: boolean } | undefined {
  if (!Array.isArray(content) || !content.every((line) => typeof line === "string")) return undefined;
  let budget = WIDGET_MAX_LENGTH;
  let clipped = false;
  const lines: string[] = [];
  for (const line of content) {
    if (budget <= 0) {
      clipped = true;
      break;
    }
    const whole = plain(line);
    const text = whole.slice(0, budget);
    clipped ||= text.length < whole.length;
    budget -= text.length;
    lines.push(text);
  }
  if (lines.length === 0) return undefined;
  const record = typeof options === "object" && options !== null ? options : {};
  const title: unknown = Reflect.get(record, "title");
  const actions = widgetActions(Reflect.get(record, "actions"));
  const widget: ExtensionWidget = {
    key,
    lines,
    ...(typeof title === "string" && title !== "" ? { title: plain(title) } : {}),
    ...(Reflect.get(record, "markdown") === true ? { markdown: true } : {}),
    ...(actions === undefined ? {} : { actions }),
  };
  return { widget, clipped };
}

/**
 * Extension statuses and widgets per session. Extensions may rewrite them many
 * times a second; browsers get the whole state at most once per interval, and
 * only when it changed.
 */
export class SessionExtensionUiState {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly publish: (sessionId: string, ui: SessionExtensionUi) => void,
    private readonly intervalMs = 500,
    private readonly now: () => number = Date.now,
  ) {}

  setStatus(sessionId: string, key: string, text: unknown): void {
    const value = typeof text === "string" ? plain(text).trim().slice(0, STATUS_MAX_LENGTH) : "";
    const entry = this.entry(sessionId);
    if (value === "") entry.statuses.delete(key);
    else entry.statuses.set(key, value);
    this.schedule(sessionId, entry);
  }

  /**
   * `requestId` goes out with the next publication only; later ones and
   * snapshots omit it. A clipped widget may have lost the reply, so it gets none.
   */
  setWidget(sessionId: string, key: string, content: unknown, options: unknown, requestId?: string): void {
    const parsed = browserWidget(key, content, options);
    const entry = this.entry(sessionId);
    if (parsed === undefined) entry.widgets.delete(key);
    else entry.widgets.set(key, requestId === undefined || parsed.clipped ? parsed.widget : { ...parsed.widget, requestId });
    this.schedule(sessionId, entry);
  }

  snapshot(sessionId: string): SessionExtensionUi {
    // Pending changes reach every browser with the next publication.
    return this.sessions.get(sessionId)?.published ?? { statuses: {}, widgets: [] };
  }

  forget(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.sessions.delete(sessionId);
    if (entry.lastJson !== EMPTY_JSON) this.publish(sessionId, { statuses: {}, widgets: [] });
  }

  dispose(): void {
    for (const entry of this.sessions.values()) clearTimeout(entry.timer);
    this.sessions.clear();
  }

  private entry(sessionId: string): SessionEntry {
    let entry = this.sessions.get(sessionId);
    if (entry === undefined) {
      entry = { statuses: new Map(), widgets: new Map(), lastJson: EMPTY_JSON, published: { statuses: {}, widgets: [] }, lastPublishedAt: Number.NEGATIVE_INFINITY, timer: undefined };
      this.sessions.set(sessionId, entry);
    }
    return entry;
  }

  private schedule(sessionId: string, entry: SessionEntry): void {
    if (entry.timer !== undefined) return;
    const wait = entry.lastPublishedAt + this.intervalMs - this.now();
    if (wait <= 0) {
      this.flush(sessionId, entry);
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.sessions.get(sessionId) === entry) this.flush(sessionId, entry);
    }, wait);
  }

  private flush(sessionId: string, entry: SessionEntry): void {
    const ui = extensionUiOf(entry);
    const json = JSON.stringify(ui);
    if (json === entry.lastJson) return;
    entry.lastPublishedAt = this.now();
    this.publish(sessionId, ui);
    for (const [key, widget] of entry.widgets) {
      if (widget.requestId === undefined) continue;
      const live = { ...widget };
      delete live.requestId;
      entry.widgets.set(key, live);
    }
    entry.published = extensionUiOf(entry);
    entry.lastJson = JSON.stringify(entry.published);
  }
}

const EMPTY_JSON = JSON.stringify({ statuses: {}, widgets: [] });

function extensionUiOf(entry: SessionEntry): SessionExtensionUi {
  return { statuses: Object.fromEntries(entry.statuses), widgets: [...entry.widgets.values()] };
}
