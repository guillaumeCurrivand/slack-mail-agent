import type { Actor, IntegrationActor } from '../../core/identity.js';
import type { AssistantModule, ConnectionItem } from '../../core/modules.js';
import type { MenuPage } from '../../core/navigation.js';
import { escapeCardValue, SlackDeliveryRejected } from '../../core/slack.js';
import { JobStore, type Sql } from '../../core/store.js';
import { monthPattern, parisMonth, parisTime, shiftMonth } from './calendar.js';
import { openInvoiceArchive, readArchiveConfig } from './drive.js';
import { findBillingEmails, MissingInvoiceLabel, openBillingMailbox, readFacturesConfig, readInvoicePdf, type BillingEmail } from './gmail.js';
import { changeCourrierSource, courrierMenu, personalBilling, selectedSource, sourceActions, sourceSchema, type CourrierSource } from './courrier.js';

export { readArchiveConfig, readFacturesConfig };

const guide = 'En DM, ouvrez Factures dans le menu. Avec un Gmail déjà connecté dans Courrier, ouvrez Utiliser ma boîte Courrier et choisissez le libellé à consulter. Retirer ma boîte retire cette autorisation. Vos relevés Courrier restent privés. Envoyez factures mois dernier, factures ce mois ou factures 2026-11 pour consulter la source choisie. La boîte de production est accessible séparément aux utilisateurs autorisés. Son récapitulatif et son archivage Drive sont réglés par l’opérateur. La consultation n’utilise pas d’IA.';
const notAllowed = 'La consultation des factures est réservée aux personnes autorisées par l’administrateur.';
const periods = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
const dates = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeZone: 'Europe/Paris' });
const summarize = (period: string) => `Factures · ${periods.format(parisTime(period))}`;
const labels = { pdf: 'PDF joint', portail: 'Lien vers le portail', 'à vérifier': 'Document à vérifier' };
const back = [{ label: 'Retour aux factures', page: 'main' }];
const emailLine = (email: BillingEmail) => `• ${escapeCardValue(email.provider)} · ${dates.format(email.date)} · ${labels[email.document]} · [Mail source](${email.source})`;
const summarizeLines = (lines: string[]) => (lines.length ? lines.slice(0, 12).join('\n') : 'Aucun e-mail de facturation repéré.')
  + (lines.length > 12 ? `\n${lines.length - 12} autre(s) e-mail(s) dans le libellé Gmail.` : '');

