import type { Actor, IntegrationActor } from '../../core/identity.js';
import type { AssistantModule } from '../../core/modules.js';
import type { MenuPage } from '../../core/navigation.js';
import { SlackDeliveryRejected } from '../../core/slack.js';
import { JobStore, type Sql } from '../../core/store.js';
import { monthPattern, parisMonth, parisTime, shiftMonth } from './calendar.js';
import { openInvoiceArchive, readArchiveConfig } from './drive.js';
import { findBillingEmails, MissingInvoiceLabel, openBillingMailbox, readFacturesConfig, readInvoicePdf } from './gmail.js';

export { readArchiveConfig, readFacturesConfig };

const guide = 'Le module consulte les e-mails de facturation libellés dans la boîte Google autorisée pour les fournisseurs configurés. En DM, ouvrez Factures dans le menu ou envoyez factures mois dernier, factures ce mois ou factures 2026-11. Les boutons et les commandes consultent la boîte en lecture seule. L’opérateur configure les personnes autorisées et peut activer un récapitulatif le 5 du mois à 9 h (heure de Paris) et la copie des PDF joints dans Drive. Les factures disponibles via un portail se récupèrent depuis le mail source. Aucun appel d’IA pour la collecte ou le récapitulatif.';
const notAllowed = 'La consultation des factures est réservée aux personnes autorisées par l’administrateur.';
const periods = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
const dates = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeZone: 'Europe/Paris' });
const summarize = (period: string) => `Factures · ${periods.format(parisTime(period))}`;
const labels = { pdf: 'PDF joint', portail: 'Lien vers le portail', 'à vérifier': 'Document à vérifier' };
const back = [{ label: 'Retour aux factures', page: 'main' }];

