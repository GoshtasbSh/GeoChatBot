/**
 * Public entry for the GeoChatBot widget bundle.
 *
 * Importing this file as a side effect registers the <geo-chatbot> Custom
 * Element. Re-exports below are the typed surface for hosts that want
 * programmatic control.
 */

export { GeoChatBotElement } from './element';
export type { GeoChatBotEvents } from './element';
export type {
  ChatProvider,
  ChatMessage,
  GenerateInput,
  GenerateOutput,
  ProviderErrorCode,
} from './providers';
export {
  ProviderError,
  setProvider,
  getProvider,
  clearProvider,
  createEcho,
  createGroq,
  createAnthropic,
  createOpenAICompat,
  createGemini,
} from './providers';
export type {
  BinaryInput,
  DataLoader,
  GeometryEncoding,
  LoaderOptions,
  LoadResult,
  SourceFormat,
  DatasetProfile,
} from './data/contracts';
export { LoaderError } from './data/contracts';

import { GeoChatBotElement } from './element';
import './element';

/**
 * Convenience for non-bundler embeds: ensure the element is defined.
 *
 * Idempotent — safe to call multiple times. If `tagName` is provided and
 * differs from `'geo-chatbot'`, a thin subclass is registered under the
 * new name (custom-element names cannot be re-bound after `define`).
 */
export function defineGeoChatBot(tagName: string = 'geo-chatbot'): void {
  if (typeof customElements === 'undefined') return;
  if (customElements.get(tagName)) return;
  if (tagName === 'geo-chatbot') {
    // Side-effect import already registered the default tag; nothing to do.
    return;
  }
  class AliasedGeoChatBot extends GeoChatBotElement {}
  customElements.define(tagName, AliasedGeoChatBot);
}
