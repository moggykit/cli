import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { it } from 'node:test'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const entry = new URL('../bin/moggykit.js', import.meta.url).href
const oldUrl = 'https://aave.pt/en/cats/test?utm_source=moggykit&utm_medium=api&utm_campaign=sponsor'
const newUrl = 'https://associacaoambientaldaviadaestrela.org/en/cats/test?utm_source=moggykit&utm_medium=api&utm_campaign=sponsor'

it('converts API links in real CLI text and JSON output without network requests', async () => {
  for (const json of [false, true]) {
    const fixture = { name: 'Test', story: 'Test story', sponsor_url: oldUrl }
    const args = ['node', 'moggykit', 'test', ...(json ? ['--json'] : [])]
    const source = `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify({ data: fixture }))});
      process.argv = ${JSON.stringify(args)}; await import(${JSON.stringify(entry)});`
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, NO_COLOR: '1' },
    })
    if (json) assert.equal(JSON.parse(stdout).sponsor_url, newUrl)
    else assert.ok(stdout.includes(newUrl))
  }
})
