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
