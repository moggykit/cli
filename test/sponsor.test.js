import assert from 'node:assert/strict'
import { it } from 'node:test'
import { sponsorUrl } from '../bin/sponsor.js'

it('converts the legacy domain while preserving the cat path, query and fragment', () => {
  const suffix = '/en/cats/mrs-maisel-2026-07?utm_source=moggykit&utm_medium=api&utm_campaign=sponsor#sponsor'
  assert.equal(sponsorUrl(`https://aave.pt${suffix}`), `https://associacaoambientaldaviadaestrela.org${suffix}`)
  assert.equal(sponsorUrl(`https://www.aave.pt${suffix}`), `https://associacaoambientaldaviadaestrela.org${suffix}`)
})

it('leaves current links and unrelated or invalid URLs unchanged', () => {
  for (const value of ['https://associacaoambientaldaviadaestrela.org/en/cats/lia',
    'https://moggy.dev/600/400/lia', 'https://aave.pt.evil.invalid/cat',
    'https://user:password@aave.pt/cat', 'javascript:alert(1)', 'invalid', null]) {
    assert.equal(sponsorUrl(value), value)
  }
})
