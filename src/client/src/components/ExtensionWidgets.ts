import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { ExtensionWidget } from "../api";
import { localization, LocalizationController } from "../localization/browser";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { hasLiveSubagents, subagentCounts, subagentRows, type SubagentRow } from "../extensionUi/subagents";
import { subagentSnapshot, SUBAGENTS_WIDGET_KEY, type SubagentSnapshot } from "../../../shared/subagentsWidget";
import { ChatView } from "./ChatView";
import "./FormattedText";
import definitions from "./extensionWidgets.messages";

export const extensionWidgetsMessages = localization.registerMessages("core.extensionWidgets", definitions);
const messages = extensionWidgetsMessages;
const COLLAPSED_KEY = "pi-web:subagents-collapsed";
const TICK_MS = 1000;

export function formatElapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return messages.t("seconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return messages.t("minutes", { minutes, seconds: seconds % 60 });
  return messages.t("hours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

function rowDetail(row: SubagentRow): string {
  const parts = [row.agent, row.model, row.tool, row.turns === undefined ? undefined : messages.t("turns", { count: row.turns }),
    row.elapsedMs === undefined ? undefined : formatElapsed(row.elapsedMs)];
  return parts.filter((part) => part !== undefined).join(" · ");
}

function subagentSummary(snapshot: SubagentSnapshot): string {
  const parts = subagentCounts(snapshot).map(({ state, count }) => messages.t("stateCount", { count, state: messages.t("subagentState", { state }) }));
  if (snapshot.omittedRuns > 0) parts.push(messages.t("omitted", { count: snapshot.omittedRuns }));
  return parts.join(" · ");
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Extension widgets above the composer. Lit re-renders only what changed between updates. */
@customElement("extension-widgets")
export class ExtensionWidgets extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this, localization);
  }

  @property({ attribute: false }) widgets: readonly ExtensionWidget[] = [];
  @property({ attribute: false }) onRunCommand: ((command: string) => void) | undefined;
  @state() private collapsed = readCollapsed();
  @state() private now = Date.now();
  private tick: ReturnType<typeof setInterval> | undefined;
  private height = 0;
  private readonly unfollowed = new Set<string>();
  private readonly hostResize = new ResizeObserver(() => { this.keepChatEnd(); });
  private readonly contentResize = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const body = entry.target.parentElement;
      const key = body?.dataset["key"];
      if (body !== null && key !== undefined && !this.unfollowed.has(key)) body.scrollTop = body.scrollHeight;
    }
  });

  override connectedCallback(): void {
    super.connectedCallback();
    this.hostResize.observe(this);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.hostResize.disconnect();
    this.contentResize.disconnect();
    this.stopTick();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("widgets")) this.hidden = this.widgets.length === 0;
  }

  protected override updated(): void {
    for (const content of this.renderRoot.querySelectorAll(".body > .content")) this.contentResize.observe(content);
    const subagents = this.subagentWidget();
    const live = subagents !== undefined && !this.collapsed && hasLiveSubagents(subagentRows(subagents, this.now));
    if (live && this.tick === undefined) this.tick = setInterval(() => { this.now = Date.now(); }, TICK_MS);
    else if (!live) this.stopTick();
  }

  private stopTick(): void {
    clearInterval(this.tick);
    this.tick = undefined;
  }

  private subagentWidget(): SubagentSnapshot | undefined {
    const widget = this.widgets.find((candidate) => candidate.key === SUBAGENTS_WIDGET_KEY);
    return widget === undefined ? undefined : subagentSnapshot(widget.lines);
  }

  // The chat shrinks as the widgets grow; keep it at its end if it was there.
  private keepChatEnd(): void {
    const height = this.isConnected ? this.offsetHeight : 0;
    const chat = this.parentElement?.querySelector("chat-view");
    if (chat instanceof ChatView) chat.keepEndAfterShrink(height - this.height);
    this.height = height;
  }

  private toggleSubagents(): void {
    this.collapsed = !this.collapsed;
    try {
      localStorage.setItem(COLLAPSED_KEY, this.collapsed ? "1" : "0");
    } catch {
      // Collapsing still works for this page.
    }
  }

  private onBodyScroll(event: Event, key: string): void {
    const body = event.currentTarget;
    if (!(body instanceof HTMLElement)) return;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) this.unfollowed.delete(key);
    else this.unfollowed.add(key);
  }

  override render() {
    return html`${repeat(this.widgets, (widget) => widget.key, (widget) => {
      const snapshot = widget.key === SUBAGENTS_WIDGET_KEY ? subagentSnapshot(widget.lines) : undefined;
      return snapshot === undefined ? this.renderWidget(widget) : this.renderSubagents(snapshot);
    })}`;
  }

  private renderSubagents(snapshot: SubagentSnapshot) {
    const label = messages.t("toggleSubagents");
    return html`
      <section class=${this.collapsed ? "panel subagents collapsed" : "panel subagents"}>
        <header>
          <button type="button" class="header-toggle" aria-expanded=${this.collapsed ? "false" : "true"} aria-label=${label} title=${label} @click=${() => { this.toggleSubagents(); }}>
            <span class="label">${messages.t("subagents")}</span><span class="summary">${subagentSummary(snapshot)}</span><span class="chevron">${this.collapsed ? "▴" : "▾"}</span>
          </button>
        </header>
        ${this.collapsed ? nothing : html`<div class="rows">${subagentRows(snapshot, this.now).map((row) => html`
          <div class="row" style=${`padding-inline-start: ${String(row.depth * 16)}px`}>
            <span class="dot" data-state=${row.state} title=${messages.t("subagentState", { state: row.state })}></span>
            <span class="name">${row.label}</span><span class="detail">${rowDetail(row)}</span>
          </div>
          ${row.progress === undefined ? nothing : html`
            <div class="progress" style=${`margin-inline-start: ${String(row.depth * 16)}px`} title=${row.progress}>
              <span class="text">${row.progress}</span>
              ${row.progressAgeMs === undefined ? nothing : html`<span class="age">· ${messages.t("ago", { age: formatElapsed(row.progressAgeMs) })}</span>`}
            </div>`}
        `)}</div>`}
      </section>
    `;
  }

  private renderWidget(widget: ExtensionWidget) {
    const text = widget.lines.join("\n");
    return html`
      <section class="panel widget">
        ${widget.title === undefined && widget.actions === undefined ? nothing : html`
          <header>
            <span class="title">${widget.title ?? ""}</span>
            ${(widget.actions ?? []).map((action) => html`
              <button type="button" class="action" title=${action.title ?? action.label} aria-label=${action.title ?? action.label}
                @click=${() => { this.onRunCommand?.(action.command); }}>${action.label}</button>`)}
          </header>`}
        <div class="body" data-key=${widget.key} @scroll=${(event: Event) => { this.onBodyScroll(event, widget.key); }}>
          <div class="content">${widget.markdown === true ? html`<formatted-text .text=${text}></formatted-text>` : html`<pre>${text}</pre>`}</div>
        </div>
      </section>
    `;
  }

  static override styles = css`
    @layer pi-web-base {
      :host { display: flex; flex-direction: column; flex: none; gap: 8px; min-height: 0; max-height: 60%; overflow-y: auto; box-sizing: border-box; padding: 6px 12px 12px; color: var(--pi-text); font: 13px var(--pi-font, system-ui, sans-serif); }
      :host([hidden]) { display: none; }
      .panel { display: flex; flex-direction: column; min-height: 0; flex: 0 1 auto; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); overflow: hidden; }
      .subagents { flex: none; }
      header { flex: none; display: flex; align-items: baseline; gap: 8px; padding: 8px 12px; }
      .panel:not(.collapsed) header { border-bottom: 1px solid var(--pi-border); }
      .header-toggle { all: unset; flex: 1; display: flex; align-items: baseline; gap: 8px; cursor: pointer; min-width: 0; }
      .label { color: var(--pi-muted); }
      .summary, .title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
      .title { font-weight: 600; }
      .action { all: unset; cursor: pointer; padding: 0 4px; color: var(--pi-muted); line-height: 1; font-size: 1.15em; }
      .action:hover, .header-toggle:hover .chevron { color: var(--pi-text); }
      .chevron { color: var(--pi-muted); }
      .rows { overflow: auto; max-height: 12em; padding: 6px 12px 8px; }
      .row { display: flex; align-items: center; gap: 8px; white-space: nowrap; padding: 2px 0; }
      .name { font-weight: 600; }
      .detail, .progress { color: var(--pi-muted); }
      .detail { overflow: hidden; text-overflow: ellipsis; }
      .progress { display: flex; gap: 6px; font-size: 0.9em; white-space: nowrap; padding: 0 0 2px 16px; }
      .progress .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .progress .age { flex: none; }
      .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--pi-warning); }
      .dot[data-state="running"] { background: var(--pi-success); }
      .dot[data-state="complete"], .dot[data-state="stopped"], .dot[data-state="queued"] { background: var(--pi-muted); }
      .dot[data-state="failed"], .dot[data-state="rejected"] { background: var(--pi-danger); }
      .body { flex: 1 1 auto; min-height: 4em; overflow: auto; padding: 8px 12px; overflow-wrap: anywhere; line-height: 1.45; }
      pre { margin: 0; white-space: pre-wrap; font: 12px var(--pi-mono, monospace); }
      formatted-text { display: block; }
    }
  `;
}
