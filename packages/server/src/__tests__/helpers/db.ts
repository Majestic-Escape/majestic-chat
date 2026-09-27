import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ConversationModel, MessageModel, ParticipantRole } from '@majestic/chat-shared';

/**
 * One in-memory replica set per test file (transactions need a replica set —
 * exactly what every Atlas tier is). Indexes are synced so the unique
 * (conversationId, clientMessageId) index is enforced like in production.
 */
let replSet: MongoMemoryReplSet | null = null;

export async function startDb(connectOptions: mongoose.ConnectOptions = {}): Promise<string> {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const uri = replSet.getUri('majestic-chat-test');
  await mongoose.connect(uri, connectOptions);
  await MessageModel.syncIndexes();
  await ConversationModel.syncIndexes();
  return uri;
}

export async function clearDb(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  const collections = await db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

export async function stopDb(): Promise<void> {
  await mongoose.disconnect();
  if (replSet) {
    await replSet.stop();
    replSet = null;
  }
}

export const HOST_ID = 'aaaaaaaaaaaaaaaaaaaaaaa1';
export const GUEST_ID = 'bbbbbbbbbbbbbbbbbbbbbbb2';
export const STRANGER_ID = 'ccccccccccccccccccccccc3';

export async function makeConversation(opts: { hostId?: string; guestId?: string; propertyId?: string } = {}): Promise<string> {
  const doc = await ConversationModel.create({
    propertyId: opts.propertyId ?? 'prop-1',
    participants: [
      { userId: opts.hostId ?? HOST_ID, role: ParticipantRole.HOST, firstName: 'Hosty', joinedAt: new Date() },
      { userId: opts.guestId ?? GUEST_ID, role: ParticipantRole.GUEST, firstName: 'Test', joinedAt: new Date() },
    ],
    unreadCount: {},
  });
  return doc._id.toString();
}

/** Raw document straight from the driver — no Mongoose transforms. */
export async function rawMessage(id: string): Promise<Record<string, unknown> | null> {
  const db = mongoose.connection.db!;
  return db.collection('messages').findOne({ _id: new mongoose.Types.ObjectId(id) }) as Promise<Record<string, unknown> | null>;
}

export async function rawConversation(id: string): Promise<Record<string, any> | null> {
  const db = mongoose.connection.db!;
  return db.collection('conversations').findOne({ _id: new mongoose.Types.ObjectId(id) }) as Promise<Record<string, any> | null>;
}

export async function countMessages(filter: Record<string, unknown> = {}): Promise<number> {
  return mongoose.connection.db!.collection('messages').countDocuments(filter);
}

let n = 0;
export const cid = (): string => `t-${Date.now()}-${++n}`;
