import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ESCALATION_REASONS } from './engine.types';

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

describe('docs/contracts/engine-internal.openapi.yaml', () => {
  it('describes exactly the calls the EngineClient makes', () => {
    expect(Object.keys(contract.paths).sort()).toEqual([
      '/health',
      '/internal/conversations',
      '/internal/conversations/{id}',
      '/internal/conversations/{id}/escalate',
      '/internal/conversations/{id}/messages',
    ]);
    expect(Object.keys(contract.paths['/internal/conversations'])).toEqual([
      'post',
    ]);
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

  it('lists the same escalation reasons as the code', () => {
    expect(contract.components.schemas.EscalationReason.enum).toEqual([
      ...ESCALATION_REASONS,
    ]);
  });
});
