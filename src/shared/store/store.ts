import { InMemoryRepository, type Entity, type Repository } from './repository.js';

/** Registry of the repositories of every module; `reset()` wipes all simulator data. */
export class Store {
  private readonly repositories = new Map<string, Repository<Entity>>();

  repository<T extends Entity>(name: string): Repository<T> {
    let repository = this.repositories.get(name);
    if (!repository) {
      repository = new InMemoryRepository<Entity>();
      this.repositories.set(name, repository);
    }
    return repository as unknown as Repository<T>;
  }

  reset(): void {
    for (const repository of this.repositories.values()) repository.clear();
  }
}
