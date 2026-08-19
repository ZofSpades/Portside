'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import {
  API_URL,
  deleteEnvVar,
  deleteProject,
  getProject,
  listDeployments,
  listEnvVars,
  rollback,
  setCustomDomain,
  setEnvVar,
  triggerDeploy,
  type Deployment,
  type DeploymentStatus,
  type EnvVarSummary,
  type Project,
} from '@/lib/api';

const ROLLBACK_ELIGIBLE = new Set<DeploymentStatus>(['LIVE', 'SUPERSEDED', 'STOPPED']);

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [envVars, setEnvVars] = useState<EnvVarSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    Promise.all([getProject(id), listDeployments(id), listEnvVars(id)])
      .then(([p, d, e]) => {
        setProject(p);
        setDeployments(d);
        setEnvVars(e);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(refresh, [id]);

  // Poll while a deployment is in flight so status/history update without a manual refresh.
  useEffect(() => {
    const active = deployments.some(
      (d) => !['LIVE', 'SUPERSEDED', 'STOPPED', 'FAILED', 'CANCELLED'].includes(d.status),
    );
    if (!active) return;
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [deployments, id]);

  if (!project) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        {error ? (
          <p className="text-red-400">{error}</p>
        ) : (
          <p className="text-slate-500">Loading…</p>
        )}
      </main>
    );
  }

  const liveDeployment = deployments.find((d) => d.id === project.currentDeploymentId);

  async function handleDeploy() {
    setBusy(true);
    setError(null);
    try {
      await triggerDeploy(id);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to deploy');
    } finally {
      setBusy(false);
    }
  }

  async function handleRollback(toDeploymentId: string) {
    setBusy(true);
    setError(null);
    try {
      await rollback(id, toDeploymentId);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to roll back');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete "${project!.name}"? This stops and removes its containers.`)) return;
    await deleteProject(id);
    router.push('/');
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 p-6">
      <header className="flex items-start justify-between">
        <div>
          <Link href="/" className="text-sm text-slate-500 hover:text-slate-300">
            ← Projects
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{project.name}</h1>
          <p className="text-sm text-slate-500">
            {project.sourceType === 'GIT'
              ? `${project.repoUrl} (${project.branch})`
              : 'Uploaded zip'}
          </p>
          {liveDeployment?.hostname && (
            <a
              href={`http://${liveDeployment.hostname}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-emerald-400 hover:underline"
            >
              http://{liveDeployment.hostname}
            </a>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleDeploy}
            disabled={busy}
            className="rounded bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-white disabled:opacity-50"
          >
            {project.currentDeploymentId ? 'Redeploy' : 'Deploy'}
          </button>
          <button
            onClick={handleDelete}
            className="rounded border border-red-900 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950"
          >
            Delete
          </button>
        </div>
      </header>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <DomainSection project={project} onChange={refresh} />

      <EnvVarsSection projectId={id} envVars={envVars} onChange={refresh} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-slate-400">Deployments</h2>
        {deployments.length === 0 ? (
          <p className="text-sm text-slate-500">No deployments yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {deployments.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between rounded-lg border border-slate-800 px-4 py-2.5"
              >
                <div className="flex items-center gap-3">
                  <StatusBadge status={d.status} />
                  <span className="text-xs text-slate-500">{d.trigger}</span>
                  <span className="text-xs text-slate-600">
                    {new Date(d.queuedAt).toLocaleString()}
                  </span>
                  {d.id === project.currentDeploymentId && (
                    <span className="text-xs text-emerald-400">current</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <Link
                    href={`/deployments/${d.id}`}
                    className="text-xs text-slate-400 hover:text-slate-200"
                  >
                    Logs
                  </Link>
                  {ROLLBACK_ELIGIBLE.has(d.status) && d.id !== project.currentDeploymentId && (
                    <button
                      onClick={() => handleRollback(d.id)}
                      disabled={busy}
                      className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
                    >
                      Roll back to this
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function StatusBadge({ status }: { status: DeploymentStatus }) {
  const color =
    status === 'LIVE'
      ? 'bg-emerald-500/20 text-emerald-300'
      : status === 'FAILED' || status === 'CANCELLED'
        ? 'bg-red-500/20 text-red-300'
        : status === 'SUPERSEDED' || status === 'STOPPED'
          ? 'bg-slate-500/20 text-slate-400'
          : 'bg-amber-500/20 text-amber-300';

  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{status}</span>;
}

function DomainSection({ project, onChange }: { project: Project; onChange: () => void }) {
  const [domain, setDomain] = useState(project.customDomain ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const webhookUrl = `${API_URL}/api/webhooks/github/${project.id}`;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await setCustomDomain(project.id, domain.trim() || null);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update domain');
    } finally {
      setBusy(false);
    }
  }

  function copySecret() {
    if (!project.webhookSecret) return;
    navigator.clipboard.writeText(project.webhookSecret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-slate-400">Custom domain</h2>
        <form onSubmit={save} className="flex gap-2">
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="myapp.com (optional)"
            className="flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded border border-slate-700 px-3 py-1.5 text-sm hover:border-slate-500 disabled:opacity-50"
          >
            Save
          </button>
        </form>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <p className="text-xs text-slate-500">
          Routes alongside the platform URL — point this domain&apos;s DNS at your Portside host to
          use it for real.
        </p>
      </div>

      {project.sourceType === 'GIT' && project.webhookSecret && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-slate-400">Auto-deploy on push</h2>
          <p className="text-xs text-slate-500">
            Add this as a webhook in your repo&apos;s Settings → Webhooks — Payload URL below,
            content type <code>application/json</code>, secret below, event: just the{' '}
            <code>push</code> event.
          </p>
          <div className="flex items-center gap-2 rounded border border-slate-800 px-3 py-1.5 font-mono text-xs text-slate-300">
            <span className="flex-1 truncate">{webhookUrl}</span>
          </div>
          <div className="flex items-center gap-2 rounded border border-slate-800 px-3 py-1.5 font-mono text-xs text-slate-300">
            <span className="flex-1 truncate">{project.webhookSecret}</span>
            <button
              onClick={copySecret}
              className="shrink-0 text-slate-500 hover:text-slate-200"
              type="button"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function EnvVarsSection({
  projectId,
  envVars,
  onChange,
}: {
  projectId: string;
  envVars: EnvVarSummary[];
  onChange: () => void;
}) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await setEnvVar(projectId, key, value);
      setKey('');
      setValue('');
      onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-slate-400">Environment variables</h2>
      {envVars.length > 0 && (
        <ul className="flex flex-col gap-1">
          {envVars.map((e) => (
            <li
              key={e.key}
              className="flex items-center justify-between rounded border border-slate-800 px-3 py-1.5 text-sm"
            >
              <span className="font-mono">{e.key}</span>
              <button
                onClick={() => deleteEnvVar(projectId, e.key).then(onChange)}
                className="text-xs text-slate-500 hover:text-red-400"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex gap-2">
        <input
          value={key}
          onChange={(ev) => setKey(ev.target.value)}
          placeholder="KEY"
          className="w-1/3 rounded border border-slate-700 bg-slate-900 px-3 py-1.5 font-mono text-sm"
        />
        <input
          value={value}
          onChange={(ev) => setValue(ev.target.value)}
          placeholder="value"
          type="password"
          className="flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={busy || !key}
          className="rounded border border-slate-700 px-3 py-1.5 text-sm hover:border-slate-500 disabled:opacity-50"
        >
          Set
        </button>
      </form>
    </section>
  );
}
