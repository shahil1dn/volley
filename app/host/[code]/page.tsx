import { notFound } from 'next/navigation';
import { findSession } from '@/lib/sessions';
import HostScreen from './HostScreen';

export default async function HostPage({ params }: { params: Promise<{ code: string }> }) {
  const session = await findSession((await params).code);
  if (!session) notFound();
  return <HostScreen sessionId={session.id} code={session.code} question={session.question} />;
}
