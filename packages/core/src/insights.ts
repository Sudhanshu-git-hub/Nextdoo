import { AppError,insightsQuerySchema,type InsightsWindow } from '@nextdoo/contracts';
import { localDateKey,localDayBounds,localParts,zonedTimeToUtc } from './calendar';
export function shiftInsightsDate(day:string,days:number){return new Date(Date.parse(day+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);}
export function insightsWindow(raw:unknown,timeZone:string,weekStart:number,now=new Date()):InsightsWindow {
  const q=insightsQuerySchema.parse(raw),today=localDateKey(now,timeZone),date=q.date??today;
  const at=(day:string)=>{const [y,m,d]=day.split('-').map(Number),value=zonedTimeToUtc(y!,m!,d!,12,0,timeZone);if(localDateKey(value,timeZone)!==day)throw new AppError('VALIDATION_FAILED','This date does not exist in the workspace time zone.');return value;};
  const p=localParts(at(date),timeZone);let from=date,to=date;
  const key=(y:number,m:number,d:number)=>new Date(Date.UTC(y,m-1,d,12)).toISOString().slice(0,10);
  if(q.period==='custom'){if(!q.from||!q.to)throw new AppError('VALIDATION_FAILED','Choose both custom dates.');from=q.from;to=q.to;}
  else if(q.from||q.to)throw new AppError('VALIDATION_FAILED','Custom dates require the custom period.');
  else if(q.period==='week'){const weekday=new Date(date+'T12:00:00Z').getUTCDay();from=shiftInsightsDate(date,-((weekday-weekStart+7)%7));to=shiftInsightsDate(from,6);}
  else if(q.period==='month'){from=key(p.year,p.month,1);to=key(p.year,p.month+1,0);}
  else if(q.period==='quarter'){const month=Math.floor((p.month-1)/3)*3+1;from=key(p.year,month,1);to=key(p.year,month+3,0);}
  else if(q.period==='year'){from=key(p.year,1,1);to=key(p.year,12,31);}
  const days=(Date.parse(to)-Date.parse(from))/86400000+1;
  if(days<1||days>366)throw new AppError('VALIDATION_FAILED','Choose a range of 1–366 local dates.');
  return {period:q.period,from,to,start:localDayBounds(at(from),timeZone).start.toISOString(),end:localDayBounds(at(to),timeZone).end.toISOString(),days,timeZone,complete:to<today};
}
export function previousInsightsWindow(window:InsightsWindow,weekStart:number,now=new Date()){
  return insightsWindow({period:'custom',from:shiftInsightsDate(window.from,-window.days),to:shiftInsightsDate(window.from,-1)},window.timeZone,weekStart,now);
}
