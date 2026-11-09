-- Sprint 12F M05: Attendance/Leave workflow schema (additive only).
-- Legacy single-column FKs on Attendance/LeaveRequest/LeaveApprovalHistory remain;
-- tenant-safe composite FKs are added alongside them for new workflow relations.
--
-- DEFERRED (post-preflight / follow-up migration):
--   UNIQUE ("companyId", "employeeId", "date") on "Attendance" — duplicate rows must be
--   resolved explicitly before enforcing one record per employee workday.
--   Partial UNIQUE one pending "AttendanceCorrection" per ("companyId", "attendanceId").
--   "AttendanceExemption" non-overlapping active exemption per user (exclusion constraint).
--   DROP legacy single-column FKs once composite tenant-safe FKs are verified in production.

BEGIN;

ALTER TABLE "Attendance"
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "Attendance"
    ADD CONSTRAINT "Attendance_version_nonnegative_check"
        CHECK ("version" >= 1);

CREATE UNIQUE INDEX "Attendance_id_companyId_key"
    ON "Attendance"("id", "companyId");

ALTER TABLE "Attendance"
    ADD CONSTRAINT "Attendance_employeeId_companyId_fkey"
        FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequest"
    ADD COLUMN "submittedByUserId" TEXT,
    ADD COLUMN "submissionMode" TEXT NOT NULL DEFAULT 'self',
    ADD COLUMN "submissionReason" TEXT;

ALTER TABLE "LeaveRequest"
    ADD CONSTRAINT "LeaveRequest_submissionMode_check"
        CHECK ("submissionMode" IN ('self', 'on_behalf')),
    ADD CONSTRAINT "LeaveRequest_submissionReason_check"
        CHECK ("submissionReason" IS NULL OR char_length(btrim("submissionReason")) BETWEEN 1 AND 500);

CREATE UNIQUE INDEX "LeaveRequest_id_companyId_key"
    ON "LeaveRequest"("id", "companyId");

CREATE INDEX "idx_LeaveRequest_company_submitter_created"
    ON "LeaveRequest"("companyId", "submittedByUserId", "createdAt");

