// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import '../../src/ui/shell.js';

interface ShellEl extends HTMLElement {
  activeTab: 'map' | 'results' | 'detail';
  datasetCount: number;
  savedCount: number;
  setTab(id: 'map' | 'results' | 'detail'): void;
  updateComplete: Promise<unknown>;
}

function mount(props: Partial<ShellEl> = {}): ShellEl {
  const el = document.createElement('gcb-shell') as never as ShellEl;
  if (props.activeTab) el.activeTab = props.activeTab;
  if (typeof props.datasetCount === 'number') el.datasetCount = props.datasetCount;
  if (typeof props.savedCount === 'number') el.savedCount = props.savedCount;
  document.body.appendChild(el);
  return el;
}

describe('<gcb-shell>', () => {
  it('renders the five named slots (3-pane combined design)', async () => {
    const el = mount();
    await el.updateComplete;
    const slotNames = Array.from(el.shadowRoot!.querySelectorAll('slot'))
      .map((s) => s.getAttribute('name'));
    expect(slotNames).toEqual(
      expect.arrayContaining(['topbar', 'iconRail', 'rail', 'main', 'dock']),
    );
  });

  it('exposes activeTab and updates it via setTab()', async () => {
    const el = mount();
    await el.updateComplete;
    expect(el.activeTab).toBe('map');
    el.setTab('detail');
    await el.updateComplete;
    expect(el.activeTab).toBe('detail');
  });

  it('setTab() emits gcb:tab with the new id (backwards-compat)', async () => {
    const el = mount();
    await el.updateComplete;
    const spy = vi.fn();
    el.addEventListener('gcb:tab', spy);
    el.setTab('results');
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as CustomEvent<string>).detail).toBe('results');
  });
});
