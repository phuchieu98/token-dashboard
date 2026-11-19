import { atom, read, update } from 'claude-code'
import type { Engine as Dollar, Register } from 'claude-code'

import type { Limit, Snapshot, Task, Tokens, UsageWindow } from '../types'

const PANE = 'token-meter'
// The dashboard's data server (Apps Script web app); `/token-meter url <URL>` points elsewhere.
const DEFAULT_ENDPOINT =
  'https://script.google.com/macros/s/AKfycbyaEk748hcksVZaCfKTFNob-CobtzDm_6QTmqrarxqq2qw7CT1DQMLtK9P1Q5MyiSb5/exec'
const SYNC_EVERY_MS = 20_000

const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

const EMPTY: Snapshot = {
  version: 1,
  updatedAt: 0,
  session: { startedAt: 0, tokens: ZERO },
  context: { tokens: 0, window: 0, percent: 0 },
  limits: [],
  task: null,
  lastTask: null,
  history: [],
  extensions: {},
}

const HISTORY_MAX = 30

// Bump the shape tag whenever Snapshot's fields change.
const snap = atom({ plugin: 'token-meter', key: 'snap' } as const, EMPTY, { shape: 'snap-2' })

type UsageLike = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

function addUsage(t: Tokens, u: UsageLike): Tokens {
  const input = t.input + (u.input_tokens ?? 0)
  const output = t.output + (u.output_tokens ?? 0)
  const cacheRead = t.cacheRead + (u.cache_read_input_tokens ?? 0)
  const cacheWrite = t.cacheWrite + (u.cache_creation_input_tokens ?? 0)

  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }
}

function fmt(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`
  }

  return String(Math.round(n))
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0
}

function bar(percent: number, width = 16): string {
  const full = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

  return '█'.repeat(full) + '░'.repeat(width - full)
}

const DAY = 86_400_000
const WEEK = 7 * DAY
const FIVE_H = 5 * 3_600_000

// The window a plan limit runs in, from its reset time; without one (an API key),
// a calendar week from Monday 00:00, or the current 5-hour block.
function windowFor(limits: Limit[], kind: 'seven_day' | 'five_hour', now: number): { start: number; end: number } {
  const span = kind === 'seven_day' ? WEEK : FIVE_H
  const reset = limits.find(l => l.kind === kind)?.resetsAt
  const end = reset === undefined ? NaN : Date.parse(reset)

  if (Number.isFinite(end)) {
    return { start: end - span, end }
  }
  if (kind === 'seven_day') {
    const d = new Date(now)
    const sinceMonday = (d.getDay() + 6) % 7
    d.setHours(0, 0, 0, 0)
    const start = d.getTime() - sinceMonday * DAY

    return { start, end: start + WEEK }
  }
  const start = Math.floor(now / FIVE_H) * FIVE_H

  return { start, end: start + FIVE_H }
}

// Adds to a window, starting it over when the limit has reset since.
function roll(w: UsageWindow | undefined, win: { start: number; end: number }, ms: number, tokens: number): UsageWindow {
  const same = w !== undefined && Math.abs(w.end - win.end) < 120_000
  const base = same ? w : { ...win, activeMs: 0, tokens: 0 }

  return { start: win.start, end: win.end, activeMs: base.activeMs + ms, tokens: base.tokens + tokens }
}

function topTools(t: Task, n = 3): string {
  return Object.entries(t.toolCounts ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k}×${v}`)
    .join(' ')
}

function limitName(kind: string): string {
  if (kind === 'five_hour') {
    return 'Giới hạn 5 giờ'
  }
  if (kind === 'seven_day') {
    return 'Giới hạn 7 ngày'
  }
  if (kind === 'spend_limit') {
    return 'Hạn mức chi'
  }

  return kind
}

function withBudget(s: Snapshot, budget: number | undefined): Snapshot {
  if (budget === undefined || budget <= 0) {
    return { ...s, budget: undefined }
  }
  const used = s.session.tokens.total

  return {
    ...s,
    budget: { tokens: budget, used, remaining: Math.max(0, budget - used), percentUsed: pct(used, budget) },
  }
}

let isDirty = false
let lastSyncNote = 'chưa cấu hình'
let skillsSent = false

