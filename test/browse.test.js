import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { describe, it } from 'node:test'
import { browse } from '../bin/browse.js'
import { openSponsor, terminalText } from '../bin/terminal.js'

// The test streams emulate a capable terminal, regardless of the test runner's TERM.
process.env.TERM = 'xterm-256color'

// Test records exercise the public API shape; they are never user-facing fallback cats.
const cat = (name) => ({ name, story: `${name}'s story`, sponsor_url: `https://associacaoambientaldaviadaestrela.org/en/cats/${name}` })

function terminal() {
  const input = new PassThrough()
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = (value) => { input.isRaw = value }
  let text = ''
  const output = { isTTY: true, write: (chunk) => { text += chunk } }
  return { input, output, text: () => text, frame: () => text.split('\u001b[H\u001b[2J').at(-1) }
}

async function session(getJson, check, open, prepare) {
  const screen = terminal()
  const running = browse({ ...screen, getJson, api: 'https://moggy.dev/api', open, prepare })
  try {
    await setImmediate()
    await check(screen)
  } finally {
    screen.input.write('q')
    await running
    assert.equal(screen.input.isRaw, false)
    assert.equal(screen.input.listenerCount('keypress'), 0)
    assert.ok(screen.text().endsWith('\u001b[?25h\u001b[?1049l'))
  }
}

