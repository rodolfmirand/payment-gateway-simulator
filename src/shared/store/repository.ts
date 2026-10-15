export interface Entity {
  id: string;
}

/**
 * Storage port used by the modules. Synchronous on purpose: both the in-memory implementation
 * and a future SQLite one (node:sqlite / better-sqlite3) are synchronous.
 */
export interface Repository<T extends Entity> {
  insert(entity: T): T;
  findById(id: string): T | undefined;
  /** Replaces an existing entity; throws if it does not exist. */
  update(entity: T): T;
  delete(id: string): boolean;
  /** All entities matching the predicate, in insertion order. */
  findAll(predicate?: (entity: T) => boolean): T[];
  clear(): void;
}

/** Stores copies so callers can never mutate persisted state by accident, like a real database. */
export class InMemoryRepository<T extends Entity> implements Repository<T> {
  private readonly items = new Map<string, T>();

  insert(entity: T): T {
    if (this.items.has(entity.id)) throw new Error(`Entity ${entity.id} already exists`);
    this.items.set(entity.id, structuredClone(entity));
    return structuredClone(entity);
  }

  findById(id: string): T | undefined {
    const entity = this.items.get(id);
    return entity && structuredClone(entity);
  }

  update(entity: T): T {
    if (!this.items.has(entity.id)) throw new Error(`Entity ${entity.id} does not exist`);
    this.items.set(entity.id, structuredClone(entity));
    return structuredClone(entity);
  }

  delete(id: string): boolean {
    return this.items.delete(id);
  }

  findAll(predicate?: (entity: T) => boolean): T[] {
    const all = [...this.items.values()];
    return structuredClone(predicate ? all.filter(predicate) : all);
  }

  clear(): void {
    this.items.clear();
  }
}
