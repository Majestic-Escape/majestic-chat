import mongoose from 'mongoose';
import {
  ChatError,
  ErrorCode,
  MessageType,
  MessageModel,
  CHAT_CONFIG,
  buildReplySnippet,
} from '@majestic/chat-shared';
import { ChatService } from '../services/ChatService';
import { MessageRepository } from '../repositories/MessageRepository';
import {
  startDb,
  stopDb,
  clearDb,
  makeConversation,
  rawMessage,
  rawConversation,
  countMessages,
  cid,
  HOST_ID,
  GUEST_ID,
  STRANGER_ID,
} from './helpers/db';

const service = new ChatService();
const text = (conversationId: string, senderId: string, t: string, extra: Record<string, unknown> = {}) =>
  service.sendMessage({ conversationId, senderId, content: { text: t }, type: MessageType.TEXT, clientMessageId: cid(), ...extra });

async function expectChatError(p: Promise<unknown>, code: ErrorCode): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(ChatError);
  await p.catch((e: ChatError) => expect(e.code).toBe(code));
}

beforeAll(async () => {
  await startDb();
});
afterAll(async () => {
  await stopDb();
});
beforeEach(async () => {
  await clearDb();
});

describe('buildReplySnippet', () => {
  const max = CHAT_CONFIG.REPLY_SNIPPET_MAX;
  it('collapses whitespace and trims', () => {
    expect(buildReplySnippet('  hello\n\n  world\t! x  ', false)).toBe('hello world ! x');
  });
  it('is empty / [Attachment] when there is no text', () => {
    expect(buildReplySnippet('', false)).toBe('');
    expect(buildReplySnippet('   ', false)).toBe('');
    expect(buildReplySnippet(undefined, false)).toBe('');
    expect(buildReplySnippet(undefined, true)).toBe('[Attachment]');
    expect(buildReplySnippet('has text', true)).toBe('has text');
  });
  it('truncates to exactly the max and never splits a surrogate pair', () => {
    expect(buildReplySnippet('a'.repeat(1000), false)).toHaveLength(max);
    expect(buildReplySnippet('a'.repeat(max), false)).toHaveLength(max);
    expect(buildReplySnippet('a'.repeat(max + 1), false)).toHaveLength(max);
    // 279 ascii + an emoji (2 code units) straddles the boundary → emoji dropped
    const straddle = buildReplySnippet('a'.repeat(max - 1) + '😀' + 'tail', false);
    expect(straddle).toBe('a'.repeat(max - 1));
    expect(straddle.length).toBeLessThanOrEqual(max);
    // 278 ascii + emoji fits exactly
    const fits = buildReplySnippet('a'.repeat(max - 2) + '😀' + 'tail', false);
    expect(fits).toBe('a'.repeat(max - 2) + '😀');
    for (const s of [straddle, fits]) {
      const last = s.charCodeAt(s.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false); // no lone high surrogate
    }
  });
  it('keeps CJK, combining marks and bidi/HTML characters as-is', () => {
    const s = '日本語 é ‮abc <script>alert(1)</script> "q"';
    expect(buildReplySnippet(s, false)).toBe(s);
  });
});

