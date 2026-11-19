import { message } from "../localization/service";

export default {
  subagents: message("subagents", "Title of the panel listing a session's background subagents"),
  toggleSubagents: message("Show or hide subagents", "Accessible label and tooltip of the subagents panel header"),
  subagentState: message<{ state: string }>(
    "{state, select, running {running} queued {queued} complete {done} failed {failed} paused {paused} partial {partial} stopped {stopped} rejected {rejected} other {{state}}}",
    "State of a background subagent run",
  ),
  stateCount: message<{ count: number; state: string }>("{count} {state}", "Number of subagent runs in one state; state is a localized subagent state"),
  omitted: message<{ count: number }>("+{count} more", "Subagent runs left out of the snapshot"),
  turns: message<{ count: number }>("{count, plural, one {# turn} other {# turns}}", "Model turns a subagent has taken"),
  seconds: message<{ seconds: number }>("{seconds}s", "Compact elapsed time under a minute"),
  minutes: message<{ minutes: number; seconds: number }>("{minutes}m {seconds}s", "Compact elapsed time under an hour"),
  hours: message<{ hours: number; minutes: number }>("{hours}h {minutes}m", "Compact elapsed time of an hour or more"),
  ago: message<{ age: string }>("{age} ago", "Age of a subagent's latest progress report; age is a compact elapsed time"),
};
