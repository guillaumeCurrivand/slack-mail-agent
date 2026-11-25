import { z } from 'zod';
import { BudgetExceeded } from '../core/budget.js';
import { ownerKey, type Actor } from '../core/identity.js';
import type { AssistantModule, ModuleContext } from '../core/modules.js';
import { SlackDeliveryRejected } from '../core/slack.js';
import { requestPlan, type QuestionAIConfig } from '../core/question-ai.js';

const decision = z.strictObject({ source: z.string(), answer: z.string() });
const unavailable = 'Je ne peux pas répondre à cette question pour le moment. Réessayez dans un nouveau message.';
const clock = /^(?:(?:tell me\s+)?(?:what|which) time (?:is it|it is)|what['’]s the time|quelle heure est[- ]il|il est quelle heure)(?:\s+(?:now|in paris|à paris))?[\s?!.]*$/i;

export function mentionAssistant(config: QuestionAIConfig) {
  return async (actor: Actor, question: string, eventId: string, context: ModuleContext, sources: AssistantModule[]) => {
    const { sql, messenger, budget } = context;
    // A worker retry can redeliver a saved answer but cannot repeat a paid call.
    const key = [eventId, ownerKey(actor), actor.channel];
    const deliver = async (text: string) => {
      const claim = await sql.query(`UPDATE jobs SET payload=payload || '{"sending":true}'::jsonb
        WHERE id=$1 AND owner=$2 AND actor->>'channel'=$3 AND NOT (payload ? 'sending') RETURNING id`, key);
      if (!claim.rows.length) return;
      try { await messenger.send(actor, { text }); }
      catch (error) {
        if (error instanceof SlackDeliveryRejected) await sql.query("UPDATE jobs SET payload=payload-'sending' WHERE id=$1", [eventId]);
        throw error;
      }
    };
    const attempt = await sql.query(`UPDATE jobs SET payload=payload || '{"answerStarted":true}'::jsonb
      WHERE id=$1 AND owner=$2 AND actor->>'channel'=$3 AND module='core' AND payload->>'type'='mention'
      AND NOT (payload ? 'answerStarted') RETURNING id`, key);
    if (!attempt.rows.length) {
      const saved = (await sql.query("SELECT payload FROM jobs WHERE id=$1 AND owner=$2 AND actor->>'channel'=$3 AND module='core' AND payload->>'type'='mention'", key)).rows[0];
      if (saved) await deliver(saved.payload.answer ?? unavailable);
      return;
    }
    let answer: string;
    try {
      if (!question || question.length > 4000) answer = 'Mentionnez-moi avec une question de 4 000 caractères maximum.';
      else if (clock.test(question)) {
        const time = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }).format(new Date());
        answer = /quelle heure/i.test(question) ? `Il est ${time} à Paris.` : `It’s ${time} in Paris.`;
      } else {
        const named = /^([a-z][a-z0-9_-]*)[\s,:]+([\s\S]+)$/i.exec(question);
        let source = sources.find(m => m.id === named?.[1]?.toLowerCase());
        let lookup = question;
        let prose = '';
        if (source && named) lookup = named[2]!;
        else if (named?.[1]?.toLowerCase() === 'documentation') prose = actor.channel.startsWith('D')
          ? 'Le classeur Documentation n’est pas disponible dans cet espace.' : 'Posez cette question dans un message privé avec moi pour consulter la Documentation.';
        else if (!config.key) prose = 'L’assistant IA n’est pas configuré.';
        else {
          const result = decision.parse(JSON.parse(await requestPlan(config, actor, {
            model: config.model,
            instructions: 'Answer general questions concisely in the language and conversational register of the user, in plain prose. Mirror tu or vous when clear. You have no tools, live web, or action authority. For a question about internal projects, technologies, hosting or tools, select the available documentation source, even when no module name was given. Short project labels and a clarification pairing a project name with its acronym are also documentation lookups. Use only listed sources. If the information requires an unavailable internal source, say so and suggest asking in a private DM. Never invent company data, private account data or actions. Return source empty for a direct answer, or the exact source id and empty answer for a lookup.',
            input: JSON.stringify({ question, now: new Date().toISOString(), defaultTimezone: 'Europe/Paris', sources: sources.map(m => m.id) }),
            text: { format: { type: 'json_schema', name: 'mention_answer', strict: true, schema: z.toJSONSchema(decision, { target: 'draft-7' }) } },
          }, budget, async () => { /* attempt persisted before the provider call */ })));
          source = sources.find(m => m.id === result.source);
          prose = result.source ? unavailable : result.answer.trim();
        }
        answer = source?.answerQuestion && actor.channel.startsWith('D')
          ? await source.answerQuestion(actor, lookup, eventId, { ...context, budget: budget.forModule(source.id) })
          : prose || unavailable;
      }
    } catch (error) { answer = error instanceof BudgetExceeded ? error.message : unavailable; }
    answer = answer.slice(0, 9500);
    await sql.query("UPDATE jobs SET payload=jsonb_set(payload,'{answer}',to_jsonb($4::text)) WHERE id=$1 AND owner=$2 AND actor->>'channel'=$3", [...key, answer]);
    await deliver(answer);
  };
}
