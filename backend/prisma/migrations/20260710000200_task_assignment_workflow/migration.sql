-- Sprint 7 task workflow is additive. No task row is ever hard-deleted by the API.

-- Composite keys let task relationships enforce the tenant boundary in PostgreSQL.
CREATE UNIQUE INDEX "User_id_companyId_key" ON "User"("id", "companyId");
CREATE UNIQUE INDEX "Employee_id_companyId_key" ON "Employee"("id", "companyId");

CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "dueDate" DATE,
    "createdByUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskAssignment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'assigned',
    "completionDetails" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Task_id_companyId_key" ON "Task"("id", "companyId");
CREATE INDEX "Task_companyId_status_idx" ON "Task"("companyId", "status");
CREATE INDEX "Task_createdByUserId_idx" ON "Task"("createdByUserId");
CREATE INDEX "Task_dueDate_idx" ON "Task"("dueDate");

CREATE UNIQUE INDEX "TaskAssignment_taskId_employeeId_key" ON "TaskAssignment"("taskId", "employeeId");
CREATE INDEX "TaskAssignment_companyId_employeeId_status_idx" ON "TaskAssignment"("companyId", "employeeId", "status");
CREATE INDEX "TaskAssignment_taskId_idx" ON "TaskAssignment"("taskId");

ALTER TABLE "Task" ADD CONSTRAINT "Task_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdByUserId_companyId_fkey"
    FOREIGN KEY ("createdByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_taskId_companyId_fkey"
    FOREIGN KEY ("taskId", "companyId") REFERENCES "Task"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_employeeId_companyId_fkey"
    FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskAssignment" ADD CONSTRAINT "TaskAssignment_reviewedByUserId_companyId_fkey"
    FOREIGN KEY ("reviewedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Task"
    ADD CONSTRAINT "Task_priority_check" CHECK ("priority" IN ('low', 'normal', 'high', 'urgent')),
    ADD CONSTRAINT "Task_status_check" CHECK ("status" IN ('active', 'completed', 'cancelled'));

ALTER TABLE "TaskAssignment"
    ADD CONSTRAINT "TaskAssignment_status_check" CHECK ("status" IN ('assigned', 'in_progress', 'submitted', 'accepted', 'returned'));

-- Direct Supabase data APIs receive no task-table access. The trusted backend
-- remains the only workflow entry point and enforces company/department scope.
ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TaskAssignment" ENABLE ROW LEVEL SECURITY;
