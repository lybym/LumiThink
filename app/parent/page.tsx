/**
 * Parent Mode home: dashboard shell for homework uploads and AI-based diagnosis.
 */
export default function ParentPage() {
  return (
    <section className="space-y-6">
      <header>
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Parent Mode</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Learning Insights Dashboard</h1>
      </header>

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-base text-slate-700">
          Upload homework images and review AI-powered cognitive diagnosis reports here.
        </p>
      </div>
    </section>
  );
}
