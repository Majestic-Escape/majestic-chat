/**
 * Golden corpus for the contact-information detector. The same fixture file
 * is committed to server.me (tests/batch-s/fixtures/contact-vectors.json) and
 * both suites pin its sha256; the release harness (tests/pw-final/
 * corpus-parity.mjs) additionally asserts the two live files are identical.
 * Regenerate with scratch tooling only when the policy changes, then re-pin
 * the hash in BOTH repos.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  detectContact,
  maskContactInfo,
  checkCandidate,
  detectContactInParts,
  maskContactInfoParts,
  buildAddressTokens,
  isAcceptableName,
  isFragmentBearing,
  normalizeForModeration,
  checkText,
  getModerationStatus,
  ModerationStatus,
} from '@majestic/chat-shared';

export const CONTACT_VECTORS_SHA256 = '44580c7312925f769a850a9f920c8720eef701423cbdee3e8e86c39eafdc7577';

const fixturePath = path.resolve(__dirname, '../../../shared/src/moderation/__fixtures__/contact-vectors.json');
// Hashed with normalised line endings so a checkout under core.autocrlf=true
// (CRLF working copy) pins the same corpus as the LF one in the index.
const raw = fs.readFileSync(fixturePath).toString('utf8').replace(/\r\n/g, '\n');
const corpus = JSON.parse(raw) as {
  version: number;
  vectors: Array<{ id: string; text: string; expected: string; kinds: string[]; masked: string }>;
  sequences: Array<{ id: string; messages: string[]; blockedAt: number[]; statuses: string[]; masked: string[] }>;
  fields: Array<{ id: string; fields: Record<string, string>; expected: string; masked: Record<string, string> }>;
  addresses: Array<{ address: Record<string, string>; tokens: { numbers: string[]; grams: string[] }; cases: Array<{ id: string; text: string; expected: string; masked: string }> }>;
  names: Array<{ name: string; ok: boolean }>;
};

describe('contact-information golden corpus', () => {
  it('is the pinned corpus (edit the corpus → re-pin the hash in both repos)', () => {
    expect(crypto.createHash('sha256').update(raw).digest('hex')).toBe(CONTACT_VECTORS_SHA256);
    expect(corpus.vectors.length).toBeGreaterThanOrEqual(120);
  });

  it.each(corpus.vectors.map((v) => [v.id, v]))('vector %s', (_id, v) => {
    const r = detectContact(v.text);
    expect(r.status).toBe(v.expected);
    for (const k of v.kinds) expect(r.kinds).toContain(k);
    expect(maskContactInfo(v.text)).toBe(v.masked);
    // the legacy API agrees
    const legacy = checkText(v.text);
    expect(getModerationStatus(legacy.confidence)).toBe(v.expected);
  });

  it.each(corpus.sequences.map((s) => [s.id, s]))('sequence %s', (_id, s) => {
    const ctx: string[] = [];
    const blocked: number[] = [];
    const statuses: string[] = [];
    s.messages.forEach((msg, i) => {
      const r = checkCandidate(ctx, msg);
      statuses.push(r.status);
      if (r.status === ModerationStatus.BLOCKED) blocked.push(i);
      else ctx.push(msg);
    });
    expect(blocked).toEqual(s.blockedAt);
    expect(statuses).toEqual(s.statuses);
    expect(maskContactInfoParts(s.messages)).toEqual(s.masked);
  });

  it.each(corpus.fields.map((f) => [f.id, f]))('fields %s', (_id, f) => {
    const keys = Object.keys(f.fields);
    const parts = keys.map((k) => f.fields[k]);
    expect(detectContactInParts(parts).status).toBe(f.expected);
    const masked = maskContactInfoParts(parts);
    expect(Object.fromEntries(keys.map((k, i) => [k, masked[i]]))).toEqual(f.masked);
  });

  it.each(corpus.addresses.map((a, i) => [i, a]))('address block %s: tokens and disclosure cases', (_i, block) => {
    const tokens = buildAddressTokens(block.address);
    expect(tokens).toEqual(block.tokens);
    for (const c of block.cases) {
      expect(detectContact(c.text, { address: tokens }).status).toBe(c.expected);
      expect(maskContactInfo(c.text, { address: tokens })).toBe(c.masked);
    }
  });

  it.each(corpus.names.map((n) => [JSON.stringify(n.name), n]))('name %s', (_id, n) => {
    expect(isAcceptableName(n.name)).toBe(n.ok);
  });

  it('normalisation keeps a map back to the original offsets', () => {
    const n = normalizeForModeration('Call ९८७६५ 43210');
    expect(n.text).toBe('call 98765 43210');
    expect(n.from[5]).toBe(5); // '९' starts at offset 5
    expect(n.to[9]).toBe(10);
  });

  it('fragment-bearing classifier', () => {
    for (const t of ['98765', 'rahul@', 'dot com', 'gmail', 'insta', 'rahul_123', 'x.in', 'call 12 34']) expect(isFragmentBearing(t)).toBe(true);
    for (const t of ['hello there', 'is the villa available?', 'we are 4', 'see you at 6']) expect(isFragmentBearing(t)).toBe(false);
  });

  it('adversarial 4000-character inputs are processed in milliseconds', () => {
    const inputs = ['a'.repeat(2000) + ' '.repeat(2000), 'x'.repeat(1000) + ' '.repeat(1000) + '(' + ' '.repeat(1000) + 'at' + ' '.repeat(990), 'a.'.repeat(2000), '9'.repeat(4000), ('a' + ' '.repeat(30)).repeat(129), 'a@'.repeat(2000), '9 '.repeat(2000), 'nine '.repeat(800), '(at) '.repeat(800), 'dot '.repeat(1000), '1.2.3.4.'.repeat(500), 'a-'.repeat(2000), '9876543210 '.repeat(363), 'x.in '.repeat(800)];
    for (const input of inputs) {
      const t0 = process.hrtime.bigint();
      detectContact(input);
      maskContactInfo(input);
      expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(40);
    }
  });
});
