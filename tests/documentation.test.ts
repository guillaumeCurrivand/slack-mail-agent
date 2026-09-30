import { createHmac, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readConfig } from '../src/app/config.js';
import { createModules } from '../src/app/modules.js';
import { dispatchJob } from '../src/core/dispatch.js';
import { Budget } from '../src/core/budget.js';
import { createServer } from '../src/core/server.js';
import { Slack } from '../src/core/slack.js';
import { coreSchema, JobStore, type Sql } from '../src/core/store.js';

const alice = { team: 'TTEAM', user: 'UALICE', channel: 'DALICE' };
const bob = { ...alice, user: 'UBOB', channel: 'DBOB' };
const env = { PUBLIC_URL: 'https://agent.example.com', DATABASE_URL: 'postgresql://unused', SLACK_TEAM_ID: 'TTEAM', SLACK_BOT_TOKEN: 'token', SLACK_SIGNING_SECRET: 'secret', ENABLED_MODULES: 'documentation' };
let db: PGlite, sql: Sql;
beforeAll(async () => { db = new PGlite(); sql = { query: (text, values) => db.query(text, values) }; await db.exec(coreSchema); });
beforeEach(async () => {
  await db.exec(`TRUNCATE jobs,ai_calls,ai_months,core_navigation_menus,core_navigation_deliveries,core_operation_slots CASCADE;
    DROP TABLE IF EXISTS documentation_history,documentation_projects,documentation_confirmations,documentation_deliveries,documentation_lookups CASCADE;`);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external provider call'); }));
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => db.close());

type Posted = { method: string; body: any; ts: string };
function parts(message: Posted): any[] { return message.body.blocks.flatMap((block: any) => block.child_blocks ?? [block]); }
function buttons(message: Posted): any[] { return parts(message).filter(block => block.type === 'actions').flatMap(block => block.elements); }
function button(message: Posted, label: string) { const found = buttons(message).find(item => item.text.text === label); expect(found, label).toBeTruthy(); return found; }
function bodyText(message: Posted): string { return parts(message).filter(block => block.type === 'rich_text').flatMap(block => block.elements.flatMap((section: any) => section.elements.map((part: any) => part.text))).join('\n'); }
function kind(message: Posted): string { return message.body.blocks[0]?.title?.text; }

async function harness(enabled = 'documentation', team = 'TTEAM') {
  const moduleEnv = { ...env, ENABLED_MODULES: enabled, SLACK_TEAM_ID: team };
  const config = readConfig(moduleEnv);
  let modules = createModules(config, sql, moduleEnv);
  const initialize = async () => { for (const module of modules.all()) await module.initialize?.({ query: async text => (await db.exec(text)).at(-1)! }); };
  await initialize();
  const jobs = new JobStore(sql);
  let app = createServer(config, jobs, modules);
  const messages: Posted[] = [];
  let failure: 'reject' | 'uncertain' | undefined;
  const slack = new Slack('token', (async (url, options) => {
    const method = String(url).split('/').at(-1)!;
    expect(['chat.postMessage', 'chat.update']).toContain(method);
    const outcome = failure; failure = undefined;
    if (outcome === 'reject') return Response.json({ ok: false, error: 'ratelimited' });
    const body = JSON.parse(String(options?.body)), ts = body.ts ?? `1234567890.${messages.length + 1}`;
    messages.push({ method, body, ts });
    if (outcome === 'uncertain') throw new Error('Lost response after delivery');
    return Response.json({ ok: true, ts });
  }) as typeof fetch);
  const post = (path: string, raw: string, type: string, signed = true) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return app.inject({ method: 'POST', url: path, payload: raw, headers: { 'content-type': type, 'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signed ? `v0=${createHmac('sha256', 'secret').update(`v0:${timestamp}:${raw}`).digest('hex')}` : 'bad' } });
  };
  const enqueueText = (text: string, actor = alice, signed = true, id = randomUUID()) => post('/slack/events', JSON.stringify({ type: 'event_callback', team_id: actor.team, event_id: id,
    event: { type: 'message', channel_type: 'im', user: actor.user, channel: actor.channel, text } }), 'application/json', signed);
  const enqueueClick = (message: Posted, control: any, actor = alice, signed = true) => post('/slack/actions', new URLSearchParams({ payload: JSON.stringify({ type: 'block_actions', team: { id: actor.team }, user: { id: actor.user }, channel: { id: actor.channel }, message: { ts: message.ts },
    action_ts: randomUUID(), actions: [{ action_id: control.action_id, value: control.value }] }) }).toString(), 'application/x-www-form-urlencoded', signed);
  const drain = async () => {
    for (const job of (await sql.query("SELECT * FROM jobs WHERE status='queued' AND available_at<=now() ORDER BY created_at,id")).rows) {
      if (!modules.enabledIds().includes(job.module)) continue;
      await dispatchJob(sql, config, modules, slack, job); await jobs.complete(job.id);
    }
    return messages.at(-1)!;
  };
  const dm = async (text: string, actor = alice) => { expect((await enqueueText(text, actor)).statusCode).toBe(200); return drain(); };
  const click = async (message: Posted, label: string, actor = alice) => { expect((await enqueueClick(message, button(message, label), actor)).statusCode).toBe(200); return drain(); };
  return { get app() { return app; }, messages, dm, click, enqueueText, enqueueClick, drain, fail: (outcome: typeof failure) => { failure = outcome; },
    restart: async (ids = enabled) => { await app.close(); modules = createModules(readConfig({ ...moduleEnv, ENABLED_MODULES: ids }), sql, { ...moduleEnv, ENABLED_MODULES: ids }); await initialize(); app = createServer(config, jobs, modules); } };
}

it('creates a shared Project only after its owner confirms and lets another User read initial history without AI or Gmail', async () => {
  const h = await harness();
  try {
    const main = await h.dm('menu');
    const menu = await h.click(main, 'Documentation');
    expect(buttons(menu).map(item => item.text.text)).toEqual(['Projects', 'Add Project', 'History', 'Help', 'Back to menu']);
    const proposal = await h.dm('documentation create project {"name":"Alpha"}');
    expect(kind(proposal)).toBe('Create Project confirmation');
    expect(bodyText(proposal)).toContain('description: Unknown');
    expect(bodyText(await h.dm('documentation projects', bob))).toContain('No Projects');
    const saved = await h.click(proposal, 'Confirm creation');
    expect(kind(saved)).toBe('Project created');
    const details = await h.dm('documentation project Alpha', bob);
    expect(bodyText(details)).toContain('name: Alpha');
    const history = await h.click(details, 'History', bob);
    expect(bodyText(history)).toContain('UALICE');
    expect(bodyText(history)).toContain('Source: Slack structured creation');
    expect(bodyText(history)).toContain('Before: No record');
    expect(bodyText(history)).toContain('name: Alpha');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('overwrites only confirmed fields after another User edits them and records actual before/after history', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm('documentation create project {"name":"Original","description":"Initial","notes":"Initial notes"}'), 'Confirm creation');
    const details = await h.dm('documentation project Original');
    const id = bodyText(details).match(/Identifier: ([\w-]+)/)![1]!;
    expect(bodyText(await h.click(details, 'Edit'))).toContain(`documentation edit project ${id}`);
    const proposal = await h.dm(`documentation edit project ${id} {"name":"Alice name","description":"A"}`);
    expect(kind(proposal)).toBe('Edit Project confirmation');
    expect(bodyText(proposal)).toContain('name: Alice name');
    expect(bodyText(proposal)).not.toContain('notes:');
    expect(bodyText(await h.dm('documentation project Original', bob))).toContain('description: Initial');
    const bobProposal = await h.dm(`documentation edit project ${id} {"description":"B","notes":"Bob notes"}`, bob);
    await h.click(bobProposal, 'Confirm edit', bob);
    await h.click(proposal, 'Confirm edit');
    const after = await h.dm(`documentation project ${id}`, bob);
    expect(bodyText(after)).toContain('name: Alice name');
    expect(bodyText(after)).toContain('description: A');
    expect(bodyText(after)).toContain('notes: Bob notes');
    const history = await h.dm(`documentation history ${id}`, bob);
    expect(bodyText(history)).toContain('History page 1/3');
    const bobHistory = await h.click(history, 'Next', bob);
    const aliceHistory = await h.click(bobHistory, 'Next', bob);
    expect(bodyText(aliceHistory)).toContain('Actor: UALICE');
    expect(bodyText(aliceHistory)).toContain('Before:\nname: Original\ndescription: B');
    expect(bodyText(aliceHistory)).toContain('After:\nname: Alice name\ndescription: A');
    expect(bodyText(aliceHistory)).not.toContain('notes:');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('validates one-record edits, optional clearing, alias ambiguity and stable identity across renames', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm('documentation create project {"name":"Alpha","aliases":["Shared"],"notes":"Keep"}'), 'Confirm creation');
    await h.click(await h.dm('documentation create project {"name":"Other","aliases":["Shared"]}'), 'Confirm creation');
    expect(kind(await h.dm('documentation edit project Shared {"notes":"No"}'))).toBe('Ambiguous Project edit');
    expect(kind(await h.dm('documentation edit project Missing {"notes":"No"}'))).toBe('Project not found');
    for (const fields of [{}, { name: null }, { name: ' ' }, { name: 'Two\nLines' }, { aliases: [''] }, { id: 'x' }, { actor: 'x' }, { changed_at: 'x' }, { archived: true }, { repositories: ['javascript:alert(1)'] }, { notes: 'x'.repeat(1501) }, [{ name: 'A' }, { name: 'B' }]]) {
      expect(kind(await h.dm(`documentation edit project Alpha ${JSON.stringify(fields)}`))).toBe('Invalid Project edit');
    }
    const details = await h.dm('documentation project Alpha');
    const id = bodyText(details).match(/Identifier: ([\w-]+)/)![1]!;
    const pending = await h.dm('documentation edit project Alpha {"description":"Pending"}');
    const rename = await h.dm(`documentation edit project ${id} {"name":"  Renamed  ","aliases":["New alias"],"notes":null,"repositories":[]}`);
    await h.click(rename, 'Confirm edit');
    await h.click(pending, 'Confirm edit');
    const current = await h.dm('documentation project new ALIAS', bob);
    expect(bodyText(current)).toContain(`Identifier: ${id}`);
    expect(bodyText(current)).toContain('name: Renamed');
    expect(bodyText(current)).toContain('notes: Unknown');
    expect(bodyText(current)).toContain('repositories: []');
    expect(bodyText(current)).toContain('description: Pending');
    expect(kind(await h.dm('documentation project Alpha'))).toBe('Project not found');
    expect(bodyText(await h.dm(`documentation history ${id}`, bob))).toContain('History page 1/3');
    const shared = await h.dm('documentation history', bob);
    expect(kind(shared)).toBe('Shared history');
    expect(bodyText(shared)).toContain('History page 1/4');
    expect(kind(await h.click(shared, 'Next'))).toBe('Menu unavailable');
    expect(bodyText(await h.click(shared, 'Next', bob))).toContain('name: Other');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('binds edit confirmations to actor, DM, workspace and operation, with fixed expiry', async () => {
  const h = await harness(), foreign = await harness('documentation', 'TOTHER');
  try {
    const creation = await h.dm('documentation create project {"name":"Private edit"}');
    await h.enqueueClick(creation, { ...button(creation, 'Confirm creation'), action_id: 'documentation:confirm_edit' });
    expect(kind(await h.drain())).toBe('Confirmation unavailable');
    await h.click(creation, 'Confirm creation');
    const pending = await h.dm('documentation edit project Private edit {"notes":"Secret replacement"}');
    expect(kind(await h.click(pending, 'Confirm edit', bob))).toBe('Confirmation unavailable');
    expect(kind(await h.click(pending, 'Confirm edit', { ...alice, channel: 'DOTHER' }))).toBe('Confirmation unavailable');
    expect(kind(await foreign.click(pending, 'Confirm edit', { ...alice, team: 'TOTHER' }))).toBe('Confirmation unavailable');
    await h.enqueueClick(pending, { ...button(pending, 'Confirm edit'), action_id: 'documentation:confirm_create' });
    expect(kind(await h.drain())).toBe('Confirmation unavailable');
    await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '24 hours' WHERE id=$1", [button(pending, 'Confirm edit').value]);
    await h.restart();
    expect(kind(await h.click(pending, 'Confirm edit'))).toBe('Confirmation expired');
    expect(bodyText(await h.dm('documentation project Private edit'))).toContain('notes: Unknown');
    expect(bodyText(await h.dm('documentation history Private edit'))).toContain('History page 1/1');
  } finally { await h.app.close(); await foreign.app.close(); }
});

it('replays saved edit outcomes after intervening edits, restart, expiry and uncertain or rejected delivery', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm('documentation create project {"name":"Recovery edit"}'), 'Confirm creation');
    for (const failure of ['uncertain', 'reject'] as const) {
      const pending = await h.dm(`documentation edit project Recovery edit {"description":"${failure}"}`);
      await h.enqueueClick(pending, button(pending, 'Confirm edit'));
      h.fail(failure); await expect(h.drain()).rejects.toThrow();
      const count = h.messages.length;
      await sql.query("UPDATE jobs SET available_at=now()+interval '1 day' WHERE status='queued'");
      const later = await h.dm('documentation edit project Recovery edit {"description":"Later"}', bob);
      await h.click(later, 'Confirm edit', bob);
      await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '2 days' WHERE id=$1", [button(pending, 'Confirm edit').value]);
      await sql.query("UPDATE jobs SET available_at=now() WHERE status='queued'");
      await h.restart(); await h.drain();
      if (failure === 'uncertain') expect(h.messages.length).toBe(count + 2);
      else expect(kind(h.messages.at(-1)!)).toBe('Project edited');
      expect(kind(await h.click(pending, 'Confirm edit'))).toBe('Project edited');
      expect(bodyText(await h.dm('documentation project Recovery edit'))).toContain('description: Later');
    }
    expect(bodyText(await h.dm('documentation history Recovery edit'))).toContain('History page 1/5');
    const satisfied = await h.dm('documentation edit project Recovery edit {"description":"Later"}');
    expect(kind(await h.click(satisfied, 'Confirm edit'))).toBe('Edit already satisfied');
    await h.click(await h.dm('documentation edit project Recovery edit {"description":"New"}', bob), 'Confirm edit', bob);
    expect(kind(await h.click(satisfied, 'Confirm edit'))).toBe('Edit already satisfied');
    expect(bodyText(await h.dm('documentation project Recovery edit'))).toContain('description: New');
    expect(bodyText(await h.dm('documentation history Recovery edit'))).toContain('History page 1/6');
  } finally { await h.app.close(); }
});

it('rolls back edits and effect checkpoints when history fails, then records values current at retry', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm('documentation create project {"name":"Atomic edit","description":"Initial"}'), 'Confirm creation');
    const proposal = await h.dm('documentation edit project Atomic edit {"description":"A"}');
    await db.exec(`CREATE FUNCTION fail_edit_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'edit history unavailable'; END; $$;
      CREATE TRIGGER fail_edit_history BEFORE INSERT ON documentation_history FOR EACH ROW EXECUTE FUNCTION fail_edit_history();`);
    await h.enqueueClick(proposal, button(proposal, 'Confirm edit'));
    await expect(h.drain()).rejects.toThrow('edit history unavailable');
    await sql.query("UPDATE jobs SET available_at=now()+interval '1 day' WHERE status='queued'");
    expect(bodyText(await h.dm('documentation project Atomic edit', bob))).toContain('description: Initial');
    await db.exec('DROP TRIGGER fail_edit_history ON documentation_history; DROP FUNCTION fail_edit_history();');
    await h.click(await h.dm('documentation edit project Atomic edit {"description":"B"}', bob), 'Confirm edit', bob);
    await sql.query("UPDATE jobs SET available_at=now() WHERE status='queued'");
    await h.restart(); await h.drain();
    const initial = await h.dm('documentation history Atomic edit', bob);
    const bobChange = await h.click(initial, 'Next', bob);
    const aliceChange = await h.click(bobChange, 'Next', bob);
    expect(bodyText(aliceChange)).toContain('History page 3/3');
    expect(bodyText(aliceChange)).toContain('Before:\ndescription: B\nAfter:\ndescription: A');
  } finally { await h.app.close(); }
});

