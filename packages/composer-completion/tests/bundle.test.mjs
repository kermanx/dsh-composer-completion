import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

test('the published browser entry loads with the shared React modules', async () => {
  const require = createRequire(import.meta.url)
  const allowed = new Set(['react', 'react-dom', 'react/jsx-runtime'])
  let entry
  const window = { __ModuleLoader__: { load: value => { entry = value } } }
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  runInNewContext(bundle, { window }, { timeout: 1000 })
  assert.equal(entry.id, '@kermanx/dsh-composer-completion')
  const client = entry.factory(specifier => {
    assert.ok(allowed.has(specifier), `Unexpected browser dependency: ${specifier}`)
    return require(specifier)
  })
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(Array.from(client.inject), ['remote'])
})
