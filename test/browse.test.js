import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { describe, it } from 'node:test'
import { browse } from '../bin/browse.js'
import { openSponsor, terminalText } from '../bin/terminal.js'

// The test streams emulate a capable terminal, regardless of the test runner's TERM.
process.env.TERM = 'xterm-256color'

// Test records exercise the public API shape; they are never user-facing fallback cats.
const cat = (name) => ({ name, story: `${name}'s story`, sponsor_url: `https://aave.pt/en/cats/${name}` })

function terminal() {
  const input = new PassThrough()
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = (value) => { input.isRaw = value }
  let text = ''
  const output = { isTTY: true, write: (chunk) => { text += chunk } }
  return { input, output, text: () => text, frame: () => text.split('\u001b[H\u001b[2J').at(-1) }
}

async function session(getJson, check, open) {
  const screen = terminal()
  const running = browse({ ...screen, getJson, api: 'https://moggy.dev/api', open })
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
      const url = 'https://aave.pt/en/cats/first?utm_source=moggykit&utm_medium=api'
      await openSponsor(url, platform, (command, args, options, callback) => {
        assert.equal(command, expected)
        assert.deepEqual(args, [url])
        assert.equal(options.shell, undefined)
        callback(null)
      })
    }
  })

  it('rejects executable schemes, control characters, credentials and missing links', async () => {
    for (const url of ['javascript:alert(1)', 'file:///tmp/cat', 'https://aave.pt/\u001b[2J', 'https://user:pass@aave.pt/', null]) {
      await assert.rejects(openSponsor(url, 'linux', () => assert.fail('must not spawn')), /no valid sponsorship URL/)
    }
    await assert.rejects(openSponsor(cat('first').sponsor_url, 'linux', (_cmd, _args, _opts, cb) => cb(new Error('no opener'))), /Could not open/)
  })
})
