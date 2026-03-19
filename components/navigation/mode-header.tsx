import Link from 'next/link';
import { Blocks, UserRound } from 'lucide-react';

const navItems = [
  {
    href: '/parent',
    label: 'Parent Mode',
    icon: UserRound,
  },
  {
    href: '/kid',
    label: 'Kid Mode',
    icon: Blocks,
  },
] as const;

/**
 * Shared top navigation for quickly switching between Parent and Kid experiences.
 */
export function ModeHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-slate-200/80 bg-white/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
        <Link href="/" className="text-lg font-semibold tracking-tight text-slate-900">
          LumiThink
        </Link>

        <nav aria-label="Mode navigation" className="flex items-center gap-2">
          {navItems.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
