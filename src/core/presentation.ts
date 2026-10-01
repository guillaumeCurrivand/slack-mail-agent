/** French display only: stored values, machine contracts and deadlines stay unchanged. */
export const formatDate = (value: Date | string | number) => `${new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value))} (Europe/Paris)`;
export const formatNumber = (value: number, digits?: number) => new Intl.NumberFormat('fr-FR', digits === undefined ? { maximumFractionDigits: 20 } : { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
export const retainedTextNotice = 'Texte enregistré avant le passage au français ; son contenu original est conservé.';
/** Presentation suffixes distinguish buttons in one Slack actions block. */
export function logicalAction(value: string): string | undefined {
  if (!value.includes('~')) return value;
  const match = /^([a-zA-Z0-9_:-]+)~button-(0|[1-9]\d{0,3})$/.exec(value);
  return match?.[1];
}
