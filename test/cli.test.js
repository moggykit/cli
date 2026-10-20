import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const BIN = new URL('../bin/moggykit.js', import.meta.url).pathname

const CAT = {
  id: 1,
  slug: 'midge-2026-07',
  name: 'Midge',
  sex: 'm',
  approx_age: '~10m',
  status: 'active',
  story: 'Found under a wheelbarrow.',
  photo_url: 'https://moggy.dev/600/400/midge-2026-07',
  sponsor_url: 'https://aave.pt/en/cats/midge-2026-07',
}

let server
let api

/** Stand in for moggy.dev so the tests never touch the network. */
before(async () => {
  server = createServer((request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }

    if (request.url === '/cats') return json(200, { data: [CAT] })
    if (request.url === '/cats/midge-2026-07') return json(200, { data: CAT })
    if (request.url === '/cats/unsafe') return json(200, { data: { ...CAT, name: 'Midge\u001b[2J', story: 'Story\u001b]52;c;secret\u0007\u009b2J' } })
    if (request.url === '/cats/empty') return json(200, { data: [] })

    return json(404, { message: 'Not found' })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  api = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

/** Run the CLI against the stub, never the real API. */
const moggykit = (args = []) =>
  run('node', [BIN, ...args], { env: { ...process.env, MOGGYKIT_API: api, NO_COLOR: '1' } })

describe('moggykit', () => {
  it('prints a random cat with its sponsor link', async () => {
    const { stdout } = await moggykit()

    assert.match(stdout, /Midge/)
    assert.match(stdout, /Found under a wheelbarrow\./)
    // The sponsor link is the entire point of the tool — never let it drop out.
    assert.match(stdout, /aave\.pt\/en\/cats\/midge-2026-07/)
  })

  it('prints a named cat', async () => {
    const { stdout } = await moggykit(['midge-2026-07'])

    assert.match(stdout, /Midge/)
  })

  it('prints raw json when asked', async () => {
    const { stdout } = await moggykit(['midge-2026-07', '--json'])

    assert.equal(JSON.parse(stdout).slug, 'midge-2026-07')
  })

  it('emits no ansi codes when colour is off', async () => {
    const { stdout } = await moggykit(['midge-2026-07'])

    assert.doesNotMatch(stdout, /\[/)
  })

  it('explains an unknown cat and exits non-zero', async () => {
    const error = await moggykit(['nope']).then(
      () => null,
      (thrown) => thrown,
    )

    assert.ok(error, 'expected a non-zero exit')
    assert.equal(error.code, 1)
    assert.match(error.stderr, /no cat by that name/)
  })

  it('explains an unreachable api and exits non-zero', async () => {
    const error = await run('node', [BIN], {
      env: { ...process.env, MOGGYKIT_API: 'https://moggy.invalid/api' },
    }).then(
      () => null,
      (thrown) => thrown,
    )

    assert.ok(error, 'expected a non-zero exit')
    assert.match(error.stderr, /could not reach moggy\.dev/)
  })

  it('strips terminal escape sequences from the original pretty output too', async () => {
    const { stdout } = await moggykit(['unsafe'])
    assert.match(stdout, /Midge/)
    assert.match(stdout, /Story/)
    assert.doesNotMatch(stdout, /\u001b|secret/)
  })

  it('keeps raw JSON parseable while escaping terminal controls', async () => {
    const { stdout } = await moggykit(['unsafe', '--json'])
    assert.equal(JSON.parse(stdout).name, 'Midge\u001b[2J')
    assert.doesNotMatch(stdout, /[\u001b\u007f-\u009f]/)
  })

  it('exits gracefully from browse in a pipe without fetching', async () => {
    const { stdout } = await run('node', [BIN, 'browse'], {
      env: { ...process.env, MOGGYKIT_API: 'https://moggy.invalid/api' },
      timeout: 2000,
    })
    assert.match(stdout, /needs an interactive terminal/)
    assert.doesNotMatch(stdout, /\u001b/)
  })

  it('shows help and version without touching the network', async () => {
    const help = await run('node', [BIN, '--help'], {
      env: { ...process.env, MOGGYKIT_API: 'https://moggy.invalid/api' },
    })

    assert.match(help.stdout, /Usage/)

    const version = await run('node', [BIN, '--version'], {
      env: { ...process.env, MOGGYKIT_API: 'https://moggy.invalid/api' },
    })

    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/)
  })
})
