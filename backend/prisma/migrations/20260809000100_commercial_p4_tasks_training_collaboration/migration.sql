-- Commercial P4 — Tasks + Training collaboration surface (additive only).
--
-- Adds the task discussion thread, task attachment linkage, and the two training
-- completion artifacts (internal certificate + reviewer evaluation).
--
-- Every new table carries "companyId" and composite tenant foreign keys
-- ("<id>", "companyId") -> ("id", "companyId"), so a row can never reference
-- another company's record even if an attacker supplies a foreign identifier.
--
-- Data-safety boundary: no DROP TABLE, DROP COLUMN, DROP INDEX, DROP SCHEMA,
-- DROP CONSTRAINT, TRUNCATE or DELETE FROM. Every statement is additive and the
-- one column added to an existing table ("Attachment"."taskId") is nullable, so
-- existing rows remain valid and a rollback needs no data repair.

BEGIN;

-- ---------------------------------------------------------------------------
-- TaskComment — task discussion thread.
--
-- Visibility is never stored here: it is derived at read time from the parent
-- task's own department/assignment scope, so a comment can never be broader
-- than the task it belongs to.
-- ---------------------------------------------------------------------------
CREATE TABLE "TaskComment" (
    "id"           TEXT         NOT NULL,
    "companyId"    TEXT         NOT NULL,
    "taskId"       TEXT         NOT NULL,
    "authorUserId" TEXT         NOT NULL,
    "body"         TEXT         NOT NULL,
    "createdAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskComment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TaskComment_body_check" CHECK (char_length("body") BETWEEN 1 AND 4000)
);

CREATE UNIQUE INDEX "TaskComment_id_companyId_key"
    ON "TaskComment"("id", "companyId");

-- Keyset pagination support, mirroring ChatMessage's (conversationId, createdAt, id).
CREATE INDEX "TaskComment_companyId_taskId_createdAt_id_idx"
    ON "TaskComment"("companyId", "taskId", "createdAt", "id");

CREATE INDEX "TaskComment_authorUserId_idx"
    ON "TaskComment"("authorUserId");

ALTER TABLE "TaskComment"
    ADD CONSTRAINT "TaskComment_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "TaskComment_taskId_companyId_fkey"
        FOREIGN KEY ("taskId", "companyId") REFERENCES "Task"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "TaskComment_authorUserId_companyId_fkey"
        FOREIGN KEY ("authorUserId", "companyId") REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Attachment.taskId — third attachment purpose ("task").
--
-- Nullable and unconstrained for existing rows: every pre-P4 attachment is a
-- chat or purchasing attachment and keeps taskId NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE "Attachment"
    ADD COLUMN "taskId" TEXT;

CREATE INDEX "Attachment_companyId_taskId_idx"
    ON "Attachment"("companyId", "taskId");

ALTER TABLE "Attachment"
    ADD CONSTRAINT "Attachment_taskId_companyId_fkey"
        FOREIGN KEY ("taskId", "companyId") REFERENCES "Task"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- TrainingCertificate — internal completion record for a finished assignment.
