// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import '../../src/ui/rail.js';
import type { SavedResultV1 } from '../../src/state/saves-store.js';

interface RailEl extends HTMLElement {
  datasets: ReadonlyArray<{ name: string; rows: number; hasGeometry: boolean }>;
  saves: ReadonlyArray<SavedResultV1>;
  activeSaveId: string | null;
  updateComplete: Promise<unknown>;
}

function mount(props: Partial<RailEl> = {}): RailEl {
  const el = document.createElement('gcb-rail') as never as RailEl;
  el.datasets = props.datasets ?? [];
  el.saves    = props.saves    ?? [];
  el.activeSaveId = props.activeSaveId ?? null;
  document.body.appendChild(el);
  return el;
}

const SAMPLE: SavedResultV1 = {
  id: 's1', version: 1, createdAt: 1,
  title: 'Throughput by port', kind: 'chart',
  origin: { planId: 'p1', stepId: 's1', question: 'q' },
  payload: {},
};

describe('<gcb-rail>', () => {
  it('renders an empty-state when both lists are empty', async () => {
    const el = mount();
    await el.updateComplete;
    const text = el.shadowRoot!.textContent ?? '';
    expect(text).toMatch(/No datasets/);
    expect(text).toMatch(/No saved results/);
  });

  it('renders one row per dataset', async () => {
    const el = mount({
      datasets: [
        { name: 'ports.csv', rows: 842, hasGeometry: true },
        { name: 'lanes.parquet', rows: 11000, hasGeometry: false },
      ],
    });
    await el.updateComplete;
    const rows = el.shadowRoot!.querySelectorAll('.dataset-row');
    expect(rows.length).toBe(2);
    expect(rows[0]!.textContent).toMatch(/ports\.csv/);
    expect(rows[0]!.textContent).toMatch(/842/);
  });

  it('renders one row per save and marks active with aria-current', async () => {
    const el = mount({ saves: [SAMPLE], activeSaveId: 's1' });
    await el.updateComplete;
    const rows = el.shadowRoot!.querySelectorAll('.saved-row');
    expect(rows.length).toBe(1);
    expect(rows[0]!.getAttribute('aria-current')).toBe('true');
    expect(rows[0]!.textContent).toMatch(/Throughput by port/);
  });

  it('emits gcb:save-select on save row click', async () => {
    const el = mount({ saves: [SAMPLE] });
    await el.updateComplete;
    const spy = vi.fn();
    el.addEventListener('gcb:save-select', spy);
    (el.shadowRoot!.querySelector('.saved-row') as HTMLElement).click();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as CustomEvent<string>).detail).toBe('s1');
  });

  it('emits gcb:save-remove on trash icon click (and does NOT emit save-select)', async () => {
    const el = mount({ saves: [SAMPLE] });
    await el.updateComplete;
    const select = vi.fn();
    const remove = vi.fn();
    el.addEventListener('gcb:save-select', select);
    el.addEventListener('gcb:save-remove', remove);
    (el.shadowRoot!.querySelector('.saved-row .remove') as HTMLElement).click();
    expect(remove).toHaveBeenCalledTimes(1);
    expect((remove.mock.calls[0][0] as CustomEvent<string>).detail).toBe('s1');
    expect(select).not.toHaveBeenCalled();
  });

  it('emits gcb:dataset-toggle on eye icon click', async () => {
    const el = mount({
      datasets: [{ name: 'ports.csv', rows: 842, hasGeometry: true }],
    });
    await el.updateComplete;
    const spy = vi.fn();
    el.addEventListener('gcb:dataset-toggle', spy);
    (el.shadowRoot!.querySelector('.dataset-row .eye') as HTMLElement).click();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as CustomEvent<string>).detail).toBe('ports.csv');
  });
});