export function createFacturesModule(config: ReturnType<typeof readFacturesConfig> | undefined, archive: ReturnType<typeof readArchiveConfig>, team: string,
  fetcher = fetch, now = Date.now, courrier?: CourrierSource): AssistantModule {
  const recipients = [...new Set(config?.recipients)];
  const identity: IntegrationActor = { kind: 'integration', team, integration: 'factures' };
  const privateAccess = (actor: Actor) => actor.team === team && /^D[A-Z0-9]+$/.test(actor.channel);
  const pilotAccess = (actor: Actor) => recipients.includes(actor.user);
  const periodFor = (text: string, at: Date) => {
    const current = parisMonth(at);
    if (monthPattern.test(text)) return text;
    if (text === 'ce mois') return current;
    if (text === 'mois dernier') return shiftMonth(current, -1);
  };

  async function report(period: string, sql: Sql, scheduled = false): Promise<MenuPage> {
    if (!config) throw new Error('Factures pilot is disabled.');
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
      lines.push(emailLine(email)
        + [...files].slice(0, 2).map((url, index) => ` · [PDF Drive ${index + 1}](${url})`).join('')
        + (files.size > 2 ? ` · [Tous les PDF](https://drive.google.com/drive/folders/${archive!.folder})` : ''));
    }
    const found = new Set(emails.map(email => email.provider));
    const missing = config.providers.filter(provider => !found.has(provider.name)).map(provider => provider.name);
    const outstanding = missing.length ? `\n\nAucun mail repéré pour ${missing.join(', ')}. Vérifiez le portail si une facture était attendue.` : '';
    return { kind: summarize(period), text: summarizeLines(lines) + outstanding, links: back };
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

  async function privateReport(actor: Actor, period: string, sql: Sql, personalOnly = false): Promise<MenuPage> {
    if (courrier) {
      const selected = await selectedSource(actor, sql);
      if (selected || personalOnly || !pilotAccess(actor)) {
        const personal = await personalBilling(courrier, selected, actor, sql, period);
        const text = personal.emails ? `Libellé Gmail · ${escapeCardValue(personal.label)}\n\n${summarizeLines(personal.emails.map(emailLine))}` : personal.error;
        return { kind: `${summarize(period)} · Courrier`, text, links: back };
      }
    }
    return !personalOnly && pilotAccess(actor) ? readReport(period, sql) : { kind: 'Factures', text: notAllowed, links: back };
  }

  return {
    id: 'factures', name: 'Factures', description: 'Retrouver les e-mails de facturation et les PDF archivés', help: { text: guide },
    menuActions: sourceActions,
    async connections(actor, sql) {
      const entries: ConnectionItem[] = [];
      if (!privateAccess(actor)) return entries;
      if (courrier) {
        const [source, connection] = await Promise.all([selectedSource(actor, sql), courrier(actor, sql)]);
        const status = !connection ? 'Gmail à connecter dans Courrier' : source?.connection_id === connection.connectionId
          ? 'Libellé autorisé' : 'Libellé à choisir';
        entries.push({ name: 'Gmail · Factures', scope: 'personal', status, account: connection?.mailbox, page: 'personal' });
      }
      if (config && pilotAccess(actor)) {
        entries.push({ name: 'Gmail · Factures de production', scope: 'workspace', status: 'Configuré par l’administrateur',
          account: config.mailbox, page: 'main' });
      }
      return entries;
    },
    async menu(actor, page, { sql }) {
      if (!privateAccess(actor) || (!courrier && !pilotAccess(actor))) return { kind: 'Factures', text: notAllowed };
      if (courrier && (page === 'personal' || page === 'personal_labels')) return courrierMenu(courrier, actor, sql, page === 'personal_labels');
      const at = new Date(now());
      if (courrier && (page === 'personal_current' || page === 'personal_previous')) {
        return privateReport(actor, periodFor(page === 'personal_current' ? 'ce mois' : 'mois dernier', at)!, sql, true);
      }
      const month = periodFor(page === 'current' ? 'ce mois' : page === 'previous' ? 'mois dernier' : page, at);
      if (month && pilotAccess(actor)) return readReport(month, sql);
      return { kind: 'Factures', text: 'Choisissez la boîte de facturation à consulter.', links: [
        ...(courrier ? [{ label: 'Utiliser ma boîte Courrier', page: 'personal' }] : []),
        ...(pilotAccess(actor) ? [{ label: 'Production · Mois dernier', page: 'previous' }, { label: 'Production · Ce mois', page: 'current' }] : []),
      ] };
    },
    async handle(actor, payload, id, context) {
      if (!privateAccess(actor) || (!courrier && !pilotAccess(actor))) return context.messenger.send(actor, { kind: 'Factures', text: notAllowed });
      let page: MenuPage;
      if (courrier && payload.type === 'menu_action' && sourceActions.some(action => action === payload.action)) {
        page = await changeCourrierSource(courrier, actor, context.sql, payload, id, context.requestedAt);
      } else {
        const period = periodFor(String(payload.text ?? '').trim().toLowerCase(), context.requestedAt);
        page = period ? await privateReport(actor, period, context.sql) : { kind: 'Factures',
          text: 'Envoyez factures mois dernier, factures ce mois ou factures AAAA-MM. Le menu Factures permet aussi de choisir votre boîte.', links: back };
      }
      const withLinks: MenuPage = { ...page, links: page.links?.map(link => ({ ...link, page: `factures:${link.page}` })) };
      await context.messenger.send(actor, withLinks);
    },
    async answerQuestion(actor, question, _id, context) {
      if (!privateAccess(actor)) return notAllowed;
      const period = periodFor(question.match(/\b20\d{2}-\d{2}\b/)?.[0] ??
        (/ce mois|mois en cours|this month/i.test(question) ? 'ce mois' : 'mois dernier'), context.requestedAt);
      if (!period) return 'Indique une période au format AAAA-MM.';
      const report = await privateReport(actor, period, context.sql);
      return `**${report.kind}**\n\n${report.text}`;
    },
    async initialize(sql) {
      await sql.query(sourceSchema);
      await sql.query(`CREATE TABLE IF NOT EXISTS factures_deliveries (
        team text NOT NULL, period text NOT NULL, recipient text NOT NULL, state text NOT NULL, PRIMARY KEY(team,period,recipient))`);
      await sql.query(`CREATE TABLE IF NOT EXISTS factures_archives (
        team text NOT NULL, folder text NOT NULL, digest text NOT NULL, file_id text NOT NULL, uploaded boolean NOT NULL DEFAULT false,
        PRIMARY KEY(team,folder,digest))`);
      if (config?.monthly) await new JobStore(sql).enqueueIntegration(`factures:${team}:schedule`, identity, { type: 'schedule' }, 'factures');
    },
    async handleIntegration(actor, payload, _id, { sql, messenger }) {
      if (actor.team !== team || actor.integration !== 'factures') return;
      const time = now(), current = parisMonth(new Date(time));
      if (payload.type === 'schedule') {
        const cutoff = parisTime(current, '05', '09');
        if (time < cutoff.getTime()) return cutoff;
        if (config?.monthly) {
          const period = shiftMonth(current, -1), jobs = new JobStore(sql);
          for (const recipient of recipients) {
            await jobs.enqueueIntegration(`factures:${team}:${period}:${recipient}`, identity, { type: 'report', period, recipient }, 'factures');
          }
        }
        return parisTime(shiftMonth(current, 1), '05', '09');
      }
      const { period, recipient } = payload;
      if (!config?.monthly || payload.type !== 'report' || typeof period !== 'string' || typeof recipient !== 'string' ||
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
