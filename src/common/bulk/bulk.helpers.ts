import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Shared helpers for the admin panel's bulk upsert mutations (XLSX import /
 * row-by-row edits) in this subgraph.
 *
 * Contract: rows with an `id` update; rows without an `id` create (rows with a
 * unique business key are matched on it first). Rows are processed
 * independently so one bad spreadsheet line never aborts the batch.
 */

export type BulkOutcome = {
  outcome: 'created' | 'updated';
  id: number | string;
};

export type BulkResult = {
  created: number;
  updated: number;
  failed: number;
  createdIds: (number | string)[];
  errors: { index: number; id?: number | string | null; message: string }[];
};

/**
 * Keeps only the keys that were actually provided so an update never overwrites
 * columns the row didn't mention. Explicit null passes through to clear
 * nullable columns.
 */
export function pickDefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as T;
}

/** Throws when any of the listed fields is missing on a create row. */
export function requireBulkFields<T extends object>(
  row: T,
  fields: (keyof T)[],
): void {
  const missing = fields.filter(
    (f) => row[f] == null || row[f] === '',
  ) as string[];
  if (missing.length > 0) {
    throw new Error(
      `Missing required field(s) for create: ${missing.join(', ')}`,
    );
  }
}

/** Turns Prisma error codes into messages an admin can act on. */
export function bulkErrorMessage(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const target = Array.isArray(error.meta?.target)
      ? ` (${(error.meta.target as string[]).join(', ')})`
      : '';
    switch (error.code) {
      case 'P2002':
        return `Duplicate value violates a unique constraint${target}`;
      case 'P2003':
        return 'Invalid relation: the referenced id does not exist, or dependent rows still reference this one';
      case 'P2025':
        return 'Row not found';
      default:
        return `Database error ${error.code}`;
    }
  }
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}

/**
 * Runs the handler per row, tallying outcomes. A row failure is recorded with
 * its 0-based index (and id when present) instead of aborting the batch.
 */
export async function processBulkRows<
  T extends { id?: number | string | null },
>(
  logger: Logger,
  rows: T[],
  handler: (row: T) => Promise<BulkOutcome>,
): Promise<BulkResult> {
  const result: BulkResult = {
    created: 0,
    updated: 0,
    failed: 0,
    createdIds: [],
    errors: [],
  };

  for (const [index, row] of rows.entries()) {
    try {
      const { outcome, id } = await handler(row);
      result[outcome] += 1;
      if (outcome === 'created') result.createdIds.push(id);
    } catch (error) {
      result.failed += 1;
      result.errors.push({
        index,
        id: row.id ?? null,
        message: bulkErrorMessage(error),
      });
    }
  }

  if (result.failed > 0) {
    logger.warn(`Bulk upsert finished with ${result.failed} failed row(s)`);
  }

  return result;
}
