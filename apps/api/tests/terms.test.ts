import { describe, expect, it } from 'vitest';
import { PrismaTermsRepository, TermsService, type TermsPrismaClient } from '../src/terms.js';
import { InMemoryTermsRepository } from './fakes/in-memory-terms-repository.js';

const V1 = { termsVersion: '1.0', privacyVersion: '1.0' };
const AT = new Date('2026-10-03T10:00:00Z');
const make = (current: typeof V1 | null = V1, secret: string | undefined = 's'.repeat(40)) => {
  const repo = new InMemoryTermsRepository();
  return { repo, service: new TermsService(repo, current, secret, () => AT) };
};

describe('TermsService', () => {
  it('is off when no versions are set: nothing required, everyone counts as accepted, nothing recorded', async () => {
    const { service, repo } = make(null);
    expect(service.required).toBe(false);
    expect(service.versions()).toBeNull();
    expect(await service.status('u1')).toEqual({ required: false, accepted: true, termsVersion: null, privacyVersion: null, acceptedAt: null });
    await service.record('u1', 'sign_up', { ip: '1.2.3.4', userAgent: 'x' });
    expect(repo.rows).toHaveLength(0);
    expect(service.matches(V1)).toBe(false);
  });

  it('requires an exact match of both versions', async () => {
    const { service } = make();
    expect(service.matches(V1)).toBe(true);
    expect(service.matches({ termsVersion: '1.0', privacyVersion: '1.1' })).toBe(false);
    expect(service.matches({ termsVersion: '1.1', privacyVersion: '1.0' })).toBe(false);
    expect(service.matches({ termsVersion: '1.0' })).toBe(false);
    expect(service.matches(undefined)).toBe(false);
    expect(service.matches({ termsVersion: 1, privacyVersion: 1 } as never)).toBe(false);
  });

  it('is not accepted until recorded, then is, with the time', async () => {
    const { service } = make();
    expect(await service.status('u1')).toMatchObject({ required: true, accepted: false, termsVersion: '1.0', privacyVersion: '1.0', acceptedAt: null });
    await service.record('u1', 're_accept', { ip: '1.2.3.4', userAgent: 'Mozilla' });
    expect(await service.status('u1')).toMatchObject({ accepted: true, acceptedAt: AT });
    expect(await service.hasAccepted('u2')).toBe(false);
  });

  it('a new version asks everyone again; the old acceptance stays on record', async () => {
    const repo = new InMemoryTermsRepository();
    const v1 = new TermsService(repo, V1, 'k'.repeat(40), () => AT);
    await v1.record('u1', 'sign_up', { ip: undefined, userAgent: undefined });
    const v2 = new TermsService(repo, { termsVersion: '2.0', privacyVersion: '1.0' }, 'k'.repeat(40), () => AT);
    expect(await v2.hasAccepted('u1')).toBe(false);
    await v2.record('u1', 're_accept', { ip: undefined, userAgent: undefined });
    expect(await v2.hasAccepted('u1')).toBe(true);
    expect(repo.rows.map((r) => r.termsVersion)).toEqual(['1.0', '2.0']);
  });

  it('stores evidence: source, versions, a keyed hash of the IP (never the IP), and a trimmed user agent', async () => {
    const { service, repo } = make();
    await service.record('u1', 'sign_up', { ip: '203.0.113.9', userAgent: 'U'.repeat(500) });
    const row = repo.rows[0]!;
    expect(row).toMatchObject({ userId: 'u1', source: 'sign_up', termsVersion: '1.0', privacyVersion: '1.0', acceptedAt: AT });
    expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('203.0.113.9');
    expect(row.userAgent).toHaveLength(300);
  });

  it('hashes the same IP the same way for one secret and differently for another', async () => {
    const a = make(V1, 'a'.repeat(40));
    const b = make(V1, 'b'.repeat(40));
    await a.service.record('u', 'sign_up', { ip: '1.1.1.1', userAgent: undefined });
    await a.service.record('u', 'sign_up', { ip: '1.1.1.1', userAgent: undefined });
    await b.service.record('u', 'sign_up', { ip: '1.1.1.1', userAgent: undefined });
    expect(a.repo.rows[0]!.ipHash).toBe(a.repo.rows[1]!.ipHash);
    expect(a.repo.rows[0]!.ipHash).not.toBe(b.repo.rows[0]!.ipHash);
  });

  it('keeps no IP evidence without a secret, or without an IP', async () => {
    const repo = new InMemoryTermsRepository();
    await new TermsService(repo, V1, undefined, () => AT).record('u', 'sign_up', { ip: '1.1.1.1', userAgent: 'x' });
    expect(repo.rows[0]!.ipHash).toBeNull();
    const noIp = make();
    await noIp.service.record('u', 'sign_up', { ip: undefined, userAgent: undefined });
    expect(noIp.repo.rows[0]).toMatchObject({ ipHash: null, userAgent: null });
  });
});

describe('PrismaTermsRepository', () => {
  it('looks up the newest acceptance of exactly these versions, and writes a full evidence row', async () => {
    const seen: { find?: unknown; create?: unknown } = {};
    const prisma: TermsPrismaClient = {
      termsAcceptance: {
        findFirst: async (args) => ((seen.find = args), { termsVersion: '1.0', privacyVersion: '1.0', acceptedAt: AT }),
        create: async (args) => ((seen.create = args), {}),
      },
    };
    const repo = new PrismaTermsRepository(prisma);
    expect(await repo.findAcceptance('u1', V1)).toEqual({ ...V1, acceptedAt: AT });
    expect(seen.find).toEqual({ where: { userId: 'u1', termsVersion: '1.0', privacyVersion: '1.0' }, orderBy: { acceptedAt: 'desc' } });
    await repo.record({ userId: 'u1', ...V1, source: 'sign_up', ipHash: 'h', userAgent: 'ua', acceptedAt: AT });
    expect(seen.create).toEqual({ data: { userId: 'u1', ...V1, source: 'sign_up', ipHash: 'h', userAgent: 'ua', acceptedAt: AT } });
    const none = new PrismaTermsRepository({ termsAcceptance: { findFirst: async () => null, create: async () => ({}) } });
    expect(await none.findAcceptance('u1', V1)).toBeNull();
  });
});
