import Link from "next/link";
import { VisualMathTool } from "@/components/kid/visual-math-tool";

/**
 * Re-homed frozen prototype math playground (R1-00 legacy asset). The R1-05
 * kid home became the Lumi conversation surface; this keeps the prototype
 * tool reachable without crowding the child chat flow. Legacy semantics are
 * unchanged and must not be treated as 2.0 product behavior.
 */
export default function KidPlaygroundPage() {
  return (
    <section className="space-y-6">
      <header>
        <Link href="/kid" className="text-sm font-semibold text-indigo-600 hover:text-indigo-700">
          ← 回到 Lumi
        </Link>
        <p className="mt-3 text-sm font-semibold uppercase tracking-wide text-indigo-600">Kid Mode</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-900 sm:text-4xl">Math Playground</h1>
      </header>

      <VisualMathTool />
    </section>
  );
}
