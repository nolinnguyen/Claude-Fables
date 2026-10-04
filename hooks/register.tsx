import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { DEFAULT_MODEL, Director, findModel, type Host, MODEL_LABELS, NARRATOR_MODELS, type NarratorModel } from './director'
import { DEFAULT_LOOK, findLook, LOOK_NAMES, LOOKS, lookFor } from './looks'
import type { FablesEnsembleScene, FablesScene, FablesTowerRow } from '../types'

import { summarizeTool } from './activity'
import { buildEnsemblePrompt, ENSEMBLE_SYSTEM, ensembleFromReply, IDLE_MS, MAX_CAST, parseEnsemble, shortIds } from './ensemble'
import { backoffMs } from './narrator'
import { pickRecap, readHistory, recapHtml, recordScene } from './recap'
import { ensembleToSvg, H, MAX_SVG, resumeAt, sceneToSvg, speaksAfter, W } from './svg'
import { type Beacon, claimLease, type Lease, rank, rowFor, STALE_MS, Tracker } from './tower'

const scene = atom({ plugin: 'fables', key: 'scene' } as const, null)
const enabled = atom({ plugin: 'fables', key: 'enabled' } as const, true)
const style = atom({ plugin: 'fables', key: 'style' } as const, DEFAULT_LOOK)
const tower = atom({ plugin: 'fables', key: 'tower' } as const, [] as FablesTowerRow[])
const towerOn = atom({ plugin: 'fables', key: 'towerOn' } as const, true)
const ensemble = atom({ plugin: 'fables', key: 'ensemble' } as const, null as FablesEnsembleScene | null)

const STORE_ENABLED = 'enabled'
const STORE_PIXEL = 'pixelArt'
const STORE_STYLE = 'style'
const STORE_MODEL = 'model'
const STORE_TOWER = 'tower'

/**
 * Where every session on this machine keeps its beacon, one file each. C:\dev
 * is the same path on both of Nolin's machines; each machine has its own tower.
 */
const TOWER_DIR = 'C:/dev/.cache/fables-tower'
/** How often a session refreshes its beacon and reads the others'. */
const TOWER_EVERY_MS = 5000
/** The narrator's lease: one session on the machine at a time writes the combined story. */
const LEASE_FILE = `${TOWER_DIR}/narrator.lease`
/** The combined story's latest scene, which every session reads and the main pane draws. */
const STORY_FILE = `${TOWER_DIR}/story.ensemble`
/** The day's log of combined-story scenes, for /fables recap: one file per local date. */
const historyFile = (day: string) => `${TOWER_DIR}/history-${day}.jsonl`
/** The most scenes a recap plays: enough to tell the day, small enough to open fast. */
const RECAP_SCENES = 40
/** A recap page stays under this, inside the 4 MiB a file write takes. */
const RECAP_MAX_CHARS = 3_800_000
const pad = (v: number) => String(v).padStart(2, '0')
const dayOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const timeOf = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Adds a scene to the day's log; the narrator alone writes it, so one write never races another. */
async function logScene($: EngineInterface, t: Tower, at: number, scene: FablesEnsembleScene) {
  const file = historyFile(dayOf(at))
  const before = await $.fs.read(file).then(String, () => '')
  await $.fs.write(file, recordScene(before, { at, scene })).catch(err => logOnce($, t, "log the story for today's recap", err))
}

