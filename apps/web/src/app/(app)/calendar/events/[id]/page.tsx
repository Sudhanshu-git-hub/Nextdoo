import { CalendarEventPage } from '@/components/CalendarEventPage';
export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params;return <CalendarEventPage id={id}/>;}
