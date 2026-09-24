import { uid, ownerKey, type Actor } from './identity.js';
import type { Sql } from './store.js';

export class BudgetExceeded extends Error { constructor() { super('The monthly AI allowance is exhausted or reserved by work already in progress. Commands that do not use AI remain available.'); } }
// Prices verified 2026-09-17; deliberately pin model and rates together. USD / million tokens.
export const PRICE_CARD = { 'gpt-4.1-mini-2025-04-14': { input: 0.4, cached: 0.1, output: 1.6 } } as const;
export const costMicro = (input: number, output: number) => Math.ceil(input * 0.4 + output * 1.6);
export class Budget {
  constructor(private sql: Sql, private limitMicro = 10_000_000, private userLimitMicro = 10_000_000, private module = 'core') {}
  async reserve(actor: Actor, amount: number, now = new Date()) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid budget reservation');
    const month = now.toISOString().slice(0, 7), id = uid();
    await this.sql.query('BEGIN');
    try {
      await this.sql.query('INSERT INTO ai_months(month) VALUES($1) ON CONFLICT DO NOTHING', [month]);
      const { rows } = await this.sql.query('SELECT * FROM ai_months WHERE month=$1 FOR UPDATE', [month]);
      const used = Number(rows[0].charged_micro) + Number(rows[0].reserved_micro);
      const perUser = await this.sql.query('SELECT COALESCE(SUM(COALESCE(charged_micro,reserved_micro)),0) AS used FROM ai_calls WHERE month=$1 AND owner=$2', [month, ownerKey(actor)]);
      if (used + amount > this.limitMicro || Number(perUser.rows[0].used) + amount > this.userLimitMicro) throw new BudgetExceeded();
      await this.sql.query('INSERT INTO ai_calls(id,month,owner,reserved_micro,module) VALUES($1,$2,$3,$4,$5)', [id, month, ownerKey(actor), amount, this.module]);
      await this.sql.query('UPDATE ai_months SET reserved_micro=reserved_micro+$2 WHERE month=$1', [month, amount]);
      await this.sql.query('COMMIT'); return id;
    } catch (error) { await this.sql.query('ROLLBACK'); throw error; }
  }
  async settle(id: string, amount: number) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid usage');
    await this.sql.query('BEGIN');
    try {
      const call = (await this.sql.query('SELECT * FROM ai_calls WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (call && call.status === 'reserved') {
        await this.sql.query('UPDATE ai_months SET reserved_micro=reserved_micro-$2,charged_micro=charged_micro+$3 WHERE month=$1', [call.month, call.reserved_micro, amount]);
        await this.sql.query("UPDATE ai_calls SET charged_micro=$2,status='settled' WHERE id=$1", [id, amount]);
      }
      await this.sql.query('COMMIT');
    } catch (error) { await this.sql.query('ROLLBACK'); throw error; }
  }
  async usage(now = new Date()) {
    const row = (await this.sql.query('SELECT * FROM ai_months WHERE month=$1', [now.toISOString().slice(0, 7)])).rows[0];
    return { charged: Number(row?.charged_micro ?? 0) / 1e6, reserved: Number(row?.reserved_micro ?? 0) / 1e6 };
  }
  async claimAlert(thresholdMicro: number) {
    const result = await this.sql.query('UPDATE ai_months SET alert_sent=true WHERE month=$1 AND NOT alert_sent AND charged_micro+reserved_micro >= $2 RETURNING month', [new Date().toISOString().slice(0, 7), thresholdMicro]);
    return result.rows.length > 0;
  }
  async releaseAlert() { await this.sql.query('UPDATE ai_months SET alert_sent=false WHERE month=$1', [new Date().toISOString().slice(0, 7)]); }
  async byModule(now = new Date()) {
    const result = await this.sql.query(`SELECT module, COALESCE(SUM(charged_micro),0) AS charged,
      COALESCE(SUM(CASE WHEN status='reserved' THEN reserved_micro ELSE 0 END),0) AS reserved
      FROM ai_calls WHERE month=$1 GROUP BY module ORDER BY module`, [now.toISOString().slice(0, 7)]);
    return result.rows.map(row => ({ module: String(row.module), charged: Number(row.charged) / 1e6, reserved: Number(row.reserved) / 1e6 }));
  }
}

export async function budgetReport(budget: Budget) {
  const now = new Date();
  const usage = await budget.usage(now), modules = await budget.byModule(now);
  return `Team AI usage this UTC calendar month: $${usage.charged.toFixed(4)} recorded, $${usage.reserved.toFixed(4)} reserved. All modules share the same allowance. Hosting is billed separately. Uncertain requests retain their reservation.${modules.map(m => `\n${m.module}: $${m.charged.toFixed(4)} recorded, $${m.reserved.toFixed(4)} reserved.`).join('')}`;
}
