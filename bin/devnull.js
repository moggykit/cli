import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { terminalText } from './terminal.js'
import { sponsorUrl } from './sponsor.js'

const run = promisify(execFile)
const ORIGIN = 'https://dev-null.sh'
const MAX_PHOTO_BYTES = 10_240_000

function webUrl(value, label) {
  let url
  try {
    url = new URL(value)
    if (typeof value !== 'string' || url.protocol !== 'https:' || url.username || url.password ||
      /[\s\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error()
  } catch {
    throw new Error(`This cat has no valid ${label} URL.`)
  }
  return url.href
}

async function photoFrom(url, fetcher, signal) {
  const response = await fetcher(url, { signal, redirect: 'error' })
  if (!response.ok) throw new Error(`Could not fetch the photo (HTTP ${response.status}).`)
  if (Number(response.headers.get('content-length')) > MAX_PHOTO_BYTES) {
    await response.body?.cancel()
    throw new Error('The photo is larger than /dev/null’s 10 MB limit.')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.length
    if (size > MAX_PHOTO_BYTES) throw new Error('The photo is larger than /dev/null’s 10 MB limit.')
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  let type
  let extension
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) [type, extension] = ['image/jpeg', 'jpg']
  else if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) [type, extension] = ['image/png', 'png']
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') [type, extension] = ['image/webp', 'webp']
  else throw new Error('The photo must be a JPEG, PNG or WebP image.')
  return { bytes, type, extension }
}

export async function signingIdentity(key, signal, execute = run) {
  const path = resolve(key)
  if (!path.endsWith('.pub')) throw new Error('MOGGYKIT_DEVNULL_KEY must name a public .pub key loaded in your SSH agent.')
  try {
    const { stdout } = await execute('ssh-keygen', ['-lf', path], { signal, timeout: 10_000 })
    await execute('ssh-add', ['-T', path], { signal, timeout: 10_000 })
    return { path, fingerprint: terminalText(stdout.trim()) }
  } catch {
    throw new Error('Load your GitHub SSH key with ssh-add, and set MOGGYKIT_DEVNULL_KEY to its .pub file. Sign in to /dev/null with that GitHub account first.')
  }
}

/** OpenSSH uses the agent; MoggyKit never reads a private key or prompts for its passphrase. */
export async function signPayload(payload, key, signal, execute = run) {
  const directory = await mkdtemp(join(tmpdir(), 'moggykit-sign-'))
  const file = join(directory, 'post')
  try {
    await writeFile(file, payload, { mode: 0o600 })
    await execute('ssh-keygen', ['-Y', 'sign', '-U', '-n', 'devnull-commit-images', '-f', key, file],
      { signal, timeout: 15_000 })
    const signature = (await readFile(`${file}.sig`, 'utf8'))
      .replace(/-----BEGIN SSH SIGNATURE-----|-----END SSH SIGNATURE-----|\s/g, '')
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw new Error()
    return signature
  } catch {
    throw new Error('Could not sign the post. Check that your SSH key is loaded in the agent.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Preparation only downloads the public photo and checks the local signing key. */
export async function preparePost(cat, {
  signal,
  key = process.env.MOGGYKIT_DEVNULL_KEY ?? join(homedir(), '.ssh', 'id_ed25519.pub'),
  fetcher = fetch,
  identity = signingIdentity,
  sign = signPayload,
} = {}) {
  const sponsor = webUrl(sponsorUrl(cat.sponsor_url), 'sponsorship')
  if (!cat.photo_url) throw new Error('This cat has no photo to attach. Choose another cat.')
  const photoUrl = webUrl(cat.photo_url, 'photo')
  const signing = await identity(key, signal)
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(abort, 15_000)
  let photo
  try {
    photo = await photoFrom(photoUrl, fetcher, controller.signal)
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Photo download cancelled or timed out. Nothing was posted.')
    throw new Error(`Could not download the cat’s photo: ${terminalText(error.message)}`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }

  let attempted = false
  const body = [terminalText(cat.name), terminalText(cat.story), `Sponsor: ${sponsor}`]
    .filter(Boolean).join('\n\n')

  return {
    body,
    photoUrl,
    photo: `${photo.type} · ${photo.bytes.length} bytes · ${photoUrl}`,
    fingerprint: signing.fingerprint,
    key: signing.path,
    dispose() { photo = null },
    async publish(text, publishSignal) {
      if (attempted || !photo) throw new Error('This draft has already been submitted or discarded. No post was sent.')
      if (!text.trim()) throw new Error('Write some text before posting.')
      attempted = true
      const hash = createHash('sha256').update(photo.bytes).digest('hex')
      // Mirrors /dev/null's terminal protocol: timestamp, nonce, empty reply, image hash, body.
      const payload = `${Math.floor(Date.now() / 1000)}\n${randomBytes(16).toString('hex')}\n\n${hash}\n${text}`
      const signature = await sign(payload, signing.path, publishSignal)
      publishSignal?.throwIfAborted()
      const form = new FormData()
      form.append('payload', new Blob([payload], { type: 'text/plain' }), 'post')
      form.append('images[]', new Blob([photo.bytes], { type: photo.type }), `cat.${photo.extension}`)
      const timeout = new AbortController()
      const cancel = () => timeout.abort()
      publishSignal?.addEventListener('abort', cancel, { once: true })
      const postTimer = setTimeout(cancel, 60_000)
      try {
        const response = await fetcher(`${ORIGIN}/api/cli/commits`, {
          method: 'POST', body: form, headers: { 'X-SSH-Signature': signature },
          signal: timeout.signal, redirect: 'error',
        })
        const answer = terminalText((await response.text()).slice(0, 4000)).trim()
        if (!response.ok) {
          const hint = response.status === 401 ? 'Check your GitHub SSH key and /dev/null account.'
            : response.status === 422 ? 'Check the post text and photo requirements.'
            : response.status === 429 ? 'Rate limited; check your profile before trying again later.' : 'Check your /dev/null profile before trying again.'
          throw new Error(`/dev/null returned HTTP ${response.status}. ${hint}${answer ? `\n${answer}` : ''}`)
        }
        if (response.status !== 201 || !/^Committed: https:\/\/dev-null\.sh\/@[^\s/]+\/commits\/[^\s/]+(?:\s|$)/.test(answer)) {
          throw new Error('Unexpected response. Check your /dev/null profile before trying again.')
        }
        return answer
      } catch (error) {
        if (error.message.startsWith('/dev/null returned') || error.message.startsWith('Unexpected response')) throw error
        throw new Error('The post’s status is unknown. Check your /dev/null profile before trying again; MoggyKit will not retry it.')
      } finally {
        clearTimeout(postTimer)
        publishSignal?.removeEventListener('abort', cancel)
      }
    },
  }
}
