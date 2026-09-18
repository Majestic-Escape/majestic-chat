import { Router, Request, Response, NextFunction } from 'express';
import { ChatService } from '../services/ChatService';
import { ChatError, isChatError } from '@majestic/chat-shared';
import { logger } from '../lib/logger';
import { cacheGet, cacheSetEx } from '../lib/cache';
import jwt from 'jsonwebtoken';

const router = Router();
const chatService = new ChatService();

interface AuthRequest extends Request {
  user?: {
    id: string;
    firstName: string;
  };
}

// Property host validation result
interface PropertyValidationResult {
  valid: boolean;
  message?: string;
}

// Property API response structure
interface PropertyApiResponse {
  success?: boolean;
  data?: {
    host?: { _id?: string; id?: string } | string;
    hostId?: string;
  };
  property?: {
    host?: { _id?: string; id?: string } | string;
    hostId?: string;
  };
  host?: { _id?: string; id?: string } | string;
  hostId?: string;
}

// Validate that the hostId matches the property's actual host
// Redis-cached: key prophost:{propertyId}, TTL: 1 hour
async function validatePropertyHost(propertyId: string, hostId: string): Promise<PropertyValidationResult> {
  try {
    // 1. Check Redis cache for resolved hostId (optional cache)
    const cacheKey = `prophost:${propertyId}`;
    const cachedHostId = await cacheGet(cacheKey);
    
    if (cachedHostId) {
      const isValid = String(cachedHostId) === String(hostId);
      if (!isValid) {
        logger.warn({ propertyId, cachedHostId, providedHostId: hostId }, 'Host ID mismatch (cached)');
        return { valid: false, message: 'Host ID does not match property owner' };
      }
      return { valid: true };
    }

    // 2. Cache miss — fetch from API
    const apiBaseUrl = process.env.MAIN_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:5005/api/v1';
    
    logger.debug({ apiBaseUrl, propertyId, hostId }, 'Validating property host');
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    let fetchResponse: globalThis.Response;
    try {
      fetchResponse = await fetch(`${apiBaseUrl}/properties/${propertyId}`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    
    if (!fetchResponse.ok) {
      if (fetchResponse.status === 404) {
        return { valid: false, message: 'Property not found' };
      }
      logger.warn({ propertyId, status: fetchResponse.status }, 'Failed to fetch property for validation - allowing request');
      return { valid: true };
    }

    const data = await fetchResponse.json() as PropertyApiResponse;
    const property = data.data || data.property || data;

    let propertyHostId: string | undefined;
    if (typeof property.host === 'object' && property.host !== null) {
      propertyHostId = property.host._id || property.host.id;
    } else if (typeof property.host === 'string') {
      propertyHostId = property.host;
    } else {
      propertyHostId = property.hostId;
    }
    
    if (!propertyHostId) {
      logger.warn({ propertyId }, 'Property has no host field - allowing request');
      return { valid: true };
    }

    // 3. Cache the resolved hostId for 1 hour
    await cacheSetEx(cacheKey, 3600, String(propertyHostId));

    if (String(propertyHostId) !== String(hostId)) {
      logger.warn({ propertyId, propertyHostId, providedHostId: hostId }, 'Host ID mismatch');
      return { valid: false, message: 'Host ID does not match property owner' };
    }

    logger.debug({ propertyId, hostId }, 'Property host validation successful');
    return { valid: true };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      logger.warn({ propertyId, hostId }, 'Property validation timed out - allowing request');
    } else {
      logger.error({ error, propertyId, hostId }, 'Error validating property host - allowing request');
    }
    return { valid: true };
  }
}

// Middleware to verify JWT token
function verifyToken(req: AuthRequest, res: Response, next: NextFunction): void {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'No token provided' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string; firstName: string };
    
    req.user = {
      id: decoded.userId,
      firstName: decoded.firstName,
    };
    next();
  } catch (error) {
    logger.error({ error }, 'Token verification failed');
    res.status(401).json({ success: false, message: 'Invalid token' });
    return;
  }
}

// GET /api/chat/conversations - Get conversations for user (supports role filtering)
router.get('/conversations', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const role = req.query.role as string | undefined;

    let conversations;
    if (role === 'host' || role === 'guest') {
      // Server-side role filtering — avoids fetching all convs then discarding in JS
      conversations = await chatService.getConversationsByRole(userId, role);
    } else {
      conversations = await chatService.getConversations(userId);
    }
    
    res.json({ success: true, data: conversations });
  } catch (error) {
    logger.error({ error }, 'Error fetching conversations');
    if (isChatError(error)) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to fetch conversations' });
  }
});

