/**
 * Provider abstraction for GeoChatBot.
 *
 * Hosts plug a `ChatProvider` into the widget. Implementations must
 * use `fetch` only — no vendor SDKs — to keep the bundle lean and
 * vendor-neutral.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateInput {
  messages: ChatMessage[];
  /** Optional sampling controls; not all providers will respect them. */
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateOutput {
  text: string;
  /** Provider-specific usage; optional. */
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Model id actually used (post-default). */
  model?: string;
}

export interface ChatProvider {
  readonly id: string;
  readonly label: string;
  /**
   * True if the provider has a free tier or runs locally. Used to
   * surface "Free" badges in UI.
   */
  readonly free?: boolean;
  generate(input: GenerateInput): Promise<GenerateOutput>;
}

export type ProviderErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'BAD_RESPONSE'
  | 'ABORTED'
  | 'UNSUPPORTED';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId: string;
  readonly status?: number;

  constructor(
    code: ProviderErrorCode,
    message: string,
    providerId: string,
    status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.providerId = providerId;
    if (status !== undefined) this.status = status;
  }
}
