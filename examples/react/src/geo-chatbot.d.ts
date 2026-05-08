// Teach React/JSX about the <geo-chatbot> custom element and its props.
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

type GeoChatBotProps = DetailedHTMLProps<
  HTMLAttributes<HTMLElement> & {
    theme?: 'light' | 'dark';
  },
  HTMLElement
>;

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'geo-chatbot': GeoChatBotProps;
    }
  }
}

export {};
