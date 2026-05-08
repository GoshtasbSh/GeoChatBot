'use client';

import { useCallback, useState } from 'react';
import { GeoChatBotEmbed } from '@/components/geo-chatbot-embed';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface ResultEvent {
  kind: 'layer' | 'chart' | 'table' | 'summary';
  timestamp: number;
  detail: unknown;
}

export default function DashboardPage() {
  const [events, setEvents] = useState<ResultEvent[]>([]);

  const handleResult = useCallback((detail: unknown) => {
    setEvents((prev) => [
      {
        kind: (detail as { kind: ResultEvent['kind'] }).kind ?? 'summary',
        timestamp: Date.now(),
        detail,
      },
      ...prev.slice(0, 9), // keep last 10
    ]);
  }, []);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      {/* Host map placeholder */}
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
          <h1 className="font-semibold text-zinc-900 dark:text-zinc-50">
            Headless Mode Demo
          </h1>
          <Badge variant="secondary">mode=&quot;headless&quot;</Badge>
        </div>
        <div className="flex flex-1 overflow-hidden">
          {/* Simulated host map */}
          <div className="flex flex-1 items-center justify-center bg-zinc-100 dark:bg-zinc-900">
            <div className="text-center text-zinc-400">
              <div className="mb-2 text-4xl">🗺️</div>
              <p className="text-sm font-medium">
                Host&apos;s own map would go here
              </p>
              <p className="mt-1 text-xs">
                (MapLibre, Leaflet, Google Maps, etc.)
              </p>
            </div>
          </div>

          {/* Status panel */}
          <div className="flex w-72 flex-col gap-3 overflow-y-auto border-l border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              Widget events
            </h2>
            {events.length === 0 ? (
              <p className="text-xs text-zinc-400">
                No events yet. Use the widget panel to run a query.
              </p>
            ) : (
              events.map((ev, i) => (
                <Card key={i} className="text-xs">
                  <CardHeader className="p-3 pb-1">
                    <CardTitle className="flex items-center gap-2 text-xs">
                      <Badge variant="outline">{ev.kind}</Badge>
                      <span className="text-zinc-400">
                        {new Date(ev.timestamp).toLocaleTimeString()}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-3 pt-0">
                    <pre className="overflow-x-auto whitespace-pre-wrap text-zinc-500 dark:text-zinc-400">
                      {JSON.stringify(ev.detail, null, 2).slice(0, 200)}
                    </pre>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Headless widget panel */}
      <div className="flex w-96 flex-col border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <p className="text-xs text-zinc-500">
            GeoChatBot in headless mode — results emit as events, not rendered
            inside this panel.
          </p>
        </div>
        <div className="flex-1 overflow-hidden">
          <GeoChatBotEmbed mode="headless" onResult={handleResult} />
        </div>
      </div>
    </div>
  );
}
