/**
 * happy-dom (≤ 15.x) does not honour the `dataTransfer` init option in
 * the DragEvent constructor.  This setup file replaces the global
 * DragEvent with a thin subclass that stores the init's `dataTransfer`
 * so component tests can drive drag-and-drop behaviour.
 *
 * Only runs in the test environment — never shipped to production.
 */
if (typeof DragEvent !== 'undefined') {
  const OrigDragEvent = DragEvent;

  class PatchedDragEvent extends OrigDragEvent {
    readonly dataTransfer: DataTransfer | null;

    constructor(type: string, init?: DragEventInit) {
      super(type, init);
      // happy-dom ignores init.dataTransfer — store it ourselves.
      this.dataTransfer = init?.dataTransfer ?? null;
    }
  }

  // @ts-expect-error — intentional global replacement for test env only
  globalThis.DragEvent = PatchedDragEvent;
}
