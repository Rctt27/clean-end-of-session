/**
 * Where the clean stop stands:
 * - `armed`: watching the credit windows, nothing happens.
 * - `stopping`: threshold reached, agents warned, no new agent.
 * - `overage`: past 100 %, the clean stop goes on within the overage budget.
 * - `stopped`: the clean stop is over, no request leaves anymore.
 * - `braked`: the overage budget ran out, no request leaves anymore.
 * - `off`: the person turned the mod off for this session.
 */
export type CleanEndPhase = 'armed' | 'stopping' | 'overage' | 'stopped' | 'braked' | 'off'

/** A subagent the clean stop is waiting on, as it was when first seen. */
export type CleanEndAgent = {
  id: string
  description: string
  type: string
  /** Its last known status (AgentStatus), refreshed as the stop goes on. */
  status: string
  /** Its final answer, the status report, once its run ended. */
  report: string | null
}

export type CleanEndStatus = {
  phase: CleanEndPhase
  /** What triggered the stop, e.g. "five_hour 90 %" or "manuel". */
  trigger: string | null
  /** When the credit window that triggered resets, ISO 8601. */
  resetsAt: string | null
  /** The session's cost when the windows passed 100 %, in USD. */
  baselineUsd: number | null
  /** Estimated overage spent since then, in USD. */
  spentUsd: number
  /** Subagents warned, by id: tool calls each made since its warning. */
  warned: Record<string, number>
  /** The resume memo's absolute path, once the stop wrote one. */
  memoPath: string | null
  /** Every subagent the stop covers, kept even once it finished. */
  agents: CleanEndAgent[]
  /** Main turns ended with every agent done but the memo still provisional. */
  idleTurns: number
}

declare module 'claude-code' {
  interface PluginState {
    'clean-end-of-session': { status: CleanEndStatus }
  }
}
