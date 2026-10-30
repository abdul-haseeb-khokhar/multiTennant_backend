import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { PENDING_EVENT_TYPES } from '../events/engine-events.service';
import { REQUEST_TYPES } from '../requests/state-machine';
import { CONVERSATION_STATUSES, ESCALATION_REASONS } from './engine.types';

interface Operation {
  parameters?: Array<{ $ref?: string }>;
  requestBody?: unknown;
}

const contract = parse(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'docs',
      'contracts',
      'engine-internal.openapi.yaml',
    ),
    'utf8',
  ),
) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, { enum?: string[] }> };
};

const events = parse(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'docs',
      'contracts',
      'backend-events.openapi.yaml',
    ),
    'utf8',
  ),
) as {
  paths: Record<string, unknown>;
  components: { schemas: { Events: { properties: Record<string, unknown> } } };
};

const backendInternal = parse(
  readFileSync(
    join(
      __dirname,
      '..',
      '..',
      'docs',
      'contracts',
      'backend-internal.openapi.yaml',
    ),
    'utf8',
  ),
) as {
  security: Array<Record<string, unknown>>;
  paths: Record<
    string,
    Record<string, { summary: string; parameters?: Array<{ $ref?: string }> }>
  >;
  components: {
    schemas: Record<string, { enum?: Array<string | null> }>;
  };
};

describe('docs/contracts/engine-internal.openapi.yaml', () => {
  it('describes exactly the calls the EngineClient makes', () => {
    expect(Object.keys(contract.paths).sort()).toEqual([
      '/health',
      '/internal/conversation-counts',
      '/internal/conversations',
      '/internal/conversations/{id}',
      '/internal/conversations/{id}/claim',
      '/internal/conversations/{id}/escalate',
      '/internal/conversations/{id}/human-messages',
      '/internal/conversations/{id}/messages',
      '/internal/conversations/{id}/release',
      '/internal/conversations/{id}/resolve',
    ]);
    expect(
      Object.keys(contract.paths['/internal/conversations']).sort(),
    ).toEqual(['get', 'post']);
    expect(Object.keys(contract.paths['/internal/conversations/{id}'])).toEqual(
      ['get'],
    );
  });

  it('requires the tenant header on every internal call and the idempotency key on commands', () => {
    for (const [path, methods] of Object.entries(contract.paths)) {
      if (!path.startsWith('/internal')) continue;
      for (const operation of Object.values(methods)) {
        const refs = (operation.parameters ?? []).map((p) => p.$ref);
        expect(refs).toContain('#/components/parameters/TenantId');
        expect(refs).toContain('#/components/parameters/RequestId');
        if (operation.requestBody) {
          expect(refs).toContain('#/components/parameters/IdempotencyKey');
        }
      }
    }
  });

  it('marks every Phase 4 call as a proposed addition for the engine owner to confirm', () => {
    for (const path of [
      '/internal/conversation-counts',
      '/internal/conversations/{id}/claim',
      '/internal/conversations/{id}/release',
      '/internal/conversations/{id}/resolve',
      '/internal/conversations/{id}/human-messages',
    ]) {
      const operation = Object.values(contract.paths[path])[0] as {
        summary: string;
      };
      expect([path, operation.summary]).toEqual([
        path,
        expect.stringContaining('[proposed addition]'),
      ]);
    }
    const list = contract.paths['/internal/conversations'].get as unknown as {
      summary: string;
    };
    expect(list.summary).toContain('[proposed addition]');
  });

  it('lists the same conversation statuses and release targets as the code', () => {
    const schemas = contract.components.schemas;
    expect(schemas.ConversationStatus.enum).toEqual([...CONVERSATION_STATUSES]);
    expect(schemas.ReleaseTarget.enum).toEqual([
      'active',
      'escalated',
      'resolved',
    ]);
    expect(Object.keys(schemas.ConversationCounts)).toContain('properties');
  });

  it('lists the same escalation reasons as the code', () => {
    expect(contract.components.schemas.EscalationReason.enum).toEqual([
      ...ESCALATION_REASONS,
    ]);
  });
});

describe('docs/contracts/engine-internal.openapi.yaml after Phase 5A (what Abdullah agreed)', () => {
  const message = (
    contract as unknown as {
      components: { schemas: { Message: { properties: object } } };
    }
  ).components.schemas.Message.properties;

  it('messages carry content_key, provider, model, tokens and latency (M1)', () => {
    expect(Object.keys(message)).toEqual(
      expect.arrayContaining([
        'contentKey',
        'provider',
        'model',
        'tokensIn',
        'tokensOut',
        'latencyMs',
      ]),
    );
  });

  it('says the first-token timeout is 10 seconds and the claim retry answers 200', () => {
    const text = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'docs',
        'contracts',
        'engine-internal.openapi.yaml',
      ),
      'utf8',
    );
    expect(text).toContain('10 seconds');
    expect(text).not.toMatch(/allows 5 seconds/);
    expect(text).toMatch(
      /answers 200 with the same conversation, not 409 \(agreed/,
    );
  });
});

