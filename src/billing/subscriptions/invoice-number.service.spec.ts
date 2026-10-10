import { InvoiceNumberService } from './invoice-number.service';

describe('InvoiceNumberService', () => {
  const service = new InvoiceNumberService();
  const tx = (lastNumber: number) => ({
    $queryRaw: jest.fn().mockResolvedValue([{ last_number: lastNumber }]),
  });

  it('formats INV-<year>-<six digits> from the counter row the database returns', async () => {
    const client = tx(1);
    await expect(
      service.next(client as never, new Date('2026-10-07T12:00:00Z')),
    ).resolves.toBe('INV-2026-000001');
    expect(
      await service.next(tx(1234) as never, new Date('2027-01-01T00:00:00Z')),
    ).toBe('INV-2027-001234');
  });

  it('uses one atomic upsert against the counter table, keyed by the UTC year', async () => {
    const client = tx(5);
    await service.next(client as never, new Date('2026-12-31T23:59:59Z'));
    const [strings, year] = client.$queryRaw.mock.calls[0];
    const sql = strings.join('?');
    expect(sql).toMatch(/INSERT INTO "tenant_core"."invoice_sequences"/);
    expect(sql).toMatch(/ON CONFLICT \("year"\) DO UPDATE/);
    expect(sql).toMatch(/"last_number" \+ 1/);
    expect(sql).toMatch(/RETURNING "last_number"/);
    expect(year).toBe(2026);
  });

  it('starts a new sequence in a new year', async () => {
    const client = tx(1);
    await service.next(client as never, new Date('2027-01-01T00:00:00Z'));
    expect(client.$queryRaw.mock.calls[0][1]).toBe(2027);
  });
});