// Chat time and tokens per limit window live in the store, so they add up across sessions.
async function addActivity($: Dollar, ms: number, tokens: number): Promise<void> {
  const saved = (await $.store.get('activity')) as Snapshot['activity'] | undefined
  const s = await read($, snap)
  const now = await $.clock.now()
  const activity = {
    week: roll(saved?.week, windowFor(s.limits, 'seven_day', now), ms, tokens),
    five: roll(saved?.five, windowFor(s.limits, 'five_hour', now), ms, tokens),
  }
  await $.store.set('activity', activity)
  await update($, snap, x => ({ ...x, activity }))
}

async function budgetOf($: Dollar): Promise<number | undefined> {
  const v = await $.store.get('budget')

  return typeof v === 'number' ? v : undefined
}

async function refreshUsage($: Dollar): Promise<void> {
  const u = await $.session.usage()
  const budget = await budgetOf($)
  const limits: Limit[] = u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
  const now = await $.clock.now()
  await update($, snap, s =>
    withBudget(
      {
        ...s,
        updatedAt: now,
        session: { ...s.session, startedAt: u.startedAt, costUsd: u.cost?.usd },
        context: { tokens: u.context.tokens ?? 0, window: u.context.window, percent: u.context.percent ?? 0 },
        limits,
      },
      budget,
    ),
  )
  isDirty = true
}

async function endpoint($: Dollar): Promise<string> {
  const url = await $.store.get('endpoint')

  return typeof url === 'string' && url !== '' ? url : DEFAULT_ENDPOINT
}

async function post($: Dollar, payload: unknown): Promise<{ ok?: boolean; error?: string; [k: string]: unknown }> {
  const r = await $.http.fetch(await endpoint($), {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  })

  try {
    return JSON.parse(r.text) as { ok?: boolean; error?: string }
  } catch {
    return { ok: false, error: `HTTP ${r.status}` }
  }
}

// The signed-in Claude account's email, from the person's own config file, as a link's default name.
async function claudeEmail($: Dollar): Promise<string | undefined> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? home

  if (dir === undefined) {
    return undefined
  }
  try {
    const cfg = JSON.parse(await $.fs.read(`${dir}/.claude.json`)) as { oauthAccount?: { emailAddress?: string } }

    return cfg.oauthAccount?.emailAddress
  } catch {
    return undefined
  }
}

async function sync($: Dollar, force = false): Promise<string> {
  if (!isDirty && !force) {
    return lastSyncNote
  }
  const deviceKey = await $.store.get('deviceKey')

  if (typeof deviceKey !== 'string' || deviceKey === '') {
    lastSyncNote = 'chưa liên kết (mở app → Liên kết tài khoản → lấy mã, rồi /token-meter link <mã>)'

    return lastSyncNote
  }
  const s = await read($, snap)
  const link = await $.store.get('link')
  // `/token-meter private on` keeps what each task was about on this machine.
  const isPrivate = (await $.store.get('private')) === true
  const strip = (t: Task): Task => (isPrivate ? { ...t, label: '' } : t)
  // The installed skills go up once per session (they rarely change and the list is long).
  let skills: { name: string; description: string; plugin: string }[] | undefined

  if (!skillsSent) {
    try {
      const all = await $.command.list()
      skills = all
        .filter(c => (c.source === 'plugin' || c.source === 'user') && c.name !== 'token-meter')
        .map(c => ({ name: c.name, description: (c.description ?? '').slice(0, 200), plugin: c.plugin ?? (c.source === 'user' ? 'cá nhân' : '') }))
    } catch {
      skills = undefined
    }
  }
  const body = JSON.stringify({
    deviceKey,
    skills,
    link: typeof link === 'string' ? link : '',
    snapshot: {
      ...s,
      task: s.task && strip(s.task),
      lastTask: s.lastTask && strip(s.lastTask),
      history: s.history.map(strip),
    },
  })

  try {
    const r = await $.http.fetch(await endpoint($), {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body,
    })
    isDirty = false
    let res: { ok?: boolean; error?: string } = {}

    try {
      res = JSON.parse(r.text) as { ok?: boolean; error?: string }
    } catch {
      res = { ok: false, error: `HTTP ${r.status}` }
    }
    if (res.error === 'unlinked') {
      await $.store.set('deviceKey', '')
      lastSyncNote = 'liên kết đã bị huỷ trong app — tạo mã mới để liên kết lại'
      $.ui.toast('Token meter: liên kết với dashboard đã bị huỷ.')
    } else {
      lastSyncNote = res.ok ? `đã gửi ${new Date(await $.clock.now()).toLocaleTimeString()}` : `lỗi: ${res.error ?? r.status}`
      if (res.ok && skills !== undefined) {
        skillsSent = true
      }
    }
  } catch (err) {
    lastSyncNote = `lỗi mạng: ${String(err).slice(0, 60)}`
  }

  return lastSyncNote
}

