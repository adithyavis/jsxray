'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function DashboardPage() {
  const router = useRouter();
  return (
    <main>
      <h1>Dashboard</h1>
      <Link href="/dashboard/settings">Settings</Link>
      <button onClick={() => router.push('/posts/1')}>First post</button>
    </main>
  );
}
