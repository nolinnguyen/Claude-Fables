import { describe, expect, test } from 'claude-code/testing'

import { buildEnsemblePrompt, ensembleFromReply, MAX_LINE, parseEnsemble, shortIds } from '../hooks/ensemble'
import { ensembleToSvg } from '../hooks/svg'

/** The agents on stage, as the beacons say. */
const AGENTS = [
  { id: 'fq', title: 'Fair Question', status: 'waiting' as const },
  { id: 'rfq', title: 'RFQ board', status: 'working' as const },
  { id: 'jc', title: 'Job Costing', status: 'failed' as const },
]

describe('the ensemble scene', () => {
  test('keeps one character per real agent: strangers dropped, bad fields fixed, the missing ones added', () => {
    const scene = parseEnsemble(
      {
        backdrop: 'city',
        headline: 'Three critters, one city, and somebody needs you.',
        cast: [
          { id: 'fq', action: 'wave', x: 30, line: 'Which thumbnail? I need you!' },
          { id: 'ghost', action: 'dance', x: 50, line: 'I am not a real agent' },
          { id: 'rfq', action: 'moonwalk', x: 400, line: 'x'.repeat(200) },
          { id: 'fq', action: 'dance', x: 90, line: 'a second fq is ignored' },
        ],
      },
      AGENTS,
    )
    expect(scene?.backdrop).toBe('city')
    expect(scene?.headline).toBe('Three critters, one city, and somebody needs you.')
    expect(scene?.cast.map(c => c.id)).toEqual(['fq', 'rfq', 'jc'])
    expect(scene?.cast[0]).toMatchObject({ action: 'wave', x: 30, line: 'Which thumbnail? I need you!', status: 'waiting', name: 'Fair Question' })
    // An unknown action falls back to what the agent is doing; x is clamped; a long line is cut.
    expect(scene?.cast[1]).toMatchObject({ action: 'inspect', x: 100, status: 'working' })
    expect(scene!.cast[1]!.line.length).toBeLessThanOrEqual(MAX_LINE)
    // The agent the narrator forgot still stands on stage, doing what its status says.
    expect(scene?.cast[2]).toMatchObject({ id: 'jc', action: 'panic', status: 'failed', name: 'Job Costing' })
  })

  test('the narrator hears every agent: its name, how it stands, what it did last, and who needs the person', () => {
    const prompt = buildEnsemblePrompt(
      [
        { ...AGENTS[0]!, recent: ['asks you: which thumbnail?'] },
        { ...AGENTS[1]!, ask: 'price the drywall for job 214', recent: ['read takeoff.csv', 'edited pricing.ts'] },
        { ...AGENTS[2]!, recent: ['ran shell: npm test'] },
      ],
      ['Two critters at work in the lab.'],
    )
    expect(prompt).toContain('id "fq" (Fair Question): WAITING ON THE PERSON')
    expect(prompt).toContain('id "jc" (Job Costing): FAILED')
    expect(prompt).toContain('id "rfq" (RFQ board): working')
    expect(prompt).toContain('edited pricing.ts')
    expect(prompt).toContain('asked for: "price the drywall for job 214"')
    expect(prompt).toContain('Two critters at work in the lab.')
    // A fenced reply with chatter around it still comes back as a scene.
    const reply = 'Here you go:\n```json\n{"backdrop":"lab","headline":"Lab night.","cast":[{"id":"fq","action":"wave","x":20,"line":"Help?"}]}\n```'
    expect(ensembleFromReply(reply, AGENTS)?.cast.map(c => c.id)).toEqual(['fq', 'rfq', 'jc'])
  })

  test('one stage draws every agent once, by name, with who needs the person marked, well under the size limit', () => {
    const six = ['Fair Question', 'RFQ board', 'Job Costing', 'Money Lane', 'Reddit mods', 'Config/Hooks'].map((title, i) => ({
      id: `a${i}`,
      title,
      status: (['waiting', 'working', 'failed', 'done', 'working', 'working'] as const)[i]!,
    }))
    const scene = parseEnsemble(
      { backdrop: 'city', headline: 'Fair Question is waving at you from the corner.', cast: six.map((a, i) => ({ id: a.id, action: 'walk', x: i * 15, line: `line number ${i} about \`pricing.ts\` and more words` })) },
      six,
    )!
    const svg = ensembleToSvg(scene, { width: 1000, height: 192 })
    expect(svg.startsWith('<svg')).toBe(true)
    for (const a of six) expect(svg.split(`>${a.title}<`).length - 1).toBe(1)
    expect(svg).toContain('data-status="waiting"')
    expect(svg).toContain('Fair Question is waving at you')
    expect(svg.length).toBeLessThan(60_000)
  })

  test('the spotlight goes to the agent the narrator names, else to the first one that needs the person', () => {
    const named = parseEnsemble({ backdrop: 'lab', headline: 'h', spotlight: 'rfq', cast: [] }, AGENTS)
    expect(named?.spotlight).toBe('rfq')
    const unknown = parseEnsemble({ backdrop: 'lab', headline: 'h', spotlight: 'ghost', cast: [] }, AGENTS)
    expect(unknown?.spotlight).toBe('fq')
    const calm = parseEnsemble({ backdrop: 'lab', headline: 'h', cast: [] }, [{ id: 'x', title: 'X', status: 'working' }, { id: 'y', title: 'Y', status: 'done' }])
    expect(calm?.spotlight).toBe('x')
  })

  test('the stage looks its best that fits: lit scenery, each agent in its own color, the spotlight in the full bubble', () => {
    const LOOKS = ['pixel', 'original', 'ukiyoe', 'blueprint', 'aero']
    const BACKDROPS = ['forest', 'space', 'city', 'desert', 'volcano', 'lab', 'night']
    for (const size of [2, 4, 6]) {
      const agents = Array.from({ length: size }, (_, i) => ({ id: `a${i}`, title: `Agent number ${i}`, status: (['waiting', 'working', 'failed', 'done'] as const)[i % 4]! }))
      for (const backdrop of BACKDROPS)
        for (const look of LOOKS) {
          const scene = parseEnsemble(
            { backdrop, headline: 'Six critters and one long night of `npm test`', spotlight: 'a0', cast: agents.map((a, i) => ({ id: a.id, action: ['walk', 'dig', 'panic', 'celebrate'][i % 4], x: i * 20, line: `Agent ${i} is pricing drywall in takeoff.csv and failed twice` })) },
            agents,
          )!
          const svg = ensembleToSvg(scene, { width: 1100, height: 192, look })
          expect(svg.length).toBeLessThanOrEqual(126_000)
          // Every agent has its own tint.
          const tints = new Set([...svg.matchAll(/data-tint="([^"]+)"/g)].map(m => m[1]))
          expect(tints.size).toBe(size)
          // The spotlight speaks in the full, typed bubble.
          expect(svg).toContain('data-part="speech"')
        }
    }
    // With room to spare, the scenery is the lit one, not the flat fallback.
    const two = parseEnsemble({ backdrop: 'forest', headline: 'h', cast: [] }, AGENTS.slice(0, 2))!
    expect(ensembleToSvg(two, { width: 1100, height: 192 })).toContain('data-stage="lit"')
  })

  test('a character can go over to another agent: only toward a real one, and the drawing walks it there', () => {
    const scene = parseEnsemble(
      {
        backdrop: 'lab',
        headline: 'Money Lane walks over to cheer Job Costing on',
        spotlight: 'rfq',
        cast: [
          { id: 'fq', action: 'wave', x: 10, line: 'hi', toward: 'jc' },
          { id: 'rfq', action: 'inspect', x: 50, line: 'pricing', toward: 'rfq' },
          { id: 'jc', action: 'panic', x: 90, line: 'help', toward: 'ghost' },
        ],
      },
      AGENTS,
    )!
    expect(scene.cast.map(c => c.toward)).toEqual(['jc', undefined, undefined])
    const svg = ensembleToSvg(scene, { width: 1100, height: 192 })
    const walker = /<g data-agent="fq"[^>]*>([\s\S]*?)<\/g><g data-agent=/.exec(svg)?.[1] ?? ''
    expect(walker).toMatch(/type="translate" values="(-?[\d.]+) [\d.]+;(-?[\d.]+) [\d.]+"/)
    const [, from, to] = /type="translate" values="(-?[\d.]+) [\d.]+;(-?[\d.]+) [\d.]+"/.exec(walker)!
    expect(Number(to)).toBeGreaterThan(Number(from) + 100)
  })

  test('a scene in a new place fades in; one in the same place carries straight on', () => {
    const scene = parseEnsemble({ backdrop: 'volcano', headline: 'h', cast: [] }, AGENTS)!
    const fading = ensembleToSvg(scene, { width: 1100, height: 192, enter: 'fade' })
    const plain = ensembleToSvg(scene, { width: 1100, height: 192 })
    expect(fading).toContain('data-part="entrance"')
    expect(plain).not.toContain('data-part="entrance"')
  })

  test('an agent done and left a while is told as idle, so its critter dozes; a fresh one is not', () => {
    const prompt = buildEnsemblePrompt(
      [
        { id: 'old', title: 'Money Lane', status: 'done', isIdle: true },
        { id: 'new', title: 'RFQ board', status: 'done' },
      ],
      [],
    )
    expect(prompt).toContain('id "old" (Money Lane): done a while ago, untouched since (asleep)')
    expect(prompt).toContain('id "new" (RFQ board): done, ready for the person to look')
  })

  test('the narrator sees short ids, never the long session ids, and its scene comes back under the real ids', () => {
    const real = [
      { id: '334a1995-42d3-4b2a-80fb-051b8b8c47fe', title: 'Reddit mods', status: 'working' as const },
      { id: 'c7a36437-be9f-4579-8665-b4d0794d0fb2', title: 'Fair Question', status: 'waiting' as const },
    ]
    const { agents, restore } = shortIds(real)
    expect(agents.map(a => a.id)).toEqual(['a1', 'a2'])
    expect(buildEnsemblePrompt(agents, [])).not.toContain('334a1995')
    const scene = restore(ensembleFromReply('{"backdrop":"lab","headline":"h","spotlight":"a2","cast":[{"id":"a1","action":"walk","x":10,"line":"hi","toward":"a2"}]}', agents)!)
    expect(scene.spotlight).toBe('c7a36437-be9f-4579-8665-b4d0794d0fb2')
    expect(scene.cast.map(c => [c.id, c.toward])).toEqual([
      ['334a1995-42d3-4b2a-80fb-051b8b8c47fe', 'c7a36437-be9f-4579-8665-b4d0794d0fb2'],
      ['c7a36437-be9f-4579-8665-b4d0794d0fb2', undefined],
    ])
  })

  test('an answer that is not a scene is no scene', () => {
    expect(parseEnsemble('just chatter', AGENTS)).toBe(null)
    expect(parseEnsemble({ backdrop: 'mars', cast: [] }, AGENTS)).toBe(null)
  })
})
