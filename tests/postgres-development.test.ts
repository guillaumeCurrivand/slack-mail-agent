import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreSchema } from '../src/core/store.js';
import { developmentSchema, DevelopmentStore } from '../src/modules/development/store.js';
import { configurationSchema, ConfigurationStore } from '../src/modules/development/configuration-store.js';
import type { Project, Ticket } from '../src/modules/development/domain.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('Development real PostgreSQL claims', () => {
  const namespace = `test_development_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Pool, pool: pg.Pool, store: DevelopmentStore;
  const project: Project = { id: 'pilot', name: 'Pilot', channel: 'CPROJECT', folder: '123', repository: 'https://github.com/example/project', skill: 'maintenance', enabled: true };
  const ticket: Ticket = { id: 'abc123', name: 'Fix', description: 'Fix it', status: 'Ready for AI', url: 'https://app.clickup.com/t/abc123', comments: [], attachments: [] };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${namespace}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${namespace}` });
    await pool.query(coreSchema + developmentSchema + configurationSchema); store = new DevelopmentStore(pool, 'TTEAM'); await store.save(project, 'setup');
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); await admin.end(); } });
  it('admits one snapshot under concurrent polls and one worker across projects sharing a repository', async () => {
    await Promise.all(Array.from({ length: 4 }, () => store.observe(project, ticket.id, ticket.status, ticket)));
    expect(await store.history(project.id)).toHaveLength(1);
    const other = { ...project, id: 'other', repository: `${project.repository}.git` }; await store.save(other, 'setup-other'); await store.observe(other, ticket.id, ticket.status, ticket);
    const claims = await Promise.all(Array.from({ length: 4 }, () => store.claim(randomUUID(), ['pilot', 'other'])));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
  it('applies concurrent confirmations only once and preserves a later opposite project transition', async () => {
    const actor = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
    const configured = { ...project, id: 'confirmations', repository: 'https://github.com/example/confirmations' };
    await store.save(configured, 'setup-confirmations');
    await store.propose(actor, 'pause-confirmation', configured, 'pause');
    const results = await Promise.all(Array.from({ length: 4 }, () => store.confirm(actor, 'pause-confirmation', false)));
    expect(results.filter(result => result === 'applied')).toHaveLength(1);
    expect((await store.project(configured.id))!.enabled).toBe(false);
    await store.propose(actor, 'resume-confirmation', { ...configured, enabled: false }, 'resume');
    expect(await store.confirm(actor, 'resume-confirmation', false)).toBe('applied');
    expect(await store.confirm(actor, 'pause-confirmation', false)).toBe('already_applied');
    expect((await store.project(configured.id))!.enabled).toBe(true);
  });
  it('serializes separate retry confirmations for the same blocked ticket', async () => {
    const actor = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
    const configured = { ...project, id: 'retry-confirmations', repository: 'https://github.com/example/retries' };
    await store.save(configured, 'setup-retries');
    await store.review(configured, ticket, '1.000001', 'blocked-review');
    const run = (await store.history(configured.id))[0];
    await pool.query("UPDATE development_runs SET state='blocked' WHERE id=$1", [run.id]);
    await store.propose(actor, 'retry-one', configured, 'retry', run.id);
    await store.propose(actor, 'retry-two', configured, 'retry', run.id);
    const results = await Promise.all(['retry-one', 'retry-two'].map(id => store.confirm(actor, id, false)));
    expect(results.filter(result => result === 'applied')).toHaveLength(1);
    expect(await store.history(configured.id)).toHaveLength(2);
  });
  it('atomically accepts one competing form creation and one competing edit', async () => {
    const forms = new ConfigurationStore(pool);
    const alice = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' }, bob = { team: 'TTEAM', user: 'UBOB', channel: 'DBOB' };
    const candidate = { ...project, id: 'form-race', enabled: false };
    for (const [actor, id] of [[alice, 'create-alice'], [bob, 'create-bob']] as const) {
      await forms.create(actor, id, null);
      await forms.submit(actor, id, candidate);
      await forms.validated(actor, id);
    }
    const created = await Promise.all([forms.finish(alice, 'create-alice', false), forms.finish(bob, 'create-bob', false)]);
    expect(created.sort()).toEqual(['applied', 'conflict']);
    for (const [actor, id] of [[alice, 'edit-alice'], [bob, 'edit-bob']] as const) {
      await forms.create(actor, id, candidate);
      await forms.submit(actor, id, { ...candidate, name: actor.user });
      await forms.validated(actor, id);
    }
    const edited = await Promise.all([forms.finish(alice, 'edit-alice', false), forms.finish(bob, 'edit-bob', false)]);
    expect(edited.sort()).toEqual(['applied', 'conflict']);
    const saved = await store.project(candidate.id);
    await forms.finish(alice, 'edit-alice', false);
    await forms.finish(bob, 'edit-bob', false);
    expect(await store.project(candidate.id)).toEqual(saved);
  });
});