it('shows every value in long shared history and Projects grown by independent confirmed edits', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm('documentation create project {"name":"Long"}'), 'Confirm creation');
    const links = Array.from({ length: 10 }, (_, index) => `https://example.com/${index}/` + '-'.repeat(350));
    await h.click(await h.dm(`documentation edit project Long ${JSON.stringify({ repositories: links })}`), 'Confirm edit');
    await h.click(await h.dm(`documentation edit project Long ${JSON.stringify({ documentationLinks: links, notes: '*'.repeat(900) + 'FINAL VALUE' })}`), 'Confirm edit');
    let details = await h.dm('documentation project Long');
    let all = bodyText(details);
    while (buttons(details).some(control => control.text.text === 'More values')) { details = await h.click(details, 'More values'); all += bodyText(details); }
    expect(all).toContain('notes: ' + '*'.repeat(900) + 'FINAL VALUE');
    expect(all).toContain('documentationLinks: ' + JSON.stringify(links));
    await h.click(await h.dm(`documentation edit project Long ${JSON.stringify({ documentationLinks: links.map(url => url.replaceAll('-', '~')), notes: '*'.repeat(900) + 'FINAL REPLACEMENT' })}`), 'Confirm edit');
    let history = await h.dm('documentation history Long');
    for (let index = 0; index < 3; index++) history = await h.click(history, 'Next');
    let historyText = bodyText(history);
    while (buttons(history).some(control => control.text.text === 'More values')) { history = await h.click(history, 'More values'); historyText += bodyText(history); }
    expect(historyText).toContain('*'.repeat(900) + 'FINAL VALUE');
    expect(historyText).toContain('*'.repeat(900) + 'FINAL REPLACEMENT');
    expect(historyText).toContain('documentationLinks: ' + JSON.stringify(links.map(url => url.replaceAll('-', '~'))));
  } finally { await h.app.close(); }
});

