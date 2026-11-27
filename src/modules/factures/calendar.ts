const paris = 'Europe/Paris';
const calendar = new Intl.DateTimeFormat('sv-SE', { timeZone: paris, year: 'numeric', month: '2-digit', day: '2-digit' });
const parisOffset = new Intl.DateTimeFormat('en', { timeZone: paris, timeZoneName: 'longOffset' });

export const monthPattern = /^20\d{2}-(?:0[1-9]|1[0-2])$/;
export const parisMonth = (date: Date) => calendar.format(date).slice(0, 7);

export function shiftMonth(period: string, offset: number) {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1 + offset, 1)).toISOString().slice(0, 7);
}

export function parisTime(period: string, day = '01', hour = '00') {
  const date = period + '-' + day;
  const offset = parisOffset.formatToParts(new Date(date + 'T12:00:00Z')).find(part => part.type === 'timeZoneName')!.value.slice(3);
  return new Date(date + 'T' + hour + ':00:00' + offset);
}