ALTER TABLE "LeaveRequest"
    ADD CONSTRAINT "LeaveRequest_employeeId_companyId_fkey"
        FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "LeaveRequest_hrReviewerId_companyId_fkey"
        FOREIGN KEY ("hrReviewerId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "LeaveRequest_submittedByUserId_companyId_fkey"
        FOREIGN KEY ("submittedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveApprovalHistory"
    ADD COLUMN "fromStatus" TEXT,
    ADD COLUMN "toStatus" TEXT,
    ADD COLUMN "isOverride" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "actorRoleSnapshot" TEXT,
    ADD COLUMN "reasonCategory" TEXT;

CREATE INDEX "idx_LeaveApprovalHistory_request_created"
    ON "LeaveApprovalHistory"("leaveRequestId", "companyId", "createdAt");

CREATE INDEX "idx_LeaveApprovalHistory_action_states"
    ON "LeaveApprovalHistory"("companyId", "action", "fromStatus", "toStatus");

ALTER TABLE "LeaveApprovalHistory"
    ADD CONSTRAINT "LeaveApprovalHistory_leaveRequestId_companyId_fkey"
        FOREIGN KEY ("leaveRequestId", "companyId") REFERENCES "LeaveRequest"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "LeaveApprovalHistory_actionByUserId_companyId_fkey"
        FOREIGN KEY ("actionByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AttendanceExemption" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "employeeId" TEXT,
    "validFrom" TIMESTAMPTZ(3) NOT NULL,
    "validUntil" TIMESTAMPTZ(3),
    "reasonCategory" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdByUserId" TEXT NOT NULL,
    "revokedByUserId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "AttendanceExemption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AttendanceCorrection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "attendanceId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "requestedClockIn" TIMESTAMPTZ(3),
    "requestedClockOut" TIMESTAMPTZ(3),
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "decisionReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AttendanceCorrection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AttendanceCorrectionHistory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "correctionId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "safeReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AttendanceCorrectionHistory_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AttendanceExemption"
    ADD CONSTRAINT "AttendanceExemption_reasonCategory_check"
        CHECK (char_length(btrim("reasonCategory")) BETWEEN 1 AND 100),
    ADD CONSTRAINT "AttendanceExemption_note_check"
        CHECK ("note" IS NULL OR char_length("note") <= 2000),
    ADD CONSTRAINT "AttendanceExemption_status_check"
        CHECK ("status" IN ('active', 'revoked')),
    ADD CONSTRAINT "AttendanceExemption_interval_check"
        CHECK ("validUntil" IS NULL OR "validUntil" > "validFrom"),
    ADD CONSTRAINT "AttendanceExemption_version_check"
        CHECK ("version" >= 1),
    ADD CONSTRAINT "AttendanceExemption_state_check"
        CHECK (
            ("status" = 'active' AND "revokedAt" IS NULL AND "revokedByUserId" IS NULL)
            OR
            ("status" = 'revoked' AND "revokedAt" IS NOT NULL AND "revokedByUserId" IS NOT NULL)
        );

ALTER TABLE "AttendanceCorrection"
    ADD CONSTRAINT "AttendanceCorrection_status_check"
        CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled')),
    ADD CONSTRAINT "AttendanceCorrection_version_check"
        CHECK ("version" >= 1),
    ADD CONSTRAINT "AttendanceCorrection_reason_check"
        CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500),
    ADD CONSTRAINT "AttendanceCorrection_decisionReason_check"
        CHECK ("decisionReason" IS NULL OR char_length(btrim("decisionReason")) BETWEEN 1 AND 500);

ALTER TABLE "AttendanceCorrectionHistory"
    ADD CONSTRAINT "AttendanceCorrectionHistory_action_check"
        CHECK ("action" IN ('submit', 'approve', 'reject', 'cancel', 'reopen')),
    ADD CONSTRAINT "AttendanceCorrectionHistory_fromStatus_check"
        CHECK ("fromStatus" IN ('pending', 'approved', 'rejected', 'cancelled')),
    ADD CONSTRAINT "AttendanceCorrectionHistory_toStatus_check"
        CHECK ("toStatus" IN ('pending', 'approved', 'rejected', 'cancelled')),
    ADD CONSTRAINT "AttendanceCorrectionHistory_safeReason_check"
        CHECK ("safeReason" IS NULL OR char_length("safeReason") <= 500);

CREATE UNIQUE INDEX "AttendanceExemption_id_companyId_key"
    ON "AttendanceExemption"("id", "companyId");

CREATE INDEX "idx_AttendanceExemption_user_effective"
    ON "AttendanceExemption"("companyId", "userId", "status", "validFrom", "validUntil");

CREATE INDEX "idx_AttendanceExemption_creator_company"
    ON "AttendanceExemption"("createdByUserId", "companyId");

CREATE INDEX "idx_AttendanceExemption_revoker_company"
    ON "AttendanceExemption"("revokedByUserId", "companyId");

CREATE INDEX "idx_AttendanceExemption_employee_company"
    ON "AttendanceExemption"("employeeId", "companyId");

CREATE UNIQUE INDEX "AttendanceCorrection_id_companyId_key"
    ON "AttendanceCorrection"("id", "companyId");

CREATE INDEX "idx_AttendanceCorrection_attendance_status"
    ON "AttendanceCorrection"("companyId", "attendanceId", "status");

CREATE INDEX "idx_AttendanceCorrection_employee_status_created"
    ON "AttendanceCorrection"("companyId", "employeeId", "status", "createdAt");

CREATE INDEX "idx_AttendanceCorrection_requester_company"
    ON "AttendanceCorrection"("requestedByUserId", "companyId");

CREATE INDEX "idx_AttendanceCorrection_reviewer_company"
    ON "AttendanceCorrection"("reviewedByUserId", "companyId");

CREATE UNIQUE INDEX "AttendanceCorrectionHistory_id_companyId_key"
    ON "AttendanceCorrectionHistory"("id", "companyId");

CREATE INDEX "idx_AttendanceCorrectionHistory_correction_created"
    ON "AttendanceCorrectionHistory"("correctionId", "companyId", "createdAt");

CREATE INDEX "idx_AttendanceCorrectionHistory_actor_created"
    ON "AttendanceCorrectionHistory"("companyId", "actorUserId", "createdAt");

ALTER TABLE "AttendanceExemption"
    ADD CONSTRAINT "AttendanceExemption_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AttendanceExemption_userId_companyId_fkey"
        FOREIGN KEY ("userId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AttendanceExemption_employeeId_companyId_fkey"
        FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AttendanceExemption_createdByUserId_companyId_fkey"
        FOREIGN KEY ("createdByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AttendanceExemption_revokedByUserId_companyId_fkey"
        FOREIGN KEY ("revokedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendanceCorrection"
    ADD CONSTRAINT "AttendanceCorrection_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AttendanceCorrection_attendanceId_companyId_fkey"
        FOREIGN KEY ("attendanceId", "companyId") REFERENCES "Attendance"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AttendanceCorrection_employeeId_companyId_fkey"
        FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AttendanceCorrection_requestedByUserId_companyId_fkey"
        FOREIGN KEY ("requestedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AttendanceCorrection_reviewedByUserId_companyId_fkey"
        FOREIGN KEY ("reviewedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendanceCorrectionHistory"
    ADD CONSTRAINT "AttendanceCorrectionHistory_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AttendanceCorrectionHistory_correctionId_companyId_fkey"
        FOREIGN KEY ("correctionId", "companyId") REFERENCES "AttendanceCorrection"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "AttendanceCorrectionHistory_actorUserId_companyId_fkey"
        FOREIGN KEY ("actorUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendanceExemption" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttendanceCorrection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AttendanceCorrectionHistory" ENABLE ROW LEVEL SECURITY;

COMMIT;
