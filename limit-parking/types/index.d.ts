/** The usage window that was nearly spent when the session parked. */
export type ParkedWindow = {
  /** `five_hour`, `seven_day` or `spend_limit`. */
  kind: string
  percent: number
  /** When it resets, as an ISO 8601 timestamp. */
  resetsAt?: string
}

/** A parked session: kept in the store too, so a new session can resume it. */
export type Parked = {
  window: ParkedWindow
  /** Milliseconds since the epoch. */
  parkedAt: number
  /** Claude's own resume note, saved through the save_note tool. */
  note?: string
  /** The last answer before parking: what resumes from when no note was saved. */
  lastAnswer?: string
  /** Set once a measurement showed the window had reset. */
  isReset?: boolean
  /** Set once Claude has been told to park, so it is told once. */
  isDelivered?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'limit-parking': { parked: Parked | null }
  }
}
