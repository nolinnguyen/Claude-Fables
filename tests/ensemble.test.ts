import { describe, expect, test } from 'claude-code/testing'

import { buildEnsemblePrompt, ensembleFromReply, MAX_LINE, parseEnsemble } from '../hooks/ensemble'

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
        { ...AGENTS[1]!, recent: ['read takeoff.csv', 'edited pricing.ts'] },
        { ...AGENTS[2]!, recent: ['ran shell: npm test'] },
      ],
      ['Two critters at work in the lab.'],
    )
    expect(prompt).toContain('id "fq" (Fair Question): WAITING ON THE PERSON')
    expect(prompt).toContain('id "jc" (Job Costing): FAILED')
    expect(prompt).toContain('id "rfq" (RFQ board): working')
    expect(prompt).toContain('edited pricing.ts')
    expect(prompt).toContain('Two critters at work in the lab.')
    // A fenced reply with chatter around it still comes back as a scene.
    const reply = 'Here you go:\n```json\n{"backdrop":"lab","headline":"Lab night.","cast":[{"id":"fq","action":"wave","x":20,"line":"Help?"}]}\n```'
    expect(ensembleFromReply(reply, AGENTS)?.cast.map(c => c.id)).toEqual(['fq', 'rfq', 'jc'])
  })

  test('an answer that is not a scene is no scene', () => {
    expect(parseEnsemble('just chatter', AGENTS)).toBe(null)
    expect(parseEnsemble({ backdrop: 'mars', cast: [] }, AGENTS)).toBe(null)
  })
})