describe('sendMessage with replyTo', () => {
  it('stores a server-derived snapshot of the quoted message (happy path, own and theirs)', async () => {
    const conv = await makeConversation();
    const { message: original } = await text(conv, HOST_ID, 'Original  message\nwith newline');
    const { message: reply, created } = await text(conv, GUEST_ID, 'my reply', { replyTo: { messageId: original.id } });
    expect(created).toBe(true);
    expect(reply.replyTo).toEqual({
      messageId: original.id,
      senderId: HOST_ID,
      text: 'Original message with newline',
      type: 'text',
    });
    // quoting your own message
    const { message: own } = await text(conv, GUEST_ID, 'quoting myself', { replyTo: { messageId: reply.id } });
    expect(own.replyTo?.senderId).toBe(GUEST_ID);
    expect(own.replyTo?.text).toBe('my reply');
    // raw document holds exactly the four fields, no _id
    const raw = await rawMessage(reply.id);
    expect(raw?.replyTo).toEqual({ messageId: original.id, senderId: HOST_ID, text: 'Original message with newline', type: 'text' });
  });

  it('truncates long originals to REPLY_SNIPPET_MAX and quotes legacy >4000-char originals', async () => {
    const conv = await makeConversation();
    // legacy over-long message inserted directly (predates the cap)
    const legacy = await MessageModel.create({
      conversationId: conv,
      senderId: HOST_ID,
      clientMessageId: cid(),
      type: 'text',
      content: { text: 'x'.repeat(5000) },
      moderation: { status: 'clean', flags: [], confidence: 0 },
      readBy: [],
      status: 'sent',
    });
    const { message } = await text(conv, GUEST_ID, 'r', { replyTo: { messageId: legacy._id.toString() } });
    expect(message.replyTo?.text).toHaveLength(CHAT_CONFIG.REPLY_SNIPPET_MAX);
  });

  it('quotes attachment-only, text+attachment and every message type', async () => {
    const conv = await makeConversation();
    const att = { id: 'a1', url: 'https://x.test/a.png', type: 'image' as const, filename: 'a.png', size: 10, mimeType: 'image/png' };
    // No client may send attachments until an upload path exists (schema
    // rejects them); such originals can only be legacy rows, so seed them
    // directly and make sure they still quote correctly.
    await expect(service.sendMessage({
      conversationId: conv, senderId: HOST_ID, type: MessageType.IMAGE, clientMessageId: cid(), content: { attachments: [att] },
    })).rejects.toThrow();
    const onlyAtt = await MessageModel.create({ conversationId: conv, senderId: HOST_ID, clientMessageId: cid(), type: MessageType.IMAGE, content: { attachments: [att] }, moderation: { status: 'clean', flags: [], confidence: 0 }, readBy: [], status: 'sent' });
    const both = await MessageModel.create({ conversationId: conv, senderId: HOST_ID, clientMessageId: cid(), type: MessageType.IMAGE, content: { text: 'see pic', attachments: [att] }, moderation: { status: 'clean', flags: [], confidence: 0 }, readBy: [], status: 'sent' });
    const r1 = await text(conv, GUEST_ID, 'r1', { replyTo: { messageId: onlyAtt._id.toString() } });
    const r2 = await text(conv, GUEST_ID, 'r2', { replyTo: { messageId: both._id.toString() } });
    expect(r1.message.replyTo).toMatchObject({ text: '[Attachment]', type: 'image' });
    expect(r2.message.replyTo).toMatchObject({ text: 'see pic', type: 'image' });
    for (const type of Object.values(MessageType)) {
      const { message: m } = await service.sendMessage({
        conversationId: conv, senderId: HOST_ID, type, clientMessageId: cid(), content: { text: `typed ${type}` },
      });
      const { message: r } = await text(conv, GUEST_ID, 'reply', { replyTo: { messageId: m.id } });
      expect(r.replyTo?.type).toBe(type);
    }
  });

  it('never nests: a reply to a reply carries only the direct original', async () => {
    const conv = await makeConversation();
    const { message: a } = await text(conv, HOST_ID, 'A');
    const { message: b } = await text(conv, GUEST_ID, 'B', { replyTo: { messageId: a.id } });
    const { message: c } = await text(conv, HOST_ID, 'C', { replyTo: { messageId: b.id } });
    expect(c.replyTo).toEqual({ messageId: b.id, senderId: GUEST_ID, text: 'B', type: 'text' });
    expect((c.replyTo as Record<string, unknown>).replyTo).toBeUndefined();
    const raw = await rawMessage(c.id);
    expect(Object.keys(raw!.replyTo as object).sort()).toEqual(['messageId', 'senderId', 'text', 'type']);
  });

  it('rejects unknown, foreign-conversation and deleted targets with MESSAGE_NOT_FOUND', async () => {
    const conv = await makeConversation();
    const other = await makeConversation({ hostId: STRANGER_ID, guestId: 'ddddddddddddddddddddddd4' });
    const { message: foreign } = await text(other, STRANGER_ID, 'secret in another thread');
    await expectChatError(text(conv, GUEST_ID, 'x', { replyTo: { messageId: new mongoose.Types.ObjectId().toString() } }), ErrorCode.MESSAGE_NOT_FOUND);
    await expectChatError(text(conv, GUEST_ID, 'x', { replyTo: { messageId: foreign.id } }), ErrorCode.MESSAGE_NOT_FOUND);
    const { message: mine } = await text(conv, HOST_ID, 'to be deleted');
    await MessageModel.updateOne({ _id: mine.id }, { $set: { deletedAt: new Date() } });
    await expectChatError(text(conv, GUEST_ID, 'x', { replyTo: { messageId: mine.id } }), ErrorCode.MESSAGE_NOT_FOUND);
    expect(await countMessages({ conversationId: conv, 'content.text': 'x' })).toBe(0);
  });

  it('rejects malformed ids and forged snapshot fields at the schema', async () => {
    const conv = await makeConversation();
    await expect(text(conv, GUEST_ID, 'x', { replyTo: { messageId: 'not-an-id' } })).rejects.toThrow();
    // extra keys are stripped, the snapshot still comes from the server
    const { message: orig } = await text(conv, HOST_ID, 'real text');
    const { message: r } = await text(conv, GUEST_ID, 'x', { replyTo: { messageId: orig.id, text: 'FORGED', senderId: 'evil' } });
    expect(r.replyTo).toEqual({ messageId: orig.id, senderId: HOST_ID, text: 'real text', type: 'text' });
  });

  it('keeps the participant check and the 4000-char cap', async () => {
    const conv = await makeConversation();
    await expectChatError(text(conv, STRANGER_ID, 'hi'), ErrorCode.USER_NOT_PARTICIPANT);
    await expect(text(conv, GUEST_ID, 'a'.repeat(4001))).rejects.toThrow(/too long/);
    const ok = await text(conv, GUEST_ID, 'a'.repeat(4000));
    expect(ok.message.content.text).toHaveLength(4000);
  });
});

