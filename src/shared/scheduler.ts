export interface ScheduledTask {
  id: number;
  label: string;
  due_at: Date;
}

interface Entry extends ScheduledTask {
  timer: NodeJS.Timeout;
  run: () => void;
}

/**
 * Runs the transitions that happen "later" on Pagar.me (e.g. a processing card that is confirmed by the
 * acquirer). Tasks fire after `delayMs`, or right away through `runPending()`.
 */
export class Scheduler {
  private readonly entries = new Map<number, Entry>();
  private nextId = 1;

  constructor(
    private readonly delayMs: number,
    private readonly onError: (error: unknown, label: string) => void = () => undefined,
  ) {}

  schedule(label: string, run: () => void, delayMs = this.delayMs): void {
    const id = this.nextId++;
    const timer = setTimeout(() => {
      this.execute(id);
    }, delayMs);
    this.entries.set(id, { id, label, due_at: new Date(Date.now() + delayMs), timer, run });
  }

  /** Tasks waiting to run, oldest first. */
  pending(): ScheduledTask[] {
    return [...this.entries.values()].map(({ id, label, due_at }) => ({ id, label, due_at }));
  }

  /** Runs every pending task now, including tasks scheduled by them. Returns how many ran. */
  runPending(): number {
    let ran = 0;
    while (this.entries.size > 0) {
      const [first] = this.entries.keys();
      if (first === undefined) break;
      this.execute(first);
      ran++;
    }
    return ran;
  }

  cancelAll(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }

  private execute(id: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    try {
      entry.run();
    } catch (error) {
      this.onError(error, entry.label);
    }
  }
}
