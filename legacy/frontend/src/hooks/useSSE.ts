import { useState, useEffect, useCallback, useRef } from 'react';
import type { LogEntry } from '../types';

export function useSSE() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const connect = () => {
      const es = new EventSource('/api/logs/stream');
      esRef.current = es;

      es.onmessage = (event) => {
        try {
          const entry: LogEntry = JSON.parse(event.data);
          setLogs((prev) => [...prev, entry]);
        } catch {
          // ignore parse errors
        }
      };

      es.onerror = () => {
        es.close();
        // Reconnect after 3 seconds
        setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      esRef.current?.close();
    };
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  return { logs, clearLogs };
}
