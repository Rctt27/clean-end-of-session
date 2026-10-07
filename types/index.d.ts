/**
 * Where the clean stop stands:
 * - `armed`: watching the credit windows, nothing happens.
 * - `stopping`: threshold reached, agents warned, no new agent.
 * - `overage`: past 100 %, the clean stop goes on within the overage budget.
 * - `stopped`: the clean stop is over, no request leaves anymore.
 * - `braked`: the overage budget ran out, no request leaves anymore.
 * - `off`: the mod is off for this session (turned off, or not armed at start).
 */
export type GracefulStopPhase = 'armed' | 'stopping' | 'overage' | 'stopped' | 'braked' | 'off'

/** A subagent the clean stop is waiting on, as it was when first seen. */
export type GracefulStopAgent = {
  id: string
  description: string
  type: string
  /** Its last known status (AgentStatus), refreshed as the stop goes on. */
  status: string
  /** Its final answer, the status report, once its run ended. */
  report: string | null
}

export type GracefulStopStatus = {
  phase: GracefulStopPhase
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
  agents: GracefulStopAgent[]
  /** Main turns ended with every agent done but the memo still provisional. */
  idleTurns: number
}

/** A credit window as the engine reports it (SessionRateLimit). */
export type GracefulStopWindow = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  percentUsed: number
  /** When the window resets, ISO 8601. */
  resetsAt?: string
}

/** The session's last credit reading, as the band draws it. */
export type GracefulStopCredit = {
  windows: GracefulStopWindow[]
  /** When it was read, in ms since the epoch. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'graceful-stop': {
      status: GracefulStopStatus
      /** The last reading of this session; null before its first request. */
      credit: GracefulStopCredit | null
      /** The current minute, ticked so the band's reset countdowns move. */
      minute: number
      /** Whether this session's start was seen: a reload must not disarm it again. */
      started: boolean
    }
  }
}
