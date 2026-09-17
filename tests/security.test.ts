import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Vault, verifySlack } from '../src/crypto.js';
import { parseMail } from '../src/gmail.js';
import { createServer } from '../src/server.js';
import { schema, Store } from '../src/store.js';
import type { GoogleOAuth } from '../src/oauth.js';

it('rejects tampered Slack payloads and old or future signatures', () => {
  const raw = '{"event":"x"}', timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', 'secret').update(`v0:${timestamp}:${raw}`).digest('hex')}`;
  expect(verifySlack(raw, timestamp, signature, 'secret')).toBe(true);
  expect(verifySlack(raw + ' ', timestamp, signature, 'secret')).toBe(false);
  expect(verifySlack(raw, timestamp, signature, 'secret', Date.now() + 301_000)).toBe(false);
  expect(verifySlack(raw, timestamp, signature, 'secret', Date.now() - 301_000)).toBe(false);
});
it('binds encrypted credentials to their owner', () => {
  const vault = new Vault(randomBytes(32)), sealed = vault.seal({ refresh_token: 'private' }, 'T:U1');
  expect(vault.open(sealed, 'T:U1')).toEqual({ refresh_token: 'private' });
  expect(() => vault.open(sealed, 'T:U2')).toThrow();
});
it('reads text bodies without attachments or fetching linked content', () => {
  const encode = (text: string) => Buffer.from(text).toString('base64url');
  const mail = parseMail({ id: 'm', labelIds: ['INBOX'], historyId: '1', payload: { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: encode('Visible text') } }, { mimeType: 'text/html', body: { data: encode('<p>Duplicate</p>') } }] },
    { mimeType: 'text/plain', filename: 'secret.txt', body: { data: encode('Attachment contents') } },
  ] } });
  expect(mail.body).toBe('Visible text');
});

let db: PGlite, store: Store;
beforeAll(async () => { db = new PGlite(); await db.exec(schema); store = new Store({ query: (q, p) => db.query(q, p) }); });
afterAll(async () => db.close());
it('durably deduplicates signed DM events and ignores channels and other workspaces', async () => {
  const app = createServer({ SLACK_SIGNING_SECRET: 'secret', SLACK_TEAM_ID: 'TTEAM', PUBLIC_URL: 'https://agent.example.com' }, store, {} as GoogleOAuth);
  const request = async (body: unknown) => {
    const raw = JSON.stringify(body), ts = String(Math.floor(Date.now() / 1000));
    return app.inject({ method: 'POST', url: '/slack/events', payload: raw, headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': `v0=${createHmac('sha256', 'secret').update(`v0:${ts}:${raw}`).digest('hex')}` } });
  };
  const event = { type: 'event_callback', event_id: 'Ev1', team_id: 'TTEAM', event: { type: 'message', channel_type: 'im', channel: 'DALICE', user: 'UALICE', text: 'sort' } };
  expect((await request(event)).statusCode).toBe(200); expect((await request(event)).statusCode).toBe(200);
  expect((await request({ ...event, team_id: 'TOTHER' })).statusCode).toBe(403);
  expect((await request({ ...event, event_id: 'Ev2', event: { ...event.event, channel_type: 'channel', channel: 'CGENERAL' } })).statusCode).toBe(200);
  expect((await db.query('SELECT * FROM jobs')).rows).toHaveLength(1);
  expect((await app.inject({ method: 'POST', url: '/slack/events', payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
  await app.close();
});
