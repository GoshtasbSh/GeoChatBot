// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import '../../src/ui/settings-drawer.js';
import type { SettingsValue } from '../../src/ui/settings-drawer.js';

interface DrawerEl extends HTMLElement {
  value: SettingsValue;
  updateComplete: Promise<unknown>;
}

function mount(value?: Partial<SettingsValue>): DrawerEl {
  const el = document.createElement('gcb-settings-drawer') as never as DrawerEl;
  if (value) {
    el.value = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: '',
      dangerouslyAllowBrowser: false,
      ...value,
    };
  }
  document.body.appendChild(el);
  return el;
}

describe('<gcb-settings-drawer>', () => {
  it('disables Save when the API key is empty', async () => {
    const el = mount({ apiKey: '', dangerouslyAllowBrowser: true });
    await el.updateComplete;
    const save = el.shadowRoot!.querySelector('button.primary') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('disables Save when the dangerouslyAllowBrowser checkbox is off', async () => {
    const el = mount({ apiKey: 'sk-ant-12345', dangerouslyAllowBrowser: false });
    await el.updateComplete;
    const save = el.shadowRoot!.querySelector('button.primary') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('enables Save once both key and acknowledgement are present', async () => {
    const el = mount({ apiKey: 'sk-ant-12345', dangerouslyAllowBrowser: true });
    await el.updateComplete;
    const save = el.shadowRoot!.querySelector('button.primary') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it('emits gcb:settings with trimmed key on Save', async () => {
    const el = mount({ apiKey: '  sk-ant-with-whitespace  ', dangerouslyAllowBrowser: true });
    await el.updateComplete;
    let captured: SettingsValue | null = null;
    el.addEventListener('gcb:settings', (e) => {
      captured = (e as CustomEvent<SettingsValue>).detail;
    });
    (el.shadowRoot!.querySelector('button.primary') as HTMLButtonElement).click();
    expect(captured).not.toBeNull();
    expect(captured!.apiKey).toBe('sk-ant-with-whitespace');
  });

  it('emits gcb:settings-close on Cancel', async () => {
    const el = mount();
    await el.updateComplete;
    let closed = false;
    el.addEventListener('gcb:settings-close', () => { closed = true; });
    const cancel = [...el.shadowRoot!.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Cancel',
    ) as HTMLButtonElement;
    cancel.click();
    expect(closed).toBe(true);
  });
});
