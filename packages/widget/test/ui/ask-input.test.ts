// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import '../../src/ui/ask-input.js';
import type { AskInputDisabledReason } from '../../src/ui/ask-input.js';

interface AskEl extends HTMLElement {
  disabledReason: AskInputDisabledReason;
  examples: ReadonlyArray<string>;
  busy: boolean;
  updateComplete: Promise<unknown>;
}

function mount(props: Partial<AskEl> = {}): AskEl {
  const el = document.createElement('gcb-ask-input') as never as AskEl;
  el.disabledReason = props.disabledReason ?? null;
  el.examples = props.examples ?? [];
  el.busy = props.busy ?? false;
  document.body.appendChild(el);
  return el;
}

describe('<gcb-ask-input>', () => {
  it('renders the no-data empty state when disabledReason="no-data"', async () => {
    const el = mount({ disabledReason: 'no-data' });
    await el.updateComplete;
    const text = el.shadowRoot!.textContent ?? '';
    expect(text).toMatch(/Drop a CSV/);
    expect(el.shadowRoot!.querySelector('input[type="text"]')).toBeNull();
  });

  it('renders the no-key empty state with an Open settings button when disabledReason="no-key"', async () => {
    const el = mount({ disabledReason: 'no-key' });
    await el.updateComplete;
    let requested = false;
    el.addEventListener('gcb:request-settings', () => { requested = true; });
    const btn = el.shadowRoot!.querySelector('button') as HTMLButtonElement;
    expect(btn.textContent).toMatch(/Open settings/);
    btn.click();
    expect(requested).toBe(true);
  });

  it('renders the input + Ask button when disabledReason is null', async () => {
    const el = mount({ disabledReason: null });
    await el.updateComplete;
    const input = el.shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement;
    const btn = el.shadowRoot!.querySelector('button.ask') as HTMLButtonElement;
    expect(input).not.toBeNull();
    expect(btn).not.toBeNull();
    // Empty input → Ask is disabled.
    expect(btn.disabled).toBe(true);
  });

  it('emits gcb:ask with trimmed text on Ask click', async () => {
    const el = mount({ disabledReason: null });
    await el.updateComplete;
    const input = el.shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement;
    const btn = el.shadowRoot!.querySelector('button.ask') as HTMLButtonElement;
    input.value = '  How many points?  ';
    input.dispatchEvent(new Event('input'));
    await el.updateComplete;
    let asked: string | null = null;
    el.addEventListener('gcb:ask', (e) => { asked = (e as CustomEvent<string>).detail; });
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(asked).toBe('How many points?');
  });

  it('submits on Enter key', async () => {
    const el = mount({ disabledReason: null });
    await el.updateComplete;
    const input = el.shadowRoot!.querySelector('input[type="text"]') as HTMLInputElement;
    input.value = 'count rows';
    input.dispatchEvent(new Event('input'));
    await el.updateComplete;
    let asked: string | null = null;
    el.addEventListener('gcb:ask', (e) => { asked = (e as CustomEvent<string>).detail; });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(asked).toBe('count rows');
  });

  it('renders example chips that submit on click', async () => {
    const el = mount({ disabledReason: null, examples: ['Show me a chart.', 'Map it.'] });
    await el.updateComplete;
    const chips = el.shadowRoot!.querySelectorAll('button.chip');
    expect(chips.length).toBe(2);
    let asked: string | null = null;
    el.addEventListener('gcb:ask', (e) => { asked = (e as CustomEvent<string>).detail; });
    (chips[0] as HTMLButtonElement).click();
    expect(asked).toBe('Show me a chart.');
  });

  it('disables Ask when busy is true', async () => {
    const el = mount({ disabledReason: null, busy: true });
    await el.updateComplete;
    const btn = el.shadowRoot!.querySelector('button.ask') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
