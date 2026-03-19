"use server";

import { db } from "@/lib/db";

export type SeedResult = {
  parentId: string;
  childId: string;
  cognitiveProfileId: string;
};

/**
 * Seeds a baseline dataset for local MVP development:
 * - 1 parent account
 * - 1 child profile
 * - 1 empty cognitive profile (all quadrant scores start at 0.0)
 */
export async function seedInitialFamily(): Promise<SeedResult> {
  const parent = await db.parent.create({
    data: {
      email: `demo.parent.${Date.now()}@lumithink.local`,
    },
  });

  const child = await db.child.create({
    data: {
      parentId: parent.id,
      name: "Ava",
      age: 7,
    },
  });

  const profile = await db.cognitiveProfile.create({
    data: {
      childId: child.id,
      numberSenseScore: 0,
      spatialScore: 0,
      logicScore: 0,
      strategyScore: 0,
      latestDiagnosisSummary: "Profile initialized. Awaiting first parent upload.",
    },
  });

  return {
    parentId: parent.id,
    childId: child.id,
    cognitiveProfileId: profile.id,
  };
}
