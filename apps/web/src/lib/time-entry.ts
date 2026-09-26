import { localParts, zonedTimeToUtc } from '@nextdoo/core/calendar';

export function workspaceDateTime(value: string, zone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Enter a date and time.');
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number,number,number,number,number];
  const at = zonedTimeToUtc(year,month,day,hour,minute,zone), p = localParts(at,zone);
  if (p.year!==year||p.month!==month||p.day!==day||p.hour!==hour||p.minute!==minute) throw new Error('This local time does not exist in the workspace timezone.');
  return at.toISOString();
}
export function entryLocalTime(value: string, zone: string) {
  const p=localParts(new Date(value),zone), pad=(n:number)=>String(n).padStart(2,'0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
export const durationLabel=(seconds:number)=>`${String(Math.floor(Math.max(0,seconds)/3600)).padStart(2,'0')}:${String(Math.floor(Math.max(0,seconds)%3600/60)).padStart(2,'0')}:${String(Math.floor(Math.max(0,seconds)%60)).padStart(2,'0')}`;
