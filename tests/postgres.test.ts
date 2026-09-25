import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Budget } from '../src/core/budget.js';
import { schema } from '../src/app/schema.js';
import { JobStore, withOwner } from '../src/core/store.js';
import { uid } from '../src/modules/mail/domain.js';

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
        new Budget(a, 10_000_000, 10_000_000, 'mail').reserve({ team: 'T', user: 'A', channel: 'D' }, 6_000_000),
        new Budget(b, 10_000_000, 10_000_000, 'probe').reserve({ team: 'T', user: 'B', channel: 'D' }, 6_000_000),
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
  it('admits one active operation across workers and releases the slot after completion', async () => {
    const actor = { team: 'T', user: 'A', channel: 'D' };
    const first = new JobStore(pool), second = new JobStore(pool);
    await Promise.all([
      first.enqueueOperation('first', actor, { type: 'text', text: 'sort' }, 'mail', 'sort', 'Sort inbox'),
      second.enqueueOperation('second', actor, { type: 'text', text: 'sort' }, 'mail', 'sort', 'Sort inbox'),
    ]);
    const rows = (await pool.query("SELECT id,module,payload FROM jobs WHERE id IN ('first','second') ORDER BY id")).rows;
    expect(rows).toHaveLength(2);
    expect(rows.filter(row => row.module === 'mail')).toHaveLength(1);
    const original = rows.find(row => row.module === 'mail')!;
    expect(rows.find(row => row.module === 'core')!.payload).toMatchObject({ type: 'operation_busy', original: original.id });
    await first.complete(original.id);
    await first.enqueueOperation('third', actor, { type: 'text', text: 'sort' }, 'mail', 'sort', 'Sort inbox');
    expect((await pool.query("SELECT module FROM jobs WHERE id='third'")).rows[0].module).toBe('mail');
  });
  it('holds conflicting module work while core and another module can enter', async () => {
    const actor = { team: 'T', user: 'A', channel: 'D' };
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = withOwner(pool, actor, async () => { entered(); await gate; }, 'mail');
    await inside;
    try {
      expect(await withOwner(pool, actor, async () => 'conflict', 'mail')).toBeUndefined();
      expect(await withOwner(pool, actor, async () => 'menu', 'core')).toBe('menu');
      expect(await withOwner(pool, actor, async () => 'search', 'slack')).toBe('search');
      expect(await withOwner(pool, { ...actor, user: 'B' }, async () => 'other', 'mail')).toBe('other');
    } finally { release(); await first; }
  });
});
