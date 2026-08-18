'use client';

import { use, useEffect, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://api.localhost';

type ConnectionState = 'connecting' | 'open' | 'done' | 'error';

export default function DeploymentLogsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [lines, setLines] = useState<string[]>([]);
  const [state, setState] = useState<ConnectionState>('connecting');
  const [finalStatus, setFinalStatus] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setLines([]);
    setState('connecting');
    setFinalStatus(null);

    const source = new EventSource(`${API_URL}/api/deployments/${id}/logs/stream`, {
      withCredentials: true,
    });

    source.onopen = () => setState('open');
    source.onerror = () => setState((prev) => (prev === 'done' ? prev : 'error'));
    source.onmessage = (event) => {
      setLines((prev) => [...prev, event.data]);
    };
    source.addEventListener('done', (event: MessageEvent) => {
      setFinalStatus(event.data);
      setState('done');
      source.close();
    });

    return () => source.close();
  }, [id]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  return (
    <main className="flex min-h-screen flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Deployment logs</h1>
        <StatusBadge state={state} finalStatus={finalStatus} />
      </div>
      <p className="text-sm text-slate-500">{id}</p>
      <pre
        ref={logRef}
        className="flex-1 overflow-y-auto rounded-lg bg-black p-4 font-mono text-sm text-slate-200"
      >
        {lines.length === 0 ? (
          <span className="text-slate-500">Waiting for logs…</span>
        ) : (
          lines.join('\n')
        )}
      </pre>
    </main>
  );
}

function StatusBadge({
  state,
  finalStatus,
}: {
  state: ConnectionState;
  finalStatus: string | null;
}) {
  const label = state === 'done' ? finalStatus : state;
  const color =
    state === 'error'
      ? 'bg-red-500/20 text-red-300'
      : state === 'done'
        ? finalStatus === 'LIVE'
          ? 'bg-emerald-500/20 text-emerald-300'
          : 'bg-amber-500/20 text-amber-300'
        : 'bg-slate-500/20 text-slate-300';

  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${color}`}>{label}</span>;
}
