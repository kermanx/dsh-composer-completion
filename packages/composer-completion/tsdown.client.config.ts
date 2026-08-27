import { defineConfig } from 'tsdown'

const id = '@kermanx/dsh-composer-completion'
const externals = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-gateway/client',
  'react',
  'react-dom',
  'react/jsx-runtime',
])

export default defineConfig({
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: specifier => externals.has(specifier),
    alwaysBundle: specifier => !externals.has(specifier),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
