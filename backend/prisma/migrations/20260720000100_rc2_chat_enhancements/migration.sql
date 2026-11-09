-- Sprint 12K M10 — Chat enhancements: announcement type, replies, pins.
-- Additive only; retains history; no CASCADE deletes.

ALTER TABLE "ChatConversation"
  ADD COLUMN "repliesEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ChatConversation" DROP CONSTRAINT IF EXISTS "ChatConversation_type_check";
ALTER TABLE "ChatConversation" DROP CONSTRAINT IF EXISTS "ChatConversation_type_shape_check";

ALTER TABLE "ChatConversation"
  ADD CONSTRAINT "ChatConversation_type_check" CHECK ("type" IN ('direct', 'department', 'announcement')),
  ADD CONSTRAINT "ChatConversation_type_shape_check" CHECK (
      ("type" = 'direct' AND "directKey" IS NOT NULL AND "departmentId" IS NULL)
      OR
      ("type" = 'department' AND "departmentId" IS NOT NULL AND "directKey" IS NULL)
      OR
      ("type" = 'announcement' AND "departmentId" IS NULL AND "directKey" IS NULL AND "title" IS NOT NULL)
  );

ALTER TABLE "ChatMessage"
  ADD COLUMN "replyToMessageId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "ChatMessage_id_companyId_key" ON "ChatMessage"("id", "companyId");
CREATE INDEX IF NOT EXISTS "ChatMessage_replyToMessageId_idx" ON "ChatMessage"("replyToMessageId");

ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_replyToMessageId_companyId_fkey"
  FOREIGN KEY ("replyToMessageId", "companyId") REFERENCES "ChatMessage"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ChatPinnedMessage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "pinnedByUserId" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatPinnedMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatPinnedMessage_conversationId_messageId_key" ON "ChatPinnedMessage"("conversationId", "messageId");
CREATE UNIQUE INDEX "ChatPinnedMessage_id_companyId_key" ON "ChatPinnedMessage"("id", "companyId");
CREATE INDEX "ChatPinnedMessage_companyId_conversationId_pinnedAt_idx" ON "ChatPinnedMessage"("companyId", "conversationId", "pinnedAt");
CREATE INDEX "ChatPinnedMessage_messageId_idx" ON "ChatPinnedMessage"("messageId");
CREATE INDEX "ChatPinnedMessage_pinnedByUserId_idx" ON "ChatPinnedMessage"("pinnedByUserId");

ALTER TABLE "ChatPinnedMessage" ADD CONSTRAINT "ChatPinnedMessage_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatPinnedMessage" ADD CONSTRAINT "ChatPinnedMessage_conversationId_companyId_fkey"
    FOREIGN KEY ("conversationId", "companyId") REFERENCES "ChatConversation"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatPinnedMessage" ADD CONSTRAINT "ChatPinnedMessage_messageId_companyId_fkey"
    FOREIGN KEY ("messageId", "companyId") REFERENCES "ChatMessage"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatPinnedMessage" ADD CONSTRAINT "ChatPinnedMessage_pinnedByUserId_companyId_fkey"
    FOREIGN KEY ("pinnedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ChatPinnedMessage" ENABLE ROW LEVEL SECURITY;
