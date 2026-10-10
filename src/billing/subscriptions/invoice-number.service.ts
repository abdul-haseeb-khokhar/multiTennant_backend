import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Sequential invoice numbers per calendar year (`INV-2026-000001`), safe under concurrency: the
 * counter row is incremented with one atomic upsert inside the transaction that creates the
 * invoice. The row lock is held until that transaction ends, so two invoices can never get the
 * same number, and a rollback gives the number back (no gaps).
 *
 * The calendar year (UTC) is a placeholder: the accountant may want a fiscal year (I7).
 */
@Injectable()
export class InvoiceNumberService {
  async next(tx: Prisma.TransactionClient, now: Date): Promise<string> {
    const year = now.getUTCFullYear();
    const rows = await tx.$queryRaw<{ last_number: number }[]>`
      INSERT INTO "tenant_core"."invoice_sequences" ("year", "last_number")
      VALUES (${year}, 1)
      ON CONFLICT ("year") DO UPDATE
        SET "last_number" = "invoice_sequences"."last_number" + 1
      RETURNING "last_number"`;
    const sequence = Number(rows[0].last_number);
    return `INV-${year}-${String(sequence).padStart(6, '0')}`;
  }
}
