import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { preparePost, signingIdentity, signPayload } from '../bin/devnull.js'

// A real one-pixel PNG fixture. No production accounts, keys or posting endpoints are used.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4u0AAAAASUVORK5CYII=', 'base64')
const cat = {
  name: 'Test cat', story: 'A public test story.',
  sponsor_url: 'https://associacaoambientaldaviadaestrela.org/en/cats/test?utm_medium=api',
  photo_url: 'https://moggy.dev/600/400/test',
}
const identity = async () => ({ path: '/test/key.pub', fingerprint: '256 SHA256:test (ED25519)' })
const setup = (options = {}) => preparePost(cat, {
  identity, sign: async () => 'c2lnbmF0dXJl',
  fetcher: async (url) => {
    assert.equal(url, cat.photo_url, 'unexpected network request')
    return new Response(png, { headers: { 'content-type': 'image/png' } })
  }, ...options,
})

describe('/dev/null sharing', () => {
  it('prepares the exact API story and photo without posting or signing', async () => {
    const draft = await setup({ sign: () => assert.fail('preparing must not sign') })
    assert.equal(draft.body, `${cat.name}\n\n${cat.story}\n\nSponsor: ${cat.sponsor_url}`)
    assert.equal(draft.photoUrl, cat.photo_url)
    assert.match(draft.photo, /image\/png/)
    assert.match(draft.photo, /moggy\.dev\/600\/400\/test/)
    assert.match(draft.fingerprint, /SHA256:test/)
    draft.dispose()
    await assert.rejects(draft.publish(draft.body), /discarded/)
  })

  it('uses the new domain in drafts prepared from legacy API links', async () => {
    const draft = await preparePost({ ...cat,
      sponsor_url: 'https://aave.pt/en/cats/test?utm_source=moggykit&utm_medium=api' }, {
      identity, fetcher: async () => new Response(png),
    })
    assert.ok(draft.body.includes('https://associacaoambientaldaviadaestrela.org/en/cats/test?utm_source=moggykit&utm_medium=api'))
    assert.doesNotMatch(draft.body, /aave\.pt/)
    draft.dispose()
  })

  it('signs the official image payload and submits matching multipart bytes exactly once', async () => {
    let posts = 0
    let signed
    const draft = await setup({
      sign: async (payload, key) => { signed = payload; assert.equal(key, '/test/key.pub'); return 'c2ln' },
      fetcher: async (url, options = {}) => {
        if (url === cat.photo_url) return new Response(png)
        assert.equal(url, 'https://dev-null.sh/api/cli/commits')
        posts++
        assert.equal(options.method, 'POST')
        assert.equal(options.redirect, 'error')
        assert.equal(options.headers['X-SSH-Signature'], 'c2ln')
        assert.equal(await options.body.get('payload').text(), signed)
        const image = options.body.get('images[]')
        assert.equal(image.name, 'cat.png')
        assert.equal(image.type, 'image/png')
        assert.deepEqual(Buffer.from(await image.arrayBuffer()), png)
        const [timestamp, nonce, reply, hash, ...body] = signed.split('\n')
        assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 5)
        assert.match(nonce, /^[a-f0-9]{32}$/)
        assert.equal(reply, '')
        assert.equal(hash, createHash('sha256').update(png).digest('hex'))
        assert.equal(body.join('\n'), 'Edited post\nWith another line')
        return new Response('Committed: https://dev-null.sh/@tester/commits/123 (pending review, only you can see it until it is approved)\n', { status: 201 })
      },
    })
    const result = await draft.publish('Edited post\nWith another line')
    assert.match(result, /pending review/)
    await assert.rejects(draft.publish(draft.body), /already been submitted/)
    assert.equal(posts, 1)
    draft.dispose()
  })

  it('prevents concurrent submissions while the first signature is pending', async () => {
    let finishSign
    const draft = await setup({ sign: () => new Promise((resolve) => { finishSign = resolve }) })
    const controller = new AbortController()
    const sending = draft.publish('Post', controller.signal)
    await assert.rejects(draft.publish('Post'), /already been submitted/)
    controller.abort()
    finishSign('c2ln')
    await assert.rejects(sending)
    draft.dispose()
  })

  it('does not retry timeouts or ambiguous failures', async () => {
    let requests = 0
    const draft = await setup({ fetcher: async (_url, options = {}) => {
      if (!options.method) return new Response(png)
      requests++
      throw new Error('connection reset after upload')
    } })
    await assert.rejects(draft.publish('Post'), /status is unknown.*will not retry/)
    await assert.rejects(draft.publish('Post'), /already been submitted/)
    assert.equal(requests, 1)
    draft.dispose()
  })

  it('explains authentication, validation, rate limit and server failures safely', async () => {
    for (const status of [401, 422, 429, 500]) {
      const draft = await setup({ fetcher: async (_url, options = {}) => !options.method
        ? new Response(png) : new Response('Failure\u001b]52;c;secret\u0007', { status }) })
      await assert.rejects(draft.publish('Post'), (error) => {
        assert.match(error.message, new RegExp(`HTTP ${status}`))
        assert.doesNotMatch(error.message, /\u001b|secret/)
        return true
      })
      draft.dispose()
    }
  })

  it('rejects unexpected successful responses instead of assuming publication', async () => {
    const draft = await setup({ fetcher: async (_url, options = {}) => !options.method
      ? new Response(png) : new Response('Sign in', { status: 200 }) })
    await assert.rejects(draft.publish('Post'), /Check your \/dev\/null profile/)
    draft.dispose()
  })

  it('handles missing photos, unsafe URLs, unsupported files and oversized downloads', async () => {
    for (const changed of [{ photo_url: null }, { photo_url: 'file:///tmp/cat' }, { sponsor_url: 'javascript:alert(1)' }]) {
      await assert.rejects(preparePost({ ...cat, ...changed }, { identity, fetcher: () => assert.fail('must not fetch') }), /no (photo|valid)/)
    }
    for (const response of [
      new Response('<svg>not a photo</svg>'),
      new Response('', { status: 404 }),
      new Response(png, { headers: { 'content-length': '10240001' } }),
      new Response(new Uint8Array(10_240_001)),
    ]) {
      await assert.rejects(setup({ fetcher: async () => response }), /photo|JPEG|10 MB/)
    }
  })

  it('sanitises API text before it becomes a draft', async () => {
    const draft = await preparePost({ ...cat, story: 'Story\u001b[2J\u001b]52;c;secret\u0007' }, {
      identity, fetcher: async () => new Response(png),
    })
    assert.match(draft.body, /Story/)
    assert.doesNotMatch(draft.body, /\u001b|secret/)
    draft.dispose()
  })

  it('aborts photo preparation', async () => {
    const controller = new AbortController()
    const pending = setup({ signal: controller.signal, fetcher: async (_url, { signal }) => {
      controller.abort()
      signal.throwIfAborted()
    } })
    await assert.rejects(pending, /cancelled or timed out/)
  })
})

