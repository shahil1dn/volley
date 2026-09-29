import { notFound } from 'next/navigation';
import { findSession } from '@/lib/sessions';
import JoinForm from './JoinForm';

export default async function ParticipantPage({ params }: { params: Promise<{ code: string }> }) {
  const session = await findSession((await params).code.toUpperCase());
  if (!session) notFound();
  return <JoinForm code={session.code} question={session.question} />;
}
