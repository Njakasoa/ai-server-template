export class SemaphoreFullError extends Error {
  constructor() {
    super("semaphore queue is full");
    this.name = "SemaphoreFullError";
  }
}

export class Semaphore {
  private active = 0;
  private waiters: Array<(release: () => void) => void> = [];

  constructor(private readonly max: number, private readonly maxQueued: number) {
    if (max < 1) throw new Error("Semaphore max must be >= 1");
  }

  acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(new SemaphoreFullError());
    }
    return new Promise((resolve) => {
      this.waiters.push((release) => resolve(release));
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(this.makeRelease());
      } else {
        this.active--;
      }
    };
  }

  stats() {
    return { active: this.active, waiting: this.waiters.length, max: this.max };
  }
}
