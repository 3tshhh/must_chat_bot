import type { Conversation } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { AppError } from '../lib/errors.js';

const LIST_PAGE_SIZE = 30;
const MESSAGE_PAGE_SIZE = 100;

export async function createConversation(visitorId: string, title?: string) {
  return prisma.conversation.create({
    data: { visitorId, title: title?.slice(0, 200) ?? null },
    select: { id: true, title: true, createdAt: true, lastMessageAt: true },
  });
}

/**
 * Loads a conversation *and* checks ownership in one step.
 * A conversation belonging to someone else is reported as 404, not 403 — a 403
 * would confirm that the UUID exists.
 */
export async function getOwnedConversation(
  conversationId: string,
  visitorId: string,
): Promise<Conversation> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, visitorId, deletedAt: null },
  });
  if (!conversation) throw AppError.notFound('Conversation not found');
  return conversation;
}

export async function listConversations(visitorId: string, cursor?: string) {
  const rows = await prisma.conversation.findMany({
    where: { visitorId, deletedAt: null },
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    take: LIST_PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      title: true,
      createdAt: true,
      lastMessageAt: true,
      onboardingComplete: true,
    },
  });

  const hasMore = rows.length > LIST_PAGE_SIZE;
  const items = hasMore ? rows.slice(0, LIST_PAGE_SIZE) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}

export async function listMessages(conversationId: string, cursor?: string) {
  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { seq: 'asc' },
    take: MESSAGE_PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      seq: true,
      role: true,
      status: true,
      content: true,
      errorCode: true,
      errorMessage: true,
      standaloneQuestion: true,
      sources: true,
      profile: true,
      onboardingComplete: true,
      createdAt: true,
      completedAt: true,
    },
  });

  const hasMore = rows.length > MESSAGE_PAGE_SIZE;
  const items = hasMore ? rows.slice(0, MESSAGE_PAGE_SIZE) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}

export async function renameConversation(
  conversationId: string,
  visitorId: string,
  title: string,
) {
  await getOwnedConversation(conversationId, visitorId);
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { title: title.slice(0, 200) },
    select: { id: true, title: true, lastMessageAt: true },
  });
}

/** Soft delete: the whole point of this backend is reviewing conversations later. */
export async function deleteConversation(conversationId: string, visitorId: string) {
  await getOwnedConversation(conversationId, visitorId);
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { deletedAt: new Date() },
  });
}
