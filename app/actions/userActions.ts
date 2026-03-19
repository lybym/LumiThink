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
          cognitiveProfile: {
            create: {
              numberSenseScore: 0,
              spatialScore: 0,
              logicScore: 0,
              strategyScore: 0,
              latestDiagnosisSummary: "Initial profile created.",
            },
          },
        },
      },
    },
    include: {
      children: {
        include: {
          cognitiveProfile: true,
        },
      },
    },
  });

  return parent;
}
