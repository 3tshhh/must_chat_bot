-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "onboardingComplete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "profile" JSONB;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "onboardingComplete" BOOLEAN,
ADD COLUMN     "profile" JSONB;
