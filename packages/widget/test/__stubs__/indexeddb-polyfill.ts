/**
 * Install a fake IndexedDB into the Node test environment so the
 * retrieval VectorStore (which uses idb-keyval → IndexedDB under the
 * hood) can run without a real browser.
 *
 * fake-indexeddb is the canonical W3C-spec implementation used by
 * Jest/Vitest projects that need IndexedDB in Node.
 */

import "fake-indexeddb/auto";