describe('local SSH signing', () => {
  it('checks only the configured public key and agent', async () => {
    const calls = []
    const result = await signingIdentity('/test/key.pub', undefined, async (command, args) => {
      calls.push([command, args])
      return { stdout: '256 SHA256:fixture (ED25519)\n' }
    })
    assert.equal(result.path, '/test/key.pub')
    assert.deepEqual(calls, [['ssh-keygen', ['-lf', '/test/key.pub']], ['ssh-add', ['-T', '/test/key.pub']]])
    await assert.rejects(signingIdentity('/test/private-key'), /public .pub/)
    await assert.rejects(signingIdentity('/test/key.pub', undefined, async () => { throw new Error('no agent') }), /ssh-add/)
  })

  it('uses the images namespace and deletes temporary payload/signature files on success and failure', async () => {
    for (const fail of [false, true]) {
      let directory
      const signing = signPayload('payload', '/test/key.pub', undefined, async (command, args, options) => {
        assert.equal(command, 'ssh-keygen')
        assert.deepEqual(args.slice(0, -1), ['-Y', 'sign', '-U', '-n', 'devnull-commit-images', '-f', '/test/key.pub'])
        assert.equal(options.shell, undefined)
        const file = args.at(-1)
        directory = dirname(file)
        assert.equal(await readFile(file, 'utf8'), 'payload')
        if (fail) throw new Error('agent refused')
        await writeFile(`${file}.sig`, '-----BEGIN SSH SIGNATURE-----\nc2ln\n-----END SSH SIGNATURE-----\n')
      })
      if (fail) await assert.rejects(signing, /Could not sign/)
      else assert.equal(await signing, 'c2ln')
      await assert.rejects(readdir(directory), { code: 'ENOENT' })
    }
  })
})
