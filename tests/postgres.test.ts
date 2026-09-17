import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Budget } from '../src/ai.js';
import { schema, withOwner } from '../src/store.js';
import { uid } from '../src/domain.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('real PostgreSQL concurrency', () => {
  const namespace = `test_${uid().replaceAll('-', '')}`;
  let admin: pg.Pool, pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${namespace}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${namespace}` }); await pool.query(schema);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); await admin.end(); } });
  it('admits only one of two simultaneous requests that together exceed the team allowance', async () => {
    const a = await pool.connect(), b = await pool.connect();
    try {
      const results = await Promise.allSettled([
        new Budget(a).reserve({ team: 'T', user: 'A', channel: 'D' }, 6_000_000),
        new Budget(b).reserve({ team: 'T', user: 'B', channel: 'D' }, 6_000_000),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
      expect((await new Budget(a).usage()).reserved).toBe(6);
    } finally { a.release(); b.release(); }
  });
  it('serializes work for the same user while allowing another user to proceed', async () => {
    const actor = { team: 'T', user: 'A', channel: 'D' };
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withOwner(pool, actor, async () => { entered(); await gate; return 'first'; });
    await inside;
    try {
      expect(await withOwner(pool, actor, async () => 'second')).toBeUndefined();
      expect(await withOwner(pool, { ...actor, user: 'B' }, async () => 'other')).toBe('other');
    } finally { release(); await first; }
  });
});
