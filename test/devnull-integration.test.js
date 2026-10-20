import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { it } from 'node:test'
import { promisify } from 'node:util'
import { preparePost, signingIdentity, signPayload } from '../bin/devnull.js'

const run = promisify(execFile)
const hasTools = process.platform !== 'win32' && ['ssh-keygen', 'ssh-agent', 'ssh-add'].every((name) =>
  !spawnSync(name, ['-?'], { stdio: 'ignore' }).error)

it('uploads a photo to a localhost mock with a real, verifiable OpenSSH signature', { skip: !hasTools }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moggykit-protocol-test-'))
  const socket = join(directory, 'agent.sock')
  const key = join(directory, 'key')
  const env = { ...process.env, SSH_AUTH_SOCK: socket }
  const execute = (command, args, options = {}) => run(command, args, { ...options, env })
  let agent
  let server
  let draft
  try {
    await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
    agent = spawn('ssh-agent', ['-D', '-a', socket], { stdio: 'ignore' })
    let agentError
    agent.on('error', (error) => { agentError = error })
    for (let attempt = 0; ; attempt++) {
      if (agentError) throw agentError
      try { await access(socket); break } catch {
        if (attempt === 100) throw new Error('Test SSH agent did not start')
        await setTimeout(10)
      }
    }
    await execute('ssh-add', [key])
    const publicKey = await readFile(`${key}.pub`, 'utf8')
    const allowed = join(directory, 'allowed-signers')
    await writeFile(allowed, `fixture ${publicKey}`)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4u0AAAAASUVORK5CYII=', 'base64')
    let posts = 0
    let serverError
    server = createServer(async (request, response) => {
      try {
        if (request.method === 'GET') {
          response.writeHead(200, { 'content-type': 'image/png' })
          return response.end(png)
        }
        posts++
        const incoming = new Request('http://localhost/post', {
          method: 'POST', headers: request.headers, body: request, duplex: 'half',
        })
        const form = await incoming.formData()
        const payload = await form.get('payload').text()
        const photo = Buffer.from(await form.get('images[]').arrayBuffer())
        assert.deepEqual(photo, png)
        assert.equal(payload.split('\n')[3], createHash('sha256').update(photo).digest('hex'))
        assert.equal(payload.split('\n').slice(4).join('\n'), draft.body)
        const sig = request.headers['x-ssh-signature']
        assert.match(sig, /^[A-Za-z0-9+/=]+$/)
        const signatureFile = join(directory, 'received.sig')
        await writeFile(signatureFile, `-----BEGIN SSH SIGNATURE-----\n${sig.match(/.{1,70}/g).join('\n')}\n-----END SSH SIGNATURE-----\n`)
        await new Promise((resolve, reject) => {
          const child = execFile('ssh-keygen', ['-Y', 'verify', '-f', allowed, '-I', 'fixture',
            '-n', 'devnull-commit-images', '-s', signatureFile], { env, timeout: 5000 }, (error) => error ? reject(error) : resolve())
          child.stdin.end(payload)
        })
        response.writeHead(201, { 'content-type': 'text/plain' })
        response.end('Committed: https://dev-null.sh/@fixture/commits/123 (pending review)\n')
      } catch (error) {
        serverError = error
        response.writeHead(500)
        response.end('Mock validation failed')
      }
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const base = `http://127.0.0.1:${server.address().port}`
    draft = await preparePost({ name: 'Fixture', story: 'Public test story.',
      sponsor_url: 'https://associacaoambientaldaviadaestrela.org/en/cats/fixture', photo_url: 'https://moggy.dev/600/400/fixture' }, {
      key: `${key}.pub`,
      identity: (path, signal) => signingIdentity(path, signal, execute),
      sign: (payload, path, signal) => signPayload(payload, path, signal, execute),
      fetcher: (url, options) => {
        assert.ok(url === 'https://moggy.dev/600/400/fixture' || url === 'https://dev-null.sh/api/cli/commits')
        return fetch(`${base}${new URL(url).pathname}`, options)
      },
    })
    assert.equal(posts, 0, 'preparation must not submit')
    assert.match(await draft.publish(draft.body), /pending review/)
    if (serverError) throw serverError
    assert.equal(posts, 1)
    await assert.rejects(draft.publish(draft.body), /already been submitted/)
  } finally {
    draft?.dispose()
    server?.closeAllConnections()
    if (server?.listening) await new Promise((resolve) => server.close(resolve))
    if (agent && agent.exitCode === null) {
      const exited = new Promise((resolve) => agent.once('exit', resolve))
      agent.kill()
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  }
})
