import { TaskDetailPage } from '@/components/TaskDetailPage';
export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params;return <TaskDetailPage key={id} id={id}/>;}