describe('idempotency and the transaction', () => {
  it('plain messages have no replyTo key at all (raw and serialised)', async () => {
    const conv = await makeConversation();
    const { message } = await text(conv, HOST_ID, 'plain');
    const raw = await rawMessage(message.id);
    expect(Object.prototype.hasOwnProperty.call(raw, 'replyTo')).toBe(false);
    expect(JSON.parse(JSON.stringify(message))).not.toHaveProperty('replyTo');
    const repo = new MessageRepository();
    const page = await repo.findByConversation(conv, { limit: 10, direction: 'before' });
    expect(page.data[0]).not.toHaveProperty('replyTo', expect.anything());
    expect(JSON.stringify(page.data[0])).not.toContain('replyTo');
  });

  it('applies lastMessage + unread atomically with the insert, once', async () => {
    const conv = await makeConversation();
    const { message } = await text(conv, HOST_ID, 'hello guest');
    const c = await rawConversation(conv);
    expect(c!.lastMessage).toMatchObject({ content: 'hello guest', senderId: HOST_ID });
    expect(new Date(c!.lastMessage.sentAt).getTime()).toBe(new Date(message.createdAt).getTime());
    expect(c!.unreadCount[GUEST_ID]).toBe(1);
    expect(c!.unreadCount[HOST_ID]).toBeUndefined();
  });

  it('a resend with the same clientMessageId returns the first message unchanged and touches nothing', async () => {
    const conv = await makeConversation();
    const { message: orig } = await text(conv, HOST_ID, 'orig');
    const id = cid();
    const first = await service.sendMessage({ conversationId: conv, senderId: GUEST_ID, content: { text: 'first' }, type: MessageType.TEXT, clientMessageId: id, replyTo: { messageId: orig.id } });
    const before = await rawConversation(conv);
    const again = await service.sendMessage({ conversationId: conv, senderId: GUEST_ID, content: { text: 'CHANGED' }, type: MessageType.TEXT, clientMessageId: id });
    expect(again.created).toBe(false);
    expect(again.message.id).toBe(first.message.id);
    expect(again.message.content.text).toBe('first');
    expect(again.message.replyTo?.messageId).toBe(orig.id);
    expect(again.recipientInfo).toEqual([{ userId: HOST_ID, role: 'host' }]);
    const after = await rawConversation(conv);
    expect(after!.unreadCount).toEqual(before!.unreadCount);
    expect(after!.lastMessage).toEqual(before!.lastMessage);
    expect(await countMessages({ conversationId: conv, clientMessageId: id })).toBe(1);
  });

  it('20 concurrent sends with one clientMessageId → one document, one side-effect application', async () => {
    const conv = await makeConversation();
    const id = cid();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.sendMessage({ conversationId: conv, senderId: GUEST_ID, content: { text: 'race' }, type: MessageType.TEXT, clientMessageId: id })
      )
    );
    const ids = new Set(results.map((r) => r.message.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await countMessages({ conversationId: conv, clientMessageId: id })).toBe(1);
    const c = await rawConversation(conv);
    expect(c!.unreadCount[HOST_ID]).toBe(1);
    expect(c!.lastMessage.content).toBe('race');
  });

  it('an aborted transaction leaves no message and no side effects; the retry succeeds', async () => {
    const conv = await makeConversation();
    const repo = (service as unknown as { messageRepo: MessageRepository }).messageRepo;
    const conversationModel = (repo as unknown as { conversationModel: { updateOne: (...a: unknown[]) => unknown } }).conversationModel;
    const spy = jest.spyOn(conversationModel, 'updateOne').mockImplementationOnce(() => {
      throw new Error('simulated crash inside the transaction');
    });
    const id = cid();
    await expect(
      service.sendMessage({ conversationId: conv, senderId: GUEST_ID, content: { text: 'boom' }, type: MessageType.TEXT, clientMessageId: id })
    ).rejects.toThrow(/simulated/);
    expect(await countMessages({ conversationId: conv })).toBe(0);
    expect((await rawConversation(conv))!.lastMessage).toBeUndefined();
    spy.mockRestore();
    const retry = await service.sendMessage({ conversationId: conv, senderId: GUEST_ID, content: { text: 'boom' }, type: MessageType.TEXT, clientMessageId: id });
    expect(retry.created).toBe(true);
    expect(await countMessages({ conversationId: conv })).toBe(1);
    expect((await rawConversation(conv))!.unreadCount[HOST_ID]).toBe(1);
  });

  it('replaying an old clientMessageId after later messages changes nothing', async () => {
    const conv = await makeConversation();
    const id = cid();
    await service.sendMessage({ conversationId: conv, senderId: GUEST_ID, content: { text: 'old' }, type: MessageType.TEXT, clientMessageId: id });
    for (let i = 0; i < 5; i++) await text(conv, GUEST_ID, `later ${i}`);
    const before = await rawConversation(conv);
    const replay = await service.sendMessage({ conversationId: conv, senderId: GUEST_ID, content: { text: 'old' }, type: MessageType.TEXT, clientMessageId: id });
    expect(replay.created).toBe(false);
    const after = await rawConversation(conv);
    expect(after!.unreadCount[HOST_ID]).toBe(6);
    expect(after!.lastMessage).toEqual(before!.lastMessage);
    expect(after!.lastMessage.content).toBe('later 4');
  });
});
