import { randomUUID } from "node:crypto";

export function buildMockParentEmail(id = randomUUID()) {
  return `demo.parent.${id}@lumithink.local`;
}
