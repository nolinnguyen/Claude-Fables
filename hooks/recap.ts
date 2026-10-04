/**
 * The daily recap: the narrator logs every combined-story scene to a file for
 * the day, and /fables recap plays the day back as a page of scenes in turn.
 */

import type { FablesEnsembleScene } from '../types'

/** One logged scene: when it went up, and the scene. */
export type HistoryEntry = { at: number; scene: FablesEnsembleScene }

/** The most scenes one day's log keeps; past it the oldest go. */
export const MAX_HISTORY = 400

/** The day log with `entry` added: one JSON line per scene, a torn line (a cut-short write) dropped. */
export function recordScene(log: string, entry: HistoryEntry): string {
  const kept = log.split('\n').filter(line => {
    if (!line.trim()) return false
    try {
      JSON.parse(line)
      return true
    } catch {
      return false
    }
  })
  return [...kept, JSON.stringify(entry)].slice(-MAX_HISTORY).join('\n') + '\n'
}

export function readHistory(log: string): HistoryEntry[] {
  return log.split('\n').flatMap(line => {
    try {
      return line.trim() ? [JSON.parse(line) as HistoryEntry] : []
    } catch {
      return []
    }
  })
}

const withoutRepeats = (entries: readonly HistoryEntry[]) => entries.filter((e, i) => i === 0 || e.scene.headline !== entries[i - 1]!.scene.headline)

/** At most `max` scenes spread across the day, never the same headline twice in a row, always ending on the latest. */
export function pickRecap(entries: readonly HistoryEntry[], max: number): HistoryEntry[] {
  const distinct = withoutRepeats(entries)
  if (distinct.length <= max) return distinct
  const picked = Array.from({ length: max }, (_, i) => distinct[Math.round((i * (distinct.length - 1)) / (max - 1))]!)
  return withoutRepeats(picked)
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * The recap page: the scenes one at a time, each up long enough to watch, and
 * every headline below with its time; a click on one jumps to it.
 */
export function recapHtml(title: string, items: readonly { time: string; headline: string; svg: string }[]): string {
  const scenes = items.map((it, i) => `<div class="scene" data-i="${i}"${i === 0 ? '' : ' hidden'}>${it.svg}</div>`).join('')
  const list = items.map((it, i) => `<li data-i="${i}"><time>${escapeHtml(it.time)}</time> ${escapeHtml(it.headline)}</li>`).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; background: #1c1b19; color: #ece9df; font: 14px/1.5 ui-monospace, Consolas, monospace; }
main { max-width: 1200px; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: 18px; font-weight: 600; margin: 0 0 12px; }
.stage { background: #262624; border-radius: 6px; overflow: hidden; }
.stage svg { display: block; width: 100%; height: auto; }
.bar { display: flex; gap: 12px; align-items: center; margin: 10px 0 18px; color: #9a978f; }
button { background: #33322f; color: #ece9df; border: 1px solid #4a4843; border-radius: 4px; padding: 4px 10px; font: inherit; cursor: pointer; }
ol { list-style: none; padding: 0; margin: 0; }
li { padding: 4px 8px; border-radius: 4px; cursor: pointer; }
li.on { background: #33322f; }
time { color: #d9a441; margin-right: 8px; }
</style></head>
<body><main>
<h1>${escapeHtml(title)}</h1>
<div class="stage">${scenes}</div>
<div class="bar"><button id="play">Pause</button><span id="where"></span></div>
<ol>${list}</ol>
</main>
<script>
const scenes = [...document.querySelectorAll('.scene')];
const rows = [...document.querySelectorAll('li')];
let at = 0, timer = null;
function show(i) {
  at = (i + scenes.length) % scenes.length;
  scenes.forEach((s, k) => { s.hidden = k !== at; });
  rows.forEach((r, k) => r.classList.toggle('on', k === at));
  // Each scene starts its own animation over when it comes up.
  const svg = scenes[at].querySelector('svg'); if (svg && svg.setCurrentTime) svg.setCurrentTime(0);
  document.getElementById('where').textContent = (at + 1) + ' / ' + scenes.length;
}
function play() { timer = setInterval(() => show(at + 1), 7000); document.getElementById('play').textContent = 'Pause'; }
function pause() { clearInterval(timer); timer = null; document.getElementById('play').textContent = 'Play'; }
document.getElementById('play').onclick = () => (timer ? pause() : play());
rows.forEach((r, k) => r.onclick = () => { show(k); if (timer) { pause(); play(); } });
show(0); if (scenes.length > 1) play();
</script>
</body></html>
`
}
