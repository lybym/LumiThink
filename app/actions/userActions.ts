"use server";

import { db } from "@/lib/db";
import { buildMockParentEmail } from "./userActions.utils";

export async function createMockParentAndChild() {
  const parent = await db.parent.create({
    data: {
      email: buildMockParentEmail(),
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
