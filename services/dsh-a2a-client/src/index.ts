/**
 * P2-02 (issue #114) — public surface of the LumiThink DSH A2A Client.
 */
export { DshA2aClient } from './dsh-a2a-client.ts';
export type {
  TaskHandle,
  SendMessageInput,
  SendOptions,
  WaitOptions,
  SendMode,
  StreamEvent,
  PendingOperation,
} from './dsh-a2a-client.ts';
export {
  loadDshA2aClientConfig,
  resolveDshA2aClientConfig,
  CANCEL_RESPONSE_TIMEOUT_DEFAULT_MS,
} from './config.ts';
export type { DshA2aClientConfig, CredentialSource, ResolvedDshA2aClientConfig } from './config.ts';
export {
  FileTaskLedger,
  LEDGER_SCHEMA_VERSION,
} from './ledger.ts';
export type {
  TaskLedger,
  LedgerRecord,
  LedgerOriginalRequest,
  LedgerCancelIntent,
  LedgerCancelStatus,
  LedgerDocument,
} from './ledger.ts';
export {
  DshA2aClientError,
  TaskWaitAbortedError,
  mapClientError,
} from './errors.ts';
export type { DshA2aClientErrorCode, CancelOutcome, CancelOutcomeStatus } from './errors.ts';
export {
  taskStateName,
  isTerminalStateName,
  firstTextOfParts,
  type A2aStateName,
} from './normalize.ts';
