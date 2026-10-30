import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { PENDING_EVENT_TYPES } from '../events/engine-events.service';
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

describe('docs/contracts/backend-internal.openapi.yaml (DRAFT, nothing implemented)', () => {
  it('describes exactly the routes planned for Phases 5B and 5D', () => {
    expect(Object.keys(backendInternal.paths).sort()).toEqual([
      '/internal/numbers/{e164}',
      '/internal/tenants/{tenantId}/customers/by-phone',
      '/internal/tenants/{tenantId}/requests',
      '/internal/tenants/{tenantId}/requests/{reference}',
      '/internal/tenants/{tenantId}/requests/{reference}/withdraw',
      '/internal/tenants/{tenantId}/status',
    ]);
  });

  it('marks every operation as a draft, so nobody mistakes it for a built route', () => {
    for (const [path, methods] of Object.entries(backendInternal.paths)) {
      for (const operation of Object.values(methods)) {
        expect([path, operation.summary]).toEqual([
          path,
          expect.stringContaining('[DRAFT, not implemented]'),
        ]);
      }
    }
  });

  it('is behind the service token and none of these routes exists in the backend yet', () => {
    expect(backendInternal.security).toEqual([{ internalToken: [] }]);
    // The built routes outside /v1 are the event receiver and health only (CLAUDE.md rule 12).
    const builtInternal = ['/internal/events'];
    for (const path of Object.keys(backendInternal.paths)) {
      expect(builtInternal).not.toContain(path);
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

  it('documents the voice-first events that are acknowledged until Phases 5B and 5E', () => {
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
    expect([...PENDING_EVENT_TYPES].sort()).toEqual([
      'record.submitted',
      'record.updated',
      'usage.call_minutes',
    ]);
  });
});
