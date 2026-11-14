export type SaveTask = () => Promise<void>;

/**
 * Serialized, per-record debounced persistence queue:
 * - schedule(): coalesces rapid edits per key and executes them strictly in FIFO order.
 * - now(): cancels any pending debounced write for that key and runs immediately in the chain (safe for deletes).
 * - flushAll(): drains all pending writes and resolves when the serialized chain settles.
 */
export class SaveQueue {
  private pending = new Map<
    string,
    { task: SaveTask; timer: ReturnType<typeof setTimeout>; firstAt: number }
  >();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly delayMs = 400,
    private readonly onError: (err: unknown) => void = () => {},
    /** Upper bound on how long continuous edits/token streaming can postpone a write. */
    private readonly maxWaitMs = 1500
  ) {}

  pendingCount(): number {
    return this.pending.size;
  }

  schedule(key: string, task: SaveTask, delayMs = this.delayMs): void {
    const prev = this.pending.get(key);
    if (prev) clearTimeout(prev.timer);
    const firstAt = prev?.firstAt ?? Date.now();
    // Pure debounce starves under continuous updates (e.g. a long streamed reply): cap the wait.
    const wait = Math.max(0, Math.min(delayMs, firstAt + this.maxWaitMs - Date.now()));
    const timer = setTimeout(() => {
      void this.run(key);
    }, wait);
    this.pending.set(key, { task, timer, firstAt });
  }

  now(key: string, task: SaveTask): Promise<void> {
    this.cancel(key);
    return this.enqueue(task);
  }

  cancel(key: string): void {
    const prev = this.pending.get(key);
    if (prev) {
      clearTimeout(prev.timer);
      this.pending.delete(key);
    }
  }

  async flush(key: string): Promise<void> {
    await this.run(key);
  }

  flushAll(): Promise<void> {
    for (const key of [...this.pending.keys()]) {
      void this.run(key);
    }
    return this.chain;
  }

  private run(key: string): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) return this.chain;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    return this.enqueue(entry.task);
  }

  private enqueue(task: SaveTask): Promise<void> {
    this.chain = this.chain.then(task).catch((err) => {
      this.onError(err);
    });
    return this.chain;
  }
}

export function createSaveQueue(
  defaultDelayMs = 400,
  onError?: (err: unknown) => void,
  maxWaitMs = 1500
): SaveQueue {
  return new SaveQueue(defaultDelayMs, onError, maxWaitMs);
}