/**
 * The routes of backend-internal.openapi.yaml that are built: the agent config pull (Phase 5B-1), the
 * status check, the requests and the customer upsert (Phase 5B-2) and the agent list (Phase 5B-3).
 * They are built against this file and the mock engine; the engine owner has NOT confirmed them. Only
 * the number lookup (Phase 5D: the route the engine calls on every inbound call, engine first) is
 * still a draft.
 */
const BUILT_BACKEND_ROUTES = [
  '/internal/tenants/{tenantId}/agents',
  '/internal/tenants/{tenantId}/agents/{agentId}/config',
  '/internal/tenants/{tenantId}/status',
  '/internal/tenants/{tenantId}/requests',
  '/internal/tenants/{tenantId}/requests/{reference}',
  '/internal/tenants/{tenantId}/requests/{reference}/withdraw',
  '/internal/tenants/{tenantId}/customers/by-phone',
];

describe('docs/contracts/backend-internal.openapi.yaml (built through Phase 5B-3, the number lookup is still a draft)', () => {
  it('describes exactly the built routes plus the number lookup of Phase 5D', () => {
    expect(Object.keys(backendInternal.paths).sort()).toEqual(
      [...BUILT_BACKEND_ROUTES, '/internal/numbers/{e164}'].sort(),
    );
  });

  it('marks every built operation IMPLEMENTED and unconfirmed by the engine owner, and the rest as a draft', () => {
    for (const [path, methods] of Object.entries(backendInternal.paths)) {
      for (const operation of Object.values(methods)) {
        if (BUILT_BACKEND_ROUTES.includes(path)) {
          expect([path, operation.summary]).toEqual([
            path,
            expect.stringContaining('IMPLEMENTED'),
          ]);
          continue;
        }
        expect([path, operation.summary]).toEqual([
          path,
          expect.stringContaining('[NOT BUILT, Phase 5D]'),
        ]);
      }
    }
  });

  it('is behind the service token, and the number lookup is not built', () => {
    expect(backendInternal.security).toEqual([{ internalToken: [] }]);
    // ... and the number lookup is the engine's call on every inbound call (engine first, L8 revised)
    const lookup = backendInternal.paths['/internal/numbers/{e164}'].get;
    expect(lookup.summary).toContain('NOT BUILT');
    expect(lookup.summary).toContain('EVERY inbound call');
    expect(lookup.summary).not.toContain('fallback');
  });

  it('answers the number lookup with his B11 shape: tenantId, agentId (or null), numberId, status active or released', () => {
    const lookup = backendInternal.paths['/internal/numbers/{e164}']
      .get as unknown as {
      responses: Record<
        string,
        {
          content?: {
            'application/json': {
              schema: {
                required: string[];
                properties: Record<
                  string,
                  { enum?: string[]; nullable?: boolean }
                >;
              };
            };
          };
        }
      >;
    };
    const schema = lookup.responses['200'].content!['application/json'].schema;
    expect(schema.required).toEqual([
      'tenantId',
      'agentId',
      'numberId',
      'status',
    ]);
    expect(schema.properties.agentId.nullable).toBe(true);
    expect(schema.properties.status.enum).toEqual(['active', 'released']);
    expect(Object.keys(lookup.responses)).toEqual(
      expect.arrayContaining(['200', '404']),
    );
  });

  it('says the ENGINE signs the call ticket: no contract file has the backend signing one', () => {
    for (const file of [
      'backend-internal.openapi.yaml',
      'backend-events.openapi.yaml',
      'engine-internal.openapi.yaml',
    ]) {
      const text = readFileSync(
        join(__dirname, '..', '..', 'docs', 'contracts', file),
        'utf8',
      );
      expect([
        file,
        /backend signs a (one-minute )?(call )?ticket/i.test(text),
      ]).toEqual([file, false]);
      expect([
        file,
        /backend-first routing/i.test(text) && !/engine first/i.test(text),
      ]).toEqual([file, false]);
    }
    const internal = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'docs',
        'contracts',
        'backend-internal.openapi.yaml',
      ),
      'utf8',
    );
    expect(internal).toContain('The backend signs no ticket');
  });

  it('request types in the contract are the ones the state machine has (appointment, callback, order)', () => {
    const schemas = backendInternal.components.schemas as unknown as {
      RequestType: { enum: string[] };
    };
    expect(schemas.RequestType.enum).toEqual([...REQUEST_TYPES]);
  });

  it('the settings document of the contract is open at the end and lists the optional engine fields', () => {
    const config = (
      backendInternal.components.schemas as unknown as {
        AgentConfig: {
          properties: {
            config: {
              additionalProperties: boolean;
              required: string[];
              properties: Record<string, unknown>;
            };
          };
        };
      }
    ).AgentConfig.properties.config;
    expect(config.additionalProperties).toBe(true);
    for (const key of [
      'greeting',
      'recordCalls',
      'autoEndCalls',
      'endCallDelaySeconds',
      'profileSummary',
      'profileSummarySources',
    ]) {
      expect(Object.keys(config.properties)).toContain(key);
      expect(config.required).not.toContain(key);
    }
  });

  it('every built route is outside /v1 in configureApp (a drift check against the real prefix exclusions)', () => {
    const setup = readFileSync(join(__dirname, '..', 'app.setup.ts'), 'utf8');
    for (const path of BUILT_BACKEND_ROUTES) {
      const express = path.replace(/\{(\w+)\}/g, ':$1').replace(/^\//, '');
      expect([path, setup.includes(`'${express}'`)]).toEqual([path, true]);
    }
  });

  it('answers the status check with the reasons Abdullah named', () => {
    expect(backendInternal.components.schemas.TenantStatus).toBeDefined();
    const reasons = (
      backendInternal.components.schemas as unknown as {
        TenantStatus: {
          properties: { reason: { enum: Array<string | null> } };
        };
      }
    ).TenantStatus.properties.reason.enum;
    expect(reasons).toEqual([
      'suspended',
      'unpaid',
      'quota_exceeded',
      'agent_disabled',
      'unknown_agent',
      'unknown_tenant',
      null,
    ]);
  });

  it('puts the tenant in the path of every tenant route (the engine states it, the backend checks it)', () => {
    for (const path of Object.keys(backendInternal.paths)) {
      if (path.startsWith('/internal/tenants/')) {
        expect(path).toContain('{tenantId}');
      }
    }
  });
});

