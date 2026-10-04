import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const localURL = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.hash;
}, 'Use a loopback HTTP readiness endpoint.');
const timeout = z.number().int().min(1000).max(1_800_000).optional();
export const localServiceSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  cwd: z.string().min(1), start: z.array(z.string().min(1)).min(1),
  readyUrl: localURL, startupTimeoutMs: timeout, reuseExisting: z.boolean().optional(),
  ngrok: z.object({
    publicOrigin: z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password; }),
    upstreamPort: z.number().int().min(1).max(65535),
  }).strict().optional(),
}).strict();
export type LocalService = z.infer<typeof localServiceSchema>;
type Stop = () => Promise<void>;

async function ready(service: LocalService, budget: number) {
  try {
    const response = await fetch(service.readyUrl, { redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.ceil(budget))) });
    if (!response.ok) return false;
    if (!service.ngrok) { await response.body?.cancel(); return true; }
    const result = z.object({ tunnels: z.array(z.object({ public_url: z.string(), config: z.object({ addr: z.string() }) })) }).parse(await response.json());
    return result.tunnels.some(tunnel => {
      if (tunnel.public_url !== service.ngrok!.publicOrigin) return false;
      const upstream = URL.parse(tunnel.config.addr.includes('://') ? tunnel.config.addr : `http://${tunnel.config.addr}`);
      return upstream?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname)
        && Number(upstream.port || 80) === service.ngrok!.upstreamPort;
    });
  } catch { return false; }
}

/** Own only processes launched here. Reused healthy services are never terminated. */
export async function startLocalService(service: LocalService, directory: string, env: NodeJS.ProcessEnv): Promise<Stop> {
  const url = new URL(service.readyUrl), host = url.hostname.replace(/^\[|\]$/g, ''), port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const available = await new Promise<boolean>(resolve => {
    const probe = net.createServer(); probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
  if (!available) {
    if (service.reuseExisting && await ready(service, 1000)) return async () => {};
    throw new Error(`${service.id} : port ${port} déjà utilisé ou service existant non conforme. Aucun processus existant arrêté.`);
  }
  const logfile = `${service.id}.log`;
  const log = createWriteStream(path.join(directory, logfile), { flags: 'a', mode: 0o600 });
  let logError: Error | undefined;
  log.on('error', error => { logError = error; });
  const child = spawn(service.start[0]!, service.start.slice(1), {
    cwd: service.cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let failed: Error | undefined;
  child.on('error', error => { failed = error; });
  let stopped = false;
  const stop: Stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') await new Promise<void>(resolve => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => resolve()); killer.once('close', () => resolve());
      });
      else try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
    }
    log.end();
  };
  try {
    const allowance = service.startupTimeoutMs ?? 240_000;
    const deadline = performance.now() + allowance;
    while (performance.now() < deadline) {
      if (failed || logError || child.exitCode !== null) throw new Error(`${service.id} : démarrage échoué. Consultez ${logfile}.`);
      if (await ready(service, Math.min(1000, deadline - performance.now()))) return stop;
      await delay(Math.min(1000, Math.max(0, deadline - performance.now())));
    }
    throw new Error(`${service.id} : aucune réponse conforme après ${allowance} ms. Consultez ${logfile} et startupTimeoutMs${service.ngrok ? ' ; vérifiez aussi le domaine ngrok et le port cible' : ''}.`);
  } catch (error) { await stop(); throw error; }
}

export async function startLocalServices(services: LocalService[], directory: string, env: NodeJS.ProcessEnv): Promise<Stop> {
  const stops: Stop[] = [];
  const stop = async () => { for (const close of stops.splice(0).reverse()) await close(); };
  try {
    for (const service of services) stops.push(await startLocalService(service, directory, env));
    return stop;
  } catch (error) { await stop(); throw error; }
}
