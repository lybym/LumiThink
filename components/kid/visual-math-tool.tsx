'use client';

import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';

/**
 * Placeholder UI for the first interactive kid experience.
 * We can later replace this card with a fully interactive base-10 block tool.
 */
export function VisualMathTool() {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className="relative overflow-hidden rounded-3xl border border-indigo-100 bg-gradient-to-br from-indigo-50 via-sky-50 to-pink-50 p-6 shadow-[0_12px_40px_-18px_rgba(79,70,229,0.5)] sm:p-8"
    >
      <div className="absolute -right-8 -top-8 h-28 w-28 rounded-full bg-pink-200/40 blur-2xl" aria-hidden />
      <div className="absolute -bottom-10 -left-10 h-36 w-36 rounded-full bg-sky-200/40 blur-2xl" aria-hidden />

      <div className="relative flex items-start gap-3">
        <div className="rounded-2xl bg-white/80 p-2 shadow-sm">
          <Sparkles className="h-6 w-6 text-indigo-500" aria-hidden />
        </div>

        <div>
          <p className="text-sm font-medium text-indigo-600">Visual Math Tool</p>
          <h2 className="mt-1 text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">
            Today&apos;s Challenge: Base-10 Blocks
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-slate-600 sm:text-base">
            Build numbers with ones, tens, and hundreds blocks. Drag and stack to see place value come alive!
          </p>
        </div>
      </div>
    </motion.section>
  );
}
