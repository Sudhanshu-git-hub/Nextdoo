import { expect,it } from 'vitest';
import { parseCalendarIcs,calendarIcsExport } from './ics';
const cal=(body:string)=>'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'+body+'\r\nEND:VCALENDAR\r\n';
const event=(body:string)=>'BEGIN:VEVENT\r\n'+body+'\r\nEND:VEVENT';
const base='UID:a\r\nDTSTART:20260923T090000Z\r\nDTEND:20260923T100000Z\r\nSUMMARY:Lecture';
const parse=(body:string,zone='UTC')=>parseCalendarIcs(cal(body),zone,'2026-01-01','2027-01-01');
it('parses folded/escaped text, instants, location and exclusive all-day dates',()=>{
  const rows=parse(event(base+'\r\nDESCRIPTION:Line one\\nLine two\\, yes\r\nLOCATION:Room 1\r\nSUMMARY:Folded\r\n  title')+'\r\n'+event('UID:b\r\nDTSTART;VALUE=DATE:20260924\r\nDTEND;VALUE=DATE:20260926\r\nSUMMARY:Holiday'));
  expect(rows[0]).toMatchObject({description:'Line one\nLine two, yes',location:'Room 1',startsAt:'2026-09-23T09:00:00.000Z'});
  expect(rows[1]).toMatchObject({isAllDay:true,startDay:'2026-09-24',endDay:'2026-09-26'});
});
it('expands recurrence, exclusions and moved exceptions with original-slot identity',()=>{
  const rows=parse(event(base+'\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE:20260924T090000Z')+'\r\n'+event('UID:a\r\nRECURRENCE-ID:20260925T090000Z\r\nDTSTART:20260926T100000Z\r\nDTEND:20260926T110000Z\r\nSUMMARY:Moved'));
  expect(rows).toHaveLength(2);expect(rows[1]).toMatchObject({title:'Moved',startsAt:'2026-09-26T10:00:00.000Z',uid:'a!2026-09-25T09:00:00Z'});
});
it('uses IANA DST rules and the chosen zone for floating times',()=>{
  const rows=parse(event('UID:dst\r\nDTSTART;TZID=Europe/Berlin:20260328T090000\r\nDTEND;TZID=Europe/Berlin:20260328T100000\r\nRRULE:FREQ=DAILY;COUNT=3'));
  expect(rows.map(r=>r.startsAt)).toEqual(['2026-03-28T08:00:00.000Z','2026-03-29T07:00:00.000Z','2026-03-30T07:00:00.000Z']);
  expect(parse(event(base.replace(/Z/g,'')),'Asia/Kolkata')[0]!.startsAt).toBe('2026-09-23T03:30:00.000Z');
});
it('uses embedded VTIMEZONE without global timezone registration',()=>{
  const zone='BEGIN:VTIMEZONE\r\nTZID:Custom\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0530\r\nTZOFFSETTO:+0530\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n';
  const data=event('UID:z\r\nDTSTART;TZID=Custom:20260923T090000\r\nDTEND;TZID=Custom:20260923T100000');
  expect(parse(zone+data)[0]!.startsAt).toBe('2026-09-23T03:30:00.000Z');expect(()=>parse(data)).toThrow(/time zone/);
});
it('rejects malformed files, missing identities, dates, duplicates and unsupported recurrence',()=>{
  for(const text of ['not ICS',cal(''),cal(event(base)).replace('END:VCALENDAR',''),cal(event(base.replace('UID:a\r\n',''))),cal(event(base.replace('DTSTART:20260923T090000Z\r\n',''))),cal(event(base)+'\r\n'+event(base)),cal(event(base+'\r\nRRULE:FREQ=SECONDLY;COUNT=10')),cal(event(base+'\r\nRRULE:FREQ=MONTHLY;BYDAY=1MO')),cal(event(base.replace('100000Z','080000Z')))])expect(()=>parseCalendarIcs(text,'UTC','2026-01-01','2027-01-01')).toThrow();
});
it('enforces resource and window bounds and omits cancelled/outside-window events',()=>{
  expect(()=>parseCalendarIcs('a'.repeat(1000001),'UTC','2026-01-01','2027-01-01')).toThrow(/1 MB/);
  expect(()=>parseCalendarIcs(cal(event(base)),'UTC','2026-01-01','2030-01-01')).toThrow(/window/);
  expect(parse(event(base+'\r\nSTATUS:CANCELLED'))).toEqual([]);
  expect(parse(event(base.replaceAll('20260923','20270923')))).toEqual([]);
  expect(()=>parse(event(base+'\r\nRRULE:FREQ=DAILY;COUNT=10001'))).toThrow();
  expect(()=>parse(event(base+'\r\nRECURRENCE-ID:20260923T090000Z'))).toThrow(/matching series/);
});
it('exports safe escaped text and round-trips all-day/timed events with UTF-8 folding',()=>{
  const items=parse(event(base)+'\r\n'+event('UID:b\r\nDTSTART;VALUE=DATE:20260924\r\nDTEND;VALUE=DATE:20260925'));
  items[0]!.title='世界'.repeat(60);items[0]!.description='Text\nBEGIN:VEVENT;injection,\\';
  const output=calendarIcsExport('Name\nEND:VCALENDAR',items);
  expect(output.split('\r\n').every(line=>new TextEncoder().encode(line).length<=75)).toBe(true);
  const result=parseCalendarIcs(output,'UTC','2026-01-01','2027-01-01');expect(result[0]!.description).toBe(items[0]!.description);expect(result[0]!.title).toBe(items[0]!.title);expect(result[1]!.startDay).toBe('2026-09-24');
});
it('rejects invalid calendar dates and excludes events ending at the window boundary',()=>{
  expect(()=>parse(event(base.replaceAll('20260923','20260230')))).toThrow(/date/);
  expect(()=>parseCalendarIcs(cal(event(base)),'UTC','2026-02-30','2027-01-01')).toThrow(/window/);
  expect(parse(event('UID:before\r\nDTSTART;VALUE=DATE:20251231\r\nDTEND;VALUE=DATE:20260101'))).toEqual([]);
});