describe('browse', () => {
  it('follows real pagination, navigates both ways, wraps and opens the selected URL', async () => {
    const paths = []
    const opened = []
    await session(async (path) => {
      paths.push(path)
      return path === '/cats'
        ? { data: [cat('first')], links: { next: 'https://moggy.dev/api/cats?page=2' }, meta: { per_page: 15 } }
        : { data: [cat('second')], links: { next: null } }
    }, async (screen) => {
      assert.match(screen.text(), /Loading cats/)
      assert.match(screen.frame(), /1 \/ 2 · first/)
      assert.doesNotMatch(screen.frame(), /second's story/)
      screen.input.write('\u001b[C')
      assert.match(screen.frame(), /2 \/ 2 · second/)
      screen.input.write('s')
      await setImmediate()
      assert.deepEqual(opened, [cat('second').sponsor_url])
      screen.input.write('\u001b[C')
      assert.match(screen.frame(), /1 \/ 2 · first/)
      screen.input.write('\u001b[D')
      assert.match(screen.frame(), /2 \/ 2 · second/)
      assert.deepEqual(paths, ['/cats', '/cats?page=2'])
    }, async (url) => { opened.push(url) })
  })

  it('displays and opens legacy API sponsor links on the new domain, preserving tracking', async () => {
    const opened = []
    const url = 'https://associacaoambientaldaviadaestrela.org/en/cats/first?utm_source=moggykit&utm_medium=api'
    await session(async () => ({ data: [{ ...cat('first'),
      sponsor_url: 'https://aave.pt/en/cats/first?utm_source=moggykit&utm_medium=api' }] }), async (screen) => {
      assert.ok(screen.frame().includes(url))
      screen.input.write('s')
      await setImmediate()
      assert.deepEqual(opened, [url])
    }, async (value) => { opened.push(value) })
  })

  it('handles an empty list and null stories', async () => {
    await session(async () => ({ data: [], links: { next: null } }), async (screen) => {
      assert.match(screen.frame(), /no cats to show/)
      screen.input.write('s')
      screen.input.write('\u001b[C')
    }, () => assert.fail('must not open a URL without a cat'))
    await session(async () => ({ data: [{ ...cat('first'), story: null }] }), async (screen) => {
      assert.match(screen.frame(), /No story written yet/)
    })
  })

  it('reports request errors, malformed data and unsafe or cyclic pagination', async () => {
    for (const getJson of [
      async () => { throw new Error('moggy.dev returned 503') },
      async () => ({ data: {} }),
      async () => ({ data: [null] }),
      async () => ({ data: [], links: { next: 'https://evil.invalid/api/cats?page=2' } }),
      async () => ({ data: [], links: { next: 'https://moggy.dev/api/cats' } }),
    ]) {
      await session(getJson, async (screen) => {
        assert.match(screen.frame(), /Could not load cats:/)
      })
    }
  })

  it('allows q while loading and aborts the pending request', async () => {
    let signal
    await session((_path, abortSignal) => {
      signal = abortSignal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    }, async (screen) => {
      assert.match(screen.frame(), /Loading cats/)
    })
    assert.equal(signal.aborted, true)
  })

  it('restores raw mode and listeners on Ctrl+C, SIGTERM and input end', async () => {
    for (const exit of [(input) => input.write('\u0003'), () => process.emit('SIGTERM'), (input) => input.end()]) {
      const screen = terminal()
      const listeners = process.listenerCount('SIGTERM')
      const running = browse({ ...screen, api: 'https://moggy.dev/api', getJson: async () => ({ data: [] }) })
      await setImmediate()
      exit(screen.input)
      await running
      assert.equal(screen.input.isRaw, false)
      assert.equal(process.listenerCount('SIGTERM'), listeners)
    }
  })

  it('shows browser launch failures and sanitises all displayed API text', async () => {
    const escape = '\u001b[2J\u001b]52;c;ZXZpbA==\u0007'
    await session(async () => ({ data: [{ ...cat('first'), name: `first${escape}`, story: `story${escape}` }] }), async (screen) => {
      assert.match(screen.frame(), /first/)
      assert.doesNotMatch(screen.frame(), /52;c|ZXZpbA/)
      assert.doesNotMatch(screen.frame().replace(/\u001b\[\?25h\u001b\[\?1049l$/, ''), /\u001b/)
      screen.input.write('s')
      await setImmediate()
      assert.match(screen.frame(), /Could not open/)
    }, async () => { throw new Error('Could not open') })
  })

  it('previews, edits, confirms once and blocks reposting the same cat', async () => {
    const published = []
    let disposed = 0
    let prepared = 0
    const prepare = async (selected) => {
      prepared++
      assert.equal(selected.name, 'first')
      return {
        body: 'Original story', photo: 'image/png · 68 bytes', key: '/test/key.pub', fingerprint: 'SHA256:test',
        publish: async (text) => {
          published.push(text)
          return 'Committed: https://dev-null.sh/@tester/commits/123 (pending review)'
        },
        dispose: () => { disposed++ },
      }
    }
    await session(async () => ({ data: [cat('first'), cat('second')] }), async (screen) => {
      screen.input.write('p')
      await setImmediate()
      assert.match(screen.frame(), /Original story/)
      assert.match(screen.frame(), /image\/png/)
      assert.match(screen.frame(), /SHA256:test/)
      assert.equal(published.length, 0)
      screen.input.write('s')
      screen.input.write('\u001b[C')
      assert.equal(published.length, 0)
      screen.input.write('e')
      screen.input.write('\u0015') // Ctrl+U clears the edit buffer.
      screen.input.write('A q in edited text')
      screen.input.write('\r')
      screen.input.write('Second line!')
      screen.input.write('\u007f') // Backspace.
      screen.input.write('\u0004') // Ctrl+D returns to preview.
      assert.match(screen.frame(), /A q in edited text\nSecond line/)
      assert.equal(published.length, 0)
      screen.input.write('y')
      screen.input.write('y')
      await setImmediate()
      assert.deepEqual(published, [`A q in edited text\nSecond line\n\nSponsor: ${cat('first').sponsor_url}`])
      assert.match(screen.frame(), /pending review/)
      screen.input.write('p')
      await setImmediate()
      assert.match(screen.frame(), /already submitted/)
      assert.equal(prepared, 1)
    }, undefined, prepare)
    assert.equal(disposed, 1)
  })

  it('restores the full sponsorship URL after replacing the text, before confirmation', async () => {
    const url = `${cat('first').sponsor_url}?utm_source=moggykit&utm_medium=api&utm_campaign=sponsor`
    const sent = []
    await session(async () => ({ data: [{ ...cat('first'), sponsor_url: url }] }), async (screen) => {
      screen.input.write('p')
      await setImmediate()
      screen.input.write('e')
      screen.input.write('\u0015')
      screen.input.write('Testing the cat browser')
      screen.input.write('\u0004')
      const expected = `Testing the cat browser\n\nSponsor: ${url}`
      assert.ok(screen.frame().includes(`Post text:\n---\n${expected}\n---`))
      assert.match(screen.frame(), /Local details \(not included in the post\)/)
      assert.match(screen.frame(), /sponsorship link has been kept/)
      assert.equal(sent.length, 0)
      screen.input.write('y')
      await setImmediate()
      assert.deepEqual(sent, [expected])
    }, undefined, async () => ({ body: `Original\n\nSponsor: ${url}`, photo: 'image/png', dispose() {},
      publish: async (body) => { sent.push(body); return 'Committed: https://dev-null.sh/@test/commits/1' } }))
  })

  it('does not duplicate retained links or truncate a restored URL after a long edit', async () => {
    const url = cat('first').sponsor_url
    await session(async () => ({ data: [cat('first')] }), async (screen) => {
      screen.input.write('p')
      await setImmediate()
      screen.input.write('e')
      screen.input.write('\u0004')
      assert.equal(screen.frame().split(url).length - 1, 1)
      screen.input.write('e')
      screen.input.write('\u0015')
      screen.input.emit('keypress', 'x'.repeat(10_000), {})
      screen.input.write('\u0004')
      assert.ok(screen.frame().includes(`Sponsor: ${url}\n---`))
      screen.input.emit('keypress', '', { name: 'escape' })
    }, undefined, async () => ({ body: `Original\n\nSponsor: ${url}`, photo: 'image/png', dispose() {},
      publish: () => assert.fail('must not publish during editing') }))
  })

  it('opens the prepared photo from the preview without publishing or leaving the preview', async () => {
    for (const fail of [false, true]) {
      const opened = []
      let disposed = 0
      await session(async () => ({ data: [cat('first')] }), async (screen) => {
        screen.input.write('p')
        await setImmediate()
        assert.match(screen.frame(), /v view photo in browser/)
        screen.input.write('v')
        await setImmediate()
        assert.deepEqual(opened, ['https://moggy.dev/600/400/first'])
        assert.match(screen.frame(), fail ? /Could not open the photo/ : /Photo opened/)
        assert.match(screen.frame(), /Original/)
        assert.match(screen.frame(), /y publish/)
        screen.input.emit('keypress', '', { name: 'escape' })
        assert.match(screen.frame(), /Nothing was submitted/)
      }, async (url) => {
        opened.push(url)
        if (fail) throw new Error('browser unavailable')
      }, async () => ({ body: 'Original', photo: 'image/png', photoUrl: 'https://moggy.dev/600/400/first',
        publish: () => assert.fail('viewing a photo must not publish'), dispose: () => { disposed++ } }))
      assert.equal(disposed, 1)
    }
  })

  it('discards edits, cancels a preview, and never sends a cancelled draft', async () => {
    let disposed = 0
    await session(async () => ({ data: [cat('first')] }), async (screen) => {
      screen.input.write('p')
      await setImmediate()
      screen.input.write('e')
      screen.input.write('changed')
      screen.input.emit('keypress', '', { name: 'escape' })
      assert.match(screen.frame(), /Original/)
      assert.doesNotMatch(screen.frame(), /Originalchanged/)
      screen.input.emit('keypress', '', { name: 'escape' })
      assert.match(screen.frame(), /Nothing was submitted/)
      screen.input.write('y')
      assert.equal(disposed, 1)
    }, undefined, async () => ({ body: 'Original', photo: 'image/png',
      publish: () => assert.fail('must not submit'), dispose: () => { disposed++ } }))
  })

  it('cancels preparation and disposes late-arriving photos', async () => {
    let complete
    let disposed = 0
    let signal
    await session(async () => ({ data: [cat('first')] }), async (screen) => {
      screen.input.write('p')
      await setImmediate()
      screen.input.emit('keypress', '', { name: 'escape' })
      assert.equal(signal.aborted, true)
      complete({ dispose: () => { disposed++ } })
      await setImmediate()
      assert.equal(disposed, 1)
      assert.doesNotMatch(screen.frame(), /y publish/)
    }, undefined, (_cat, options) => {
      signal = options.signal
      return new Promise((resolve) => { complete = resolve })
    })
  })

  it('keeps preparation and submission errors readable and does not auto-retry', async () => {
    for (const failPreparation of [true, false]) {
      let publishes = 0
      await session(async () => ({ data: [cat('first')] }), async (screen) => {
        screen.input.write('p')
        await setImmediate()
        if (!failPreparation) {
          screen.input.write('y')
          await setImmediate()
          screen.input.write('p')
        }
        assert.doesNotMatch(screen.frame().replace(/\u001b\[\?25h\u001b\[\?1049l$/, ''), /\u001b/)
      }, undefined, async () => {
        if (failPreparation) throw new Error('No photo\u001b[2J')
        return { body: 'Draft', photo: 'image/png', dispose() {},
          publish: async () => { publishes++; throw new Error('Status unknown\u001b[2J') } }
      })
      assert.equal(publishes, failPreparation ? 0 : 1)
    }
  })

  it('disposes a preview on q and aborts a submission on Ctrl+C', async () => {
    for (const submit of [false, true]) {
      let disposed = 0
      let signal
      await session(async () => ({ data: [cat('first')] }), async (screen) => {
        screen.input.write('p')
        await setImmediate()
        if (submit) {
          screen.input.write('y')
          await setImmediate()
          screen.input.write('\u0003')
        }
      }, undefined, async (_cat, options) => {
        signal = options.signal
        return { body: 'Draft', photo: 'image/png', dispose: () => { disposed++ },
          publish: async (_body, abortSignal) => new Promise((_resolve, reject) => {
            abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          }) }
      })
      assert.equal(signal.aborted, true)
      assert.ok(disposed >= 1)
    }
  })

  it('avoids fetching and raw mode when either stream is not interactive', async () => {
    for (const stream of ['input', 'output']) {
      const screen = terminal()
      screen[stream].isTTY = false
      await browse({ ...screen, getJson: () => assert.fail('must not fetch'), api: 'https://moggy.dev/api' })
      assert.match(screen.text(), /needs an interactive terminal/)
      assert.equal(screen.input.isRaw, false)
      assert.doesNotMatch(screen.text(), /\u001b/)
    }
  })
})

describe('terminal safety', () => {
  it('removes OSC, CSI, C0 and C1 controls, preserving readable text', () => {
    assert.equal(terminalText('Hi\u001b[31m cat\u001b[0m\u001b]52;c;secret\u0007\r\n\tstory\u0008\u009b2J'), 'Hi cat\n\tstory')
  })

  it('opens the API URL as one argument, with no shell, on each platform', async () => {
    for (const [platform, expected] of [['darwin', 'open'], ['linux', 'xdg-open'], ['win32', 'explorer.exe']]) {
      const url = 'https://associacaoambientaldaviadaestrela.org/en/cats/first?utm_source=moggykit&utm_medium=api'
      await openSponsor(url, platform, (command, args, options, callback) => {
        assert.equal(command, expected)
        assert.deepEqual(args, [url])
        assert.equal(options.shell, undefined)
        callback(null)
      })
    }
  })

  it('rejects executable schemes, control characters, credentials and missing links', async () => {
    for (const url of ['javascript:alert(1)', 'file:///tmp/cat', 'https://associacaoambientaldaviadaestrela.org/\u001b[2J', 'https://user:pass@associacaoambientaldaviadaestrela.org/', null]) {
      await assert.rejects(openSponsor(url, 'linux', () => assert.fail('must not spawn')), /no valid sponsorship URL/)
    }
    await assert.rejects(openSponsor(cat('first').sponsor_url, 'linux', (_cmd, _args, _opts, cb) => cb(new Error('no opener'))), /Could not open/)
  })
})
