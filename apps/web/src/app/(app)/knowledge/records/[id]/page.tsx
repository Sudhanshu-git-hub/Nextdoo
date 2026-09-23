import { KnowledgeRecordView } from '@/components/knowledge/KnowledgeDetail';
export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params;return <KnowledgeRecordView key={id} id={id}/>;}
