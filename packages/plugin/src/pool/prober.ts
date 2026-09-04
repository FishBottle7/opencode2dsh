/**
 * Prober — the two-level probe scheduler (docs/ip-pool.md section 4.1).
 *
 * Hard constraints (2026-09-04 decision; do not "optimize" them away):
 *  1. Serial per exit: at most one in-flight probe per exit (per-exit probe
 *     lock in ExitPool) — one exit IP is one shared quota bucket; concurrent
 *     probes against it are self-inflicted 429s.
 *  2. Bounded concurrency across exits: `maxConcurrentProbes` workers (default
 *     3) protect the upstream total request rate, the probed public proxies
 *     and local bandwidth.
 *  3. Same-exit models run back-to-back (no lock re-acquisition churn);
 *     different exits interleave.
 *
 * The scheduler is generic over the actual probe task: admission probes,
 * periodic health probes and settings-page "probe this exit" clicks all
 * enqueue through the same queue. Tasks are async functions returning a
 * verdict already applied to the pool by the caller.
 */

import type { ExitPool } from './pool.ts'

export interface ProbeTask {
  /** Exit the task probes (drives serialization + the lock). */
  exitId: string
  /** Optional label for diagnostics. */
  kind: string
  run: () => Promise<void>
}

export interface ProberOptions {
  pool: ExitPool
  /** Global in-flight cap across exits (docs/ip-pool.md 4.6). */
  maxConcurrentProbes?: number
}

interface QueueSlot {
  task: ProbeTask
  resolve: () => void
}

export class Prober {
  readonly #pool: ExitPool
  #maxConcurrent: number
  #queue: QueueSlot[] = []
  #inFlight = 0
  #drained: (() => void) | null = null
  /** Queue snapshot counter for the settings-page progress (x/y). */
  #enqueued = 0
  #completed = 0

  constructor(options: ProberOptions) {
    this.#pool = options.pool
    this.#maxConcurrent = Math.max(1, options.maxConcurrentProbes ?? 3)
  }

  get stats(): { queued: number; inFlight: number; enqueued: number; completed: number } {
    return {
      queued: this.#queue.length,
      inFlight: this.#inFlight,
      enqueued: this.#enqueued,
      completed: this.#completed,
    }
  }

  setMaxConcurrent(value: number): void {
    this.#maxConcurrent = Math.max(1, value)
    this.#pump()
  }

  /** Enqueue one task; resolves when the task has fully run. */
  enqueue(task: ProbeTask): Promise<void> {
    this.#enqueued += 1
    return new Promise<void>((resolve) => {
      this.#queue.push({ task, resolve })
      this.#pump()
    })
  }

  /** Enqueue a batch; same-exit tasks are kept adjacent for back-to-back
   *  execution (constraint 3). Resolves when every task has run. */
  enqueueAll(tasks: ProbeTask[]): Promise<void> {
    return Promise.all(tasks.map((task) => this.enqueue(task))).then(() => undefined)
  }

  /** True when no task is queued or running. */
  get idle(): boolean {
    return this.#queue.length === 0 && this.#inFlight === 0
  }

  /** Resolves once the queue fully drains (test/UI hook). */
  async drained(): Promise<void> {
    while (!this.idle) {
      await new Promise<void>((resolve) => {
        this.#drained = resolve
      })
    }
  }

  /** A worker slot finished; release and pump. */
  #finishSlot(): void {
    this.#inFlight -= 1
    this.#completed += 1
    this.#pump()
  }

  #pump(): void {
    while (this.#inFlight < this.#maxConcurrent) {
      // Skip exits whose lock is held (a task of the same exit is running):
      // their tasks stay queued in order; other exits' tasks proceed.
      const index = this.#queue.findIndex(
        (slot) => !this.#isExitBusy(slot.task.exitId),
      )
      if (index < 0) break
      const [slot] = this.#queue.splice(index, 1)
      if (!slot) break
      this.#inFlight += 1
      void this.#runSlot(slot)
    }
    if (this.idle) {
      const waiter = this.#drained
      this.#drained = null
      waiter?.()
    }
  }

  #isExitBusy(exitId: string): boolean {
    // The pool's per-exit lock is the single source of truth for "a probe of
    // this exit is in flight": the running slot holds it until settled.
    const node = this.#pool.get(exitId)
    return node !== undefined && !this.#pool.takeProbeLock(exitId)
  }

  async #runSlot(slot: QueueSlot): Promise<void> {
    // The lock was acquired in #isExitBusy (via takeProbeLock) when this exit
    // was picked as runnable. Run, always release, then settle the waiter.
    try {
      await slot.task.run()
    } catch {
      // Task failures are the caller's diagnostics (they own the pool marks);
      // the scheduler itself must never break.
    } finally {
      this.#pool.releaseProbeLock(slot.task.exitId)
      slot.resolve()
      this.#finishSlot()
    }
  }
}
