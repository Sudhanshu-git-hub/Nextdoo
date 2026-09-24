import ICAL from 'ical.js';
import { zonedTimeToUtc } from '@nextdoo/core';

export interface ImportedEvent { uid:string;title:string;description:string;location:string;startsAt:string;endsAt:string;timeZone:string;isAllDay:boolean;startDay:string|null;endDay:string|null; }
const fail=(message:string):never=>{throw new Error(message);};
const validZone=(zone:string)=>{try{new Intl.DateTimeFormat('en',{timeZone:zone});return true;}catch{return false;}};
const day=(t:ICAL.Time)=>`${String(t.year).padStart(4,'0')}-${String(t.month).padStart(2,'0')}-${String(t.day).padStart(2,'0')}`;
function validDate(value:string){const m=/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})Z?)?$/.exec(value);if(!m)return false;const y=Number(m[1]),month=Number(m[2]),d=Number(m[3]);return y>=1000&&month>=1&&month<=12&&d>=1&&d<=new Date(Date.UTC(y,month,0)).getUTCDate()&&(!m[4]||(Number(m[4])<24&&Number(m[5])<60&&Number(m[6])<60));}
function instant(t:ICAL.Time,zone:string) {
  if(t.zone.tzid==='UTC'||(t.zone.tzid!=='floating'&&!t.isDate))return t.toJSDate().toISOString();
  if(!validZone(zone))fail('This ICS time zone needs a VTIMEZONE definition or a supported IANA name.');
  const d=zonedTimeToUtc(t.year,t.month,t.day,t.hour,t.minute,zone);d.setUTCSeconds(t.second);return d.toISOString();
}
/** Bounded snapshot expansion. Never follows URLs, fetches attachments or installs global zones. */
export function parseCalendarIcs(content:string,timeZone:string,from:string,through:string):ImportedEvent[] {
  if(new TextEncoder().encode(content).length>1000000)fail('ICS file exceeds 1 MB.');
  if(!validZone(timeZone)||!validDate(from)||!validDate(through)||from.length!==10||through.length!==10||through<=from||Date.parse(through)-Date.parse(from)>3*366*86400000)fail('Choose an import window of at most three years.');
  try {
    const root=new ICAL.Component(ICAL.parse(content));
    if(root.name!=='vcalendar'||!content.trimEnd().endsWith('END:VCALENDAR'))fail('Upload a complete VCALENDAR file.');
    const components=root.getAllSubcomponents('vevent');if(!components.length||components.length>2000)fail('Choose a file containing 1–2000 events.');
    for(const component of components){
      for(const name of ['dtstart','dtend','recurrence-id','exdate','rdate'])for(const property of component.getAllProperties(name)){
        if(property.getParameter('range'))fail('Range recurrence exceptions need a pre-expanded ICS export.');
        for(const value of property.toJSON().slice(3))if(typeof value!=='string'||!validDate(value))fail('An event contains an invalid or unsupported calendar date.');
      }
      const start=component.getFirstProperty('dtstart'),end=component.getFirstProperty('dtend');
      if(start&&end&&(start.type!==end.type||start.getParameter('tzid')!==end.getParameter('tzid')))fail('Start and end must use the same date type and time zone.');
    }
    const result=new Map<string,ImportedEvent>();
    const masters=components.filter(c=>!c.hasProperty('recurrence-id'));
    if(new Set(masters.map(c=>String(c.getFirstPropertyValue('uid')))).size!==masters.length)fail('Duplicate series UID in this file.');
    for(const c of masters){
      const uid=String(c.getFirstPropertyValue('uid')??'');if(!uid||uid.length>300)fail('Each event needs a UID of at most 300 characters.');
      if(!c.hasProperty('dtstart'))fail('An event is missing DTSTART.');
      const exceptions=components.filter(e=>e.hasProperty('recurrence-id')&&e.getFirstPropertyValue('uid')===uid);
      const event=new ICAL.Event(c,{exceptions});
      for(const property of c.getAllProperties('rrule')){
        const rule=property.getFirstValue() as ICAL.Recur;
        if(!['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(rule.freq)||rule.interval<1||rule.interval>366||(rule.count??0)>10000)fail('Only bounded daily, weekly, monthly and yearly recurrence is supported.');
        if(Object.values(rule.parts).some(values=>values.length>31))fail('Recurrence is too complex for this import.');
        if(Object.keys(rule.parts).some(key=>key!=='BYDAY')||(rule.parts.BYDAY&&(rule.freq!=='WEEKLY'||rule.parts.BYDAY.some(d=>!['MO','TU','WE','TH','FR','SA','SU'].includes(d)))))fail('This recurrence pattern needs a pre-expanded ICS export. Weekly weekdays and plain daily/monthly/yearly rules are supported.');
      }
      const add=(start:ICAL.Time,end:ICAL.Time,item:ICAL.Event,key:string)=>{
        if(String(item.component.getFirstPropertyValue('status')).toUpperCase()==='CANCELLED')return;
        const zone=String(item.component.getFirstProperty('dtstart')?.getParameter('tzid')??(start.zone.tzid==='UTC'?'UTC':timeZone));
        const a=instant(start,zone),b=instant(end,zone);
        if(b<=a)fail('Every event must have a positive duration.');
        if(day(end)<from||(day(end)===from&&(end.isDate||(!end.hour&&!end.minute&&!end.second)))||day(start)>=through)return;
        const title=String(item.summary||'Untitled event'),description=String(item.description||''),location=String(item.location||'');
        if(title.length>500||description.length>20000||location.length>1000)fail('An event exceeds supported text limits.');
        result.set(key,{uid:key,title,description,location,startsAt:a,endsAt:b,timeZone:validZone(zone)?zone:timeZone,isAllDay:start.isDate,startDay:start.isDate?day(start):null,endDay:end.isDate?day(end):null});
        if(result.size>2000)fail('More than 2000 occurrences. Choose a smaller import window.');
      };
      if(!event.isRecurring()){add(event.startDate,event.endDate,event,uid);continue;}
      const iterator=event.iterator();let steps=0;
      for(let next=iterator.next();next;next=iterator.next()){
        if(++steps>10000)fail('Recurrence expansion limit reached. Export a smaller calendar window.');
        if(day(next)>=through)break;
        const detail=event.getOccurrenceDetails(next);add(detail.startDate,detail.endDate,detail.item,uid+'!'+next.toString());
      }
      // A later original slot may have been moved into this snapshot window.
      for(const exception of exceptions){const item=new ICAL.Event(exception);add(item.startDate,item.endDate,item,uid+'!'+item.recurrenceId.toString());}
    }
    if(components.some(c=>c.hasProperty('recurrence-id')&&!masters.some(m=>m.getFirstPropertyValue('uid')===c.getFirstPropertyValue('uid'))))fail('A recurrence exception has no matching series.');
    return [...result.values()].sort((a,b)=>a.startsAt.localeCompare(b.startsAt)||a.uid.localeCompare(b.uid));
  }catch(error){throw new Error(error instanceof Error?error.message:'Malformed ICS file.');}
}

/** Authenticated file export, not a published subscription. Text is escaped to prevent property injection. */
export function calendarIcsExport(name:string,events:ImportedEvent[]) {
  const escape=(s:string)=>s.replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
  const stamp=(s:string)=>new Date(s).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//NextDoo//Calendar Center//EN','X-WR-CALNAME:'+escape(name)];
  for(const e of events)lines.push('BEGIN:VEVENT','UID:'+escape(e.uid),'DTSTAMP:'+stamp(new Date().toISOString()),e.isAllDay?'DTSTART;VALUE=DATE:'+e.startDay!.replace(/-/g,''):'DTSTART:'+stamp(e.startsAt),e.isAllDay?'DTEND;VALUE=DATE:'+e.endDay!.replace(/-/g,''):'DTEND:'+stamp(e.endsAt),'SUMMARY:'+escape(e.title),'DESCRIPTION:'+escape(e.description),'LOCATION:'+escape(e.location),'END:VEVENT');
  lines.push('END:VCALENDAR');
  return lines.map(line=>{let result='',bytes=0;for(const char of line){const size=new TextEncoder().encode(char).length;if(bytes+size>74){result+='\r\n ';bytes=1;}result+=char;bytes+=size;}return result;}).join('\r\n')+'\r\n';
}
