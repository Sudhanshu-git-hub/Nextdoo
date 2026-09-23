import { KnowledgeNotes } from '@/components/knowledge/KnowledgeNotes';
export default async function Page({searchParams}:{searchParams:Promise<{recordId?:string;databaseId?:string}>}){return <KnowledgeNotes {...await searchParams}/>;}
