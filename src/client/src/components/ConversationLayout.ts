import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { questionActionStyles, type QuestionActions } from "./questionActions";
import { uiButtonStyles } from "./ui/controlStyles";
import { askUserMessages } from "./AskUserCard";
import type { SessionActivity, SessionStatus } from "../api";
import type { ExtensionToast } from "../appState";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { conversationLayoutStyles } from "../theme/base/conversationLayoutStyles";
import { localization, LocalizationController } from "../localization/browser";
import definitions from "./conversationLayout.messages";
import runtimeDefinitions from "./runtimeActivity.messages";
import { parseRuntimeActivityPresentation } from "../../../shared/sessionActivityPresentation";

export const conversationLayoutMessages = localization.registerMessages("core.conversationLayout", definitions);
const messages = conversationLayoutMessages;
export const runtimeActivityMessages = localization.registerMessages("core.runtimeActivity", runtimeDefinitions);

/** Activity belongs to the conversation boundary, not the transcript scroller. */
export function conversationActivityText(status: SessionStatus | undefined, activity: SessionActivity | undefined, sending: boolean): string | undefined {
  if (sending) return messages.t("sending");
  const state = status === undefined ? undefined
    : status.isCompacting ? "compacting"
    : status.isBashRunning ? "bash"
    : status.isStreaming ? "running"
    : status.pendingMessageCount > 0 ? "queued" : "idle";
  if ((state === undefined && (activity === undefined || activity.phase === "idle")) || (state === "idle" && activity?.phase !== "active")) return undefined;
  if (activity === undefined || (state !== undefined && state !== "idle" && activity.phase === "idle")) return state === undefined || state === "idle" ? undefined : messages.t(state);
  const startup = activity.startupPresentation;
  // Older servers and future/unknown presentation versions retain their raw fallback.
  if (activity.phase === "active" && startup !== undefined
    && ["create", "open"].includes(startup.intent)
    && ["runtime", "extensions"].includes(startup.stage)
    && typeof startup.catalogRefreshing === "boolean") {
    return messages.t("startup", { intent: startup.intent, stage: startup.stage, refreshing: startup.catalogRefreshing ? "yes" : "no" });
  }
  const runtime = parseRuntimeActivityPresentation(activity.runtimePresentation);
  let label = activity.label;
  let detail = activity.detail;
  if (runtime !== undefined) {
    label = "value" in runtime ? runtimeActivityMessages.t(runtime.kind, { value: runtime.value }) : runtimeActivityMessages.t(runtime.kind);
    if ("detailKind" in runtime) {
      detail = runtimeActivityMessages.t(`${runtime.detailKind}Detail`);
    }
  }
  return detail !== undefined && detail !== "" ? messages.t("summary", { label, detail }) : label;
}

/** pi-goal's status text: green while active, grey when complete, amber when it waits. */
export function goalTone(goal: string): "active" | "complete" | "attention" {
  if (goal.startsWith("active")) return "active";
  if (goal === "complete") return "complete";
  return "attention";
}

/** Owns the transcript/composer boundary; children own their content and actions. */
@customElement("conversation-layout")
export class ConversationLayout extends LitElement {
  constructor() {
    super();
    stylesheetIntegrationCapability.createController(this);
    new LocalizationController(this, localization);
  }

  @property({ attribute: false }) status: SessionStatus | undefined;
  @property({ attribute: false }) activity: SessionActivity | undefined;
  @property({ type: Boolean }) sending = false;
  @property({ type: Boolean }) visualEffects = true;
  @property({ attribute: false }) questionActions: QuestionActions | undefined;
  @property({ attribute: false }) onChatMode: (() => void) | undefined;
  /** The session's goal status, shown as a pill over the transcript. */
  @property({ attribute: false }) goal: string | undefined;
  @property({ attribute: false }) toasts: readonly ExtensionToast[] = [];
  @state() private chatMode = false;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has("questionActions")) return;
    const previous = changed.get("questionActions");
    if (previous?.key !== this.questionActions?.key || previous?.editVersion !== this.questionActions?.editVersion) {
      this.chatMode = false;
    }
  }

  private async switchMode(): Promise<void> {
    this.chatMode = !this.chatMode;
    await this.updateComplete;
    if (this.chatMode) this.onChatMode?.();
    else this.questionActions?.focus();
  }

  override render() {
    const activity = conversationActivityText(this.status, this.activity, this.sending);
    const answering = this.questionActions !== undefined && !this.chatMode;
    return html`
      <div class="transcript">
        <slot></slot>
        ${this.goal === undefined ? nothing : html`
          <div class="goal" data-tone=${goalTone(this.goal)} title=${messages.t("goal", { goal: this.goal })}><span class="goal-dot"></span><span class="goal-label">${messages.t("goalLabel")}</span><span class="goal-text">${this.goal}</span></div>
        `}
        <div class="toasts" role="status">${this.toasts.map((toast) => html`<div class="toast">${toast.message}</div>`)}</div>
      </div>
      <div class="composer-boundary">
        ${this.questionActions === undefined ? nothing : html`
          <div class="question-mode">
            <span role="status">${askUserMessages.t(this.chatMode ? "pending" : "answerMode")}</span>
            <button type="button" class="ui-button ui-button--compact" @click=${() => { void this.switchMode(); }}>
              ${askUserMessages.t(this.chatMode ? "backToAnswers" : "chatInstead")}
            </button>
          </div>
        `}
        <div class="question-actions" ?hidden=${!answering}>${this.questionActions?.content ?? nothing}</div>
        <div class="chat-composer" ?hidden=${answering} ?inert=${answering}><slot name="composer"></slot></div>
        <div class=${this.visualEffects ? "activity-region" : "activity-region plain"} aria-live="polite">${activity === undefined ? nothing : html`
          <div class="activity-dock"><span class="dot"></span><span class="activity-text">${activity}</span></div>
        `}</div>
      </div>
      <slot name="status"></slot>
    `;
  }

  static override styles = [conversationLayoutStyles, uiButtonStyles, questionActionStyles];
}