describe('docs/contracts/backend-events.openapi.yaml', () => {
  it('describes the one receiver route, outside /v1', () => {
    expect(Object.keys(events.paths)).toEqual(['/internal/events']);
  });

  it('documents the event types the backend handles', () => {
    expect(Object.keys(events.components.schemas.Events.properties)).toEqual(
      expect.arrayContaining([
        'conversation.created',
        'conversation.escalated',
        'conversation.assigned',
        'conversation.released',
        'conversation.resolved',
        'message.created',
        'usage.recorded',
        'action.proposed',
      ]),
    );
  });

  it('documents the voice-first events (record.* are handled since Phase 5B-2, usage.call_minutes is acknowledged until 5E)', () => {
    const types = Object.keys(events.components.schemas.Events.properties);
    expect(types).toEqual(
      expect.arrayContaining([
        'record.submitted',
        'record.updated',
        'usage.call_minutes',
      ]),
    );
  });

  it('lists exactly the types the receiver acknowledges without handling', () => {
    expect([...PENDING_EVENT_TYPES].sort()).toEqual(['usage.call_minutes']);
  });
});

/** L7 (decided 2026-10-28): every contract carries the agent id. */
describe('the agent id in the contracts (L7)', () => {
  it('the engine contract accepts X-Agent-Id on the routes that start work for an agent', () => {
    const parameters = (
      contract as unknown as {
        components: {
          parameters: Record<string, { name: string; in: string }>;
        };
      }
    ).components.parameters;
    expect(parameters.AgentId).toMatchObject({
      name: 'X-Agent-Id',
      in: 'header',
    });
    for (const [path, method] of [
      ['/internal/conversations', 'post'],
      ['/internal/conversations/{id}/messages', 'post'],
    ] as const) {
      expect(
        contract.paths[path][method].parameters?.map((p) => p.$ref),
      ).toContain('#/components/parameters/AgentId');
    }
  });

  it('the event data of the voice-first events carries agentId', () => {
    const properties = events.components.schemas.Events.properties as Record<
      string,
      { properties: Record<string, unknown> }
    >;
    for (const type of [
      'record.submitted',
      'record.updated',
      'usage.call_minutes',
      'conversation.created',
    ]) {
      expect(Object.keys(properties[type].properties)).toContain('agentId');
    }
  });

  it('the backend-internal draft carries agentId on the status check, requests, customer upsert and the config route', () => {
    const text = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        'docs',
        'contracts',
        'backend-internal.openapi.yaml',
      ),
      'utf8',
    );
    const schemas = backendInternal.components.schemas as unknown as Record<
      string,
      { properties: Record<string, unknown> }
    >;
    expect(Object.keys(schemas.TenantStatus.properties)).toContain('agentId');
    expect(Object.keys(schemas.CreateRequest.properties)).toContain('agentId');
    expect(Object.keys(schemas.AgentConfig.properties)).toContain('agentId');
    expect(Object.keys(schemas.AgentSummary.properties)).toContain('agentId');
    expect(text).toContain('/components/parameters/AgentIdQuery');
    // the settings version a call was served with travels on the request (the engine's pull names it)
    expect(Object.keys(schemas.CreateRequest.properties)).toContain(
      'configVersion',
    );
  });
});
