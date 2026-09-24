import type { InsightsReport } from './insights';

/** One snapshot feeds every format. A long-form CSV preserves every metric and its path. */
export function insightsExport(report:InsightsReport,format:'csv'|'json'){
  const filename=`nextdoo-insights-${report.window.from}-${report.window.to}.${format}`;
  if(format==='json')return {filename,type:'application/json',content:JSON.stringify(report,null,2)};
  const cell=(value:unknown)=>{let text=String(value??'');if(/^[\s]*[=+\-@]/.test(text)&&typeof value!=='number')text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
  const rows:unknown[][]=[['Metric path','Value']];
  const visit=(value:unknown,path:string)=>{if(value!==null&&typeof value==='object'){for(const [key,item] of Object.entries(value))visit(item,path?`${path}.${key}`:key);}else rows.push([path,value]);};
  visit(report,'');
  return {filename,type:'text/csv;charset=utf-8',content:rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n'};
}
