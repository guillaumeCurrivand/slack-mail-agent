import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createModules } from '../src/app/modules.js';
import { readConfig } from '../src/app/config.js';
import { dispatchJob } from '../src/core/dispatch.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { type AgentMessage, SlackDeliveryRejected } from '../src/core/slack.js';
import { coreSchema, type Sql } from '../src/core/store.js';
import { createHyperdxModule } from '../src/modules/hyperdx/index.js';
import { readReport } from '../src/modules/hyperdx/report.js';

const env = { ENABLED_MODULES: 'hyperdx', PUBLIC_URL: 'https://example.test', DATABASE_URL: 'unused',
  SLACK_TEAM_ID: 'TTEAM', SLACK_BOT_TOKEN: 'fake', SLACK_SIGNING_SECRET: 'fake' };
const db = new PGlite(), sql: Sql = { query: (text, values) => db.query(text, values) };
beforeAll(() => db.exec(coreSchema));
afterAll(() => db.close());

it('registers the French DM guide and requires credentials only when enabled', () => {
  expect(() => createModules(readConfig(env), sql, env)).toThrow();
  expect(createModules(readConfig({ ...env, ENABLED_MODULES: '' }), sql, env).text('hyperdx aide').module).toBe('core');
  const registry = createModules(readConfig(env), sql, { ...env, HYPERDX_API_KEY: 'fake', HYPERDX_SERVICES: '["svc"]' });
  expect(registry.text('hyperdx aide')).toEqual({ module: 'hyperdx', payload: { type: 'text', text: 'help' } });
});

it('schedules once, resumes a partial run and never repeats an uncertain Slack send', async () => {
  const cutoff = Date.UTC(2026, 4, 1, 6);
  let time = cutoff - 1000;
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('slack.com')) return Response.json({ ok: true, channel: { id: 'CTEST', is_member: true } });
    const query = JSON.parse(String(init?.body));
    expect(query.startTime).toBe(Date.UTC(2026, 3, 30));
    expect(query.endTime).toBe(cutoff);
    if (query.series[0].where.includes('service:"quiet"')) return Response.json({ data: [] });
    return Response.json({ data: [{ group: ['a::b', 'error'], 'series_0.data': '5' }, { group: ['a::b', 'error'], 'series_0.data': 2 }] });
  });
  const module = createHyperdxModule({ apiKey: 'fake', services: ['one', 'two', 'quiet'] }, 'TTEAM', 'fake', fetcher, () => time);
  const registry = new ModuleRegistry([module]), postChannel = vi.fn().mockResolvedValue('1.2');
  const run = (job: any) => dispatchJob(sql, readConfig(env), registry, { send: vi.fn(), postChannel }, job);
  await module.initialize!(sql);
  await module.initialize!(sql);
  const schedule = (await sql.query('SELECT * FROM jobs')).rows;
  expect(schedule).toHaveLength(1);
  expect(await run(schedule[0])).toEqual(new Date(cutoff));
  await sql.query("INSERT INTO hyperdx_channels(team,channel_id) VALUES('TTEAM','CTEST'),('TTEAM','COTHER')");
  time = cutoff + 1000;
  expect(await run(schedule[0])).toEqual(new Date(cutoff + 86_400_000));
  await run(schedule[0]);
  const reports = (await sql.query("SELECT * FROM jobs WHERE payload->>'type'='report'")).rows;
  expect(reports).toHaveLength(6);
  await sql.query("DELETE FROM hyperdx_channels WHERE channel_id='COTHER'");
  await sql.query("INSERT INTO hyperdx_channels(team,channel_id) VALUES('TTEAM','COTHER')");
  for (const report of reports.filter(job => job.payload.channel === 'COTHER')) await run(report);
  expect(fetcher).not.toHaveBeenCalled();
  const activeChannel = reports.filter(job => job.payload.channel === 'CTEST');
  await run(activeChannel.find(job => job.payload.service === 'quiet'));
  expect(postChannel).not.toHaveBeenCalled();
  const selected = activeChannel.filter(job => job.payload.service !== 'quiet');
  postChannel.mockRejectedValueOnce(new SlackDeliveryRejected('rate limited', 'ratelimited', 120));
  expect(await run(selected[0])).toEqual(new Date(time + 120_000));
  await run(selected[0]);
  expect(postChannel.mock.lastCall?.[1].text).toContain('7 × a::b');
  await run(selected[0]);
  postChannel.mockRejectedValueOnce(new Error('connection lost'));
  await expect(run(selected[1])).rejects.toThrow();
  await run(selected[1]);
  expect(postChannel).toHaveBeenCalledTimes(3);
  expect((await sql.query('SELECT state FROM hyperdx_deliveries ORDER BY state')).rows).toEqual([{ state: 'sent' }, { state: 'uncertain' }]);
});

it('omits services with no occurrences and propagates query failures', async () => {
  const report = (response: Response) => readReport('fake', 'svc', Date.UTC(2026, 0, 1, 6), async () => response);
  await expect(report(Response.json({ data: [] }))).resolves.toBeUndefined();
  await expect(report(Response.json({ data: [{ group: ['example', 'warn'], 'series_0.data': '0' }] }))).resolves.toBeUndefined();
  await expect(report(Response.json({ error: 'bad key' }, { status: 401 }))).rejects.toThrow();
  await expect(report(Response.json({}))).rejects.toThrow();
});

it('configures a shared destination through the DM picker and rejects a stale activation', async () => {
  const channel = 'CPICK', actor = { team: 'TPICK', user: 'UALICE', channel: 'DALICE' };
  const info = { id: channel, name: 'monitoring', is_channel: true, is_member: true };
  const module = createHyperdxModule({ apiKey: 'fake', services: ['svc'] }, actor.team, 'bot',
    async url => Response.json(String(url).includes('conversations.info') ? { ok: true, channel: info } : { ok: true, channels: [info] }));
  const registry = new ModuleRegistry([module]);
  await module.initialize!(sql);
  const saved: AgentMessage[] = [];
  const messenger = { send: vi.fn(), async post(_actor: unknown, message: AgentMessage) { saved.push(message); return '10.11'; },
    async update(_actor: unknown, _ts: string, message: AgentMessage) { saved.push(message); } };
  const run = (route: ReturnType<ModuleRegistry['text']>, id: string) =>
    dispatchJob(sql, readConfig(env), registry, messenger, { ...route, actor, id });
  await run(registry.text('hyperdx channels'), 'pick-open');
  const click = async (button: NonNullable<AgentMessage['buttons']>[number], id: string) => {
    const route = registry.action(button.action, button.value);
    await run({ ...route, payload: { ...route.payload, timestamp: '10.11' } }, id);
  };
  const row = () => saved.at(-1)!.table!.rowButtons![0]!;
  expect(row().action).toBe('hyperdx:channel_add');
  await click(row(), 'pick-add');
  expect(row().action).toBe('hyperdx:channel_remove');
  const staleRemove = row();
  await click(staleRemove, 'pick-remove');
  expect(row().action).toBe('hyperdx:channel_add');
  await click(row(), 'pick-readd');
  await click(staleRemove, 'pick-stale-remove');
  expect((await sql.query('SELECT channel_id FROM hyperdx_channels WHERE team=$1', [actor.team])).rows).toEqual([{ channel_id: channel }]);
});
