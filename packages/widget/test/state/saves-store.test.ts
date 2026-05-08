// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SavesStore, type SavedResultV1 } from '../../src/state/saves-store.js';

const KEY = 'geochatbot:saves:v1';

beforeEach(() => {
  localStorage.clear();
});

function sample(overrides: Partial<SavedResultV1> = {}): Omit<SavedResultV1, 'id' | 'version' | 'createdAt'> {
  return {
    title: overrides.title ?? 'Untitled',
    origin: overrides.origin ?? { planId: 'p1', stepId: 's1', question: 'q' },
    kind: overrides.kind ?? 'chart',
    payload: overrides.payload ?? { ok: true },
  };
}

describe('SavesStore', () => {
  it('list() returns [] when localStorage has nothing', () => {
    const store = new SavesStore();
    expect(store.list()).toEqual([]);
  });

  it('add() persists, returns the saved entry, and emits change', () => {
    const store = new SavesStore();
    const onChange = vi.fn();
    store.addEventListener('change', onChange);

    const saved = store.add(sample({ title: 'A' }));
    expect(saved.id).toBeTruthy();
    expect(saved.version).toBe(1);
    expect(saved.title).toBe('A');
    expect(saved.createdAt).toBeGreaterThan(0);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(1);
  });

  it('list() reads back what add() wrote', () => {
    const store = new SavesStore();
    const a = store.add(sample({ title: 'A' }));
    const b = store.add(sample({ title: 'B' }));
    const items = store.list();
    expect(items.map((x) => x.title)).toEqual(['A', 'B']);
    expect(items.map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it('rename() updates title and emits change', () => {
    const store = new SavesStore();
    const a = store.add(sample({ title: 'A' }));
    const onChange = vi.fn();
    store.addEventListener('change', onChange);
    store.rename(a.id, 'A renamed');
    expect(store.get(a.id)?.title).toBe('A renamed');
    expect(onChange).toHaveBeenCalled();
  });

  it('remove() drops the entry and emits change', () => {
    const store = new SavesStore();
    const a = store.add(sample({ title: 'A' }));
    const onChange = vi.fn();
    store.addEventListener('change', onChange);
    store.remove(a.id);
    expect(store.list()).toEqual([]);
    expect(onChange).toHaveBeenCalled();
  });

  it('clear() empties the list and emits change', () => {
    const store = new SavesStore();
    store.add(sample({ title: 'A' }));
    store.add(sample({ title: 'B' }));
    const onChange = vi.fn();
    store.addEventListener('change', onChange);
    store.clear();
    expect(store.list()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('drops entries with version !== 1 on read', () => {
    localStorage.setItem(KEY, JSON.stringify([
      { id: '1', version: 1, createdAt: 1, title: 'keep', origin: { planId: 'p', stepId: 's', question: 'q' }, kind: 'chart', payload: {} },
      { id: '2', version: 2, createdAt: 2, title: 'drop', origin: { planId: 'p', stepId: 's', question: 'q' }, kind: 'chart', payload: {} },
    ]));
    const store = new SavesStore();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.title).toBe('keep');
  });

  it('caps at 200 entries (FIFO eviction)', () => {
    const store = new SavesStore();
    for (let i = 0; i < 205; i++) store.add(sample({ title: `t${i}` }));
    const items = store.list();
    expect(items.length).toBe(200);
    // Oldest 5 evicted
    expect(items[0]!.title).toBe('t5');
  });
});
