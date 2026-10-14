/**
 * R1-06 guardian domain public surface (issue #18; docs/API_CONTRACT.md §12).
 */

export {
  ADMIN_ACTOR_ID,
  CURRENT_GUARDIAN_DISCLOSURE_VERSION,
  GUARDIAN_ACTOR_ID,
  GUARDIAN_API_PROTOCOL_VERSIONS,
  GUARDIAN_AUDIT_KINDS,
  GUARDIAN_CONSENT_IDS,
  GUARDIAN_DISCLOSURE_ID,
  GUARDIAN_DISCLOSURES,
  GUARDIAN_FAMILY_CHILD_REF,
  GUARDIAN_FEATURE_SWITCH_IDS,
  GUARDIAN_MASKED_VALUE,
  applyGuardianAuthorizationAction,
  buildGuardianStatusSnapshot,
  currentGuardianDisclosure,
  initialGuardianAuthorizationState,
  isConsentActive,
  isSwitchEnabled,
  parseGuardianAuthorizationAction,
  parseGuardianAuditEntry,
} from "./authorizations.ts";
export type {
  GuardianApiProtocolVersion,
  GuardianAuditEntry,
  GuardianAuditEntryView,
  GuardianAuditKind,
  GuardianAuthorizationAction,
  GuardianAuthorizationState,
  GuardianAuthorizationTransition,
  GuardianConsentId,
  GuardianConsentState,
  GuardianDisclosureDocument,
  GuardianEgressStatus,
  GuardianFeatureSwitchId,
  GuardianStatusSnapshot,
  GuardianSwitchState,
  GuardianUsageSummary,
} from "./authorizations.ts";
export {
  PROVIDER_EGRESS_CLASSES,
  assertGuardianSurfaceAccess,
  assertProviderEgressPermitted,
  canCancelFamilyTurn,
  isGuardianSurfaceAllowed,
  providerEgressAuthorized,
} from "./permissions.ts";
export type { GuardianSurface, ProviderEgressClass } from "./permissions.ts";
export {
  GUARDIAN_AUTH_SCHEME,
  GUARDIAN_PRINCIPALS,
  GUARDIAN_SESSION_TOKEN_PATTERN,
  buildGuardianLoginResponse,
  buildGuardianLogoutResponse,
  parseGuardianLoginRequest,
  sessionTokenFromAuthorizationHeader,
} from "./session.ts";
export type { GuardianLoginResponse, GuardianLogoutResponse, GuardianPrincipal } from "./session.ts";
