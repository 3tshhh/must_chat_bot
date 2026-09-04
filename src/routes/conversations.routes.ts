import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { conversationRateLimit, messageRateLimit } from '../middleware/rateLimit.js';
import { cancelGeneration, deleteConversationAndSession, sendMessage } from '../services/chat.service.js';
import {
  createConversation,
  getOwnedConversation,
  listConversations,
  listMessages,
  renameConversation,
} from '../services/conversation.service.js';
import { streamRoute } from './stream.routes.js';

export const conversationsRouter = Router();

const uuid = z.string().uuid('Expected a conversation UUID');
const idParams = z.object({ id: uuid });

/** POST /api/conversations — mint the UUID the website will route to. */
conversationsRouter.post('/', conversationRateLimit, async (req, res) => {
  const body = z.object({ title: z.string().trim().max(200).optional() }).parse(req.body ?? {});
  const conversation = await createConversation(req.visitorId, body.title);
  res.status(201).json(conversation);
});

/** GET /api/conversations — this visitor's threads, newest activity first. */
conversationsRouter.get('/', async (req, res) => {
  const query = z.object({ cursor: uuid.optional() }).parse(req.query);
  res.json(await listConversations(req.visitorId, query.cursor));
});

/** GET /api/conversations/:id — the transcript, for the UI and for later review. */
conversationsRouter.get('/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const query = z.object({ cursor: uuid.optional() }).parse(req.query);

  const conversation = await getOwnedConversation(id, req.visitorId);
  const messages = await listMessages(id, query.cursor);

  res.json({
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    lastMessageAt: conversation.lastMessageAt,
    // Optional UI/review state per the agent contract — not academic logic we
    // compute ourselves, just relayed from the agent's own onboarding flow.
    profile: conversation.profile,
    onboardingComplete: conversation.onboardingComplete,
    messages: messages.items,
    nextCursor: messages.nextCursor,
  });
});

conversationsRouter.patch('/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const body = z.object({ title: z.string().trim().min(1).max(200) }).parse(req.body);
  res.json(await renameConversation(id, req.visitorId, body.title));
});

conversationsRouter.delete('/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  await deleteConversationAndSession(id, req.visitorId);
  res.status(204).end();
});

/**
 * POST /api/conversations/:id/messages
 * Returns 202 with the ids; the tokens come from GET /stream. See sendMessage()
 * for why the two are split.
 */
conversationsRouter.post('/:id/messages', messageRateLimit, async (req, res) => {
  const { id } = idParams.parse(req.params);
  const body = z
    .object({
      content: z
        .string()
        .trim()
        // The agent requires question.length >= 2; matching it here turns a
        // would-be 422 from the agent into a clean 400 from us.
        .min(2, 'Message must be at least 2 characters')
        .max(env.MAX_MESSAGE_CHARS, `Message exceeds ${env.MAX_MESSAGE_CHARS} characters`),
    })
    .parse(req.body);

  const result = await sendMessage(id, req.visitorId, body.content);
  res.status(202).json({
    ...result,
    streamUrl: `/api/conversations/${id}/stream?messageId=${result.assistantMessageId}`,
  });
});

/** GET /api/conversations/:id/stream?messageId=… — resumable SSE. */
conversationsRouter.get('/:id/stream', streamRoute);

conversationsRouter.post('/:id/messages/:messageId/cancel', async (req, res) => {
  const params = z.object({ id: uuid, messageId: uuid }).parse(req.params);
  await cancelGeneration(params.id, req.visitorId, params.messageId);
  res.status(202).json({ ok: true });
});
