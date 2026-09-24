import { describe,it,expect } from 'vitest';
import { insightsWindow,previousInsightsWindow } from './insights';
import { personalTrackerStreaks } from './personal-tracker';
const now=new Date('2026-09-24T12:00:00Z');
describe('Insights local periods',()=>{
  it.each([
    ['day','2026-09-24','2026-09-24',1],['week','2026-09-21','2026-09-27',7],['month','2026-09-01','2026-09-30',30],['quarter','2026-07-01','2026-09-30',92],['year','2026-01-01','2026-12-31',365],
  ])('%s covers its full calendar period',(period,from,to,days)=>{expect(insightsWindow({period},'UTC',1,now)).toMatchObject({from,to,days,complete:false});});
  it('uses workspace date and configured week start',()=>{expect(insightsWindow({period:'week'},'Pacific/Kiritimati',0,new Date('2026-09-26T23:00:00Z'))).toMatchObject({from:'2026-09-27',to:'2026-10-03'});});
  it.each([['2026-03-08',23],['2026-11-01',25]])('resolves DST day %s',(date,hours)=>{const w=insightsWindow({period:'day',date},'America/New_York',1,now);expect((Date.parse(w.end)-Date.parse(w.start)+1)/3600000).toBe(hours);});
  it('allows leap years and compares equal numbers of dates',()=>{const w=insightsWindow({period:'year',date:'2024-02-01'},'UTC',1,now),p=previousInsightsWindow(w,1,now);expect(w.days).toBe(366);expect(p).toMatchObject({days:366,to:'2023-12-31',from:'2022-12-31',complete:true});});
  it('compares March with 31 adjacent dates, not the shorter February',()=>{const p=previousInsightsWindow(insightsWindow({period:'month',date:'2026-03-01'},'UTC',1,now),1,now);expect(p).toMatchObject({from:'2026-01-29',to:'2026-02-28',days:31});});
  it.each([{period:'custom'},{period:'custom',from:'2026-09-02',to:'2026-09-01'},{period:'custom',from:'2024-01-01',to:'2026-01-01'},{period:'day',from:'2026-01-01'},{period:'day',date:'2026-02-30'},{period:'day',workspaceId:'foreign'}])('rejects invalid or unbounded input %o',query=>expect(()=>insightsWindow(query,'UTC',1,now)).toThrow());
  it('rejects a calendar date skipped by a timezone change',()=>expect(()=>insightsWindow({period:'day',date:'2011-12-30'},'Pacific/Apia',1,now)).toThrow());
});
describe('range-bound recording streaks',()=>{
  const rows=(days:string[])=>days.map(day=>({day,stars:null,statusName:null}));
  it('deduplicates dates, excludes outside dates and resets at gaps',()=>expect(personalTrackerStreaks('2026-09-01','2026-09-06',rows(['2026-08-31','2026-09-01','2026-09-02','2026-09-02','2026-09-04','2026-09-05','2026-09-06']))).toEqual({longest:3,current:3}));
  it('does not claim a current streak with a missing ending date',()=>expect(personalTrackerStreaks('2026-09-01','2026-09-06',rows(['2026-09-01','2026-09-02']))).toEqual({longest:2,current:0}));
  it('handles empty data',()=>expect(personalTrackerStreaks('2026-09-01','2026-09-06',[])).toEqual({longest:0,current:0}));
});
