-- Sprint 8 internal chat foundation. This migration is additive and retains all history.

-- Composite department references enforce tenant boundaries in PostgreSQL.
CREATE UNIQUE INDEX "Department_id_companyId_key" ON "Department"("id", "companyId");

CREATE TABLE "ChatConversation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "departmentId" TEXT,
    "directKey" TEXT,
    "title" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatParticipant" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ChatParticipant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatConversation_id_companyId_key" ON "ChatConversation"("id", "companyId");
CREATE UNIQUE INDEX "ChatConversation_companyId_directKey_key" ON "ChatConversation"("companyId", "directKey");
CREATE UNIQUE INDEX "ChatConversation_companyId_departmentId_type_key" ON "ChatConversation"("companyId", "departmentId", "type");
CREATE INDEX "ChatConversation_companyId_type_lastMessageAt_idx" ON "ChatConversation"("companyId", "type", "lastMessageAt");
CREATE INDEX "ChatConversation_departmentId_idx" ON "ChatConversation"("departmentId");
CREATE INDEX "ChatConversation_createdByUserId_idx" ON "ChatConversation"("createdByUserId");

CREATE UNIQUE INDEX "ChatParticipant_conversationId_userId_key" ON "ChatParticipant"("conversationId", "userId");
CREATE INDEX "ChatParticipant_companyId_userId_active_idx" ON "ChatParticipant"("companyId", "userId", "active");
CREATE INDEX "ChatParticipant_conversationId_idx" ON "ChatParticipant"("conversationId");

CREATE INDEX "ChatMessage_conversationId_createdAt_id_idx" ON "ChatMessage"("conversationId", "createdAt", "id");
CREATE INDEX "ChatMessage_companyId_conversationId_idx" ON "ChatMessage"("companyId", "conversationId");
CREATE INDEX "ChatMessage_senderUserId_idx" ON "ChatMessage"("senderUserId");

ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_departmentId_companyId_fkey"
    FOREIGN KEY ("departmentId", "companyId") REFERENCES "Department"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_createdByUserId_companyId_fkey"
    FOREIGN KEY ("createdByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ChatParticipant" ADD CONSTRAINT "ChatParticipant_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatParticipant" ADD CONSTRAINT "ChatParticipant_conversationId_companyId_fkey"
    FOREIGN KEY ("conversationId", "companyId") REFERENCES "ChatConversation"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatParticipant" ADD CONSTRAINT "ChatParticipant_userId_companyId_fkey"
    FOREIGN KEY ("userId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_companyId_fkey"
    FOREIGN KEY ("conversationId", "companyId") REFERENCES "ChatConversation"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_senderUserId_companyId_fkey"
    FOREIGN KEY ("senderUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ChatConversation"
    ADD CONSTRAINT "ChatConversation_type_check" CHECK ("type" IN ('direct', 'department')),
    ADD CONSTRAINT "ChatConversation_type_shape_check" CHECK (
        ("type" = 'direct' AND "directKey" IS NOT NULL AND "departmentId" IS NULL)
        OR
        ("type" = 'department' AND "departmentId" IS NOT NULL AND "directKey" IS NULL)
    );

ALTER TABLE "ChatMessage"
    ADD CONSTRAINT "ChatMessage_body_length_check" CHECK (char_length(btrim("body")) BETWEEN 1 AND 4000);

-- Supabase Data API roles receive no direct table grants. The trusted backend
-- remains the only entry point and enforces membership and department scope.
ALTER TABLE "ChatConversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChatParticipant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChatMessage" ENABLE ROW LEVEL SECURITY;
