import { useCallback, useRef, useState } from 'react';
import { createEcho } from '@geochatbot/widget';
import { GeoChatBotReact, type GeoChatBotElement } from './GeoChatBotReact';

export function App() {
  const ref = useRef<GeoChatBotElement | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [log, setLog] = useState<string>('');

  const append = useCallback((line: string) => {
    setLog((prev) => (prev + line + '\n').slice(-4000));
  }, []);

  const onResult = useCallback(
    (payload: unknown) => append('[result] ' + JSON.stringify(payload).slice(0, 240)),
    [append],
  );
  const onError = useCallback(
    (payload: unknown) => {
      const msg = payload instanceof Error ? payload.message : JSON.stringify(payload);
      append('[error] ' + msg);
    },
    [append],
  );

  const useEcho = useCallback(() => {
    const el = ref.current;
    if (el && typeof el.setProvider === 'function') {
      el.setProvider(createEcho());
      append('provider=echo');
    } else {
      append('setProvider not available');
    }
  }, [append]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'light' ? 'dark' : 'light'));
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1 style={{ fontSize: 18 }}>GeoChatBot — React example</h1>
      <div style={{ display: 'flex', gap: 8, margin: '12px 0', flexWrap: 'wrap' }}>
        <button onClick={toggleTheme}>Toggle theme (current: {theme})</button>
        <button onClick={useEcho}>setProvider(createEcho())</button>
        <button onClick={() => ref.current?.clear?.()}>clear()</button>
      </div>

      <GeoChatBotReact
        ref={ref}
        theme={theme}
        onResult={onResult}
        onError={onError}
        style={{ display: 'block', height: 560, border: '1px solid #e5e7eb', borderRadius: 8 }}
      />

      <h3>Event log</h3>
      <pre
        style={{
          background: '#0b1020',
          color: '#e2e8f0',
          padding: 10,
          borderRadius: 6,
          fontSize: 12,
          maxHeight: 200,
          overflow: 'auto',
        }}
      >
        {log}
      </pre>
    </div>
  );
}