// Shared by `/token-meter link` and the `link` tool Claude can call.
async function linkWithCode($: Dollar, code: string | undefined, name?: string): Promise<string> {
  if (code === undefined || code.trim() === '') {
    const linked = await $.store.get('linkedAs')

    return typeof linked === 'string' && linked
      ? `Đang liên kết: ${linked}. Huỷ: /token-meter unlink`
      : 'Chưa liên kết. Mở app → menu T → Liên kết tài khoản → "Liên kết tài khoản Claude" để lấy mã, rồi chạy /token-meter link <mã> [tên].'
  }
  const label = (name ?? '').trim() || (await claudeEmail($)) || 'Claude Code'

  try {
    const res = await post($, { action: 'pairFinish', code: code.trim(), label })

    if (!res.ok) {
      return `Không liên kết được: ${res.error ?? 'lỗi không rõ'}`
    }
    await $.store.set('deviceKey', String(res.deviceKey))
    await $.store.set('linkedAs', `"${String(res.label)}" → ${String(res.email)}`)
  } catch (err) {
    return `Không liên kết được: ${String(err).slice(0, 80)}`
  }
  isDirty = true
  const note = await sync($, true)

  return `Đã liên kết tài khoản Claude này với dashboard (${String(await $.store.get('linkedAs'))}). Gửi thử: ${note}`
}

