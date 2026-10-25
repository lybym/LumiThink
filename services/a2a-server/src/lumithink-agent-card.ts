/**
 * LumiThink A2A Agent Card (P1-01, issue #83).
 *
 * Design source: docs/A2A_DESIGN.md §4/§9 — ONE LumiThink agent
 * (no Companion/Learning split), A2A v1.0.1, JSONRPC binding only, and
 * skills are DISCOVERY metadata: they are never an authorization basis and
 * never assumed to route a business operation (design §4; AC 2 of #83).
 *
 * The card declares the bearer security scheme so clients can discover that
 * JSON-RPC methods require authentication (P1-01 synthetic validation gate;
 * the real two-tier Client/Principal identity is P1-03 / issue #85).
 *
 * Types are the locked SDK's proto-generated shapes: every proto field is a
 * required property (optionality shows up as `| undefined`), oneofs are
 * `{ $case, value }` unions, and enums are numeric SDK enums.
 */
import type { AgentCard, HTTPAuthSecurityScheme, SecurityScheme } from '@a2a-js/sdk';

/** The single public agent identity. Never split per channel or domain. */
export const LUMITHINK_AGENT_NAME = 'lumithink';

/** The only protocol version this validation service declares (design §9.1). */
export const LUMITHINK_A2A_VERSION = '1.0';

/** Service package version, mirrored into the Agent Card `version` field. */
export const LUMITHINK_A2A_SERVER_VERSION = '0.1.0';

const bearerScheme: SecurityScheme = {
  scheme: {
    $case: 'httpAuthSecurityScheme',
    value: {
      description:
        'Registered bearer credential binding BOTH identity tiers server-side: the calling ' +
        'client (Client Identity) and the verified user or restricted visitor it acts for ' +
        '(Principal Identity). One credential per client binding; no stacked auth headers. ' +
        'See docs/A2A_DESIGN.md §5.2 and ADR-0014.',
      scheme: 'bearer',
      bearerFormat: 'opaque',
    } satisfies HTTPAuthSecurityScheme,
  },
};

export function buildLumithinkAgentCard(base: string): AgentCard {
  return {
    name: LUMITHINK_AGENT_NAME,
    description:
      'LumiThink single family agent — A2A validation service (P1-01 #83 skeleton, P1-02 #84 ' +
      'SQLite Task Manager, P1-03 #85 two-tier Client/Principal identity & household ' +
      'authorization). SYNTHETIC executor only: protocol/transport verification, not a real ' +
      'DSH execution gate.',
    version: LUMITHINK_A2A_SERVER_VERSION,
    provider: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: { bearerAuth: bearerScheme },
    // The requirement itself is enforced by the 401 bearer gate (error-map.ts).
    securityRequirements: [{ schemes: { bearerAuth: { list: [] } } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'chat',
        name: 'Chat (synthetic)',
        description: 'Synthetic chat capability for transport verification only',
        tags: ['synthetic'],
        examples: [],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
    ],
    signatures: [],
    supportedInterfaces: [
      { url: base, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: LUMITHINK_A2A_VERSION },
    ],
  };
}
