/** The session's recent work, by band: when each call finished, and when a band last failed. */
export type Activity = {
  /** Band id → finish times (ms since the epoch) of the last minute's calls. */
  hits: Record<string, number[]>
  /** Band id → when a call in it last failed. */
  failedAt: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'session-equalizer': { activity: Activity; isHidden: boolean }
  }
}
