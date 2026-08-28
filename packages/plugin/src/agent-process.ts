import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'

/**
 * Drives the agent child process (design.md section 8.1-8.2):
 * spawn with piped stdio, READY-line handshake for the random port,
 * exponential-backoff restart on unexpected exit (1s -> 60s, circuit breaker
 * after N consecutive crashes), and graceful stop (SIGTERM -> 5s -> SIGKILL;
 * Windows uses taskkill /T because signals are not deliverable there).
 */

export interface ReadyInfo {
  port: number
  version: string
}

export type AgentState = 'starting' | 'ready' | 'stopped' | 'tripped'

export interface AgentProcessEvents {
  ready: (info: ReadyInfo) => void
  state: (state: AgentState) => void
  log: (line: string) => void
  'exit-restart': (delayMs: number, crashes: number) => void
  'circuit-tripped': (crashes: number) => void
}

const GRACEFUL_STOP_TIMEOUT_MS = 5000

/**
 * Uptime after which a run counts as "stable": the consecutive-crash counter
 * resets. Prevents an infinite fast-crash loop from never tripping the breaker
 * just because each spawn briefly reaches READY.
 */
const STABLE_UPTIME_MS = 30_000

export class AgentProcess extends EventEmitter {
  private child: ChildProcess | null = null
  private state: AgentState = 'stopped'
  private consecutiveCrashes = 0
  private restartTimer: NodeJS.Timeout | null = null
  private stopping = false
  private disposed = false
  private backoffMs: number
  private readySinceMs = 0
  #ready: ReadyInfo | null = null
  private readonly agentPath: string
  private readonly args: string[]
  private readonly options: {
    restartDelayMs: number
    restartMaxDelayMs: number
    maxConsecutiveCrashes: number
    onLog?: (line: string) => void
  }

  constructor(
    agentPath: string,
    args: string[],
    options: {
      restartDelayMs: number
      restartMaxDelayMs: number
      maxConsecutiveCrashes: number
      onLog?: (line: string) => void
    },
  ) {
    super()
    this.agentPath = agentPath
    this.args = args
    this.options = options
    this.backoffMs = options.restartDelayMs
  }

  getState(): AgentState {
    return this.state
  }

  get readyInfo(): ReadyInfo | null {
    return this.#ready
  }

