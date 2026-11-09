CREATE TABLE "TrainingCourse" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "courseCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "instructorName" TEXT,
    "deliveryMode" TEXT NOT NULL DEFAULT 'onsite',
    "location" TEXT,
    "startDate" DATE,
    "endDate" DATE,
    "durationHours" INTEGER,
    "capacity" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdByUserId" TEXT NOT NULL,
    "publishedByUserId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "completedAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "archivedByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrainingCourse_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TrainingResource" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL DEFAULT 'link',
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrainingResource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TrainingAssignment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeNameSnapshot" TEXT NOT NULL,
    "employeeNumSnapshot" TEXT NOT NULL,
    "departmentIdSnapshot" TEXT,
    "departmentNameSnapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'assigned',
    "progressPercent" INTEGER NOT NULL DEFAULT 0,
    "assignedByUserId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "completionNote" TEXT,
    "completedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "score" INTEGER,
    "cancelledByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrainingAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrainingCourse_companyId_courseCode_key" ON "TrainingCourse"("companyId", "courseCode");
CREATE UNIQUE INDEX "TrainingCourse_id_companyId_key" ON "TrainingCourse"("id", "companyId");
CREATE INDEX "TrainingCourse_companyId_status_startDate_idx" ON "TrainingCourse"("companyId", "status", "startDate");
CREATE INDEX "TrainingCourse_companyId_category_idx" ON "TrainingCourse"("companyId", "category");
CREATE INDEX "TrainingCourse_createdByUserId_idx" ON "TrainingCourse"("createdByUserId");

CREATE UNIQUE INDEX "TrainingResource_id_companyId_key" ON "TrainingResource"("id", "companyId");
CREATE INDEX "TrainingResource_companyId_courseId_idx" ON "TrainingResource"("companyId", "courseId");
CREATE INDEX "TrainingResource_courseId_sortOrder_idx" ON "TrainingResource"("courseId", "sortOrder");

CREATE UNIQUE INDEX "TrainingAssignment_courseId_employeeId_key" ON "TrainingAssignment"("courseId", "employeeId");
CREATE UNIQUE INDEX "TrainingAssignment_id_companyId_key" ON "TrainingAssignment"("id", "companyId");
CREATE INDEX "TrainingAssignment_companyId_employeeId_status_idx" ON "TrainingAssignment"("companyId", "employeeId", "status");
CREATE INDEX "TrainingAssignment_companyId_courseId_status_idx" ON "TrainingAssignment"("companyId", "courseId", "status");
CREATE INDEX "TrainingAssignment_departmentIdSnapshot_status_idx" ON "TrainingAssignment"("departmentIdSnapshot", "status");

ALTER TABLE "TrainingCourse" ADD CONSTRAINT "TrainingCourse_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrainingCourse" ADD CONSTRAINT "TrainingCourse_createdByUserId_companyId_fkey"
    FOREIGN KEY ("createdByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrainingCourse" ADD CONSTRAINT "TrainingCourse_publishedByUserId_companyId_fkey"
    FOREIGN KEY ("publishedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrainingCourse" ADD CONSTRAINT "TrainingCourse_completedByUserId_companyId_fkey"
    FOREIGN KEY ("completedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrainingCourse" ADD CONSTRAINT "TrainingCourse_cancelledByUserId_companyId_fkey"
    FOREIGN KEY ("cancelledByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrainingCourse" ADD CONSTRAINT "TrainingCourse_archivedByUserId_companyId_fkey"
    FOREIGN KEY ("archivedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrainingResource" ADD CONSTRAINT "TrainingResource_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrainingResource" ADD CONSTRAINT "TrainingResource_courseId_companyId_fkey"
    FOREIGN KEY ("courseId", "companyId") REFERENCES "TrainingCourse"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrainingAssignment" ADD CONSTRAINT "TrainingAssignment_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrainingAssignment" ADD CONSTRAINT "TrainingAssignment_courseId_companyId_fkey"
    FOREIGN KEY ("courseId", "companyId") REFERENCES "TrainingCourse"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrainingAssignment" ADD CONSTRAINT "TrainingAssignment_employeeId_companyId_fkey"
    FOREIGN KEY ("employeeId", "companyId") REFERENCES "Employee"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrainingAssignment" ADD CONSTRAINT "TrainingAssignment_assignedByUserId_companyId_fkey"
    FOREIGN KEY ("assignedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrainingAssignment" ADD CONSTRAINT "TrainingAssignment_reviewedByUserId_companyId_fkey"
    FOREIGN KEY ("reviewedByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrainingAssignment" ADD CONSTRAINT "TrainingAssignment_cancelledByUserId_companyId_fkey"
    FOREIGN KEY ("cancelledByUserId", "companyId") REFERENCES "User"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TrainingCourse"
    ADD CONSTRAINT "TrainingCourse_status_check" CHECK ("status" IN ('draft', 'published', 'completed', 'cancelled', 'archived')),
    ADD CONSTRAINT "TrainingCourse_deliveryMode_check" CHECK ("deliveryMode" IN ('onsite', 'online', 'hybrid', 'self_paced')),
    ADD CONSTRAINT "TrainingCourse_title_check" CHECK (char_length(btrim("title")) > 0),
    ADD CONSTRAINT "TrainingCourse_durationHours_check" CHECK ("durationHours" IS NULL OR "durationHours" > 0),
    ADD CONSTRAINT "TrainingCourse_capacity_check" CHECK ("capacity" IS NULL OR "capacity" > 0),
    ADD CONSTRAINT "TrainingCourse_date_range_check" CHECK ("endDate" IS NULL OR "startDate" IS NULL OR "endDate" >= "startDate");

ALTER TABLE "TrainingResource"
    ADD CONSTRAINT "TrainingResource_title_check" CHECK (char_length(btrim("title")) > 0),
    ADD CONSTRAINT "TrainingResource_type_check" CHECK ("resourceType" IN ('link', 'video', 'document')),
    ADD CONSTRAINT "TrainingResource_url_check" CHECK (
      "url" ~ '^https://[^[:space:]]+$' OR
      "url" ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]+)?(/[^[:space:]]*)?$'
    ),
    ADD CONSTRAINT "TrainingResource_url_credentials_check" CHECK (
      "url" !~ '^[A-Za-z][A-Za-z0-9+.-]*://[^/[:space:]]*@'
    );

ALTER TABLE "TrainingAssignment"
    ADD CONSTRAINT "TrainingAssignment_status_check" CHECK ("status" IN ('assigned', 'in_progress', 'submitted', 'completed', 'returned', 'cancelled')),
    ADD CONSTRAINT "TrainingAssignment_progress_check" CHECK ("progressPercent" BETWEEN 0 AND 100),
    ADD CONSTRAINT "TrainingAssignment_score_check" CHECK ("score" IS NULL OR "score" BETWEEN 0 AND 100),
    ADD CONSTRAINT "TrainingAssignment_employeeName_check" CHECK (char_length(btrim("employeeNameSnapshot")) > 0),
    ADD CONSTRAINT "TrainingAssignment_employeeNum_check" CHECK (char_length(btrim("employeeNumSnapshot")) > 0);

ALTER TABLE "TrainingCourse" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TrainingResource" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TrainingAssignment" ENABLE ROW LEVEL SECURITY;
