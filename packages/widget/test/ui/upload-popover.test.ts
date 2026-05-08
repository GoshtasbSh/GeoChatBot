// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import '../../src/ui/upload-popover.js';

interface PopEl extends HTMLElement {
  open: boolean;
  updateComplete: Promise<unknown>;
}

function mount(open = false): PopEl {
  const el = document.createElement('gcb-upload-popover') as never as PopEl;
  el.open = open;
  document.body.appendChild(el);
  return el;
}

describe('<gcb-upload-popover>', () => {
  it('renders nothing when open=false', async () => {
    const el = mount(false);
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('.popover')).toBeNull();
  });

  it('renders the drop area + format hint when open=true', async () => {
    const el = mount(true);
    await el.updateComplete;
    const text = el.shadowRoot!.textContent ?? '';
    expect(el.shadowRoot!.querySelector('.popover')).not.toBeNull();
    expect(text).toMatch(/Drop a file/);
    expect(text).toMatch(/CSV.*GeoJSON.*Shapefile.*Excel.*Parquet/);
  });

  it('emits gcb:files with a File[] on a drop event', async () => {
    const el = mount(true);
    await el.updateComplete;
    const spy = vi.fn();
    el.addEventListener('gcb:files', spy);
    const drop = el.shadowRoot!.querySelector('.drop-area') as HTMLElement;
    const file = new File(['a,b\n1,2'], 'tiny.csv', { type: 'text/csv' });
    const dt = new DataTransfer();
    dt.items.add(file);
    drop.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    expect(spy).toHaveBeenCalledTimes(1);
    const detail = (spy.mock.calls[0][0] as CustomEvent<File[]>).detail;
    expect(detail.length).toBe(1);
    expect(detail[0]!.name).toBe('tiny.csv');
  });

  it('emits gcb:popover-close on Escape', async () => {
    const el = mount(true);
    await el.updateComplete;
    const spy = vi.fn();
    el.addEventListener('gcb:popover-close', spy);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emits gcb:popover-close on outside click', async () => {
    const el = mount(true);
    await el.updateComplete;
    const spy = vi.fn();
    el.addEventListener('gcb:popover-close', spy);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit close when the popover itself is mousedowned', async () => {
    const el = mount(true);
    await el.updateComplete;
    const spy = vi.fn();
    el.addEventListener('gcb:popover-close', spy);
    const popover = el.shadowRoot!.querySelector('.popover') as HTMLElement;
    popover.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    expect(spy).not.toHaveBeenCalled();
  });
});
