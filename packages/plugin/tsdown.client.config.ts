/**
 * Standalone tsdown config for the opencode2dsh client bundle (docs/ip-pool.md
 * §5.4) — mirrors dsh-llm-proxy's validated chain, adapted to the rc.2
 * platform seeds verified on this host (web-frontend static table):
 * react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis,
 * @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives,
 * plus the @deepseek-ai/dsh-client-runtime/client preload graph row.
 *
 * Emits a closure-factory artifact into lib/client.js that calls
 * window.__ModuleLoader__.load({ id, factory }) and resolves its externals
 * through the injected require (the shell's module table). CSS Modules are
 * compiled by lightningcss inside the bundle (virtual module). The node half
 * keeps its own tsdown build (package.json "build"), so this config only
 * builds the browser half.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath, sep } from 'node:path'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

const ID = '@opencode2dsh/dsh-plugin'

/**
 * Browser platform modules the shell seeds into the frozen module table
 * (rc.2 host, verified in the web-frontend dist kernel table). Every
 * specifier here is an external answered by the loader at runtime.
 */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

/** Preload graph row (client-runtime is preloaded, not a static seed). */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** Externals resolved from the loader module table. */
export const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

const config: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  // Browser bundle lands next to the node half (single lib/ artifact dir);
  // the entryFileNames pin keeps it exactly lib/client.js.
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  // Anything NOT in the loader module table must inline instead.
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [{
    // Bundle purity gate: platform seed entries stay external, everything
    // else under @deepseek-ai is a build error (cross-plugin value imports
    // are forbidden — collaborate through cordis services; type-only imports
    // are erased).
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) — ` +
        'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased)',
      )
    },
  }, {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(`${ID}/${basename(fileId)}`)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}

export default config
