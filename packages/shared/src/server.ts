// Server-only exports (includes Mongoose models)
// DO NOT import this in client code

export * from './index';
export { MessageModel, IMessageDocument } from './schemas/Message.schema';
export { ConversationModel, IConversationDocument } from './schemas/Conversation.schema';
