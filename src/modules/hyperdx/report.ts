import { z } from 'zod';
import { escapeCardValue } from '../../core/slack.js';

const responseSchema = z.object({ data: z.array(z.object({
  group: z.tuple([z.string().nullable(), z.enum(['warn', 'error'])]),
  'series_0.data': z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number).pipe(z.number().int().nonnegative()),
})) });

export async function readReport(apiKey: string, service: string, cutoff: number, fetcher: typeof fetch) {
  const start = new Date(cutoff);
  start.setUTCDate(start.getUTCDate() - 1);
  start.setUTCHours(0, 0, 0, 0);
  const response = await fetcher('https://api.hyperdx.io/api/v1/charts/series', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ startTime: start.getTime(), endTime: cutoff, series: [{
      dataSource: 'events', aggFn: 'count', field: '',
      where: `(level:error OR level:warn) AND service:${JSON.stringify(service)}`, groupBy: ['message', 'level'],
    }] }),
  });
  if (!response.ok) throw new Error('HyperDX query failed.');
  const { data } = responseSchema.parse(await response.json());
  const groups = new Map<string, { message: string; level: string; count: number }>();
  for (const row of data) {
    if (row['series_0.data'] === 0) continue;
    const [message, level] = row.group, key = JSON.stringify(row.group);
    const group = groups.get(key) ?? { message: message ?? '[Message inconnu]', level, count: 0 };
    group.count += row['series_0.data'];
    groups.set(key, group);
  }
  if (!groups.size) return;
  const lines = [...groups.values()].sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
    .slice(0, 20).map(({ message, level, count }) =>
      `${level === 'error' ? '🔴' : '🟠'} ${count} × ${escapeCardValue(message.replace(/\s+/g, ' ').slice(0, 180))}`);
  const date = (value: Date) => value.toLocaleDateString('fr-FR', { timeZone: 'UTC' });
  return { kind: 'Bilan HyperDX', text: [escapeCardValue(service),
    `Du ${date(start)} à 00 h au ${date(new Date(cutoff))} à 06 h UTC.`,
    lines.join('\n')].join('\n\n') };
}
