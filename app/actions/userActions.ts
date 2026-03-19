"use server";

import { db } from "@/lib/db";

export async function createMockParentAndChild() {
  const suffix = Date.now();

  const parent = await db.parent.create({
    data: {
      email: `demo.parent.${suffix}@lumithink.local`,
      children: {
        create: {
          name: "Ava",
          age: 8,
          initialMathLevel: "Grade 3",
          activeWeaknesses: ["borrowing in subtraction", "multi-step word problems"],
        },
      },
    },
    include: {
      children: true,
    },
  });

  return parent;
}
