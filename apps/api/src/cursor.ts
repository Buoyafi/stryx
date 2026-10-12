import { z } from 'zod';

/** A position in a newest-first list: the last row's time and id (the id breaks ties within a millisecond). */
export interface ListCursor {
  at: Date;
  id: string;
}

/** The cursor on the wire: the row's ISO time and id joined by "_". Opaque to clients. */
export const encodeCursor = (row: { createdAt: Date; id: string }): string => `${row.createdAt.toISOString()}_${row.id}`;

export const CursorSchema = z.string().max(120).transform((v, ctx): ListCursor => {
  const cut = v.indexOf('_');
  const at = new Date(cut > 0 ? v.slice(0, cut) : '');
  const id = v.slice(cut + 1);
  if (cut <= 0 || Number.isNaN(at.getTime()) || !id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bad cursor' });
    return z.NEVER;
  }
  return { at, id };
});

/** The cursor for the next page: the last row's, when the page was full. */
export const nextCursor = <T extends { createdAt: Date; id: string }>(rows: readonly T[], limit: number): string | null =>
  rows.length === limit ? encodeCursor(rows[rows.length - 1]!) : null;
