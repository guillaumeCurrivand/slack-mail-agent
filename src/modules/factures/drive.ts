import { importPKCS8, SignJWT } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sql } from '../../core/store.js';

const fileId = z.string().regex(/^[\w-]+$/);
const serviceAccount = z.object({ client_email: z.email(), private_key: z.string().min(1) });

export function readArchiveConfig(env: NodeJS.ProcessEnv) {
  const folder = env.FACTURES_DRIVE_FOLDER_ID?.trim();
  if (!folder && !env.FACTURES_DRIVE_SERVICE_ACCOUNT_JSON?.trim()) return;
  return {
    folder: fileId.parse(folder),
    account: serviceAccount.parse(JSON.parse(env.FACTURES_DRIVE_SERVICE_ACCOUNT_JSON ?? 'null')),
  };
}

export async function openInvoiceArchive(config: NonNullable<ReturnType<typeof readArchiveConfig>>, sql: Sql, team: string, fetcher: typeof fetch) {
  const key = await importPKCS8(config.account.private_key, 'RS256');
  const oauth = 'https://oauth2.googleapis.com/token';
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/drive' })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(config.account.client_email).setAudience(oauth)
    .setIssuedAt().setExpirationTime('5m').sign(key);
  const tokenResponse = await fetcher(oauth, {
    method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) throw new Error('Factures Drive authorization unavailable.');
  const token = z.object({ access_token: z.string().min(1) }).parse(await tokenResponse.json()).access_token;
  const drive = 'https://www.googleapis.com/drive/v3';
  const request = (url: string, init: RequestInit = {}) => fetcher(url, {
    ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(30_000),
  });
  const folder = await request(`${drive}/files/${config.folder}?supportsAllDrives=true&fields=driveId,mimeType,trashed,capabilities(canAddChildren)`);
  if (!folder.ok) throw new Error('Factures Drive folder unavailable.');
  const target = z.object({ driveId: fileId, mimeType: z.literal('application/vnd.google-apps.folder'), trashed: z.literal(false),
    capabilities: z.object({ canAddChildren: z.literal(true) }) }).parse(await folder.json());

  return async (pdf: Buffer, period: string) => {
    const hash = createHash('sha256').update(pdf).digest('hex');
    const keys = [team, config.folder, hash];
    const lookup = () => sql.query('SELECT file_id, uploaded FROM factures_archives WHERE team=$1 AND folder=$2 AND digest=$3', keys);
    let record = (await lookup()).rows[0];
    if (!record) {
      const generated = await request(`${drive}/files/generateIds?count=1`);
      if (!generated.ok) throw new Error('Factures Drive file ID unavailable.');
      const { ids: [id] } = z.object({ ids: z.tuple([fileId]) }).parse(await generated.json());
      await sql.query('INSERT INTO factures_archives(team,folder,digest,file_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [...keys, id]);
      record = (await lookup()).rows[0];
    }
    if (!record.uploaded) {
      const boundary = randomUUID();
      const metadata = JSON.stringify({ id: record.file_id, name: `Facture-${period}-${hash.slice(0, 12)}.pdf`, parents: [config.folder] });
      const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
        pdf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
      const uploaded = await request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: new Uint8Array(body),
      });
      if (!uploaded.ok && uploaded.status !== 409) throw new Error('Factures Drive upload failed.');
      if (uploaded.status === 409) {
        const existing = await request(`${drive}/files/${record.file_id}?supportsAllDrives=true&fields=driveId,parents,trashed`);
        if (!existing.ok) throw new Error('Factures Drive upload outcome unavailable.');
        const match = z.object({ driveId: z.literal(target.driveId), parents: z.array(z.string()), trashed: z.literal(false) }).parse(await existing.json());
        if (!match.parents.includes(config.folder)) throw new Error('Factures Drive upload destination changed.');
      }
      await sql.query('UPDATE factures_archives SET uploaded=true WHERE team=$1 AND folder=$2 AND digest=$3', keys);
    }
    return `https://drive.google.com/file/d/${record.file_id}/view`;
  };
}
