import { z } from 'zod';

export const SignupInputSchema = z.object({
  email: z.string().email(),
  // 8 characters is a floor, not a strength policy.
  password: z.string().min(8).max(200),
});
export type SignupInput = z.infer<typeof SignupInputSchema>;

export const LoginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

/** A handle box on the profile page. */
const HANDLE_MESSAGE = {
  discord: 'Discord usernames are 2 to 32 characters: letters, numbers, "_" and ".".',
  x: 'X handles are 1 to 15 characters: letters, numbers and "_".',
};

function handleField(kind: 'discord' | 'x') {
  return z
    .string()
    .max(64)
    .nullable()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return undefined;
      const value = (raw ?? '').trim().replace(/^@+/, '');
      if (value === '') return null;
      const ok = kind === 'discord' ? /^[a-z0-9_.]{2,32}$/.test(value.toLowerCase()) && !value.includes('..') : /^[A-Za-z0-9_]{1,15}$/.test(value);
      if (!ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: HANDLE_MESSAGE[kind] });
        return z.NEVER;
      }
      return kind === 'discord' ? value.toLowerCase() : value;
    });
}

export const DISPLAY_NAME_MAX = 32;

/** The name to greet a member by. */
export const displayNameField = z
  .string()
  .max(200)
  .nullable()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined) return undefined;
    const value = (raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
    if (value === '') return null;
    if (value.length > DISPLAY_NAME_MAX) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Keep your name to ${DISPLAY_NAME_MAX} characters or fewer.` });
      return z.NEVER;
    }
    if (!/^[\p{L}\p{M}\p{N} .'_-]+$/u.test(value) || !/[\p{L}\p{N}]/u.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use letters, numbers, spaces and . \' - _ only.' });
      return z.NEVER;
    }
    return value;
  });

export const ProfileUpdateSchema = z
  .object({ displayName: displayNameField, discordHandle: handleField('discord'), xHandle: handleField('x') })
  .strict();
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;
