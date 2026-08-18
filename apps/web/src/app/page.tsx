'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  createProjectFromGit,
  createProjectFromZip,
  getMe,
  listProjects,
  loginUrl,
  logout,
  type Project,
  type User,
} from '@/lib/api';

export default function HomePage() {
  const [user, setUser] = useState<User | null | 'loading'>('loading');

  useEffect(() => {
    getMe().then(setUser);
  }, []);

  if (user === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-slate-500">Loading…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6">
        <h1 className="text-3xl font-semibold tracking-tight">Portside</h1>
        <p className="max-w-md text-center text-slate-400">
          Connect a repo, deploy, get a live URL. Log in with GitHub to get started.
        </p>
        <a
          href={loginUrl()}
          className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white"
        >
          Log in with GitHub
        </a>
      </main>
    );
  }

  return <Dashboard user={user} />;
}

function Dashboard({ user }: { user: User }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listProjects()
      .then(setProjects)
      .catch((err) => setError(err.message));
  }

  useEffect(refresh, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 p-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {user.avatarUrl && <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full" />}
          <span className="text-sm text-slate-300">{user.login}</span>
        </div>
        <button
          onClick={() => logout().then(() => window.location.reload())}
          className="text-sm text-slate-400 hover:text-slate-200"
        >
          Log out
        </button>
      </header>

      <NewProjectForm onCreated={refresh} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-slate-400">Projects</h2>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {projects === null ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-slate-500">No projects yet — create one above.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/projects/${project.id}`}
                  className="flex items-center justify-between rounded-lg border border-slate-800 px-4 py-3 hover:border-slate-600"
                >
                  <span className="font-medium">{project.name}</span>
                  <span className="text-xs text-slate-500">{project.sourceType}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function NewProjectForm({ onCreated }: { onCreated: () => void }) {
  const [mode, setMode] = useState<'git' | 'zip'>('git');
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'git') {
        await createProjectFromGit({ name, repoUrl, branch });
      } else {
        if (!file) throw new Error('Choose a zip file');
        await createProjectFromZip(name, file);
      }
      setName('');
      setRepoUrl('');
      setFile(null);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-slate-800 p-4">
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={mode === 'git'} onChange={() => setMode('git')} />
          Git repo
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={mode === 'zip'} onChange={() => setMode('zip')} />
          Upload zip
        </label>
      </div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Project name"
        required
        className="rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm"
      />

      {mode === 'git' ? (
        <div className="flex gap-2">
          <input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/owner/repo.git"
            required
            className="flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm"
          />
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
            className="w-24 rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm"
          />
        </div>
      ) : (
        <input
          type="file"
          accept=".zip"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm"
        />
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="self-start rounded bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-white disabled:opacity-50"
      >
        {busy ? 'Creating…' : 'Create project'}
      </button>
    </form>
  );
}
