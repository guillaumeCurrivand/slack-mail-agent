import { isDeepStrictEqual } from 'node:util';
import { ownerKey, type Actor } from '../../core/identity.js';
import { JobStore } from '../../core/store.js';
import { transaction, type Database } from '../../core/transactions.js';
import type { Project } from './domain.js';
import type { FolderChoice } from './providers.js';

export const configurationSchema = `CREATE TABLE IF NOT EXISTS development_configuration_forms (
 id text PRIMARY KEY, owner text NOT NULL, channel text NOT NULL, base jsonb, candidate jsonb,
 state text NOT NULL DEFAULT 'editing', created_at timestamptz NOT NULL DEFAULT now()
); ALTER TABLE development_configuration_forms ADD COLUMN IF NOT EXISTS thread text;
ALTER TABLE development_configuration_forms ADD COLUMN IF NOT EXISTS folders jsonb`;
export type ConfigurationForm = { id: string; owner: string; channel: string; thread?: string; folders?: FolderChoice[] | null; base: Project | null; candidate: Project | null; state: string };

export class ConfigurationStore {
  constructor(private db: Database) {}
  async get(actor: Pick<Actor, 'team' | 'user'>, id: string): Promise<ConfigurationForm | undefined> {
    return (await this.db.query("SELECT * FROM development_configuration_forms WHERE id=$1 AND owner=$2 AND created_at>=now()-interval '24 hours'", [id, ownerKey(actor)])).rows[0] as ConfigurationForm | undefined;
  }
  async create(actor: Actor, id: string, base: Project | null, candidate = base, folders?: FolderChoice[]) {
    await this.db.query('INSERT INTO development_configuration_forms(id,owner,channel,base,candidate,thread,folders) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [id, ownerKey(actor), actor.channel, base && JSON.stringify(base), candidate && JSON.stringify(candidate), actor.thread ?? null, folders ? JSON.stringify(folders) : null]);
    return this.get(actor, id);
  }
  async submit(actor: Pick<Actor, 'team' | 'user'>, id: string, candidate: Project) {
    return transaction(this.db, async sql => {
      const form = (await sql.query("SELECT * FROM development_configuration_forms WHERE id=$1 AND owner=$2 AND created_at>=now()-interval '24 hours' FOR UPDATE", [id, ownerKey(actor)])).rows[0] as ConfigurationForm | undefined;
      if (!form || (form.base && form.base.id !== candidate.id)) return false;
      if (form.state !== 'editing') return isDeepStrictEqual(form.candidate, candidate) && ['submitted', 'ready', 'applied'].includes(form.state);
      await sql.query("UPDATE development_configuration_forms SET candidate=$2,state='submitted' WHERE id=$1", [id, JSON.stringify(candidate)]);
      await new JobStore(sql).enqueue(`development:configuration:${id}`, { ...actor, channel: form.channel, ...(form.thread ? { thread: form.thread } : {}) }, { type: 'configuration_validate', form: id }, 'development');
      return true;
    });
  }
  async validated(actor: Actor, id: string) {
    await this.db.query("UPDATE development_configuration_forms SET state='ready' WHERE id=$1 AND owner=$2 AND channel=$3 AND state='submitted' AND created_at>=now()-interval '24 hours'", [id, ownerKey(actor), actor.channel]);
  }
  async finish(actor: Actor, id: string, cancel: boolean) {
    return transaction(this.db, async sql => {
      const form = (await sql.query("SELECT * FROM development_configuration_forms WHERE id=$1 AND owner=$2 AND channel=$3 AND created_at>=now()-interval '24 hours' FOR UPDATE", [id, ownerKey(actor), actor.channel])).rows[0] as ConfigurationForm | undefined;
      if (!form) return 'unavailable';
      if (['applied', 'cancelled', 'conflict'].includes(form.state)) return form.state === 'applied' ? 'already_applied' : form.state;
      if (!cancel && (form.state !== 'ready' || !form.candidate)) return 'unavailable';
      let state = 'cancelled';
      if (!cancel) {
        const candidate = form.candidate!;
        const changed = form.base
          ? await sql.query('UPDATE development_projects SET config=$3 WHERE team=$1 AND id=$2 AND config=$4::jsonb RETURNING id', [actor.team, form.base.id, JSON.stringify(candidate), JSON.stringify(form.base)])
          : await sql.query('INSERT INTO development_projects(team,id,config) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [actor.team, candidate.id, JSON.stringify(candidate)]);
        state = changed.rows.length ? 'applied' : 'conflict';
      }
      await sql.query('UPDATE development_configuration_forms SET state=$2 WHERE id=$1', [id, state]);
      return state;
    });
  }
}