export const register: Register = on => {
  on('tool.run', { tool: 'mcp__token-meter__link' }, async ($, e) => {
    const input = e as unknown as { code?: unknown; name?: unknown }
    const code = typeof input.code === 'string' ? input.code : undefined
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Claude Code'

    if (code === undefined || code.trim() === '') {
      const linked = await $.store.get('linkedAs')

      return { result: typeof linked === 'string' && linked ? `Đang liên kết: ${linked}` : 'Chưa liên kết.' }
    }
    const saved = await $.store.get('endpoint')
    const url = typeof saved === 'string' && saved !== '' ? saved : DEFAULT_ENDPOINT
    let res: { ok?: boolean; error?: string; deviceKey?: unknown; label?: unknown; email?: unknown }

    try {
      const r = await $.http.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'pairFinish', code: code.trim(), label: name }),
      })

      res = JSON.parse(r.text) as typeof res
    } catch (err) {
      return { result: `Không liên kết được: ${String(err).slice(0, 80)}` }
    }
    if (!res.ok) {
      return { result: `Không liên kết được: ${res.error ?? 'lỗi không rõ'}` }
    }
    await $.store.set('deviceKey', String(res.deviceKey))
    await $.store.set('linkedAs', `"${String(res.label)}" → ${String(res.email)}`)
    isDirty = true

    return { result: `Đã liên kết tài khoản Claude này với dashboard ("${String(res.label)}" → ${String(res.email)}). Số liệu gửi lên trong lần đồng bộ kế tiếp.` }
  })

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'link',
      description:
        'Link this Claude Code to the user\'s Token Dashboard account with a pairing code (format ABCD-EFGH) shown in the app under Liên kết tài khoản. Without a code, reports whether it is linked. Same as /token-meter link <code> [name].',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Pairing code from the app, e.g. ABCD-EFGH. Omit to check the link status.' },
          name: { type: 'string', description: 'Optional name for this machine, e.g. PC.' },
        },
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'token-meter',
      description: 'Token meter: link <mã> [tên] | unlink | open | budget | sync | private | clear-history | url | ext',
      argumentHint: '[link <mã>|unlink|open|budget|sync|private|clear-history|url|ext]',
      immediate: true,
    })
    await refreshUsage($)
    await addActivity($, 0, 0)
    void $.ui.open({ id: PANE, title: 'Token' })
    $.clock.every(SYNC_EVERY_MS, () => {
      void sync($)
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refreshUsage($)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      const label = e.text.trim().replace(/\s+/g, ' ').slice(0, 70) || '(tiếp tục)'
      const task: Task = {
        status: 'running',
        label,
        startedAt: now,
        steps: 0,
        tools: 0,
        toolCounts: {},
        skills: [],
        tokens: ZERO,
        agentTokens: 0,
      }
      await update($, snap, s => ({ ...s, task }))
      isDirty = true
    }

    return next(e)
  })

  // Every model request, the main loop's and each subagent's, counts toward the task and the session.
  on('turn.step', async function* ($, e, next) {
    const res = yield* next(e)

    if (res.usage !== null) {
      const u = res.usage
      const budget = await budgetOf($)
      await update($, snap, s =>
        withBudget(
          {
            ...s,
            session: { ...s.session, tokens: addUsage(s.session.tokens, u) },
            task:
              s.task === null
                ? null
                : {
                    ...s.task,
                    steps: s.task.steps + 1,
                    tokens: addUsage(s.task.tokens, u),
                    agentTokens:
                      s.task.agentTokens + (e.agentId === undefined ? 0 : addUsage(ZERO, u).total),
                  },
          },
          budget,
        ),
      )
      await addActivity($, 0, addUsage(ZERO, u).total)
      isDirty = true
    }

    return res
  })

  on('tool.call', async ($, e, next) => {
    await update($, snap, s =>
      s.task === null
        ? s
        : {
            ...s,
            task: {
              ...s.task,
              tools: s.task.tools + 1,
              toolCounts: { ...s.task.toolCounts, [e.tool]: (s.task.toolCounts[e.tool] ?? 0) + 1 },
            },
          },
    )

    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    await update($, snap, s =>
      s.task === null || s.task.skills.includes(e.skill)
        ? s
        : { ...s, task: { ...s.task, skills: [...s.task.skills, e.skill] } },
    )
    isDirty = true

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)

    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, snap, s => {
        if (s.task === null) {
          return s
        }
        const done: Task = { ...s.task, status: 'idle', endedAt: now }

        return { ...s, lastTask: done, task: null, history: [done, ...s.history].slice(0, HISTORY_MAX) }
      })
      await refreshUsage($)
      await addActivity($, e.durationMs, 0)
      void sync($, true)
    }

    return done
  })

  on('command.run', { command: 'token-meter' }, async ($, e) => {
    const [cmd = 'open', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)

    if (cmd === 'open') {
      await $.ui.open({ id: PANE, title: 'Token' })

      return { text: 'Đã mở tab Token.' }
    }
    if (cmd === 'url') {
      const [url] = rest

      if (url === 'default') {
        await $.store.set('endpoint', '')

        return { text: 'Đã quay về máy chủ mặc định.' }
      }
      if (url === undefined || !/^https:\/\//.test(url)) {
        return { text: `Máy chủ hiện tại: ${await endpoint($)}\nĐổi: /token-meter url <URL web app> (hoặc "default")` }
      }
      await $.store.set('endpoint', url)

      return { text: `Đã lưu máy chủ: ${url}` }
    }
    if (cmd === 'budget') {
      const n = Number((rest[0] ?? '').replace(/[_,.]/g, ''))

      if (!Number.isFinite(n) || n < 0) {
        return { text: 'Cách dùng: /token-meter budget <số token>, ví dụ 2000000 (0 để tắt)' }
      }
      await $.store.set('budget', n)
      await refreshUsage($)

      return { text: n === 0 ? 'Đã tắt ngân sách token.' : `Ngân sách: ${fmt(n)} token.` }
    }
    if (cmd === 'sync') {
      return { text: `Đồng bộ: ${await sync($, true)}` }
    }
    if (cmd === 'link') {
      const [code, ...nameParts] = rest

      return { text: await linkWithCode($, code, nameParts.join(' ')) }
    }
    if (cmd === 'unlink') {
      await $.store.set('deviceKey', '')
      await $.store.set('linkedAs', '')

      return { text: 'Máy này đã ngừng gửi số liệu. (Muốn xoá hẳn khỏi dashboard: vào app → Liên kết tài khoản → Huỷ liên kết.)' }
    }
    if (cmd === 'private') {
      const isOn = rest[0] !== 'off'
      await $.store.set('private', isOn)
      isDirty = true

      return {
        text: isOn
          ? 'Riêng tư: BẬT. Dashboard chỉ nhận số liệu, không nhận nội dung task.'
          : 'Riêng tư: TẮT. Dashboard hiển thị cả nội dung từng task.',
      }
    }
    if (cmd === 'clear-history') {
      await update($, snap, s => ({ ...s, history: [] }))
      isDirty = true

      return { text: 'Đã xoá lịch sử task.' }
    }
    if (cmd === 'ext') {
      const [key, ...value] = rest

      if (key === undefined) {
        return { text: 'Cách dùng: /token-meter ext <key> <value>' }
      }
      const raw = value.join(' ')
      const num = Number(raw)
      await update($, snap, s => ({ ...s, extensions: { ...s.extensions, [key]: raw !== '' && Number.isFinite(num) ? num : raw } }))
      isDirty = true

      return { text: `Đã thêm mục mở rộng "${key}".` }
    }

    return {
      text: 'Lệnh: open | link <mã> [tên] | unlink | budget <N> | sync | private on|off | clear-history | url <URL>|default | ext <key> <value>',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snap)
    const t = s.task ?? s.lastTask
    const ctxLeft = Math.max(0, s.context.window - s.context.tokens)

    return (
      <Box flexDirection="column">
        <Text bold>Token đã dùng (phiên)</Text>
        <Text>
          {fmt(s.session.tokens.total)} token
          {s.budget ? ` · ${s.budget.percentUsed}% ngân sách` : ''}
          {s.session.costUsd !== undefined ? ` · $${s.session.costUsd.toFixed(2)}` : ''}
        </Text>
        <Text dimColor>
          vào {fmt(s.session.tokens.input)} · ra {fmt(s.session.tokens.output)} · cache {fmt(s.session.tokens.cacheRead + s.session.tokens.cacheWrite)}
        </Text>

        <Text bold>Còn lại</Text>
        {s.budget && (
          <Text>
            Ngân sách {bar(s.budget.percentUsed)} {fmt(s.budget.remaining)} ({Math.round((100 - s.budget.percentUsed) * 10) / 10}%)
          </Text>
        )}
        <Text>
          Context {bar(s.context.percent)} {fmt(ctxLeft)} ({Math.round((100 - s.context.percent) * 10) / 10}%)
        </Text>
        {s.limits.map(l => (
          <Text>
            {limitName(l.kind)} {bar(l.percentUsed)} {Math.round((100 - l.percentUsed) * 10) / 10}% còn
          </Text>
        ))}

        <Text bold>{s.task ? 'Task đang chạy' : 'Task gần nhất'}</Text>
        {t === null ? (
          <Text dimColor>Chưa có task.</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{t.label}</Text>
            <Text>
              {fmt(t.tokens.total)} token · {pct(t.tokens.total, s.session.tokens.total)}% phiên · {t.steps} lượt gọi · {t.tools} tool
            </Text>
            <Text>Skill: {t.skills.length > 0 ? t.skills.join(', ') : '—'}</Text>
          </Box>
        )}

        {s.history.length > 0 && <Text bold>Token theo task</Text>}
        {s.history.slice(0, 8).map(task => (
          <Text>
            {fmt(task.tokens.total).padStart(6)} {String(pct(task.tokens.total, s.session.tokens.total)).padStart(4)}%{' '}
            {task.label.slice(0, 40)}
            {topTools(task).length > 0 ? ` · ${topTools(task)}` : ''}
          </Text>
        ))}

        {Object.keys(s.extensions).length > 0 && <Text bold>Mở rộng</Text>}
        {Object.entries(s.extensions).map(([k, v]) => (
          <Text dimColor>
            {k}: {String(v)}
          </Text>
        ))}
        <Text dimColor>
          Liên kết: {String((await $.store.get('linkedAs')) || 'chưa')} · Dashboard: {lastSyncNote}
        </Text>
      </Box>
    )
  })
}
