import { css } from "lit";

export const conversationLayoutStyles = css`
  @layer pi-web-base {
    :host { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; isolation: isolate; }
    :host([hidden]) { display: none; }
    .transcript { position: relative; display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; isolation: isolate; }
    .goal { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 2; display: flex; align-items: center; gap: 8px; max-width: 80%; box-sizing: border-box; padding: 4px 14px; border: 1px solid var(--pi-border); border-radius: 999px; background: var(--pi-surface); box-shadow: 0 2px 10px rgb(0 0 0 / 18%); color: var(--pi-text); font: 12px var(--pi-font, system-ui, sans-serif); white-space: nowrap; overflow: hidden; pointer-events: none; }
    .goal-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--pi-warning); }
    .goal[data-tone="active"] .goal-dot { background: var(--pi-success); }
    .goal[data-tone="complete"] .goal-dot { background: var(--pi-muted); }
    .goal-label { color: var(--pi-muted); }
    .goal-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .toasts { position: absolute; top: 44px; left: 50%; transform: translateX(-50%); z-index: 2; display: flex; flex-direction: column; align-items: center; gap: 6px; width: min(560px, calc(100% - 24px)); pointer-events: none; }
    .toast { box-sizing: border-box; max-width: 100%; padding: 6px 12px; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); box-shadow: 0 2px 10px rgb(0 0 0 / 18%); color: var(--pi-text); font: 12px/1.4 var(--pi-font, system-ui, sans-serif); overflow-wrap: anywhere; white-space: pre-wrap; max-height: 40vh; overflow: auto; pointer-events: auto; }
    ::slotted(chat-view) { flex: 1 1 auto; min-height: 0; min-width: 0; }
    .composer-boundary { position: relative; flex: 0 0 auto; min-width: 0; container-type: inline-size; }
    .chat-composer[hidden], .question-actions[hidden] { display: none; }
    .question-mode { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; padding: 8px 12px; border-top: 1px solid var(--pi-border); background: var(--pi-surface); color: var(--pi-text); font: 13px var(--pi-font, system-ui, sans-serif); }
    .question-mode span { min-width: 0; overflow-wrap: anywhere; }
    .question-actions { color: var(--pi-text); font: 14px var(--pi-font, system-ui, sans-serif); }
    ::slotted([slot="composer"]) { isolation: isolate; }
    ::slotted([slot="status"]) { flex: 0 0 auto; }
    /* Only this decoration crosses the boundary, never the whole transcript. */
    .activity-region { position: absolute; top: -9px; inset-inline: 8px; z-index: 1; display: flex; justify-content: center; pointer-events: none; }
    .activity-dock { display: flex; align-items: center; gap: 4px; max-width: 100%; height: 18px; min-width: 0; box-sizing: border-box; background: var(--pi-success-surface); color: var(--pi-text); padding: 1px 6px; font: 11px/16px var(--pi-font, system-ui, sans-serif); }
    .activity-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--pi-success); flex: 0 0 auto; animation: pulse 1s steps(1, end) infinite; }
    .plain .dot { animation: none; }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
    @keyframes pulse { 0%, 100% { transform: scale(.75); opacity: .55; } 50% { transform: scale(1.2); opacity: 1; } }
  }
`;
