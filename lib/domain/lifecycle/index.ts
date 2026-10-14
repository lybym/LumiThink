/**
 * R1-09 child data lifecycle domain (issue #21) — public surface.
 *
 * `policy.ts` is the code-side source of truth for the retention matrix and
 * the fail-closed lifecycle payload shapes (docs/MEMORY_POLICY.md +
 * docs/PRIVACY_DATA_FLOW.md mirror it).
 */
export {
  CHILD_DATA_ACTION_KINDS,
  DATA_KIND_POLICIES,
  DATA_STORAGE_LOCATIONS,
  LIFECYCLE_FAMILY_CHILD_REF,
  LIFECYCLE_PROTOCOL_VERSIONS,
  MAX_DELETION_LEDGER_RECORDS,
  lifecycleOperatorRole,
  parseChildDataActionRequest,
  validateChildDataDeletionRecord,
  validateChildDataEraseResult,
  validateChildDataExport,
  validateChildDataInventory,
  type ChildDataAction,
  type ChildDataConversationView,
  type ChildDataDeletionRecord,
  type ChildDataEraseResult,
  type ChildDataExport,
  type ChildDataInventory,
  type DataKindPolicy,
  type DataStorageLocation,
  type LifecycleProtocolVersion,
} from "./policy.ts";
