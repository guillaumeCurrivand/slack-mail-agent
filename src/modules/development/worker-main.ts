import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Work } from './domain.js';
import { atomicJson, LocalRunner, localProjectSchema } from './runner.js';

export const workerConfigSchema = z.object({
  server: z.url().refine(value => { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)); }),
  stateDirectory: z.string().min(1), agent: z.array(z.string().min(1)).min(1).default(['agent']),
  projects: z.array(localProjectSchema).min(1),
}).strict().refine(value => new Set(value.projects.map(project => project.id)).size === value.projects.length, 'Duplicate local project.');

export async function runWorker(filename: string, once = false) {
  if (Number(process.versions.node.split('.')[0]) < 24 || typeof fetch !== 'function') {
    throw new Error(`Le worker Mayassistant exige Node 24+ (version actuelle : ${process.version}). Sous Windows, utilisez scripts/start-development-worker.ps1 ; le runtime du projet reste séparé.`);
  }
  const config = workerConfigSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
  const token = process.env.DEVELOPMENT_WORKER_TOKEN;
  if (!token || token.length < 32) throw new Error('DEVELOPMENT_WORKER_TOKEN manquant.');
  const root = path.resolve(config.stateDirectory);
  await mkdir(root, { recursive: true });
  const lockPath = path.join(root, 'worker.lock');
  // Exclusive local lock is intentionally not reclaimed by age. Never overlap an orphaned Cursor process.
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid }));
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const identityFile = path.join(root, 'worker.json');
    let worker: string;
    try { worker = z.uuid().parse(JSON.parse(await readFile(identityFile, 'utf8')).id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; worker = randomUUID(); await atomicJson(identityFile, { id: worker }); }
    const request = async (endpoint: string, body: unknown) => {
      const response = await fetch(`${config.server.replace(/\/$/, '')}/development/worker/${endpoint}`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Mayassistant ${endpoint} : HTTP ${response.status}.`);
      return response.json() as Promise<any>;
    };
    const runner = new LocalRunner(root, config.agent);
    do {
      try {
        const { work } = await request('claim', { worker, projects: config.projects.map(project => project.id) }) as { work: Work | null };
        if (work) {
          const project = config.projects.find(project => project.id === work.project.id);
          if (!project) throw new Error('Projet local introuvable ; restaurez sa configuration pour terminer le traitement.');
          const result = await runner.run(work, project, async expected => (await request('attempt', { id: work.id, lease: work.lease, expected })).attempt);
          await request('result', { id: work.id, lease: work.lease, result });
          console.log(`${work.project.id} / ${work.ticket.id} : ${result.outcome}`);
        }
      } catch (error) { console.error(error instanceof Error ? error.message.split('\n')[0] : 'Worker indisponible.'); }
      if (!once && !stopping) await delay(5000);
    } while (!once && !stopping);
  } finally {
    await lock.close(); await unlink(lockPath);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filename = process.argv[2];
  if (!filename) { console.error('Usage: development-worker <configuration.json> [--once]'); process.exitCode = 1; }
  else runWorker(filename, process.argv.includes('--once')).catch(error => { console.error(error instanceof Error ? error.message : 'Worker indisponible.'); process.exitCode = 1; });
}
