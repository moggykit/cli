import { execFile } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'

/** API text is content, never terminal instructions. Keep only ordinary whitespace. */
export function terminalText(value) {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/\r/g, '')
}

/** Pass a validated web URL as an argument, never through a shell. */
export function openSponsor(value, platform = process.platform, execute = execFile) {
  let url
  try {
    if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error()
    url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error()
  } catch {
    return Promise.reject(new Error('This cat has no valid sponsorship URL.'))
  }

  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer.exe' : 'xdg-open'
  return new Promise((resolve, reject) => {
    execute(command, [url.href], { timeout: 5000, windowsHide: true }, (error) => {
      if (error) reject(new Error('Could not open your browser. Use the sponsorship URL shown above.'))
      else resolve()
    })
  })
}