it('preserves the saved edit target and expiry on proposal retry after a rename, and reports missing targets accurately', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm('documentation create project {"name":"Retry target"}'), 'Confirm creation');
    const initial = await h.dm('documentation project Retry target');
    const id = bodyText(initial).match(/Identifier: ([\w-]+)/)![1]!;
    await h.enqueueText('documentation edit project Retry target {"notes":"Original replacement"}');
    h.fail('reject'); await expect(h.drain()).rejects.toThrow('rejected');
    await sql.query("UPDATE jobs SET available_at=now()+interval '1 day' WHERE status='queued'");
    await h.click(await h.dm(`documentation edit project ${id} {"name":"New name"}`, bob), 'Confirm edit', bob);
    await h.click(await h.dm('documentation create project {"name":"Retry target"}', bob), 'Confirm creation', bob);
    await sql.query("UPDATE jobs SET available_at=now() WHERE status='queued'");
    await h.restart(); const retry = await h.drain();
    expect(bodyText(retry)).toContain(`Edit shared Project: ${id}`);
    await h.click(retry, 'Confirm edit');
    expect(bodyText(await h.dm('documentation project New name'))).toContain('notes: Original replacement');
    expect(bodyText(await h.dm('documentation project Retry target'))).toContain('notes: Unknown');
    const missing = await h.dm(`documentation edit project ${id} {"notes":"Missing"}`);
    // Simulate a damaged reference; record removal is not a supported User action.
    await sql.query("UPDATE documentation_confirmations SET target_id='missing-target' WHERE id=$1", [button(missing, 'Confirm edit').value]);
    expect(kind(await h.click(missing, 'Confirm edit'))).toBe('Edit failed');
    await h.restart(); expect(kind(await h.click(missing, 'Confirm edit'))).toBe('Edit failed');
    expect(bodyText(await h.dm('documentation project New name'))).toContain('notes: Original replacement');
    expect(bodyText(await h.dm('documentation history New name'))).toContain('History page 1/3');
  } finally { await h.app.close(); }
});

