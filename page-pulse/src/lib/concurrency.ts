import { OverCapacityError, RateLimitedError } from './errors';

interface GuardOptions {
  globalMax: number;
  perClientMax: number;
  queueMaxDepth: number;
  queueTimeoutMs: number;
}

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
}

export class ConcurrencyGuard {
  private inflightGlobal = 0;
  private readonly perClient = new Map<string, number>();
  private readonly waiters: Waiter[] = [];

  constructor(private readonly opts: GuardOptions) {}

  async acquire(clientId: string): Promise<() => void> {
    const clientCount = this.perClient.get(clientId) ?? 0;
    if (clientCount >= this.opts.perClientMax) {
      throw new RateLimitedError(1, { reason: 'per-client concurrency limit exceeded' });
    }
    this.perClient.set(clientId, clientCount + 1);

    try {
      await this.acquireGlobalSlot();
    } catch (err) {
      this.decrementClient(clientId);
      throw err;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.decrementClient(clientId);
      this.releaseGlobalSlot();
    };
  }

  get inflight(): number {
    return this.inflightGlobal;
  }

  get queued(): number {
    return this.waiters.length;
  }

  private acquireGlobalSlot(): Promise<void> {
    if (this.inflightGlobal < this.opts.globalMax) {
      this.inflightGlobal += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.opts.queueMaxDepth) {
      return Promise.reject(new OverCapacityError());
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new OverCapacityError());
      }, this.opts.queueTimeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private releaseGlobalSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    this.inflightGlobal = Math.max(0, this.inflightGlobal - 1);
  }

  private decrementClient(clientId: string): void {
    const count = (this.perClient.get(clientId) ?? 1) - 1;
    if (count <= 0) this.perClient.delete(clientId);
    else this.perClient.set(clientId, count);
  }
}
