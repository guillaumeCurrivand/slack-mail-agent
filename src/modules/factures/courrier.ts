import { ownerKey, type Actor } from '../../core/identity.js';
import type { JobPayload } from '../../core/modules.js';
import { boundMenuTarget, type MenuPage } from '../../core/navigation.js';
import type { Sql } from '../../core/store.js';
import { escapeCardValue } from '../../core/slack.js';
import { findBillingEmails, type LabelledMailReader } from './gmail.js';

type Label = { id: string; name: string };
type MailConnection = Omit<LabelledMailReader, 'labelId'> & {
  mailbox: string;
  connectionId: string;
  labels(): Promise<Label[]>;
  current(): Promise<boolean>;
};
export type CourrierSource = (actor: Actor, sql: Sql) => Promise<MailConnection | undefined>;
type Selection = { connection_id: string; label_id: string };
export const sourceActions = ['use_mail_label', 'remove_mail_label'] as const;

export const sourceSchema = `CREATE TABLE IF NOT EXISTS factures_mail_sources (
  owner text PRIMARY KEY, connection_id text, label_id text, changed_at timestamptz NOT NULL, event_id text NOT NULL,
  CHECK ((connection_id IS NULL) = (label_id IS NULL))
)`;

export async function selectedSource(actor: Actor, sql: Sql): Promise<Selection | undefined> {
  return (await sql.query('SELECT connection_id,label_id FROM factures_mail_sources WHERE owner=$1 AND label_id IS NOT NULL',
    [ownerKey(actor)])).rows[0];
}

const valueOf = (selection: Selection) => JSON.stringify([selection.connection_id, selection.label_id]);
const explainConnection = 'Connectez d’abord votre Gmail dans Courrier, puis revenez ici pour choisir un libellé.';
const unavailable = 'La boîte Courrier est indisponible. Vérifiez la connexion Gmail dans Courrier et réessayez.';
const personalPage = (text: string): MenuPage => ({ kind: 'Factures · Ma boîte Courrier', text, links: [{ label: 'Retour aux factures', page: 'main' }] });

export async function courrierMenu(source: CourrierSource, actor: Actor, sql: Sql, choose = false): Promise<MenuPage> {
  const selected = await selectedSource(actor, sql);
  const connection = await source(actor, sql);
  const remove = selected ? [{ label: 'Retirer ma boîte', action: 'remove_mail_label', value: valueOf(selected), bound: true }] : [];
  if (!connection) return { ...personalPage(explainConnection), buttons: remove };
  if (!choose) {
    let label: Label | undefined;
    if (selected?.connection_id === connection.connectionId) {
      try { label = (await connection.labels()).find(entry => entry.id === selected.label_id); }
      catch { return { ...personalPage(unavailable), buttons: remove }; }
    }
    return {
      ...personalPage(label ? `Libellé autorisé · ${escapeCardValue(label.name)}. Les courriels sont consultés uniquement dans votre DM.`
        : 'Choisissez le libellé contenant vos factures. Seul ce libellé sera consulté pour vos relevés privés.'),
      buttons: remove,
      links: [
        ...(label ? [{ label: 'Mon mois dernier', page: 'personal_previous' }, { label: 'Mon mois en cours', page: 'personal_current' }] : []),
        { label: label ? 'Changer de libellé' : 'Choisir un libellé', page: 'personal_labels' },
        { label: 'Retour aux factures', page: 'main' },
      ],
    };
  }
  try {
    const labels = (await connection.labels()).filter(label => /^[\w-]{1,128}$/.test(label.id) && label.name.trim());
    if (!labels.length) return personalPage('Créez dans Gmail un libellé pour vos factures, puis revenez choisir ce libellé.');
    return {
      ...personalPage(`Consulter les messages d’un libellé dans ${escapeCardValue(connection.mailbox)}. Choisir une ligne autorise la lecture de ce seul libellé dans votre DM.`),
      table: {
        columns: ['Libellé Gmail'], literalText: true, rows: labels.map(label => [label.name]),
        rowButtonColumn: 'Actions',
        rowButtons: labels.map(label => ({ label: 'Choisir', action: 'use_mail_label',
          value: valueOf({ connection_id: connection.connectionId, label_id: label.id }), bound: true })),
      },
    };
  } catch { return personalPage(unavailable); }
}

export async function changeCourrierSource(source: CourrierSource, actor: Actor, sql: Sql, payload: JobPayload, eventId: string, at: Date): Promise<MenuPage> {
  const bound = await boundMenuTarget(sql, actor, payload.value, payload.timestamp);
  const stale = 'Ce choix a expiré. Rouvrez Factures pour choisir un libellé.';
  if (!bound) return personalPage(stale);
  const saved = (await sql.query('SELECT content FROM core_navigation_menus WHERE id=$1 AND owner=$2 AND channel=$3 AND timestamp=$4',
    [bound.target.id, ownerKey(actor), actor.channel, bound.target.timestamp])).rows[0]?.content as MenuPage | undefined;
  const choices = [...(saved?.buttons ?? []), ...(saved?.table?.rowButtons ?? []).flatMap(row => row ?? [])];
  const presented = choices.some(button => button.action === `factures:${payload.action}` && button.value === payload.value);
  if (!presented) return personalPage(stale);
  const [connectionId, labelId]: [string, string] = JSON.parse(bound.value);
  const remove = payload.action === 'remove_mail_label';
  if (remove) {
    const selected = await selectedSource(actor, sql);
    if (!selected || valueOf(selected) !== bound.value) return personalPage(stale);
  } else {
    const connection = await source(actor, sql);
    if (!connection || connection.connectionId !== connectionId) return personalPage(stale);
    try {
      if (!(await connection.labels()).some(label => label.id === labelId) || !await connection.current()) return personalPage(stale);
    } catch { return personalPage(unavailable); }
  }
  await sql.query(`INSERT INTO factures_mail_sources(owner,connection_id,label_id,changed_at,event_id) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(owner) DO UPDATE SET connection_id=excluded.connection_id,label_id=excluded.label_id,
      changed_at=excluded.changed_at,event_id=excluded.event_id
    WHERE (factures_mail_sources.changed_at,factures_mail_sources.event_id) < (excluded.changed_at,excluded.event_id)`,
  [ownerKey(actor), remove ? null : connectionId, remove ? null : labelId, at, eventId]);
  return courrierMenu(source, actor, sql);
}

export async function personalBilling(source: CourrierSource, selection: Selection | undefined, actor: Actor, sql: Sql, period: string) {
  if (!selection) return { error: 'Ouvrez Factures → Utiliser ma boîte Courrier et choisissez un libellé.' };
  try {
    const connection = await source(actor, sql);
    if (!connection || connection.connectionId !== selection.connection_id) {
      return { error: 'Votre connexion Courrier a changé. Choisissez à nouveau un libellé dans Factures.' };
    }
    const label = (await connection.labels()).find(item => item.id === selection.label_id);
    if (!label) return { error: 'Ce libellé n’existe plus dans Gmail. Choisissez un autre libellé dans Factures.' };
    const emails = await findBillingEmails({ mailbox: connection.mailbox }, period, { ...connection, labelId: label.id });
    if (!await connection.current()) return { error: 'Votre connexion Courrier a changé. Rouvrez Factures.' };
    return { emails, label: label.name };
  } catch { return { error: unavailable }; }
}
