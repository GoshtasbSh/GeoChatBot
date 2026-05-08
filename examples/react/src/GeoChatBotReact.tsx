import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type Ref,
} from 'react';
// Side-effect import: registers the <geo-chatbot> custom element.
import '@geochatbot/widget';

import './geo-chatbot.d';

type Theme = 'light' | 'dark';

/**
 * Minimum surface of the <geo-chatbot> element we rely on.
 * The actual element exposes more methods; this keeps the wrapper typed
 * without leaking internals.
 */
export interface GeoChatBotElement extends HTMLElement {
  pushData?: (file: File | Blob) => Promise<unknown> | void;
  setProvider?: (provider: unknown) => void;
  clear?: () => void;
  on?: (event: 'result' | 'error' | 'plan', handler: (payload: unknown) => void) => () => void;
}

export interface GeoChatBotReactProps {
  theme?: Theme;
  onResult?: (payload: unknown) => void;
  onError?: (payload: unknown) => void;
  onPlan?: (payload: unknown) => void;
  style?: React.CSSProperties;
  className?: string;
}

export const GeoChatBotReact = forwardRef<GeoChatBotElement, GeoChatBotReactProps>(
  function GeoChatBotReact(props, ref: Ref<GeoChatBotElement>) {
    const { theme = 'light', onResult, onError, onPlan, style, className } = props;
    const innerRef = useRef<GeoChatBotElement | null>(null);

    useImperativeHandle<GeoChatBotElement | null, GeoChatBotElement | null>(
      ref,
      () => innerRef.current,
      [],
    );

    useEffect(() => {
      const el = innerRef.current;
      if (!el || typeof el.on !== 'function') return;
      const unsubs: Array<() => void> = [];
      if (onResult) unsubs.push(el.on('result', onResult));
      if (onError) unsubs.push(el.on('error', onError));
      if (onPlan) unsubs.push(el.on('plan', onPlan));
      return () => {
        for (const u of unsubs) {
          try { u(); } catch { /* ignore */ }
        }
      };
    }, [onResult, onError, onPlan]);

    return (
      <geo-chatbot
        ref={innerRef as unknown as Ref<HTMLElement>}
        theme={theme}
        style={style}
        className={className}
      />
    );
  },
);
