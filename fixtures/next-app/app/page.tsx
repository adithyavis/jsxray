import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function HomePage() {
  return (
    <main>
      <h1>Home</h1>
      <Link href="/about">About</Link>
      <Link href="/dashboard">Open dashboard</Link>
      <Button>Nothing</Button>
    </main>
  );
}
