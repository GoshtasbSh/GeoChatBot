/**
 * Public entry for the GeoChatBot widget bundle.
 *
 * Importing this file as a side effect registers the <geo-chatbot> Custom
 * Element. Re-exports are provided for hosts that want typed access.
 */

export { GeoChatBotElement } from './element';
export type {
  BinaryInput,
  DataLoader,
  GeometryEncoding,
  LoaderOptions,
  LoadResult,
  SourceFormat,
} from './data/contracts';
export { LoaderError } from './data/contracts';

import './element';

/** Convenience for non-bundler embeds: ensure the element is defined. */
export function defineGeoChatBot(): void {
  // Importing './element' above already calls customElements.define via @customElement.
  // This function exists so consumers can call it explicitly after a dynamic import.
}
