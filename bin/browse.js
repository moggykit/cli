import { emitKeypressEvents } from 'node:readline'
import { openSponsor, terminalText } from './terminal.js'

/** One selected index, redrawn after each keypress. No persistent cat cache. */
export async function browse({ getJson, api, input = process.stdin, output = process.stdout, open = openSponsor }) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function' || process.env.TERM === 'dumb') {
    output.write('moggykit browse needs an interactive terminal. Run `npx moggykit` or `npx moggykit --json` for piped output.\n')
    return
  }

  const controller = new AbortController()
  const cats = []
  let index = 0
  let message = 'Loading cats…'
  let opening = false
  let stopped = false
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  const wasRaw = Boolean(input.isRaw)

  function draw() {
    if (stopped) return
    const cat = cats[index]
    const lines = ['MoggyKit — rescue cats', '']
    if (cat) {
      lines.push(`${index + 1} / ${cats.length} · ${terminalText(cat.name)}`, '',
        terminalText(cat.story) || 'No story written yet.', '',
        `Sponsor: ${terminalText(cat.sponsor_url)}`, '')
    }
    if (message) lines.push(message, '')
    lines.push('← / → previous / next · s sponsor · q quit')
    output.write(`\u001b[H\u001b[2J${lines.join('\n')}\n`)
  }

  function stop() {
    if (stopped) return
    stopped = true
    controller.abort()
    finish()
  }

  async function keypress(text, key = {}) {
    if (text === 'q' || (key.ctrl && key.name === 'c')) return stop()
    if (stopped || !cats.length) return
    if (key.name === 'left' || key.name === 'right') {
      index = (index + (key.name === 'left' ? -1 : 1) + cats.length) % cats.length
      message = ''
      draw()
    } else if (text === 's' && !opening) {
      opening = true
      message = 'Opening sponsorship page…'
      draw()
      try {
        await open(cats[index].sponsor_url)
        message = 'Sponsorship page opened.'
      } catch (error) {
        message = terminalText(error.message)
      } finally {
        opening = false
        draw()
      }
    }
  }

  async function load() {
    try {
      let path = '/cats'
      const visited = new Set()
      const base = new URL(`${api.replace(/\/$/, '')}/cats`)
      while (path && !stopped) {
        if (visited.has(path)) throw new Error('moggy.dev returned repeated pagination links')
        visited.add(path)
        const page = await getJson(path, controller.signal)
        if (stopped) return
        if (!Array.isArray(page?.data) || page.data.some((cat) => !cat || typeof cat.name !== 'string' ||
          !(cat.story === null || typeof cat.story === 'string') || typeof cat.sponsor_url !== 'string')) {
          throw new Error('moggy.dev returned an unexpected cat list')
        }
        cats.push(...page.data)
        const next = page.links?.next
        path = null
        if (next != null) {
          const url = new URL(next, base)
          if (url.origin !== base.origin || url.pathname !== base.pathname || url.username || url.password) {
            throw new Error('moggy.dev returned an unexpected pagination link')
          }
          path = `/cats${url.search}`
        }
      }
      message = cats.length ? '' : 'moggy.dev has no cats to show right now.'
    } catch (error) {
      cats.length = 0
      message = `Could not load cats: ${terminalText(error.message)}`
    }
    draw()
  }

  try {
    emitKeypressEvents(input)
    input.setRawMode(true)
    input.resume()
    input.on('keypress', keypress)
    input.once('end', stop)
    input.once('close', stop)
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    output.write('\u001b[?1049h\u001b[?25l')
    draw()
    void load()
    await done
  } finally {
    stop()
    input.removeListener('keypress', keypress)
    input.removeListener('end', stop)
    input.removeListener('close', stop)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    input.setRawMode(wasRaw)
    input.pause()
    output.write('\u001b[?25h\u001b[?1049l')
  }
}