it('edits exact names and aliases containing braces with JSON braces inside replacement strings', async () => {
  const h = await harness();
  try {
    await h.click(await h.dm('documentation create project {"name":"Alpha {Beta}","aliases":["Alias {with braces}"]}'), 'Confirm creation');
    const notes = 'Literal {braces} and a nested-looking {"notes":"value"}';
    const named = await h.dm(`documentation edit project Alpha {Beta} ${JSON.stringify({ notes })}`);
    expect(kind(named)).toBe('Edit Project confirmation');
    expect(bodyText(named)).toContain(`notes: ${notes}`);
    await h.click(named, 'Confirm edit');
    const aliased = await h.dm('documentation edit project Alias {with braces} {"description":"Alias edit"}', bob);
    expect(kind(aliased)).toBe('Edit Project confirmation');
    await h.click(aliased, 'Confirm edit', bob);
    const current = await h.dm('documentation project Alpha {Beta}');
    expect(bodyText(current)).toContain(`notes: ${notes}`);
    expect(bodyText(current)).toContain('description: Alias edit');
  } finally { await h.app.close(); }
});

it('keeps confirmations private and saved effects unique across forged controls, duplicate clicks, restarts and delivery failures', async () => {
  const h = await harness();
  try {
    const proposal = await h.dm('documentation create project {"name":"Recovery"}');
    expect(kind(await h.click(proposal, 'Confirm creation', bob))).toBe('Confirmation unavailable');
    expect(kind(await h.click(proposal, 'Confirm creation', { ...alice, channel: 'DOTHER' }))).toBe('Confirmation unavailable');
    expect(bodyText(await h.dm('documentation projects', bob))).toContain('No Projects');
    await h.enqueueClick(proposal, button(proposal, 'Confirm creation'));
    h.fail('uncertain');
    await expect(h.drain()).rejects.toThrow('Lost response');
    const afterDelivery = h.messages.length;
    await h.restart(); await h.drain();
    expect(h.messages).toHaveLength(afterDelivery);
    await h.click(proposal, 'Confirm creation');
    const details = await h.dm('documentation project Recovery', bob);
    const history = await h.click(details, 'History', bob);
    expect(bodyText(history).match(/Source: Slack structured creation/g)).toHaveLength(1);
    expect(bodyText(await h.dm('documentation projects'))).toContain('page 1/1 · 1 Projects');
    const rejected = await h.dm('documentation create project {"name":"Rejected delivery"}');
    await h.enqueueClick(rejected, button(rejected, 'Confirm creation'));
    h.fail('reject'); await expect(h.drain()).rejects.toThrow('rejected');
    await h.restart(); await h.drain();
    expect(kind(h.messages.at(-1)!)).toBe('Project created');
    await h.click(rejected, 'Confirm creation');
    const again = await h.dm('documentation project Rejected delivery');
    expect(bodyText(await h.click(again, 'History')).match(/Source: Slack structured creation/g)).toHaveLength(1);
  } finally { await h.app.close(); }
});

