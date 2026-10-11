import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
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
});
