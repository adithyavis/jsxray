import Link from 'next/link';
import { Card } from '@acme/ui';

export default function HomePage() {
  return (
    <Card>
      <Link href="/team">Team</Link>
    </Card>
  );
}