it('pages shared Projects and ambiguous exact lookups privately, and renders saved links as links with all fixed values', async () => {
  const h = await harness();
  try {
    for (let index = 0; index < 9; index++) {
      const proposal = await h.dm(`documentation create project ${JSON.stringify({ name: `Project ${index}`, aliases: ['Shared alias'], description: 'A description', repositories: ['https://example.com/repo?q=1&branch=main'], documentationLinks: ['http://docs.example.com/alpha'], notes: 'Notes\nSecond line' })}`);
      expect(bodyText(proposal)).toContain('Notes\nSecond line');
      await h.click(proposal, 'Confirm creation');
    }
    const first = await h.dm('documentation projects', bob);
    expect(bodyText(first)).toContain('page 1/2 · 9 Projects');
    const wrongUser = await h.click(first, 'Next');
    expect(kind(wrongUser)).toBe('Menu unavailable');
    const second = await h.click(first, 'Next', bob);
    expect(second.ts).toBe(first.ts);
    expect(second.method).toBe('chat.update');
    expect(bodyText(second)).toContain('Project 8');
    expect(bodyText(second)).not.toContain('Project 0');
    const ambiguous = await h.dm('documentation project Shared alias', bob);
    expect(kind(ambiguous)).toBe('Choose a Project');
    expect(bodyText(ambiguous)).toContain('ambiguous');
    const choices = await h.click(ambiguous, 'Next', bob);
    const details = await h.click(choices, 'Project 8', bob);
    expect(bodyText(details)).toContain('notes: Notes\nSecond line');
    const links = parts(details).filter(part => part.type === 'rich_text').flatMap(part => part.elements.flatMap((section: any) => section.elements)).filter(part => part.type === 'link');
    expect(links.map(part => part.url)).toEqual(['https://example.com/repo?q=1&branch=main', 'http://docs.example.com/alpha']);
    const ambiguousHistory = await h.dm('documentation history Shared alias', bob);
    const selectedHistory = await h.click(ambiguousHistory, 'Project 0', bob);
    expect(kind(selectedHistory)).toBe('Project history');
    expect(bodyText(selectedHistory)).toContain('name: Project 0');
    expect(kind(await h.dm('documentation project Project', bob))).toBe('Project not found');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('shows exact literal values on the confirmation Card and rejects editable metadata, multiple records and unsafe links', async () => {
  const h = await harness();
  try {
    const notes = 'A&B <@UBOB> *bold* [forged](https://evil.example) !here';
    const proposal = await h.dm(`documentation create project ${JSON.stringify({ name: 'Literal', notes })}`);
    expect(bodyText(proposal)).toContain(`notes: ${notes}`);
    expect(parts(proposal).filter(part => part.type === 'rich_text').flatMap(part => part.elements.flatMap((section: any) => section.elements)).some(part => part.type === 'link')).toBe(false);
    for (const fields of [{ name: '' }, { name: 'A', id: 'editable' }, [{ name: 'A' }, { name: 'B' }], { name: 'A', repositories: ['javascript:alert(1)'] }, { name: 'A', notes: 'x'.repeat(1501) }, { name: 'A', repositories: ['https://user:secret@example.com'] }]) {
      expect(kind(await h.dm(`documentation create project ${JSON.stringify(fields)}`))).toBe('Invalid Project');
    }
    expect(bodyText(await h.dm('documentation projects'))).toContain('No Projects');
    await h.click(proposal, 'Confirm creation');
    expect(bodyText(await h.dm('documentation project Literal'))).toContain(`notes: ${notes}`);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('expires creation after 24 hours, preserves an applied outcome after expiry and does not refresh proposals on retry', async () => {
  const h = await harness();
  try {
    const old = await h.dm('documentation create project {"name":"Expired"}');
    await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '24 hours' WHERE id=$1", [button(old, 'Confirm creation').value]);
    await h.restart();
    expect(kind(await h.click(old, 'Confirm creation'))).toBe('Confirmation expired');
    expect(bodyText(await h.dm('documentation projects'))).toContain('No Projects');
    await h.enqueueText('documentation create project {"name":"Retry"}');
    h.fail('reject'); await expect(h.drain()).rejects.toThrow('rejected');
    await h.restart(); const proposal = await h.drain();
    const id = button(proposal, 'Confirm creation').value;
    await h.click(proposal, 'Confirm creation');
    await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '2 days' WHERE id=$1", [id]);
    expect(kind(await h.click(proposal, 'Confirm creation'))).toBe('Project created');
    expect(bodyText(await h.dm('documentation projects'))).toContain('1 Projects');
    expect(bodyText(await h.dm('documentation history Retry')).match(/Source: Slack structured creation/g)).toHaveLength(1);
    await h.enqueueText('documentation create project {"name":"Retry expired"}');
    h.fail('reject'); await expect(h.drain()).rejects.toThrow('rejected');
    await sql.query("UPDATE documentation_confirmations SET created_at=now()-interval '2 days' WHERE applied_at IS NULL");
    await h.restart(); const expiredRetry = await h.drain();
    expect(kind(await h.click(expiredRetry, 'Confirm creation'))).toBe('Confirmation expired');
    expect(bodyText(await h.dm('documentation projects'))).toContain('1 Projects');
  } finally { await h.app.close(); }
});

it('scopes shared Projects/history to the configured workspace even with the same User IDs in another installation', async () => {
  const h = await harness(), foreign = await harness('documentation', 'TOTHER');
  const otherAlice = { ...alice, team: 'TOTHER' };
  try {
    const proposal = await h.dm('documentation create project {"name":"Workspace private"}');
    await h.click(proposal, 'Confirm creation');
    const details = await h.dm('documentation project Workspace private');
    const identifier = bodyText(details).match(/Identifier: ([\w-]+)/)![1]!;
    expect(bodyText(await foreign.dm('documentation projects', otherAlice))).toContain('No Projects');
    expect(kind(await foreign.dm(`documentation project ${identifier}`, otherAlice))).toBe('Project not found');
    expect(kind(await foreign.dm(`documentation history ${identifier}`, otherAlice))).toBe('Project not found');
    expect(kind(await foreign.click(proposal, 'Confirm creation', otherAlice))).toBe('Confirmation unavailable');
    expect(kind(await foreign.click(details, 'History', otherAlice))).toBe('Menu unavailable');
    expect(bodyText(await h.dm('documentation projects'))).toContain('1 Projects');
  } finally { await h.app.close(); await foreign.app.close(); }
});

it('keeps signed ingress and workspace validation and pauses disabled Documentation with private navigation intact', async () => {
  const h = await harness();
  try {
    expect((await h.enqueueText('documentation projects', alice, false)).statusCode).toBe(401);
    expect((await h.enqueueText('documentation projects', { ...alice, team: 'TOTHER' })).statusCode).toBe(403);
    const menu = await h.dm('menu');
    const documentation = await h.click(menu, 'Documentation');
    const list = await h.click(documentation, 'Projects');
    expect(kind(await h.click(list, 'Back to menu'))).toBe('Menu');
    expect(kind(await h.click(menu, 'Documentation', bob))).toBe('Menu unavailable');
    const add = await h.click(documentation, 'Add Project');
    expect(bodyText(add)).toContain('documentation create project');
    expect(kind(await h.dm('projects'))).toBe('Help');
    const proposal = await h.dm('documentation create project {"name":"Paused"}');
    expect((await h.enqueueClick(proposal, button(proposal, 'Confirm creation'), { ...alice, team: 'TOTHER' })).statusCode).toBe(403);
    expect((await h.enqueueClick(proposal, button(proposal, 'Confirm creation'), alice, false)).statusCode).toBe(401);
    const deliveryId = randomUUID();
    await h.enqueueText('documentation create project {"name":"Queued"}', alice, true, deliveryId);
    await h.enqueueText('documentation create project {"name":"Queued"}', alice, true, deliveryId);
    await h.restart('');
    const count = h.messages.length;
    await h.drain(); expect(h.messages).toHaveLength(count);
    expect(buttons(await h.dm('menu')).map(item => item.text.text)).not.toContain('Documentation');
    expect(kind(await h.click(proposal, 'Confirm creation'))).toBe('Help');
    expect(kind(await h.click(menu, 'Documentation'))).toBe('Module unavailable');
    await h.restart();
    const queuedProposal = await h.drain();
    expect(kind(queuedProposal)).toBe('Create Project confirmation');
    await h.click(queuedProposal, 'Confirm creation');
    await h.click(proposal, 'Confirm creation');
    expect(bodyText(await h.dm('documentation projects', bob))).toContain('2 Projects');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});

it('retains lifetime inventory/history while cleaning expired private metadata and preserving checkpoints for pending jobs', async () => {
  const h = await harness();
  try {
    const proposal = await h.dm('documentation create project {"name":"Lifetime"}');
    await h.click(proposal, 'Confirm creation');
    await h.enqueueText('documentation create project {"name":"Pending delivery"}');
    h.fail('uncertain'); await expect(h.drain()).rejects.toThrow('Lost response');
    const attempts = h.messages.length;
    await db.exec(`UPDATE documentation_projects SET created_at=now()-interval '60 days';
      UPDATE documentation_history SET changed_at=now()-interval '60 days';
      UPDATE documentation_confirmations SET created_at=now()-interval '60 days';
      UPDATE documentation_deliveries SET created_at=now()-interval '60 days';`);
    const modules = createModules(readConfig(env), sql, env);
    await modules.all()[0]!.cleanup?.({} as any);
    await h.restart(); await h.drain();
    expect(h.messages).toHaveLength(attempts);
    const details = await h.dm('documentation project Lifetime', bob);
    expect(bodyText(details)).toContain('name: Lifetime');
    expect(bodyText(await h.click(details, 'History', bob))).toContain('name: Lifetime');
    expect(bodyText(await h.dm('documentation projects'))).toContain('1 Projects');
  } finally { await h.app.close(); }
});

it('rolls back the Project and confirmation effect if initial history fails, then safely retries the saved operation', async () => {
  const h = await harness();
  try {
    const proposal = await h.dm('documentation create project {"name":"Atomic"}');
    await db.exec(`CREATE FUNCTION fail_documentation_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'history unavailable'; END; $$;
      CREATE TRIGGER fail_history BEFORE INSERT ON documentation_history FOR EACH ROW EXECUTE FUNCTION fail_documentation_history();`);
    await h.enqueueClick(proposal, button(proposal, 'Confirm creation'));
    await expect(h.drain()).rejects.toThrow('history unavailable');
    await sql.query("UPDATE jobs SET available_at=now()+interval '1 day' WHERE status='queued'");
    expect(bodyText(await h.dm('documentation projects', bob))).toContain('No Projects');
    await db.exec('DROP TRIGGER fail_history ON documentation_history; DROP FUNCTION fail_documentation_history();');
    await sql.query("UPDATE jobs SET available_at=now() WHERE status='queued'");
    await h.restart(); await h.drain();
    expect(kind(h.messages.at(-1)!)).toBe('Project created');
    expect(bodyText(await h.dm('documentation history Atomic', bob)).match(/Source: Slack structured creation/g)).toHaveLength(1);
  } finally { await h.app.close(); }
});

it('keeps all delivered Documentation paths available when the shared AI allowance is exhausted', async () => {
  const h = await harness();
  try {
    await new Budget(sql, 10_000_000, 10_000_000, 'mail').reserve(alice, 10_000_000);
    await h.dm('documentation create project {"name":"No AI needed","aliases":["Budgetless"]}');
    const proposal = h.messages.find(message => kind(message) === 'Create Project confirmation')!;
    await h.click(proposal, 'Confirm creation');
    const project = await h.dm('documentation project Budgetless', bob);
    expect(bodyText(project)).toContain('name: No AI needed');
    const identifier = bodyText(project).match(/Identifier: ([\w-]+)/)![1]!;
    expect(bodyText(await h.dm(`documentation project ${identifier}`))).toContain('name: No AI needed');
    expect(bodyText(await h.dm('documentation history Budgetless', bob))).toContain('Source: Slack structured creation');
    const edit = await h.dm('documentation edit project Budgetless {"notes":"Still no AI needed"}', bob);
    expect(kind(await h.click(edit, 'Confirm edit', bob))).toBe('Project edited');
    expect(bodyText(await h.dm('documentation project Budgetless'))).toContain('notes: Still no AI needed');
    expect(kind(await h.dm('documentation'))).toBe('Documentation help');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  } finally { await h.app.close(); }
});