/** Writes the day's recap page and says where it is. */
async function writeRecap($: EngineInterface, day: string, look: string): Promise<string> {
  let log: string
  try {
    log = String(await $.fs.read(historyFile(day)))
  } catch {
    return `No combined story was logged on ${day}. The narrator logs scenes while two or more agents are running.`
  }
  const entries = readHistory(log)
  // Each scene is up to ~126 KB of drawing and a file write stops at 4 MiB: fewer scenes until the page fits.
  let count = RECAP_SCENES
  let picked = pickRecap(entries, count)
  if (picked.length === 0) return `The log for ${day} has no readable scenes.`
  const pageOf = (list: typeof picked) =>
    recapHtml(
      `Your agents, ${day}`,
      list.map(e => ({ time: timeOf(e.at), headline: e.scene.headline.replace(/`/g, ''), svg: ensembleToSvg(e.scene, { width: 1100, height: 192, look }) })),
    )
  let page = pageOf(picked)
  while (page.length > RECAP_MAX_CHARS && count > 2) {
    count = Math.max(2, Math.floor(count * 0.75))
    picked = pickRecap(entries, count)
    page = pageOf(picked)
  }
  const file = `${TOWER_DIR}/recap-${day}.html`
  await $.fs.write(file, page)
  const items = picked
  return `Recap of ${day}: ${items.length} scenes, ${timeOf(picked[0]!.at)} to ${timeOf(picked.at(-1)!.at)}. Open ${file.replace(/\//g, '\\')} in a browser.`
}
/** The combined story is asked for at most this often, and only when an agent's news changed. */
const ENSEMBLE_GAP_MS = 8000
/** How many headlines the combined story remembers, for continuity. */
const MAX_HEADLINES = 4
const TOWER_COLORS: Record<FablesTowerRow['status'], string> = {
  waiting: 'yellow',
  failed: 'red',
  done: 'green',
  working: 'cyan',
  ended: 'gray',
}
/** Every scene is drawn with the 3D Claude, in the style the person chose (looks.ts). */
const FIGURE = '3d'
/** This plugin's own tools, if it ever registers any, are not part of the story. */
const OWN_TOOLS = 'mcp__fables__'

/**
 * The band's code font advance in CSS pixels: the desktop measures the band in
 * cells of it, and the Svg wants pixels.
 */
const PX_PER_COLUMN = 8
/** CSS pixels per stage unit: the stage's H units come out this many times taller. */
const SCALE = 1.5

/**
 * The band's box in CSS pixels: its whole width, at a fixed height so the art and
 * the caption keep one size whatever the window; the stage widens to fill it.
 */
function bandBox(columns: number): { width: number; height: number } {
  const width = Number.isFinite(columns) && columns > 0 ? Math.round(columns * PX_PER_COLUMN) : W * SCALE
  return { width, height: Math.round(H * SCALE) }
}

/** The narrator's host in a session: Claude Code's clock, its model, the band, and how the band draws a scene. */
function host($: EngineInterface, band: Band): Host {
  return {
    now: () => $.clock.now(),
    complete: ask => $.model.complete(ask),
    show: drawn => update($, scene, () => drawn),
    speaksAfter: async next => speaksAfter((await draw($, band, next)).base) * 1000,
  }
}

async function chooseLook($: EngineInterface, n: Director, name: string) {
  const look = lookFor(name)
  n.look = look.name
  await $.store.set(STORE_STYLE, look.name)
  await update($, style, () => look.name)
  return { text: `Scenes are now drawn as ${look.label}.` }
}

async function chooseModel($: EngineInterface, n: Director, model: NarratorModel) {
  n.model = model
  await $.store.set(STORE_MODEL, model)
  return { text: `${MODEL_LABELS[model]} now writes the story.` }
}

async function setOn($: EngineInterface, n: Director, at: Host, value: boolean) {
  await n.setOn(at, value)
  await $.store.set(STORE_ENABLED, value)
  await update($, enabled, () => value)
}

/**
 * The scene up now, when it went up, and its drawing in the box and style last
 * asked for. The band is drawn again whenever its props change (the turn
 * ending flips isWorking, the window is resized) and the desktop may start the
 * frame over then; so every drawing after the first is set to the scene's own
 * clock, and it carries on where it was instead of typing its caption again.
 */
type Drawn = { scene: string; at: number; key: string; base: string }
/** The drawing kept, and the band's box as last drawn, so a scene can be drawn the moment it goes up. */
type Band = { drawn?: Drawn; box: { width: number; height: number } }

/** The scene in the band's box and style, drawn once and kept: a scene going up starts its clock. */
async function draw($: EngineInterface, band: Band, next: FablesScene): Promise<Drawn> {
  const look = await read($, style)
  const key = `${band.box.width}x${band.box.height}|${look}`
  const same = JSON.stringify(next)
  const kept = band.drawn
  if (kept?.scene === same && kept.key === key) return kept
  const at = kept?.scene === same ? kept.at : await $.clock.now()
  band.drawn = { scene: same, at, key, base: sceneToSvg(next, { ...band.box, look, figure: FIGURE }) }
  return band.drawn
}

/** This session's beacon, and what the tower last listed. */
type Tower = {
  tracker?: Tracker
  cwd: string
  shown: string
  hasLogged: Set<string>
  writing: Promise<void>
  /** Every live session's beacon, this one's included, the ones that need the person first. */
  live: Beacon[]
  /** Whether this session holds the narrator's lease. */
  narrates: boolean
  /** Mirrors of the switches, for the timers: Fables on, and the other sessions shown. */
  isOn: boolean
  isTowerOn: boolean
  /** The combined-story scene on the band: when it went up, whether it fades in, and its drawing for the band's box and look. */
  staged?: { sceneKey: string; at: number; enter?: 'fade'; backdrop: string; drawKey: string; svg: string }
  /** The combined story: the news it was last written from, its headlines, its file as last read, and its narrator's pace. */
  story: { key: string; headlines: string[]; read: string; isAsking: boolean; nextAt: number; failures: number }
}

/** Whether the band shows the combined story rather than this session's own cartoon. */
const isEnsemble = (t: Tower) => t.isOn && t.isTowerOn && hasOthers(t)
const hasOthers = (t: Tower) => t.live.some(b => b.sessionId !== t.tracker?.beacon.sessionId)

/** Says once per session, in the transcript, why the tower cannot do its part. */
function logOnce($: EngineInterface, t: Tower, what: string, err: unknown) {
  if (t.hasLogged.has(what)) return
  t.hasLogged.add(what)
  $.ui.log(`fables: the control tower could not ${what}: ${err instanceof Error ? err.message : String(err)}`)
}

/**
 * Writes this session's beacon. Writes go one at a time, in order, each with the
 * beacon as it is when its turn comes, so the file always ends on the latest state.
 */
function publish($: EngineInterface, t: Tower): Promise<void> {
  t.writing = t.writing.then(async () => {
    const b = t.tracker?.beacon
    if (!b) return
    await $.fs.write(`${TOWER_DIR}/${b.sessionId}.json`, JSON.stringify(b)).catch(err => logOnce($, t, "write this session's status", err))
  })
  return t.writing
}

/** After /clear or a resume the session goes on under a new id: its beacon starts over under that one. */
async function follow($: EngineInterface, t: Tower) {
  const id = await $.session.id()
  if (!t.tracker || t.tracker.beacon.sessionId === id) return
  // The old id's beacon says it ended, so it does not stand on stage as a second agent until it goes stale.
  t.tracker.end(await $.clock.now())
  await publish($, t)
  t.tracker = new Tracker(id, t.cwd, await $.clock.now())
}

/** Reads every session's beacon and lists the others; a file caught mid-write is read again next time. */
async function scan($: EngineInterface, t: Tower) {
  const self = t.tracker?.beacon.sessionId
  if (!self) return
  const now = await $.clock.now()
  let entries: Awaited<ReturnType<EngineInterface['fs']['list']>>
  try {
    entries = await $.fs.list(TOWER_DIR)
  } catch (err) {
    return logOnce($, t, 'read the other sessions', err)
  }
  const beacons: Beacon[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    // A beacon its session stopped refreshing is a session that is gone: not worth opening.
    if (now - entry.mtimeMs > STALE_MS) continue
    try {
      beacons.push(JSON.parse(String(await $.fs.read(`${TOWER_DIR}/${entry.name}`))) as Beacon)
    } catch {
      // Mid-write by its session: the next scan reads it whole.
    }
  }
  t.live = rank(beacons, { now, self: '' })
  const rows = rank(beacons, { now, self }).map(b => rowFor(b, now))
  const key = JSON.stringify(rows)
  if (key === t.shown) return
  t.shown = key
  await update($, tower, () => rows)
}

/** Takes or renews the narrator's lease, or leaves it to the session that holds it. */
async function lead($: EngineInterface, t: Tower) {
  const self = t.tracker?.beacon.sessionId
  if (!self) return
  let current: Lease | null = null
  try {
    current = JSON.parse(String(await $.fs.read(LEASE_FILE))) as Lease
  } catch {
    // No lease yet, or one caught mid-write: claim it.
  }
  const claim = claimLease(current, self, await $.clock.now())
  t.narrates = claim.isMine
  if (claim.isMine) await $.fs.write(LEASE_FILE, JSON.stringify(claim.lease)).catch(err => logOnce($, t, 'take the narrator lease', err))
}

/** Loads the combined story's latest scene, as the narrator last wrote it. */
async function followStory($: EngineInterface, t: Tower) {
  let text: string
  try {
    text = String(await $.fs.read(STORY_FILE))
  } catch {
    return
  }
  if (text === t.story.read) return
  t.story.read = text
  try {
    const saved = JSON.parse(text) as { scene: FablesEnsembleScene; key: string; headlines: string[] }
    // Whoever narrates next carries the story on from here.
    t.story.key = saved.key
    t.story.headlines = saved.headlines
    // A scene written by an older session lacks newer fields (the spotlight): it gets the same cleanup as a fresh one.
    const cast = Array.isArray(saved.scene?.cast) ? saved.scene.cast : []
    const scene = parseEnsemble(saved.scene, cast.map(c => ({ id: c.id, title: c.name, status: c.status })))
    if (scene) await update($, ensemble, () => scene)
  } catch {
    // Mid-write: read whole next beat.
  }
}

/** The most sessions the band lists; the rest are counted in the header. */
const MAX_ROWS = 8

function towerTree($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], rows: readonly FablesTowerRow[]) {
  const { Box, Text } = $.ui.resolve(e)
  const needs = rows.filter(r => r.status === 'waiting' || r.status === 'failed').length
  const working = rows.filter(r => r.status === 'working').length
  const more = rows.length > MAX_ROWS ? ` · ${rows.length - MAX_ROWS} more` : ''
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>{`other sessions: ${needs} need you · ${working} working${more}`}</Text>
      {rows.slice(0, MAX_ROWS).map(r => (
        <Box flexDirection="row" gap={1}>
          <Text color={TOWER_COLORS[r.status]} bold>
            ●
          </Text>
          <Text bold wrap="truncate">
            {r.label}
          </Text>
          <Text color={TOWER_COLORS[r.status]}>{r.state}</Text>
          <Text dimColor wrap="truncate">
            {r.doing}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

/** What the tower says a tool call is doing: a question to the person names the question. */
function towerLine(tool: string, input: Readonly<Record<string, unknown>>): string {
  if (tool === 'AskUserQuestion') {
    const first = Array.isArray(input.questions) ? (input.questions[0] as { question?: unknown } | undefined) : undefined
    return `asks you: ${typeof first?.question === 'string' ? first.question : 'a question'}`
  }
  if (tool === 'ExitPlanMode') return 'asks you to approve a plan'
  return summarizeTool(tool, input)
}

/**
 * Writes the next scene of the combined story, when this session is the one on
 * screen, other agents are live, and some agent's news changed since the last one.
 */
async function narrateEnsemble($: EngineInterface, t: Tower, model: NarratorModel) {
  const now = await $.clock.now()
  if (!t.narrates || !isEnsemble(t)) return
  if (t.story.isAsking || now < t.story.nextAt) return
  const agents = t.live.slice(0, MAX_CAST).map(b => ({ id: b.sessionId, title: b.title, status: b.status, ask: b.ask, recent: b.recent, isIdle: b.status === 'done' && now - b.since > IDLE_MS }))
  const key = JSON.stringify(agents.map(a => [a.id, a.status, a.ask, a.recent, a.isIdle]))
  if (key === t.story.key) return
  t.story.isAsking = true
  try {
    // The narrator sees short ids (a1, a2...), not the sessions' long ones; the scene comes back under the real ids.
    const short = shortIds(agents)
    const reply = await $.model.complete({ model, system: ENSEMBLE_SYSTEM, prompt: buildEnsemblePrompt(short.agents, t.story.headlines), maxTokens: 2000, effort: 'low', timeoutMs: 30_000 })
    const written = reply.isAnswered ? ensembleFromReply(reply.text, short.agents) : null
    const next = written ? short.restore(written) : null
    if (next) {
      t.story.key = key
      t.story.failures = 0
      t.story.headlines = [...t.story.headlines, next.headline].filter(Boolean).slice(-MAX_HEADLINES)
      const text = JSON.stringify({ scene: next, key, headlines: t.story.headlines })
      t.story.read = text
      await $.fs.write(STORY_FILE, text).catch(err => logOnce($, t, 'share the combined story', err))
      await logScene($, t, now, next)
      await update($, ensemble, () => next)
    } else t.story.failures++
  } catch (err) {
    t.story.failures++
    logOnce($, t, 'write the combined story', err)
  } finally {
    t.story.isAsking = false
    t.story.nextAt = (await $.clock.now()) + Math.max(ENSEMBLE_GAP_MS, backoffMs(t.story.failures))
  }
}

export const register: Register = (on, options) => {
  const t: Tower = { cwd: '', shown: '', hasLogged: new Set(), writing: Promise.resolve(), live: [], narrates: false, isOn: true, isTowerOn: true, story: { key: '', headlines: [], read: '', isAsking: false, nextAt: 0, failures: 0 } }
  const n = new Director()
  const band: Band = { box: bandBox(NaN) }
  // The config menu's choice is the default; /fables model overrides it.
  const configured = findModel(options.model) ?? DEFAULT_MODEL
  n.model = configured
  n.look = DEFAULT_LOOK

  on('session.start', async ($, e, next) => {
    n.isOn = (await $.store.get(STORE_ENABLED)) !== false
    n.model = findModel(await $.store.get(STORE_MODEL)) ?? configured
    await update($, enabled, () => n.isOn)
    const saved = await $.store.get(STORE_STYLE)
    // Pixel art was once a switch of its own: someone who turned it off keeps the original look, drawn smooth.
    const smooth = (await $.store.get(STORE_PIXEL)) === false
    n.look = typeof saved === 'string' && LOOKS[saved] ? saved : smooth ? 'original' : DEFAULT_LOOK
    await update($, style, () => n.look)
    await $.command.register({
      name: 'fables',
      description: 'Claude Fables: turn the cartoons above the prompt on or off, pick a style, or pick the model that writes them',
      argumentHint: '[on|off|style [name|off]|model [sonnet|haiku]|tower [on|off]|recap [YYYY-MM-DD]]',
    })
    // A session's own cartoon is written only while the band would show it: with other agents
    // live (and the tower on), the combined story takes the band instead.
    $.clock.every(1000, () => {
      if (!isEnsemble(t)) void n.tick(host($, band))
    })
    t.isOn = n.isOn
    t.isTowerOn = (await $.store.get(STORE_TOWER)) !== false
    await update($, towerOn, () => t.isTowerOn)
    t.cwd = await $.session.cwd()
    t.tracker = new Tracker(await $.session.id(), t.cwd, await $.clock.now())
    await publish($, t)
    $.clock.every(TOWER_EVERY_MS, async () => {
      await follow($, t)
      t.tracker?.alive(await $.clock.now())
      await publish($, t)
      await scan($, t)
      await lead($, t)
      await followStory($, t)
      await narrateEnsemble($, t, n.model)
    })
    return next(e)
  })

  on('command.run', { command: 'fables' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const md = /^(?:model|models|narrator)\b\s*(.*)$/.exec(arg)
    if (md) {
      const want = (md[1] ?? '').trim()
      if (!want) {
        const list = NARRATOR_MODELS.map(m => `${m === n.model ? '▸' : ' '} ${m} · ${MODEL_LABELS[m]}`).join('\n')
        return { text: `${MODEL_LABELS[n.model]} writes the story. Pick another with /fables model <name>:\n${list}` }
      }
      const model = findModel(want)
      if (!model) return { text: `No narrator called "${want}". Try /fables model sonnet or /fables model haiku.` }
      return chooseModel($, n, model)
    }
    const st = /^(?:style|styles|look)\b\s*(.*)$/.exec(arg)
    if (st) {
      const want = (st[1] ?? '').trim()
      if (!want) {
        const list = LOOK_NAMES.map(name => `${name === n.look ? '▸' : ' '} ${name} · ${lookFor(name).label}`).join('\n')
        return { text: `Scenes are drawn in ${lookFor(n.look).label}. Pick a style with /fables style <name>, or /fables style off for the default:\n${list}` }
      }
      const look = /^(off|none|default|plain)$/.test(want) ? lookFor(DEFAULT_LOOK) : findLook(want)
      if (!look) return { text: `No style called "${want}". /fables style lists them.` }
      return chooseLook($, n, look.name)
    }
    const rc = /^recap(?:\s+(\d{4}-\d{2}-\d{2}))?$/.exec(arg)
    if (rc) return { text: await writeRecap($, rc[1] ?? dayOf(await $.clock.now()), await read($, style)) }
    const tw = /^tower(?:\s+(on|off))?$/.exec(arg)
    if (tw) {
      const value = tw[1] === 'on' ? true : tw[1] === 'off' ? false : !(await read($, towerOn))
      await $.store.set(STORE_TOWER, value)
      t.isTowerOn = value
      await update($, towerOn, () => value)
      return { text: value ? 'The control tower lists your other sessions above the prompt.' : 'The control tower is off.' }
    }
    // Pixel art is a style now; the old switch still works, as a way to pick it or the smooth original.
    const px = /^pixel(?:\s+(on|off))?$/.exec(arg)
    if (px) return chooseLook($, n, px[1] === 'off' || (!px[1] && n.look === 'pixel') ? 'original' : 'pixel')
    const value = arg === 'on' ? true : arg === 'off' ? false : !n.isOn
    await setOn($, n, host($, band), value)
    t.isOn = value
    return {
      text: value
        ? `Claude Fables is on: cartoons written by ${MODEL_LABELS[n.model]} play above the prompt while Claude works.`
        : 'Claude Fables is off.',
    }
  })

  on('prompt.submit', async ($, e, next) => {
    n.submit(e.text)
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await follow($, t)
    // Notifications, peers and wakeups come in as prompts too; only the person's say what the session is for.
    t.tracker?.prompt(e.prompt, e.session_title, await $.clock.now(), e.source === undefined || e.source === 'user')
    await publish($, t)
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    t.tracker?.notify(e.notification_type, e.message, await $.clock.now())
    await publish($, t)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isTold = e.agentId === undefined && !tool.startsWith(OWN_TOOLS)
    if (isTold) {
      n.tool(tool, e)
      t.tracker?.toolStart(tool, towerLine(tool, e), await $.clock.now())
      await publish($, t)
    }
    const ran = await next(e)
    if (isTold && (ran.deny !== undefined || ran.isError === true)) n.failed(tool, e)
    if (isTold) {
      t.tracker?.toolEnd(tool, await $.clock.now())
      await publish($, t)
    }
    return ran
  })

  on('session.append', async ($, e, next) => {
    if (e.door === 'response' && e.agentId === undefined && Array.isArray(e.message.content)) {
      const said = e.message.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join(' ')
        .trim()
      n.said(said)
      t.tracker?.said(said, await $.clock.now())
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      n.complete(e.reason)
      t.tracker?.turnEnd(e.reason, await $.clock.now())
      await publish($, t)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    t.tracker?.end(await $.clock.now())
    await publish($, t)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const isTowerOn = await read($, towerOn)
    const story = isTowerOn && (await read($, enabled)) && e.surface === 'desktop' && hasOthers(t) ? await read($, ensemble) : null
    if (story) {
      const liveIds = new Set(t.live.map(b => b.sessionId))
      const shown = { ...story, cast: story.cast.filter(c => liveIds.has(c.id)) }
      if (shown.cast.length > 0) {
        const { Svg } = $.ui.resolve(e)
        band.box = bandBox(e.props.bodyColumns)
        const look = await read($, style)
        const now = await $.clock.now()
        // A scene goes up once: its clock starts, and it fades in when it opens on a new place.
        const sceneKey = JSON.stringify(shown)
        if (t.staged?.sceneKey !== sceneKey) {
          const enter = t.staged && t.staged.backdrop !== shown.backdrop ? ('fade' as const) : undefined
          t.staged = { sceneKey, at: now, enter, backdrop: shown.backdrop, drawKey: '', svg: '' }
        }
        const drawKey = `${band.box.width}x${band.box.height}|${look}|${t.live.length}`
        if (t.staged.drawKey !== drawKey) {
          t.staged.drawKey = drawKey
          t.staged.svg = ensembleToSvg(shown, { ...band.box, look, enter: t.staged.enter, more: Math.max(0, t.live.length - shown.cast.length) })
        }
        // Every later drawing (the turn ending, a resize) carries on from the scene's own clock instead of starting over.
        const along = Math.floor((now - t.staged.at) / 100) / 10
        const resumed = resumeAt(t.staged.svg, along)
        return <Svg source={resumed.length <= MAX_SVG ? resumed : t.staged.svg} alt={shown.headline} width={band.box.width} height={band.box.height} isInteractive />
      }
    }
    const rows = isTowerOn ? await read($, tower) : []
    const list = rows.length > 0 ? towerTree($, e, rows) : null
    const current = e.surface === 'desktop' && (await read($, enabled)) ? await read($, scene) : null
    if (!current) return list ?? next(e)
    const { Box, Svg } = $.ui.resolve(e)
    // The interactive frame does not size itself from the markup (left alone it
    // is a 300x150 box), so give it the band's box; a new width draws anew.
    band.box = bandBox(e.props.bodyColumns)
    const { width, height } = band.box
    const { base, at } = await draw($, band, current)
    // To a tenth of a second, so drawings in the same moment stay the same.
    const along = Math.floor(((await $.clock.now()) - at) / 100) / 10
    const resumed = resumeAt(base, along)
    const cartoon = (
      <Svg
        source={resumed.length <= MAX_SVG ? resumed : base}
        alt={current.caption}
        width={width}
        height={height}
        isInteractive
      />
    )
    if (!list) return cartoon
    return (
      <Box flexDirection="column">
        {cartoon}
        {list}
      </Box>
    )
  })
}
