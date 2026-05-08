// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import '../../src/ui/shell.js';

interface ShellEl extends HTMLElement {
  activeTab: 'map' | 'results' | 'detail';
  datasetCount: number;
  savedCount: number;
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
  it('renders the four named slots', async () => {
    const el = mount();
    await el.updateComplete;
    const slotNames = Array.from(el.shadowRoot!.querySelectorAll('slot'))
      .map((s) => s.getAttribute('name'));
    expect(slotNames).toEqual(expect.arrayContaining(['topbar', 'rail', 'main', 'dock']));
  });

  it('renders three tab buttons (Map, Results, Detail)', async () => {
    const el = mount();
    await el.updateComplete;
    const tabs = Array.from(el.shadowRoot!.querySelectorAll('[role="tab"]'));
    expect(tabs.length).toBe(3);
    expect(tabs[0]!.textContent).toMatch(/Map/);
    expect(tabs[1]!.textContent).toMatch(/Results/);
    expect(tabs[2]!.textContent).toMatch(/Detail/);
  });

  it('tab badges reflect datasetCount + savedCount', async () => {
    const el = mount({ datasetCount: 842, savedCount: 3 });
    await el.updateComplete;
    const text = el.shadowRoot!.textContent ?? '';
    expect(text).toMatch(/842/);
    expect(text).toMatch(/3/);
  });

  it('clicking a tab emits gcb:tab with the new id', async () => {
    const el = mount();
    await el.updateComplete;
    const spy = vi.fn();
    el.addEventListener('gcb:tab', spy);
    const resultsTab = el.shadowRoot!.querySelectorAll('[role="tab"]')[1] as HTMLElement;
    resultsTab.click();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as CustomEvent<string>).detail).toBe('results');
  });

  it('activeTab prop drives aria-selected', async () => {
    const el = mount({ activeTab: 'detail' });
    await el.updateComplete;
    const tabs = Array.from(el.shadowRoot!.querySelectorAll('[role="tab"]'));
    const selected = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected.length).toBe(1);
    expect(selected[0]!.textContent).toMatch(/Detail/);
  });
});
