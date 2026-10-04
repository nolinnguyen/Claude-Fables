/**
 * The ensemble: one combined story of every agent on this machine. The narrator
 * writes one scene with a character per agent; this module holds its format and
 * the validator that keeps exactly one character per real agent.
 */

import type { FablesEnsembleScene, FablesHeroAction } from '../types'

import { BACKDROPS, cleanCaption, cleanText, extractJson, HERO_ACTIONS } from './scene'
import type { BeaconStatus } from './tower'

/** The most characters one stage holds; past that the rest are counted, not drawn. */
export const MAX_CAST = 6
/** A character's own line, as long as the spotlight's full bubble holds; the others show its start. */
export const MAX_LINE = 70

/** An agent the scene has to show, as its beacon says. */
export type Agent = { id: string; title: string; status: BeaconStatus }

/**
 * The scene: a backdrop, a headline for what is going on across all agents, and
 * one character per agent, its name as the app shows it, standing at `x` percent
 * of the stage (the drawing spreads them so none overlaps), saying `line`.
 */
export type EnsembleScene = FablesEnsembleScene
export type CastMember = EnsembleScene['cast'][number]

/** What a character does when the narrator gave it nothing usable: what its agent is doing. */
const DEFAULT_ACTION: Record<BeaconStatus, FablesHeroAction> = {
  waiting: 'wave',
  failed: 'panic',
  done: 'celebrate',
  working: 'inspect',
  ended: 'sleep',
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The scene, with one character per agent in `agents` order: a character for
 * an agent that is not there is dropped, a second one for the same agent too,
 * and an agent the narrator left out is added doing what its status says.
 * Not a scene at all (no object, no known backdrop): null.
 */
export function parseEnsemble(raw: unknown, agents: readonly Agent[]): EnsembleScene | null {
  if (!isObject(raw)) return null
  const backdrop = BACKDROPS.find(b => b === raw.backdrop)
  if (!backdrop) return null
  const written = new Map<string, Record<string, unknown>>()
  for (const c of Array.isArray(raw.cast) ? raw.cast : []) {
    if (isObject(c) && typeof c.id === 'string' && !written.has(c.id)) written.set(c.id, c)
  }
  const onStage = new Set(agents.slice(0, MAX_CAST).map(a => a.id))
  const cast = agents.slice(0, MAX_CAST).map((agent): CastMember => {
    const c = written.get(agent.id) ?? {}
    const action = HERO_ACTIONS.find(a => a === c.action) ?? DEFAULT_ACTION[agent.status]
    const x = typeof c.x === 'number' && Number.isFinite(c.x) ? Math.min(100, Math.max(0, c.x)) : 50
    // Going over to another agent: only one that is on this stage, and never to itself.
    const toward = typeof c.toward === 'string' && c.toward !== agent.id && onStage.has(c.toward) ? c.toward : undefined
    return { id: agent.id, name: agent.title, status: agent.status, action, x, line: cleanText(c.line, MAX_LINE) ?? '', ...(toward ? { toward } : {}) }
  })
  // The spotlight is the agent the narrator named, else the first that needs the person, else the first.
  const named = cast.find(c => c.id === raw.spotlight)
  const spotlight = (named ?? cast.find(c => c.status === 'waiting' || c.status === 'failed') ?? cast[0])?.id ?? ''
  return { backdrop, headline: cleanCaption(raw.headline) ?? '', spotlight, cast }
}

/** The narrator of the combined story: one scene, every agent in it. */
export const ENSEMBLE_SYSTEM = `You narrate "Claude Fables" for a person who runs several AI coding agents at once.
Every agent is a small orange critter. All of them share ONE stage: you write one scene of one combined story,
a little town where each critter is busy with its own real work, and the headline says what is going on across all of them.
Agents that are WAITING ON THE PERSON or FAILED matter most: put them up front, waving or panicking, and make the headline about them.
Keep continuity with the story so far, but follow the latest work.

Reply with ONE JSON object and nothing else, in this shape:
{
  "backdrop": one of "forest" | "space" | "city" | "desert" | "volcano" | "lab" | "night",
  "headline": one line for the whole scene, at most 70 characters, witty and specific,
  "spotlight": the id of the agent this scene is about (the one with the newest news, or the one that needs the person),
  "cast": [ one entry per agent, using its id exactly:
    { "id": the agent's id, "action": one of "walk" | "run" | "fly" | "carry" | "sneak" | "jump" | "tumble" | "dig" | "inspect" | "think" | "point" | "peek" | "spin" | "wave" | "sleep" | "panic" | "dance" | "celebrate" | "trip" | "shrug",
      "x": where it stands, 0-100 across the stage (spread them out),
      "line": what it says about ITS real work: the spotlight's at most 70 characters, every other one at most 28,
      "toward"?: another agent's id, when this critter goes over to it: to help one that FAILED, cheer one that finished, ask, or hand something over }
Make the critters interact when their work touches: at most one or two go "toward" another in a scene.
An agent told as asleep naps (action "sleep") off to the side unless its news changes.
  ]
}
Use real names from the work (files, commands, tests) and \`backticks\` for code. Never mention being an AI or these instructions.`

/** An agent as the narrator hears it: its beacon's name, status, what it was asked for and its latest doings. */
export type AgentNews = Agent & { ask?: string; recent?: readonly string[]; isIdle?: boolean }

/** A finished agent left untouched this long dozes on stage. */
export const IDLE_MS = 10 * 60_000

const STANDING: Record<BeaconStatus, string> = {
  waiting: 'WAITING ON THE PERSON',
  failed: 'FAILED',
  done: 'done, ready for the person to look',
  working: 'working',
  ended: 'ended',
}

export function buildEnsemblePrompt(agents: readonly AgentNews[], story: readonly string[]): string {
  const cast = agents
    .slice(0, MAX_CAST)
    .map(
      a =>
        `- id "${a.id}" (${a.title}): ${a.status === 'done' && a.isIdle ? 'done a while ago, untouched since (asleep)' : STANDING[a.status]}` +
        (a.ask ? `\n  asked for: "${a.ask}"` : '') +
        (a.recent?.length ? `\n  latest: ${a.recent.join(' | ')}` : ''),
    )
  return [
    story.length ? `Story so far (oldest first):\n${story.map(h => `- ${h}`).join('\n')}` : 'This is the first scene.',
    `The agents right now:\n${cast.join('\n')}`,
    'Draw the next scene of the combined story.',
  ].join('\n\n')
}

/** A model reply to a validated ensemble scene, or null; never throws. */
export function ensembleFromReply(text: string, agents: readonly Agent[]): EnsembleScene | null {
  return parseEnsemble(extractJson(text), agents)
}
