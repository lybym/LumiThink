import Link from 'next/link';

/**
 * Entry page that nudges users into either Parent or Kid mode.
 */
export default function HomePage() {
  return (
    <section className="grid gap-4 sm:grid-cols-2">
      <Link
        href="/parent"
        className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow"
      >
        <p className="text-sm font-medium text-slate-500">Parent Mode</p>
        <h2 className="mt-1 text-xl font-semibold text-slate-900">Open dashboard</h2>
      </Link>

      <Link
        href="/kid"
        className="rounded-2xl border border-indigo-100 bg-gradient-to-br from-indigo-50 to-sky-50 p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow"
      >
        <p className="text-sm font-medium text-indigo-500">Kid Mode</p>
        <h2 className="mt-1 text-xl font-semibold text-slate-900">Start playground</h2>
      </Link>
    </section>
  );
}
