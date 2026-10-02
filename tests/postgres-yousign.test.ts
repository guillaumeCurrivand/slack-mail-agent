import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreSchema, withWorkOwner } from '../src/core/store.js';
import { YousignStore } from '../src/modules/yousign/store.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('Yousign real PostgreSQL coordination', () => {
  const namespace = `test_yousign_${randomUUID().replaceAll('-', '')}`;
  const identity = { kind: 'integration' as const, team: 'TTEAM', integration: 'company' };
  const alice = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' }, bob = { ...alice, user: 'UBOB', channel: 'DBOB' };
  let admin: pg.Pool, pool: pg.Pool, store: YousignStore;
  const summary = () => ({ id: randomUUID(), name: 'signer.done', time: new Date().toISOString(), request: 'Synthetic contract' });
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${namespace}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${namespace}`, application_name: namespace });
    await pool.query(coreSchema); store = new YousignStore(pool, identity); await store.initialize();
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); await admin.end(); } });

  it('atomically accepts duplicate receipts and shared additions from distinct Users', async () => {
    await Promise.all([store.change(alice, randomUUID(), 'CPUBLIC'), store.change(bob, randomUUID(), 'CPUBLIC')]);
    expect(await store.destinations()).toHaveLength(1);
    const body = summary(); await Promise.all(Array.from({ length: 5 }, () => store.accept(body)));
    const saved = (await pool.query('SELECT id FROM yousign_events WHERE event_id=$1', [body.id])).rows;
    expect(saved).toHaveLength(1); expect(await store.deliveries(saved[0].id)).toHaveLength(1);
    expect((await pool.query("SELECT id FROM jobs WHERE payload->>'event'=$1", [saved[0].id])).rows).toHaveLength(1);
  });

  it('snapshots the committed activation after waiting for another connection’s removal/re-add transaction', async () => {
    const old = (await store.destinations())[0]!, next = randomUUID(), body = summary(), blocker = await pool.connect();
    let receipt: Promise<unknown> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT integration FROM yousign_integrations WHERE team=$1 AND integration=$2 FOR UPDATE', [identity.team, identity.integration]);
      receipt = store.accept(body);
      const deadline = Date.now() + 5000;
      while (true) {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT integration FROM yousign_integrations%'", [namespace]);
        if (waiting.rows.length) break;
        if (Date.now() > deadline) throw new Error('Receipt did not wait for the shared guard');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await blocker.query('UPDATE yousign_destinations SET active=false,removed_at=now() WHERE id=$1', [old.id]);
      await blocker.query('INSERT INTO yousign_destinations(id,team,integration,channel_id) VALUES($1,$2,$3,$4)', [next, identity.team, identity.integration, old.channel_id]);
      await blocker.query('COMMIT'); await receipt;
      const saved = (await pool.query('SELECT id FROM yousign_events WHERE event_id=$1', [body.id])).rows[0];
      expect((await store.deliveries(saved.id)).map(row => row.activation)).toEqual([next]);
    } finally { await blocker.query('ROLLBACK'); await receipt; blocker.release(); }
  });

  it('applies only one competing uncertain confirmation and isolates the integration worker lock from User work', async () => {
    const body = summary(); await store.accept(body);
    const saved = (await pool.query('SELECT id FROM yousign_events WHERE event_id=$1', [body.id])).rows[0];
    const delivery = (await store.deliveries(saved.id))[0]!;
    await store.claim(delivery.id); await store.finish(delivery.id, 'uncertain', undefined, 'uncertain');
    const first = await store.propose(alice, randomUUID(), delivery.id), second = await store.propose(bob, randomUUID(), delivery.id);
    const effects = await Promise.all([store.confirm(alice, first!), store.confirm(bob, second!)]);
    expect(effects.filter(Boolean)).toHaveLength(1);
    expect((await pool.query("SELECT id FROM jobs WHERE id LIKE 'yousign:resend:%' AND payload->>'event'=$1", [saved.id])).rows).toHaveLength(1);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), inside = new Promise<void>(resolve => { entered = resolve; });
    const held = withWorkOwner(pool, identity, async () => { entered(); await gate; }, 'yousign'); await inside;
    try {
      expect(await withWorkOwner(pool, identity, async () => true, 'yousign')).toBeUndefined();
      expect(await withWorkOwner(pool, alice, async () => true, 'yousign')).toBe(true);
    } finally { release(); await held; }
  });
});
