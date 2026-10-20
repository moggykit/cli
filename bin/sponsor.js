/** Keep older API responses usable after the association's domain change. */
export function sponsorUrl(value) {
  if (typeof value !== 'string') return value
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) &&
      ['aave.pt', 'www.aave.pt'].includes(url.hostname) && !url.username && !url.password) {
      url.hostname = 'associacaoambientaldaviadaestrela.org'
      return url.href
    }
  } catch {
    // Leave invalid input for the existing terminal sanitisation and URL validation.
  }
  return value
}
