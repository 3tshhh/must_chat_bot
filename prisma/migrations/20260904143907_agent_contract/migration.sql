/*
  Warnings:

  - You are about to drop the column `agentThreadId` on the `Conversation` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Conversation" DROP COLUMN "agentThreadId";

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "sources" JSONB,
ADD COLUMN     "standaloneQuestion" TEXT;
