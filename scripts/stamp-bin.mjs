#!/usr/bin/env node
/**
 * Copy the locally built agent binary for the current platform into the
 * plugin package's bin/ directory before `pnpm pack`, so the tarball is
 * self-contained (plan.md deliverable 3 is the proper multi-platform
 * optionalDependencies split; this dev stamp is enough for local installs).
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pluginDir = join(repoRoot, 'packages', 'plugin')
const exe = process.platform === 'win32' ? 'opencode2dsh-agent.exe' : 'opencode2dsh-agent'
const source = join(repoRoot, 'packages', 'agent-bin-' + process.platform + '-' + process.arch, exe)
const outDir = join(pluginDir, 'bin')

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
copyFileSync(source, join(outDir, exe))
console.log('stamped ' + exe + ' -> packages/plugin/bin/')
