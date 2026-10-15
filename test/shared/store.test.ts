import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../../src/shared/store/repository.js';
import { Store } from '../../src/shared/store/store.js';

interface Thing {
  id: string;
  tags: string[];
}

describe('InMemoryRepository', () => {
  it('inserts, finds, updates and deletes', () => {
    const repo = new InMemoryRepository<Thing>();
    repo.insert({ id: 'a', tags: [] });
    repo.update({ id: 'a', tags: ['x'] });
    expect(repo.findById('a')).toEqual({ id: 'a', tags: ['x'] });
    expect(repo.delete('a')).toBe(true);
    expect(repo.findById('a')).toBeUndefined();
    expect(repo.delete('a')).toBe(false);
  });

  it('refuses duplicated inserts and updates of unknown entities', () => {
    const repo = new InMemoryRepository<Thing>();
    repo.insert({ id: 'a', tags: [] });
    expect(() => repo.insert({ id: 'a', tags: [] })).toThrow();
    expect(() => repo.update({ id: 'b', tags: [] })).toThrow();
  });

  it('never hands out references to the stored state', () => {
    const repo = new InMemoryRepository<Thing>();
    const original = { id: 'a', tags: ['x'] };
    repo.insert(original);
    original.tags.push('mutated');
    repo.findById('a')?.tags.push('mutated');
    repo.findAll()[0]?.tags.push('mutated');
    expect(repo.findById('a')).toEqual({ id: 'a', tags: ['x'] });
  });

  it('lists in insertion order with an optional filter', () => {
    const repo = new InMemoryRepository<Thing>();
    for (const id of ['c', 'a', 'b']) repo.insert({ id, tags: id === 'a' ? ['x'] : [] });
    expect(repo.findAll().map((t) => t.id)).toEqual(['c', 'a', 'b']);
    expect(repo.findAll((t) => t.tags.length === 0).map((t) => t.id)).toEqual(['c', 'b']);
  });
});

describe('Store', () => {
  it('returns the same repository for the same name and clears all of them on reset', () => {
    const store = new Store();
    store.repository<Thing>('things').insert({ id: 'a', tags: [] });
    store.repository<Thing>('others').insert({ id: 'b', tags: [] });
    expect(store.repository<Thing>('things').findById('a')).toBeDefined();
    store.reset();
    expect(store.repository<Thing>('things').findAll()).toEqual([]);
    expect(store.repository<Thing>('others').findAll()).toEqual([]);
  });
});
