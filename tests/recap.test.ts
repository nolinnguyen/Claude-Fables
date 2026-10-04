import { describe, expect, test } from 'claude-code/testing'

import { MAX_HISTORY, pickRecap, recapHtml, recordScene } from '../hooks/recap'

const scene = (headline: string) => ({ backdrop: 'lab' as const, headline, spotlight: 'a', cast: [] })

describe('the daily recap', () => {
  test('the day log keeps every scene in order, one per line, the oldest dropped past its cap', () => {
    let log = ''
    for (let i = 0; i < MAX_HISTORY + 5; i++) log = recordScene(log, { at: i, scene: scene(`h${i}`) })
    const lines = log.trim().split('\n')
    expect(lines.length).toBe(MAX_HISTORY)
    expect(JSON.parse(lines[0]!).scene.headline).toBe('h5')
    expect(JSON.parse(lines.at(-1)!).scene.headline).toBe(`h${MAX_HISTORY + 4}`)
    // A torn last line (a write cut short) is dropped, not carried on.
    expect(recordScene('{"at":1,"scene":{"headl', { at: 2, scene: scene('next') }).trim().split('\n').length).toBe(1)
  })

  test('the recap shows the day spread out, no scene twice in a row, ending on the latest', () => {
    const entries = ['a', 'a', 'b', 'c', 'c', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((h, i) => ({ at: i * 1000, scene: scene(h) }))
    const picked = pickRecap(entries, 5)
    expect(picked.length).toBe(5)
    expect(picked.at(-1)!.scene.headline).toBe('i')
    expect(picked[0]!.scene.headline).toBe('a')
    for (let i = 1; i < picked.length; i++) expect(picked[i]!.scene.headline).not.toBe(picked[i - 1]!.scene.headline)
  })

  test('the page plays the scenes in turn and lists every headline with its time', () => {
    const html = recapHtml('Your agents, Oct 3', [
      { time: '21:04', headline: 'Fair Question waves for a thumbnail', svg: '<svg data-n="1"></svg>' },
      { time: '21:30', headline: 'Job Costing trips on a <KeyError>', svg: '<svg data-n="2"></svg>' },
    ])
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('Your agents, Oct 3')
    expect(html).toContain('<svg data-n="2"></svg>')
    expect(html).toContain('21:30')
    expect(html).toContain('Job Costing trips on a &lt;KeyError&gt;')
  })
})
