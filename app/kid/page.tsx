import { VisualMathTool } from '../../components/kid/visual-math-tool';

/**
 * Kid Mode home: highly visual and playful learning surface.
 */
export default function KidPage() {
  return (
    <section className="space-y-6">
      <header>
        <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">Kid Mode</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-900 sm:text-4xl">Math Playground</h1>
      </header>

      <VisualMathTool />
    </section>
  );
}
