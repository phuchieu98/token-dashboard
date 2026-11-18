export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Task = {
  status: 'running' | 'idle'
  label: string
  startedAt: number
  endedAt?: number
  steps: number
  tools: number
  // How many times each tool ran during the task (Bash, Edit, Read, ...).
  toolCounts: Record<string, number>
  skills: string[]
  tokens: Tokens
  // The part of `tokens` spent by subagents the task started.
  agentTokens: number
}

// One usage window (the plan's 7-day or 5-hour limit): when it runs, and
// how much chat time and how many tokens this Claude spent inside it.
export type UsageWindow = { start: number; end: number; activeMs: number; tokens: number }

export type Snapshot = {
  version: 1
  updatedAt: number
  session: { startedAt: number; tokens: Tokens; costUsd?: number }
  context: { tokens: number; window: number; percent: number }
  limits: Limit[]
  budget?: { tokens: number; used: number; remaining: number; percentUsed: number }
  task: Task | null
  lastTask: Task | null
  // Finished tasks of this session, newest first.
  history: Task[]
  // Chat time and tokens per limit window, kept across sessions.
  activity?: { week?: UsageWindow; five?: UsageWindow }
  // Free slot for later add-ons (more metrics, a cookie/session link, ...).
  extensions: Record<string, string | number | boolean>
}

declare module 'claude-code' {
  interface PluginState {
    'token-meter': { snap: Shaped<Snapshot> }
  }
}