--
-- Snapshot columns freeze the course title and employee identity at issue time,
-- so a later course rename or employee edit cannot retroactively change an
-- already-issued certificate. Issue-only: revocation is deliberately not
-- modelled (recorded as a deferred P4 decision).
-- ---------------------------------------------------------------------------
CREATE TABLE "TrainingCertificate" (
    "id"                   TEXT           NOT NULL,
    "companyId"            TEXT           NOT NULL,
    "assignmentId"         TEXT           NOT NULL,
    "courseId"             TEXT           NOT NULL,
    "employeeId"           TEXT           NOT NULL,
    "serialNumber"         TEXT           NOT NULL,
    "courseTitleSnapshot"  TEXT           NOT NULL,
    "employeeNameSnapshot" TEXT           NOT NULL,
    "employeeNumSnapshot"  TEXT           NOT NULL,
    "completedAtSnapshot"  TIMESTAMPTZ(3) NOT NULL,
    "issuedByUserId"       TEXT           NOT NULL,
    "issuedAt"             TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"            TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3)   NOT NULL,

    CONSTRAINT "TrainingCertificate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrainingCertificate_id_companyId_key"
    ON "TrainingCertificate"("id", "companyId");

-- One certificate per assignment. The composite FK to (id, companyId) means a
-- second row under a different company could never resolve, so this is exact.
CREATE UNIQUE INDEX "TrainingCertificate_assignmentId_companyId_key"
    ON "TrainingCertificate"("assignmentId", "companyId");

CREATE UNIQUE INDEX "TrainingCertificate_companyId_serialNumber_key"
    ON "TrainingCertificate"("companyId", "serialNumber");

CREATE INDEX "TrainingCertificate_companyId_employeeId_issuedAt_idx"
    ON "TrainingCertificate"("companyId", "employeeId", "issuedAt");

CREATE INDEX "TrainingCertificate_companyId_courseId_idx"
    ON "TrainingCertificate"("companyId", "courseId");

CREATE INDEX "TrainingCertificate_issuedByUserId_idx"
    ON "TrainingCertificate"("issuedByUserId");

ALTER TABLE "TrainingCertificate"
    ADD CONSTRAINT "TrainingCertificate_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "TrainingCertificate_assignmentId_companyId_fkey"
        FOREIGN KEY ("assignmentId", "companyId") REFERENCES "TrainingAssignment"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "TrainingCertificate_courseId_companyId_fkey"
        FOREIGN KEY ("courseId", "companyId") REFERENCES "TrainingCourse"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "TrainingCertificate_employeeId_companyId_fkey"
        FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "TrainingCertificate_issuedByUserId_companyId_fkey"
        FOREIGN KEY ("issuedByUserId", "companyId") REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- TrainingEvaluation — reviewer-authored assessment of a completed assignment.
--
-- Performance-adjacent, so reading it requires an explicit permission rather
-- than the ordinary training-view scope. Scores are bounded 1..5 small integers
-- and never enter audit payloads (audit.ts forbids a "score" key by regex).
-- ---------------------------------------------------------------------------
CREATE TABLE "TrainingEvaluation" (
    "id"                 TEXT           NOT NULL,
    "companyId"          TEXT           NOT NULL,
    "assignmentId"       TEXT           NOT NULL,
    "courseId"           TEXT           NOT NULL,
    "employeeId"         TEXT           NOT NULL,
    "effectivenessScore" INTEGER        NOT NULL,
    "knowledgeScore"     INTEGER        NOT NULL,
    "applicationScore"   INTEGER        NOT NULL,
    "recommendation"     TEXT           NOT NULL,
    "comment"            TEXT,
    "evaluatedByUserId"  TEXT           NOT NULL,
    "evaluatedAt"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"          TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3)   NOT NULL,

    CONSTRAINT "TrainingEvaluation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TrainingEvaluation_effectivenessScore_check"
        CHECK ("effectivenessScore" BETWEEN 1 AND 5),
    CONSTRAINT "TrainingEvaluation_knowledgeScore_check"
        CHECK ("knowledgeScore" BETWEEN 1 AND 5),
    CONSTRAINT "TrainingEvaluation_applicationScore_check"
        CHECK ("applicationScore" BETWEEN 1 AND 5),
    CONSTRAINT "TrainingEvaluation_recommendation_check"
        CHECK ("recommendation" IN ('recommended', 'recommended_with_follow_up', 'repeat_required')),
    CONSTRAINT "TrainingEvaluation_comment_check"
        CHECK ("comment" IS NULL OR char_length("comment") BETWEEN 1 AND 2000)
);

CREATE UNIQUE INDEX "TrainingEvaluation_id_companyId_key"
    ON "TrainingEvaluation"("id", "companyId");

-- One evaluation per assignment (same composite-FK reasoning as the certificate).
CREATE UNIQUE INDEX "TrainingEvaluation_assignmentId_companyId_key"
    ON "TrainingEvaluation"("assignmentId", "companyId");

CREATE INDEX "TrainingEvaluation_companyId_employeeId_evaluatedAt_idx"
    ON "TrainingEvaluation"("companyId", "employeeId", "evaluatedAt");

CREATE INDEX "TrainingEvaluation_companyId_courseId_idx"
    ON "TrainingEvaluation"("companyId", "courseId");

CREATE INDEX "TrainingEvaluation_evaluatedByUserId_idx"
    ON "TrainingEvaluation"("evaluatedByUserId");

ALTER TABLE "TrainingEvaluation"
    ADD CONSTRAINT "TrainingEvaluation_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "TrainingEvaluation_assignmentId_companyId_fkey"
        FOREIGN KEY ("assignmentId", "companyId") REFERENCES "TrainingAssignment"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "TrainingEvaluation_courseId_companyId_fkey"
        FOREIGN KEY ("courseId", "companyId") REFERENCES "TrainingCourse"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "TrainingEvaluation_employeeId_companyId_fkey"
        FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "TrainingEvaluation_evaluatedByUserId_companyId_fkey"
        FOREIGN KEY ("evaluatedByUserId", "companyId") REFERENCES "User"("id", "companyId")
        ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
