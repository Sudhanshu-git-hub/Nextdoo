import { uuid } from '@nextdoo/contracts';
import { requireAuth } from '@/server/auth';
import { RecurrenceView } from '@/components/views/RecurrenceView';
export const dynamic = 'force-dynamic';
export default async function RecurrencePage({ params }: { params: Promise<{ id: string }> }) {
 await requireAuth(); const { id } = await params;
 return <RecurrenceView key={id} id={uuid.parse(id)} />;
}
