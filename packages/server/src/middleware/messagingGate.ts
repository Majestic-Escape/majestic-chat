import { Request, Response, NextFunction } from 'express';
import { ChatError, ErrorCode, MESSAGING_DISABLED_MESSAGE } from '@majestic/chat-shared';
import { TypedSocket } from '../socket/server';
import { isMessagingEnabled, peekMessagingEnabled } from '../lib/messagingToggle';

/**
 * The server-side half of the admin "Messaging" switch. When it is off nothing
 * in this service answers — not the REST API, not a socket handshake, not an
 * event on a socket that was already open. Hiding the UI is a courtesy; these
 * three gates are the control, and they run BEFORE authentication so a probe
 * learns nothing about tokens, conversations or users (and costs nothing).
 *
 *   messagingGate        every /api/chat REST route (503 + code)
 *   messagingSocketGate  the handshake (connect_error with data.code)
 *   messagingPacketGate  every packet of an open socket (ack + drop)
 */

/** REST: 503 `{ success:false, code:'MESSAGING_DISABLED', message }`. */
export async function messagingGate(_req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await isMessagingEnabled()) return next();
  res.set('Cache-Control', 'no-store');
  res.status(503).json({ success: false, code: ErrorCode.MESSAGING_DISABLED, message: MESSAGING_DISABLED_MESSAGE });
}

/** Socket handshake. A refusal from a middleware is not retried by the client. */
export async function messagingSocketGate(_socket: TypedSocket, next: (err?: Error) => void): Promise<void> {
  if (await isMessagingEnabled()) return next();
  const err = ChatError.messagingDisabled() as ChatError & { data?: unknown };
  err.data = { code: ErrorCode.MESSAGING_DISABLED };
  next(err);
}

/**
 * Per-packet check for a socket that is already connected. Reads the last
 * value seen synchronously (no await per keystroke, packets keep their order);
 * the sweep in `socket/server.ts` keeps that value fresh and drops the sockets.
 */
export function messagingPacketGate(socket: TypedSocket, packet: unknown[], next: (err?: Error) => void): void {
  if (peekMessagingEnabled() !== false) return next();
  const last = packet[packet.length - 1];
  if (typeof last === 'function') {
    (last as (r: unknown) => void)({ success: false, code: ErrorCode.MESSAGING_DISABLED, error: MESSAGING_DISABLED_MESSAGE });
  }
  socket.emit('messaging:disabled');
  socket.disconnect(true);
}
