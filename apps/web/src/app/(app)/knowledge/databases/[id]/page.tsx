import { KnowledgeDatabaseView } from '@/components/knowledge/KnowledgeDatabase';
export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params;return <KnowledgeDatabaseView key={id} id={id}/>;}
