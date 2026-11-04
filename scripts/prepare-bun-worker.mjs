import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = new URL('../packages/plugin/', import.meta.url)
await mkdir(new URL('lib/', root), { recursive: true })
await copyFile(fileURLToPath(new URL('src/adapter/bun-worker.mjs', root)), fileURLToPath(new URL('lib/bun-worker.mjs', root)))
