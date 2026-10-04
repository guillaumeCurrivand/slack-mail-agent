import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreSchema } from '../src/core/store.js';
import { developmentSchema, DevelopmentStore } from '../src/modules/development/store.js';
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
    await pool.query(coreSchema + developmentSchema); store = new DevelopmentStore(pool, 'TTEAM'); await store.save(project, 'setup');
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); await admin.end(); } });
  it('admits one snapshot under concurrent polls and one worker across projects sharing a repository', async () => {
    await Promise.all(Array.from({ length: 4 }, () => store.observe(project, ticket.id, ticket.status, ticket)));
    expect(await store.history(project.id)).toHaveLength(1);
    const other = { ...project, id: 'other', repository: `${project.repository}.git` }; await store.save(other, 'setup-other'); await store.observe(other, ticket.id, ticket.status, ticket);
    const claims = await Promise.all(Array.from({ length: 4 }, () => store.claim(randomUUID(), ['pilot', 'other'])));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});
