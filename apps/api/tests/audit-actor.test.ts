import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { credentialActorType } from '../src/audit-actor.js';

const request = (fields: Partial<FastifyRequest>) => fields as FastifyRequest;

describe('credentialActorType', () => {
  it('the operator token with admin rights is admin', () => {
    expect(credentialActorType(request({}))).toBe('admin');
  });

  it('a signed-in account is user until its role says otherwise', () => {
    expect(credentialActorType(request({ sessionToken: 'abc' }))).toBe('user');
  });

  it('the operator token where it may not act as admin is user', () => {
    expect(credentialActorType(request({ adminDenied: true }))).toBe('user');
  });
});
