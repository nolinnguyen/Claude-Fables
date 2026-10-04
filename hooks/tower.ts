/**
 * The control tower: every session on this machine writes a beacon (what it is
 * doing, and whether it needs the person), and the band in the main pane lists
 * the others, the ones that need the person first.
 */

import type { FablesTowerRow } from '../types'

/** Where a session stands, as the person needs to know it. */
export type BeaconStatus = FablesTowerRow['status']

/** One session's beacon, written whole to its own file. */
export type Beacon = {
  v: 1
  sessionId: string
  /** The session's title as the app shows it, else the start of its first prompt. */
  title: string
  /** The working directory's last segment. */
  project: string
  status: BeaconStatus
  /** When the status last changed, ms since the epoch. */
  since: number
  /** The latest thing it did or said, one short line. */
  doing: string
  /** The last heartbeat: a beacon not refreshed for STALE_MS is a session that is gone. */
  aliveAt: number
}

/** A live session refreshes its beacon well inside this. */
export const STALE_MS = 60_000

/** Tools that stop the session until the person answers. */
const ASKS_PERSON = new Set(['AskUserQuestion', 'ExitPlanMode'])

const MAX_DOING = 120
const MAX_TITLE = 48

const cut = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** One session's own beacon, kept as its events come in. */
export class Tracker {
  beacon: Beacon
  private hasTitle = false

  constructor(sessionId: string, cwd: string, now: number) {
    const project = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
    this.beacon = { v: 1, sessionId, title: project, project, status: 'done', since: now, doing: '', aliveAt: now }
  }

  private set(status: BeaconStatus, now: number, doing?: string) {
    if (this.beacon.status !== status) this.beacon = { ...this.beacon, status, since: now }
    if (doing !== undefined) this.beacon = { ...this.beacon, doing: cut(doing, MAX_DOING) }
    this.beacon = { ...this.beacon, aliveAt: now }
  }

  /** The person sent a prompt: the app's title for the session when it has one, else the first prompt's start. */
  prompt(text: string, title: string | undefined, now: number) {
    if (title) {
      this.beacon = { ...this.beacon, title: cut(title, MAX_TITLE) }
      this.hasTitle = true
    } else if (!this.hasTitle) {
      this.beacon = { ...this.beacon, title: cut(text, MAX_TITLE) }
      this.hasTitle = true
    }
    this.set('working', now)
  }

  toolStart(tool: string, line: string, now: number) {
    this.set(ASKS_PERSON.has(tool) ? 'waiting' : 'working', now, line)
  }

  /** A tool came back: whatever it waited on (a question, a permission prompt) has been answered. */
  toolEnd(_tool: string, now: number) {
    if (this.beacon.status === 'waiting') this.set('working', now)
  }

  /**
   * The app told the person something. Mid-turn it is a permission prompt or a
   * question, and the session waits on them; after the turn it is the idle
   * nudge, and the session is still just done.
   */
  notify(_type: string, message: string, now: number) {
    if (this.beacon.status === 'working') this.set('waiting', now, message)
  }

  said(text: string, now: number) {
    if (text) this.set(this.beacon.status, now, text)
  }

  turnEnd(reason: string, now: number) {
    this.set(reason === 'error' || reason === 'refusal' ? 'failed' : 'done', now)
  }

  end(now: number) {
    this.set('ended', now)
  }

  alive(now: number) {
    this.beacon = { ...this.beacon, aliveAt: now }
  }
}

/** How long ago, in the largest whole unit: 12s, 4m, 3h, 2d. */
function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86_400)}d`
}

/** One line of the tower: who, where it stands and for how long, and what it last did. */
export type Row = FablesTowerRow

export function rowFor(b: Beacon, now: number): Row {
  return { status: b.status, label: b.title, state: `${b.status} ${age(now - b.since)}`, doing: b.doing }
}

/** Which statuses come first: the ones that need the person. */
const ORDER: Record<BeaconStatus, number> = { waiting: 0, failed: 1, done: 2, working: 3, ended: 4 }

/**
 * The other live sessions, the ones that need the person first: waiting (the
 * longest wait first), failed, done (the newest first), then working.
 */
export function rank(beacons: readonly Beacon[], at: { now: number; self: string }): Beacon[] {
  return beacons
    .filter(b => b.sessionId !== at.self && b.status !== 'ended' && at.now - b.aliveAt <= STALE_MS)
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || (a.status === 'waiting' ? a.since - b.since : b.since - a.since))
}
