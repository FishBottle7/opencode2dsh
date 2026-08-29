#!/usr/bin/env node
/**
 * Release prep for the published package: sync the current docs into the
 * plugin package so the npm page and the plugin market always ship the
 * latest README/LICENSE.
 *
 * The published package does NOT bundle the Go agent (legacy/): adapter mode
 * is the marketplace shape. To use sidecar mode, build the agent yourself
 * (legacy/agent, `go build ./cmd/agent`) and point `agentPath` at it.
 */
import { copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginDir = join(repoRoot, 'packages', 'plugin')

for (const doc of ['README.md', 'README.zh-CN.md', 'LICENSE']) {
  copyFileSync(join(repoRoot, doc), join(pluginDir, doc))
  console.log('synced ' + doc + ' -> packages/plugin/')
}