// GET /api/chat/conversations/check - Check if conversation exists for property
router.get('/conversations/check', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const { propertyId, hostId, guestId } = req.query;

    if (!propertyId || !hostId || !guestId) {
      res.status(400).json({
        success: false,
        message: 'Property ID, Host ID, and Guest ID are required',
      });
      return;
    }

    // Verify the requesting user is either the host or guest
    if (userId !== hostId && userId !== guestId) {
      res.status(403).json({
        success: false,
        message: 'You are not authorized to check this conversation',
      });
      return;
    }

    const conversation = await chatService.checkConversationExists(
      propertyId as string,
      hostId as string,
      guestId as string
    );

    res.json({ 
      success: true, 
      data: { 
        exists: !!conversation,
        conversationId: conversation?.id || null,
        hasMessages: !!conversation?.lastMessage
      } 
    });
  } catch (error) {
    logger.error({ error }, 'Error checking conversation');
    if (isChatError(error)) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to check conversation' });
  }
});

// POST /api/chat/conversations - Create or get existing conversation
router.post('/conversations', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { propertyId, hostId, guestId, bookingId, hostFirstName, hostLastName, guestFirstName, guestLastName } = req.body;
    const userId = req.user!.id;

    logger.debug({ propertyId, hostId, guestId, userId }, 'Creating conversation request');

    if (!propertyId || !hostId || !guestId) {
      res.status(400).json({
        success: false,
        message: 'Property ID, Host ID, and Guest ID are required',
      });
      return;
    }

    // Verify the requesting user is either the host or guest
    if (userId !== hostId && userId !== guestId) {
      logger.warn({ userId, hostId, guestId }, 'User not authorized to create conversation');
      res.status(403).json({
        success: false,
        message: 'You are not authorized to create this conversation',
      });
      return;
    }

    // Server-side validation: Verify hostId matches the property's actual host
    // This prevents malicious users from creating conversations with arbitrary hosts
    const propertyValidation = await validatePropertyHost(propertyId, hostId);
    if (!propertyValidation.valid) {
      logger.warn({ propertyId, hostId, userId, message: propertyValidation.message }, 'Invalid hostId for property');
      res.status(400).json({
        success: false,
        message: propertyValidation.message || 'Invalid host for this property',
      });
      return;
    }

    const conversation = await chatService.getOrCreateConversation(
      propertyId,
      hostId,
      guestId,
      bookingId,
      { hostFirstName, hostLastName, guestFirstName, guestLastName }
    );

    logger.info({ conversationId: conversation.id, propertyId }, 'Conversation created/retrieved successfully');
    res.json({ success: true, data: conversation });
  } catch (error) {
    logger.error({ error, body: req.body }, 'Error creating conversation');
    if (isChatError(error)) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to create conversation' });
  }
});

// GET /api/chat/conversations/:id - Get single conversation
router.get('/conversations/:id', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const conversationId = req.params.id;

    const conversation = await chatService.getConversation(conversationId, userId);
    
    res.json({ success: true, data: conversation });
  } catch (error) {
    logger.error({ error }, 'Error fetching conversation');
    if (isChatError(error)) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to fetch conversation' });
  }
});

// GET /api/chat/conversations/:id/messages - Get messages for conversation
router.get('/conversations/:id/messages', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const conversationId = req.params.id;
    const { limit = '50', cursor, direction = 'before' } = req.query;

    const messages = await chatService.getMessages(conversationId, userId, {
      limit: parseInt(limit as string, 10),
      cursor: cursor as string | undefined,
      direction: direction as 'before' | 'after',
    });

    res.json({ success: true, data: messages });
  } catch (error) {
    logger.error({ error }, 'Error fetching messages');
    if (isChatError(error)) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to fetch messages' });
  }
});

// GET /api/chat/unread-count - Get total unread message count for user (role-scoped)
router.get('/unread-count', verifyToken, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;
    const role = (req.query.role as string) || 'guest';

    const { UnreadCountService } = await import('../services/UnreadCountService');
    const unreadCountService = UnreadCountService.getInstance();

    // Support 'all' to return both host and guest counts in one call
    if (role === 'all') {
      const counts = await unreadCountService.getBothUnreadCounts(userId);
      res.json({ success: true, data: { host: counts.host, guest: counts.guest } });
      return;
    }

    if (role !== 'host' && role !== 'guest') {
      res.status(400).json({ success: false, message: 'Invalid role. Must be "host", "guest", or "all".' });
      return;
    }
    
    const totalUnread = await unreadCountService.getTotalUnread(userId, role);
    res.json({ success: true, data: { totalUnread, role } });
  } catch (error) {
    logger.error({ error }, 'Error fetching unread count');
    if (isChatError(error)) {
      res.status(error.statusCode).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to fetch unread count' });
  }
});

export { router as conversationRoutes };
