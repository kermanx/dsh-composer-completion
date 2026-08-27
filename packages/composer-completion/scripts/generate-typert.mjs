import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const packageDir = resolve(root, 'packages/composer-completion')
const output = resolve(packageDir, 'lib')
const [artifact] = new WorkspaceTypertGenerator(root, { checkDiagnostics: false })
  .generate(['@kermanx/dsh-composer-completion'], ['host'])

if (artifact === undefined || artifact.remote === undefined) {
  throw new Error('composer-completion: Typert did not emit the Host Remote contribution')
}
await mkdir(output, { recursive: true })
await Promise.all([
  writeFile(resolve(output, 'typert.host.js'), artifact.js),
  writeFile(resolve(output, 'typert.host.d.ts'), artifact.dts),
  writeFile(resolve(output, 'typert.remote-client.js'), artifact.remote.js),
  writeFile(resolve(output, 'typert.remote-client.d.ts'), artifact.remote.dts),
  writeFile(resolve(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap),
])
