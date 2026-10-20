import { emitKeypressEvents } from 'node:readline'
import { openSponsor, terminalText } from './terminal.js'
import { preparePost } from './devnull.js'
import { sponsorUrl } from './sponsor.js'

/** One selected index, redrawn after each keypress. No persistent cat cache. */
export async function browse({ getJson, api, input = process.stdin, output = process.stdout, open = openSponsor, prepare = preparePost }) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function' || process.env.TERM === 'dumb') {
    output.write('moggykit browse needs an interactive terminal. Run `npx moggykit` or `npx moggykit --json` for piped output.\n')
    return
  }

  const controller = new AbortController()
  const cats = []
  let index = 0
  let loaded = false
  let message = 'Loading cats…'
  let opening = false
  let view = 'browse'
  let draft
  let body = ''
  let beforeEditing = ''
  let shareController
  const attemptedCats = new Set()
  const catKey = (cat) => cat.slug ?? cat.sponsor_url
  let stopped = false
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  const wasRaw = Boolean(input.isRaw)

  function draw() {
    if (stopped) return
    const cat = cats[index]
    if (view !== 'browse') {
      const lines = ['Post this cat to /dev/null', '']
      if (draft) lines.push('Post text:', '---', terminalText(body), '---', '',
        'Local details (not included in the post):',
        `Attachment: ${terminalText(draft.photo)}`,
        `Signing key: ${terminalText(draft.key)}`,
        `Fingerprint: ${terminalText(draft.fingerprint)}`, '')
      if (message) lines.push(message, '')
      lines.push(view === 'edit' ? 'Type to edit · Backspace delete · Ctrl+U clear · Ctrl+D preview · Esc discard edits'
        : view === 'preview' ? 'v view photo in browser · e edit · y publish to /dev/null · Esc cancel · q quit'
        : view === 'posting' ? 'Submitting once… · q quit (submission may already have reached /dev/null)'
        : 'Preparing photo and local signing key… · Esc cancel · q quit')
      output.write(`\u001b[H\u001b[2J${lines.join('\n')}\n`)
      return
    }
    const lines = ['MoggyKit — rescue cats', '']
    if (cat) {
      lines.push(`${index + 1} / ${cats.length} · ${terminalText(cat.name)}`, '',
        terminalText(cat.story) || 'No story written yet.', '',
        `Sponsor: ${terminalText(cat.sponsor_url)}`, '')
    }
    if (message) lines.push(message, '')
    lines.push('← / → previous / next · s sponsor · p post to /dev/null · q quit')
    output.write(`\u001b[H\u001b[2J${lines.join('\n')}\n`)
  }

  function stop() {
    if (stopped) return
    stopped = true
    controller.abort()
    shareController?.abort()
    draft?.dispose()
    draft = null
    finish()
  }

  function cancelDraft() {
    shareController?.abort()
    draft?.dispose()
    draft = null
    view = 'browse'
    message = 'Post cancelled. Nothing was submitted.'
    draw()
  }

  function reviewDraft() {
    const sponsor = cats[index].sponsor_url
    const restored = !body.includes(sponsor)
    if (restored) body = `${body.trimEnd()}\n\nSponsor: ${sponsor}`.trimStart()
    view = 'preview'
    message = restored ? 'The sponsorship link has been kept in the post. Review the complete text above.' : ''
  }

  async function startDraft(cat) {
    if (attemptedCats.has(catKey(cat))) {
      message = 'This cat was already submitted in this session. Check your /dev/null profile before posting again.'
      draw()
      return
    }
    const pending = new AbortController()
    shareController = pending
    view = 'preparing'
    message = ''
    draw()
    try {
      const prepared = await prepare(cat, { signal: pending.signal })
      if (stopped || pending.signal.aborted) return prepared.dispose()
      draft = prepared
      body = prepared.body
      reviewDraft()
    } catch (error) {
      if (stopped || pending.signal.aborted) return
      view = 'browse'
      message = terminalText(error.message)
    }
    draw()
  }

  async function publishDraft() {
    if (!body.trim()) {
      message = 'Write some text before posting.'
      draw()
      return
    }
    const selected = draft
    const sending = shareController
    attemptedCats.add(catKey(cats[index]))
    view = 'posting'
    message = ''
    draw()
    try {
      message = await selected.publish(body, sending.signal)
    } catch (error) {
      message = terminalText(error.message)
    } finally {
      selected.dispose()
      if (draft === selected) draft = null
      view = 'browse'
      draw()
    }
  }

  async function keypress(text, key = {}) {
    if (stopped) return
    if (key.ctrl && key.name === 'c') return stop()
    if (view === 'edit') {
      if (key.name === 'escape') {
        body = beforeEditing
        view = 'preview'
      } else if (key.ctrl && key.name === 'd') {
        reviewDraft()
      } else if (key.ctrl && key.name === 'u') {
        body = ''
      } else if (key.name === 'backspace') {
        body = Array.from(body).slice(0, -1).join('')
      } else if (key.name === 'return' || key.name === 'enter') {
        body += '\n'
      } else if (!key.ctrl && !key.meta && text && !['left', 'right', 'up', 'down', 'delete'].includes(key.name)) {
        body += terminalText(text)
      }
      if (view === 'edit') {
        body = body.slice(0, 10_000)
        message = ''
      }
      draw()
      return
    }
    if (text === 'q') return stop()
    if (view === 'preparing' || view === 'preview') {
      if (key.name === 'escape') return cancelDraft()
      if (view === 'preview' && text === 'e') {
        beforeEditing = body
        view = 'edit'
        message = ''
        draw()
      } else if (view === 'preview' && text === 'v' && !opening) {
        const selected = draft
        opening = true
        message = 'Opening the photo in your browser…'
        draw()
        try {
          await open(selected.photoUrl)
          if (draft === selected && view === 'preview') message = 'Photo opened. Return here to edit, cancel or confirm publishing.'
        } catch {
          if (draft === selected && view === 'preview') message = 'Could not open the photo. Open the photo URL shown in Attachment manually.'
        } finally {
          opening = false
          draw()
        }
      } else if (view === 'preview' && text === 'y') {
        await publishDraft()
      }
      return
    }
    if (view === 'posting' || !loaded || !cats.length) return
    if (key.name === 'left' || key.name === 'right') {
      index = (index + (key.name === 'left' ? -1 : 1) + cats.length) % cats.length
      message = ''
      draw()
    } else if (text === 'p') {
      await startDraft(cats[index])
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
        cats.push(...page.data.map((cat) => ({ ...cat, sponsor_url: sponsorUrl(cat.sponsor_url) })))
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
      loaded = true
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
