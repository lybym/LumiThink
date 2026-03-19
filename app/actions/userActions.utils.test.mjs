import test from "node:test";
import assert from "node:assert/strict";

import { buildMockParentEmail } from "./userActions.utils.js";

test("buildMockParentEmail uses the provided ID", () => {
  assert.equal(
    buildMockParentEmail("fixed-id"),
    "demo.parent.fixed-id@lumithink.local",
  );
});

test("buildMockParentEmail generates collision-resistant values", () => {
  const emails = new Set(Array.from({ length: 1000 }, () => buildMockParentEmail()));
  assert.equal(emails.size, 1000);
});