export function createFacturesModule(config: ReturnType<typeof readFacturesConfig>, archive: ReturnType<typeof readArchiveConfig>, team: string,
  fetcher = fetch, now = Date.now): AssistantModule {
  const recipients = [...new Set(config.recipients)];
  const identity: IntegrationActor = { kind: 'integration', team, integration: 'factures' };
  const allowed = (actor: Actor) => actor.team === team && /^D[A-Z0-9]+$/.test(actor.channel) && recipients.includes(actor.user);
  const periodFor = (text: string, at: Date) => {
    const current = parisMonth(at);
    if (monthPattern.test(text)) return text;
    if (text === 'ce mois') return current;
    if (text === 'mois dernier') return shiftMonth(current, -1);
  };

  async function report(period: string, sql: Sql, scheduled = false): Promise<MenuPage> {
    const mailbox = await openBillingMailbox(config, fetcher);
    const emails = await findBillingEmails(config, period, mailbox);
    const save = scheduled && archive && emails.some(email => email.pdfs.length) ? await openInvoiceArchive(archive, sql, team, fetcher) : undefined;
    const lines = [];
    for (const email of emails) {
      const files = new Set<string>();
      if (save) {
        for (const part of email.pdfs) {
          const pdf = await readInvoicePdf(mailbox, email.id, part);
          if (pdf) files.add(await save(pdf, period));
        }
      }
      lines.push(`• ${email.provider} · ${dates.format(email.date)} · ${labels[email.document]} · [Mail source](${email.source})`
        + [...files].slice(0, 2).map((url, index) => ` · [PDF Drive ${index + 1}](${url})`).join('')
        + (files.size > 2 ? ` · [Tous les PDF](https://drive.google.com/drive/folders/${archive!.folder})` : ''));
    }
    const intro = lines.length ? lines.slice(0, 12).join('\n') : 'Aucun e-mail de facturation repéré.';
    const more = lines.length > 12 ? `\n${lines.length - 12} autre(s) e-mail(s) dans le libellé Gmail.` : '';
    const found = new Set(emails.map(email => email.provider));
    const missing = config.providers.filter(provider => !found.has(provider.name)).map(provider => provider.name);
    const outstanding = missing.length ? `\n\nAucun mail repéré pour ${missing.join(', ')}. Vérifiez le portail si une facture était attendue.` : '';
    return { kind: summarize(period), text: intro + more + outstanding, links: back };
  }

  async function readReport(period: string, sql: Sql) {
    try { return await report(period, sql); }
    catch (error) {
      return { kind: summarize(period),
        text: error instanceof MissingInvoiceLabel ? 'Le libellé Gmail configuré est introuvable. Demandez à l’administrateur de vérifier son nom.'
          : 'La boîte Factures est indisponible. Demandez à l’administrateur de vérifier la connexion Google.',
        links: back };
    }
  }

  return {
    id: 'factures', name: 'Factures', description: 'Retrouver les e-mails de facturation et les PDF archivés', help: { text: guide },
    async menu(actor, page, { sql }) {
      if (!allowed(actor)) return { kind: 'Factures', text: notAllowed };
      const month = periodFor(page === 'current' ? 'ce mois' : page === 'previous' ? 'mois dernier' : page, new Date(now()));
      if (month) return readReport(month, sql);
      return { kind: 'Factures', text: 'Choisissez une période pour consulter les e-mails de facturation.',
        links: [{ label: 'Mois dernier', page: 'previous' }, { label: 'Ce mois', page: 'current' }] };
    },
    async handle(actor, payload, _id, context) {
      if (!allowed(actor)) return context.messenger.send(actor, { kind: 'Factures', text: notAllowed });
      const period = periodFor(String(payload.text ?? '').trim().toLowerCase(), context.requestedAt);
      if (!period) return context.messenger.send(actor, { kind: 'Factures',
        text: 'Envoyez factures mois dernier, factures ce mois ou factures AAAA-MM. Le menu Factures propose les deux derniers mois.' });
      const report = await readReport(period, context.sql);
      const page: MenuPage = { ...report, links: [{ label: 'Retour aux factures', page: 'factures:main' }] };
      await context.messenger.send(actor, page);
    },
    async answerQuestion(actor, question, _id, context) {
      if (!allowed(actor)) return notAllowed;
      const period = periodFor(question.match(/\b20\d{2}-\d{2}\b/)?.[0] ??
        (/ce mois|mois en cours|this month/i.test(question) ? 'ce mois' : 'mois dernier'), context.requestedAt);
      if (!period) return 'Indique une période au format AAAA-MM.';
      const report = await readReport(period, context.sql);
      return `**${report.kind}**\n\n${report.text}`;
    },
    async initialize(sql) {
      await sql.query(`CREATE TABLE IF NOT EXISTS factures_deliveries (
        team text NOT NULL, period text NOT NULL, recipient text NOT NULL, state text NOT NULL, PRIMARY KEY(team,period,recipient))`);
      await sql.query(`CREATE TABLE IF NOT EXISTS factures_archives (
        team text NOT NULL, folder text NOT NULL, digest text NOT NULL, file_id text NOT NULL, uploaded boolean NOT NULL DEFAULT false,
        PRIMARY KEY(team,folder,digest))`);
      if (config.monthly) await new JobStore(sql).enqueueIntegration(`factures:${team}:schedule`, identity, { type: 'schedule' }, 'factures');
    },
    async handleIntegration(actor, payload, _id, { sql, messenger }) {
      if (actor.team !== team || actor.integration !== 'factures') return;
      const time = now(), current = parisMonth(new Date(time));
      if (payload.type === 'schedule') {
        const cutoff = parisTime(current, '05', '09');
        if (time < cutoff.getTime()) return cutoff;
        if (config.monthly) {
          const period = shiftMonth(current, -1), jobs = new JobStore(sql);
          for (const recipient of recipients) {
            await jobs.enqueueIntegration(`factures:${team}:${period}:${recipient}`, identity, { type: 'report', period, recipient }, 'factures');
          }
        }
        return parisTime(shiftMonth(current, 1), '05', '09');
      }
      const { period, recipient } = payload;
      if (!config.monthly || payload.type !== 'report' || typeof period !== 'string' || typeof recipient !== 'string' ||
        !monthPattern.test(period) || period !== shiftMonth(current, -1) || !recipients.includes(recipient)) return;
      const keys = [team, period, recipient];
      if ((await sql.query('SELECT 1 FROM factures_deliveries WHERE team=$1 AND period=$2 AND recipient=$3', keys)).rows.length) return;
      const message = await report(period, sql, true);
      const claim = await sql.query(`INSERT INTO factures_deliveries(team,period,recipient,state) VALUES($1,$2,$3,'sending')
        ON CONFLICT DO NOTHING RETURNING recipient`, keys);
      if (!claim.rows.length) return;
      try {
        await messenger.send({ team, user: recipient, channel: recipient }, message);
      } catch (error) {
        if (error instanceof SlackDeliveryRejected) {
          await sql.query('DELETE FROM factures_deliveries WHERE team=$1 AND period=$2 AND recipient=$3', keys);
          return new Date(time + Math.max(60, error.retryAfter ?? 0) * 1000);
        }
        await sql.query("UPDATE factures_deliveries SET state='uncertain' WHERE team=$1 AND period=$2 AND recipient=$3", keys);
        throw error;
      }
      await sql.query("UPDATE factures_deliveries SET state='sent' WHERE team=$1 AND period=$2 AND recipient=$3", keys);
    },
  };
}
