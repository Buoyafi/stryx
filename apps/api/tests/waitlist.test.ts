import { describe, expect, it } from 'vitest';
import { PrismaWaitlistRepository, WaitlistService, csvCell, normaliseEmail, waitlistCsv, type WaitlistPrismaClient } from '../src/waitlist.js';
import { InMemoryWaitlistRepository } from './fakes/in-memory-waitlist-repository.js';

describe('normaliseEmail', () => {
  it('accepts ordinary addresses and keeps what was typed, trimmed, plus a lowercase key', () => {
    expect(normaliseEmail('  Ada.Lovelace+nft@Example.COM ')).toEqual({ email: 'Ada.Lovelace+nft@Example.COM', emailLower: 'ada.lovelace+nft@example.com' });
    expect(normaliseEmail('a@b.io')).not.toBeNull();
    expect(normaliseEmail("o'brien@mail.example.co.uk")).not.toBeNull();
    expect(normaliseEmail('josé@bücher.de')).not.toBeNull();
  });

  it('refuses things that are not an email', () => {
    for (const bad of ['', '   ', 'plain', 'a@', '@b.io', 'a@b', 'a@b.', 'a@.io', 'a@b..io', 'a b@c.io', 'a@b c.io', 'a@@b.io', 'a@b@c.io', '.a@b.io', 'a.@b.io', 'a..b@c.io', 'a@-b.io', 'a@b-.io', 'a@b.i', '<a>@b.io', '"a"@b.io', 'a\n@b.io', 'a@b.io\nBcc: x@y.io', 'a@b.io;c@d.io', 'a,b@c.io']) {
      expect(normaliseEmail(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('refuses non-strings and addresses over the length limits', () => {
    for (const bad of [undefined, null, 42, {}, ['a@b.io'], true]) expect(normaliseEmail(bad)).toBeNull();
    expect(normaliseEmail(`${'a'.repeat(65)}@b.io`)).toBeNull();
    expect(normaliseEmail(`a@${'b'.repeat(64)}.io`)).toBeNull();
    expect(normaliseEmail(`a@${'b.'.repeat(130)}io`)).toBeNull();
  });
});

describe('csvCell / waitlistCsv', () => {
  it('quotes cells that need it', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('defuses a cell a spreadsheet would run as a formula', () => {
    for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(evil).replace(/^"/, '').startsWith("'")).toBe(true);
    expect(csvCell("=HYPERLINK(\"http://x\",\"y\")")).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
  });

  it('writes a header and one line per person', () => {
    const csv = waitlistCsv([{ id: '1', email: 'a@b.io', status: 'INVITED', note: 'friend, early', invitedAt: new Date('2026-10-03T00:00:00Z'), createdAt: new Date('2026-10-02T00:00:00Z') }]);
    expect(csv).toBe('email,status,joined,invited,note\r\na@b.io,invited,2026-10-02T00:00:00.000Z,2026-10-03T00:00:00.000Z,"friend, early"\r\n');
  });
});

describe('WaitlistService', () => {
  const make = () => {
    const repo = new InMemoryWaitlistRepository();
    return { repo, service: new WaitlistService(repo, () => new Date('2026-10-05T10:00:00Z')) };
  };

  it('adds an address once however it is capitalised', async () => {
    const { service, repo } = make();
    expect(await service.join('Ada@Example.com')).toBe('added');
    expect(await service.join('ada@example.com ')).toBe('already');
    expect(await service.join('ADA@EXAMPLE.COM')).toBe('already');
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]!.email).toBe('Ada@Example.com');
  });

  it('says invalid for junk and stores nothing', async () => {
    const { service, repo } = make();
    expect(await service.join('not an email')).toBe('invalid');
    expect(await service.join(undefined)).toBe('invalid');
    expect(repo.rows).toHaveLength(0);
  });

  it('lists newest first, filters by status and counts', async () => {
    const { service } = make();
    await service.join('one@x.io');
    await service.join('two@x.io');
    await service.join('three@x.io');
    const all = await service.list();
    expect(all.map((r) => r.email)).toEqual(['three@x.io', 'two@x.io', 'one@x.io']);
    await service.setInvited(all[2]!.id, true);
    expect((await service.list({ status: 'INVITED' })).map((r) => r.email)).toEqual(['one@x.io']);
    expect(await service.counts()).toEqual({ waiting: 2, invited: 1 });
  });

  it('marks and unmarks invited, stamping the time, and reports a person who is gone', async () => {
    const { service } = make();
    await service.join('a@b.io');
    const [row] = await service.list();
    const invited = await service.setInvited(row!.id, true);
    expect(invited).toMatchObject({ status: 'INVITED', invitedAt: new Date('2026-10-05T10:00:00Z') });
    expect(await service.setInvited(row!.id, false)).toMatchObject({ status: 'WAITING', invitedAt: null });
    expect(await service.setInvited('missing', true)).toBeNull();
  });

  it('removes a person for good', async () => {
    const { service } = make();
    await service.join('a@b.io');
    const [row] = await service.list();
    expect(await service.remove(row!.id)).toBe(true);
    expect(await service.remove(row!.id)).toBe(false);
    expect(await service.list()).toEqual([]);
    expect(await service.join('a@b.io')).toBe('added'); // they can join again later
  });
});

describe('PrismaWaitlistRepository', () => {
  const delegate = (over: Partial<WaitlistPrismaClient['waitlistEntry']> = {}): WaitlistPrismaClient => ({
    waitlistEntry: {
      createMany: async () => ({ count: 1 }),
      findMany: async () => [],
      count: async () => 0,
      update: async () => ({}),
      updateMany: async () => ({ count: 1 }),
      findUnique: async () => null,
      deleteMany: async () => ({ count: 1 }),
      ...over,
    },
  });

  it('adds with skipDuplicates and reports whether a row was made', async () => {
    const seen: unknown[] = [];
    const repo = new PrismaWaitlistRepository(delegate({ createMany: async (args) => (seen.push(args), { count: 0 }) }));
    expect(await repo.addIfNew('A@b.io', 'a@b.io')).toBe(false);
    expect(seen).toEqual([{ data: [{ email: 'A@b.io', emailLower: 'a@b.io' }], skipDuplicates: true }]);
    expect(await new PrismaWaitlistRepository(delegate()).addIfNew('a@b.io', 'a@b.io')).toBe(true);
  });

  it('treats Prisma\'s record-not-found as "no longer on the list", and rethrows anything else', async () => {
    const gone = new PrismaWaitlistRepository(delegate({ update: async () => { throw Object.assign(new Error('x'), { code: 'P2025' }); } }));
    expect(await gone.setInvited('id', true, new Date())).toBeNull();
    const broken = new PrismaWaitlistRepository(delegate({ update: async () => { throw new Error('db down'); } }));
    await expect(broken.setInvited('id', true, new Date())).rejects.toThrow('db down');
  });

  it('writes only status and invitedAt when inviting, and clears invitedAt when un-inviting', async () => {
    const calls: { data: unknown }[] = [];
    const row = { id: '1', email: 'a@b.io', status: 'INVITED', note: null, invitedAt: null, createdAt: new Date() };
    const repo = new PrismaWaitlistRepository(delegate({ update: async (a) => (calls.push(a), row) }));
    const at = new Date('2026-10-05T10:00:00Z');
    await repo.setInvited('1', true, at);
    await repo.setInvited('1', false, at);
    expect(calls.map((c) => c.data)).toEqual([{ status: 'INVITED', invitedAt: at }, { status: 'WAITING', invitedAt: null }]);
  });

  it('claims for an invite only a person still waiting, in one conditional update', async () => {
    const calls: unknown[] = [];
    const row = { id: '1', email: 'a@b.io', status: 'INVITED', note: null, invitedAt: new Date(), createdAt: new Date() };
    const at = new Date('2026-10-09T10:00:00Z');
    const won = new PrismaWaitlistRepository(delegate({ updateMany: async (a) => (calls.push(a), { count: 1 }), findUnique: async () => row }));
    expect(await won.claimForInvite('1', at)).toMatchObject({ id: '1', status: 'INVITED' });
    expect(calls).toEqual([{ where: { id: '1', status: 'WAITING' }, data: { status: 'INVITED', invitedAt: at } }]);
    const lost = new PrismaWaitlistRepository(delegate({ updateMany: async () => ({ count: 0 }), findUnique: async () => row }));
    expect(await lost.claimForInvite('1', at)).toBeNull();
  });

  it('lists newest first with a limit, and counts per status', async () => {
    const args: unknown[] = [];
    const repo = new PrismaWaitlistRepository(delegate({ findMany: async (a) => (args.push(a), []), count: async (a) => ((a as { where: { status: string } }).where.status === 'WAITING' ? 7 : 3) }));
    await repo.list({ status: 'WAITING', limit: 50 });
    expect(args[0]).toEqual({ where: { status: 'WAITING' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50 });
    expect(await repo.counts()).toEqual({ waiting: 7, invited: 3 });
  });
});