  /** Spawn the agent and resolve with the READY handshake result. */
  async start(readyTimeoutMs = 10000): Promise<ReadyInfo> {
    if (this.state === 'ready' && this.#ready) return this.#ready
    if (this.state === 'starting') throw new Error('agent start already in progress')
    if (this.state === 'tripped') throw new Error('agent circuit breaker tripped; restart the plugin')

    this.stopping = false
    this.setState('starting')
    const child = spawn(this.agentPath, this.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    // Attach stderr from the start: startup failures must surface their logs.
    this.pipeLogs(child)

    const spawnError = new Promise<never>((_, reject) => {
      child.once('error', reject)
    })

    const stdoutReady = this.readReadyLine(child)
    // If the process dies before the handshake, fail with its exit code.
    const earlyExit = new Promise<never>((_, reject) => {
      child.once('exit', (code) => reject(new Error(`agent exited before READY (code ${code})`)))
    })

    try {
      this.#ready = await Promise.race([
        stdoutReady,
        spawnError,
        earlyExit,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`agent READY handshake timed out after ${readyTimeoutMs}ms`)), readyTimeoutMs),
        ),
      ])
    } catch (err) {
      this.detach(child)
      await this.killTree(child).catch(() => {})
      this.setState('stopped')
      throw err
    }

    this.setState('ready')
    this.readySinceMs = Date.now()
    child.once('exit', (code) => this.onExit(child, code))
    return this.#ready
  }

  /** Read stdout until the READY line (design.md section 8.2). */
  private readReadyLine(child: ChildProcess): Promise<ReadyInfo> {
    return new Promise((resolve, reject) => {
      const stdout = child.stdout
      if (!stdout) return reject(new Error('agent stdout is not piped'))
      const rl = createInterface({ input: stdout })
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
        rl.close()
      }
      rl.on('line', (line) => {
        this.options.onLog?.(line)
        const match = /^READY (\{.*\})\s*$/.exec(line)
        if (!match?.[1]) return
        try {
          const info = JSON.parse(match[1]) as ReadyInfo
          if (!Number.isInteger(info.port) || info.port <= 0) throw new Error(`invalid READY payload: ${line}`)
          settle(() => resolve(info))
        } catch (err) {
          settle(() => reject(err instanceof Error ? err : new Error(String(err))))
        }
      })
      rl.on('close', () => {
        if (settled) return
        settled = true
        reject(new Error('agent stdout closed before READY'))
      })
    })
  }

  private pipeLogs(child: ChildProcess): void {
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.length > 0) this.options.onLog?.(line)
      }
    })
  }

  private onExit(child: ChildProcess, code: number | null): void {
    if (child !== this.child || this.disposed) return
    this.#ready = null
    if (this.stopping) {
      this.setState('stopped')
      return
    }
    // Unexpected exit: restart with exponential backoff, trip after N crashes.
    // "Consecutive" only counts crashes without a stable run in between: once
    // the agent stayed ready longer than STABLE_UPTIME_MS, the crash counter
    // and the backoff schedule both reset.
    if (this.readySinceMs !== 0 && Date.now() - this.readySinceMs >= STABLE_UPTIME_MS) {
      this.consecutiveCrashes = 0
      this.backoffMs = this.options.restartDelayMs
    }
    this.readySinceMs = 0
    this.consecutiveCrashes += 1
    if (this.consecutiveCrashes >= this.options.maxConsecutiveCrashes) {
      this.setState('tripped')
      this.emit('circuit-tripped', this.consecutiveCrashes)
      return
    }
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.restartMaxDelayMs)
    this.emit('exit-restart', delay, this.consecutiveCrashes)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start().catch(() => {
        // start() failure already set state; schedule the next backoff via exit path
      })
    }, delay)
  }

  private detach(child: ChildProcess): void {
    child.removeAllListeners('exit')
    child.stderr?.removeAllListeners('data')
    if (this.child === child) this.child = null
  }

  /** Graceful stop: terminate, wait, then force-kill the whole tree. */
  async stop(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.setState('stopped')
      return
    }
    await this.terminate(child)
    this.setState('stopped')
  }

  /** Idempotent teardown: no more restarts after dispose. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }

  private async terminate(child: ChildProcess): Promise<void> {
    if (process.platform === 'win32') {
      // Windows has no deliverable SIGTERM for other processes; taskkill /T
      // terminates the tree (graceful attempt without /F first).
      await this.taskkill(child, false).catch(() => {})
    } else {
      child.kill('SIGTERM')
    }
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), GRACEFUL_STOP_TIMEOUT_MS))
    const result = await Promise.race([exited.then(() => 'exit' as const), timeout])
    if (result === 'timeout') {
      if (process.platform === 'win32') {
        await this.taskkill(child, true).catch(() => child.kill())
      } else {
        child.kill('SIGKILL')
      }
      await exited
    }
  }

  private async killTree(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return
    if (process.platform === 'win32') {
      await this.taskkill(child, true).catch(() => child.kill())
    } else {
      child.kill('SIGKILL')
    }
  }

  private taskkill(child: ChildProcess, force: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!child.pid) return resolve()
      const args = force ? ['/T', '/F', '/PID', String(child.pid)] : ['/T', '/PID', String(child.pid)]
      const killer = spawn('taskkill', args, { stdio: 'ignore' })
      killer.once('error', reject)
      killer.once('exit', () => resolve())
    })
  }

  private setState(state: AgentState): void {
    this.state = state
    this.emit('state', state)
  }
}
