import { describe, expect, test } from 'claude-code/testing'

import { type Beacon, claimLease, LEASE_MS, rank, rowFor, STALE_MS, Tracker } from '../hooks/tower'

const NOW = 10_000_000

/** A session's beacon as another session last wrote it, alive a second ago unless said otherwise. */
const beacon = (sessionId: string, status: Beacon['status'], since: number, extra: Partial<Beacon> = {}): Beacon => ({
  v: 1,
  sessionId,
  title: sessionId,
  project: 'dev',
  status,
  since,
  doing: '',
  aliveAt: NOW - 1000,
  ...extra,
})

describe('the control tower', () => {
  test('lists the sessions that need you first, and leaves out this one, ended ones and silent ones', () => {
    const rows = rank(
      [
        beacon('busy', 'working', NOW - 5_000),
        beacon('finished', 'done', NOW - 60_000),
        beacon('asking-long', 'waiting', NOW - 300_000),
        beacon('me', 'waiting', NOW - 900_000),
        beacon('broke', 'failed', NOW - 10_000),
        beacon('asking-new', 'waiting', NOW - 20_000),
        beacon('closed', 'ended', NOW - 1_000),
        beacon('crashed', 'working', NOW - 50_000, { aliveAt: NOW - STALE_MS - 1 }),
      ],
      { now: NOW, self: 'me' },
    )
    expect(rows.map(r => r.sessionId)).toEqual(['asking-long', 'asking-new', 'broke', 'finished', 'busy'])
  })

  test('a session waits on the person while it asks, works again once answered, and fails when its turn errors', () => {
    const t = new Tracker('s1', 'C:/dev/fair-question', 1000)
    t.prompt('make the canada oil short', 'Fair Question', 2000)
    expect(t.beacon).toMatchObject({ title: 'Fair Question', project: 'fair-question', status: 'working', since: 2000 })

    t.toolStart('AskUserQuestion', 'asked: which thumbnail?', 3000)
    expect(t.beacon).toMatchObject({ status: 'waiting', since: 3000, doing: 'asked: which thumbnail?' })
    t.toolEnd('AskUserQuestion', 9000)
    expect(t.beacon).toMatchObject({ status: 'working', since: 9000 })

    t.notify('permission_prompt', 'Claude needs your permission to use Bash', 10_000)
    expect(t.beacon).toMatchObject({ status: 'waiting', doing: 'Claude needs your permission to use Bash' })
    t.toolStart('Bash', 'ran shell: render stills', 11_000)
    expect(t.beacon).toMatchObject({ status: 'working', doing: 'ran shell: render stills' })

    t.turnEnd('error', 12_000)
    expect(t.beacon).toMatchObject({ status: 'failed', since: 12_000 })
    t.prompt('try again', undefined, 13_000)
    expect(t.beacon).toMatchObject({ status: 'working', title: 'Fair Question' })
    t.turnEnd('answer', 14_000)
    expect(t.beacon.status).toBe('done')

    // A permission prompt raised while a tool is starting: once the person approves and the tool returns, it works again.
    t.prompt('render it', undefined, 20_000)
    t.toolStart('Bash', 'ran shell: long build', 21_000)
    t.notify('permission_prompt', 'Claude needs your permission to use Bash', 21_500)
    expect(t.beacon.status).toBe('waiting')
    t.toolEnd('Bash', 30_000)
    expect(t.beacon).toMatchObject({ status: 'working', since: 30_000 })
    t.turnEnd('answer', 31_000)

    // The app's "still waiting for your input" nudge to an idle session is not a question.
    t.notify('idle_prompt', 'Claude is waiting for your input', 75_000)
    expect(t.beacon).toMatchObject({ status: 'done', since: 31_000 })
  })

  test('a beacon keeps what the person asked the session for, from its first prompt on', () => {
    const t = new Tracker('s3', 'C:/dev/fair-question', 0)
    t.prompt('make the canada oil short, 60 seconds, with captions', 'Fair Question', 1)
    t.prompt('looks good, ship it', 'Fair Question', 2)
    expect(t.beacon.ask).toBe('make the canada oil short, 60 seconds, with captions')
  })

  test('a beacon keeps the last three different things its session did, for the story', () => {
    const t = new Tracker('s2', 'C:/dev/rfq', 0)
    t.prompt('price the drywall', 'RFQ board', 1)
    for (const line of ['read takeoff.csv', 'read takeoff.csv', 'searched code for "unit price"', 'edited pricing.ts', 'ran shell: npm test']) t.toolStart('Bash', line, 2)
    expect(t.beacon.recent).toEqual(['searched code for "unit price"', 'edited pricing.ts', 'ran shell: npm test'])
  })

  test('one session at a time holds the narrator lease: it renews it, and another takes it only once it runs out', () => {
    // Nobody holds it: the first to look takes it.
    expect(claimLease(null, 'a', NOW)).toEqual({ isMine: true, lease: { sessionId: 'a', until: NOW + LEASE_MS } })
    const held = { sessionId: 'a', until: NOW + LEASE_MS }
    // Another session leaves a live lease alone.
    expect(claimLease(held, 'b', NOW + 1000)).toEqual({ isMine: false })
    // Its holder renews it.
    expect(claimLease(held, 'a', NOW + 5000)).toEqual({ isMine: true, lease: { sessionId: 'a', until: NOW + 5000 + LEASE_MS } })
    // A holder that stopped renewing (closed, crashed) loses it to the next session that looks.
    expect(claimLease(held, 'b', NOW + LEASE_MS + 1)).toEqual({ isMine: true, lease: { sessionId: 'b', until: NOW + 2 * LEASE_MS + 1 } })
  })

  test('a row names the session and says how long it has been in its state', () => {
    const asking = beacon('a', 'waiting', NOW - 4 * 60_000 - 59_000, { title: 'Fair Question', doing: 'asked: which thumbnail?' })
    expect(rowFor(asking, NOW)).toEqual({ status: 'waiting', label: 'Fair Question', state: 'waiting 4m', doing: 'asked: which thumbnail?' })
    expect(rowFor(beacon('b', 'working', NOW - 12_000), NOW).state).toBe('working 12s')
    expect(rowFor(beacon('c', 'done', NOW - 3 * 3_600_000), NOW).state).toBe('done 3h')
  })
})
