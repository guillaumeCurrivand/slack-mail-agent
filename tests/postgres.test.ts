import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Budget } from '../src/core/budget.js';
import { schema } from '../src/app/schema.js';
import { JobStore, withOwner, type Sql } from '../src/core/store.js';
import { uid } from '../src/modules/mail/domain.js';
import { createDocumentationModule } from '../src/modules/documentation/index.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { dispatchJob } from '../src/core/dispatch.js';
import type { Actor } from '../src/core/identity.js';
import type { AgentMessage, Messenger } from '../src/core/slack.js';

const url = process.env.TEST_DATABASE_URL;
function documentationDispatch(sql: Sql, defaultActor: Actor) {
  const module = createDocumentationModule(sql), modules = new ModuleRegistry([module]);
  const options = { AI_MONTHLY_LIMIT_USD: 10, AI_USER_MONTHLY_LIMIT_USD: 10, AI_ALERT_USD: 8, SLACK_ADMIN_USER_ID: '' };
  const messages: AgentMessage[] = [];
  const messenger: Messenger = { async send(_actor, message) { messages.push(message); } };
  const text = async (request: string, actor = defaultActor) => {
    await dispatchJob(sql, options, modules, messenger, { ...modules.text(request), actor, id: uid() }); return messages.at(-1)!;
  };
  const confirm = (message: AgentMessage, actor = defaultActor) => {
    const control = message.buttons!.find(button => button.action.startsWith('documentation:confirm'))!;
    return dispatchJob(sql, options, modules, messenger, { ...modules.action(control.action, control.value), actor, id: uid() });
  };
  return { module, options, messenger, text, confirm };
}
describe.skipIf(!url)('real PostgreSQL concurrency', () => {
  const namespace = `test_${uid().replaceAll('-', '')}`;
  let admin: pg.Pool, pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${namespace}`);
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${namespace}`, application_name: namespace }); await pool.query(schema);
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
  it('atomically creates one shared Project and initial history under simultaneous confirmation deliveries', async () => {
    const module = createDocumentationModule(pool);
    await module.initialize!(pool); await module.initialize!(pool);
    const modules = new ModuleRegistry([module]);
    const alice = { team: 'TDOCS', user: 'UALICE', channel: 'DALICE' }, bob = { ...alice, user: 'UBOB', channel: 'DBOB' };
    const options = { AI_MONTHLY_LIMIT_USD: 10, AI_USER_MONTHLY_LIMIT_USD: 10, AI_ALERT_USD: 8, SLACK_ADMIN_USER_ID: '' };
    const messages: Array<AgentMessage & { actor: Actor }> = [];
    const messenger: Messenger = { async send(actor, message) { messages.push({ ...message, actor }); } };
    await dispatchJob(pool, options, modules, messenger, { ...modules.text('documentation create project {"name":"Concurrent"}'), actor: alice, id: uid() });
    const control = messages.find(message => message.kind === 'Create Project confirmation')!.buttons!.find(button => button.action === 'documentation:confirm_create')!;
    await Promise.all(Array.from({ length: 4 }, () => dispatchJob(pool, options, modules, messenger, { ...modules.action(control.action, control.value), actor: alice, id: uid() })));
    await dispatchJob(pool, options, modules, messenger, { ...modules.text('documentation projects'), actor: bob, id: uid() });
    expect(messages.at(-1)!.text).toContain('1 Projects');
    await dispatchJob(pool, options, modules, messenger, { ...modules.text('documentation history Concurrent'), actor: bob, id: uid() });
    expect(messages.at(-1)!.text).toContain('History page 1/1');
    expect(messages.at(-1)!.text).toContain('Actor: UALICE');
    expect(messages.at(-1)!.text).toContain('Before: No record');
  });

  it('waits for another actor to commit, overwrites selected fields using current values and never replays the effect', async () => {
    const alice = { team: 'TOVERWRITE', user: 'UALICE', channel: 'DALICE' }, bob = { ...alice, user: 'UBOB', channel: 'DBOB' };
    const { module, options, messenger, text, confirm } = documentationDispatch(pool, alice);
    await module.initialize!(pool);
    await confirm(await text('documentation create project {"name":"Shared","description":"Initial"}'));
    const a = await text('documentation edit project Shared {"description":"A"}');
    const b = await text('documentation edit project Shared {"description":"B","notes":"Bob notes"}', bob);
    const client = await pool.connect();
    let pending: Promise<void> | undefined;
    try {
      await client.query('BEGIN');
      const bobModules = new ModuleRegistry([createDocumentationModule(client)]);
      const control = b.buttons!.find(button => button.action === 'documentation:confirm_edit')!;
      await dispatchJob(client, options, bobModules, messenger, { ...bobModules.action(control.action, control.value), actor: bob, id: uid() });
      pending = confirm(a);
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        waiting = (await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1
          AND wait_event_type='Lock' AND query LIKE 'WITH eligible AS MATERIALIZED%'`, [namespace])).rows.length > 0;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting, 'Alice must wait on the shared Project while Bob holds its uncommitted edit').toBe(true);
      await client.query('COMMIT'); await pending;
      await Promise.all(Array.from({ length: 4 }, () => confirm(a)));
      const current = await text('documentation project Shared', bob);
      expect(current.text).toContain('description: A'); expect(current.text).toContain('notes: Bob notes');
      const history = await module.menu!(bob, `history_${current.text.match(/Identifier: ([\w-]+)/)![1]}_2`, { sql: pool });
      expect(history.text).toContain('History page 3/3');
      expect(history.text).toContain('Actor: UALICE');
      expect(history.text).toContain('Before:\ndescription: B\nAfter:\ndescription: A');
      await confirm(await text('documentation edit project Shared {"description":"Later"}', bob), bob);
      await confirm(a);
      expect((await text('documentation project Shared')).text).toContain('description: Later');
    } finally {
      try { await client.query('ROLLBACK'); await pending; }
      finally { client.release(); }
    }
  });

  it('rolls back an edit, history and saved outcome on PostgreSQL failure and safely retries', async () => {
    const actor = { team: 'TROLLBACK', user: 'UALICE', channel: 'DALICE' };
    const { module, text, confirm } = documentationDispatch(pool, actor);
    await module.initialize!(pool);
    await confirm(await text('documentation create project {"name":"Atomic edit","notes":"Initial"}'));
    const edit = await text('documentation edit project Atomic edit {"notes":"Replacement"}');
    await pool.query(`CREATE FUNCTION reject_edit_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'history failure'; END; $$;
      CREATE TRIGGER reject_edit_history BEFORE INSERT ON documentation_history FOR EACH ROW EXECUTE FUNCTION reject_edit_history();`);
    try {
      await expect(confirm(edit)).rejects.toThrow('history failure');
      expect((await text('documentation project Atomic edit')).text).toContain('notes: Initial');
      expect((await text('documentation history Atomic edit')).text).toContain('History page 1/1');
    } finally { await pool.query('DROP TRIGGER reject_edit_history ON documentation_history; DROP FUNCTION reject_edit_history();'); }
    await confirm(edit); await confirm(edit);
    expect((await text('documentation project Atomic edit')).text).toContain('notes: Replacement');
    expect((await text('documentation history Atomic edit')).text).toContain('History page 1/2');
  });

  it.each(['technology', 'component', 'host', 'hosting'] as const)('serializes cross-User %s overwrites and concurrent confirmations with actual history', async kind => {
    const alice = { team: `TCATALOG${kind}`, user: 'UALICE', channel: 'DALICE' }, bob = { ...alice, user: 'UBOB', channel: 'DBOB' };
    const { module, options, messenger, text, confirm } = documentationDispatch(pool, alice);
    await module.initialize!(pool); await module.initialize!(pool);
    await confirm(await text('documentation create project {"name":"Parent"}'));
    const parent = (await text('documentation project Parent')).text.match(/Identifier: ([\w-]+)/)![1]!;
    let componentId = '', serviceId = '';
    if (kind === 'hosting') {
      const component = await text(`documentation create component ${JSON.stringify({ name: 'Parent component', projectId: parent })}`);
      await confirm(component); componentId = component.text.match(/Component: ([\w-]+)/)![1]!;
      const service = await text('documentation create host {"name":"Parent service"}');
      await confirm(service); serviceId = service.text.match(/Host\/service: ([\w-]+)/)![1]!;
    }
    const initial = kind === 'technology' ? { name: 'Shared', category: 'Initial', notes: 'Initial' }
      : kind === 'component' ? { name: 'Shared', projectId: parent, type: 'Initial', technologies: [] }
      : kind === 'host' ? { name: 'Shared', role: 'Initial', notes: 'Initial' }
      : { componentId, serviceId, environment: 'Initial', notes: 'Initial' };
    const field = { technology: 'category', component: 'type', host: 'role', hosting: 'environment' }[kind];
    const lookup = kind === 'hosting' ? 'hosting-entry' : kind;
    const creation = await text(`documentation create ${kind} ${JSON.stringify(initial)}`);
    await Promise.all(Array.from({ length: 4 }, () => confirm(creation)));
    const id = creation.text.match(/(?:Technology|Component|Host\/service|Hosting entry): ([\w-]+)/)![1]!;
    const a = await text(`documentation edit ${kind} ${id} ${JSON.stringify({ [field]: 'A' })}`);
    const b = await text(`documentation edit ${kind} ${id} ${JSON.stringify({ [field]: 'B', ...(kind === 'component' ? { name: 'Bob name' } : { notes: 'Bob notes' }) })}`, bob);
    const client = await pool.connect(); let pending: Promise<void> | undefined;
    try {
      await client.query('BEGIN');
      const bobModules = new ModuleRegistry([createDocumentationModule(client)]);
      const control = b.buttons!.find(button => button.action === `documentation:confirm_edit_${kind}`)!;
      await dispatchJob(client, options, bobModules, messenger, { ...bobModules.action(control.action, control.value), actor: bob, id: uid() });
      pending = confirm(a);
      const deadline = Date.now() + 5000; let waiting = false;
      while (Date.now() < deadline) {
        waiting = (await pool.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1
          AND wait_event_type='Lock' AND query LIKE 'WITH eligible AS MATERIALIZED%'`, [namespace])).rows.length > 0;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting, 'Alice must wait for the shared record held by Bob').toBe(true);
      await client.query('COMMIT'); await pending;
      await Promise.all(Array.from({ length: 4 }, () => confirm(a)));
      const current = await text(`documentation ${lookup} ${id}`);
      expect(current.text).toContain(`${field}: A`);
      expect(current.text).toContain(kind === 'component' ? 'name: Bob name' : 'notes: Bob notes');
      const history = await module.menu!(alice, `history${kind}_${id}_2`, { sql: pool });
      expect(history.text).toContain('History page 3/3');
      expect(history.text).toContain(`Before:\n${field}: B\nAfter:\n${field}: A`);
      await confirm(await text(`documentation edit ${kind} ${id} ${JSON.stringify({ [field]: 'Later' })}`, bob), bob);
      await confirm(a); await confirm(creation);
      expect((await text(`documentation ${lookup} ${id}`)).text).toContain(`${field}: Later`);
    } finally { try { await client.query('ROLLBACK'); await pending; } finally { client.release(); } }
  });
});
