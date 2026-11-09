CREATE INDEX IF NOT EXISTS "AuditLog_companyId_createdAt_idx"
ON "AuditLog"("companyId", "createdAt");

CREATE INDEX IF NOT EXISTS "AuditLog_companyId_action_createdAt_idx"
ON "AuditLog"("companyId", "action", "createdAt");

CREATE INDEX IF NOT EXISTS "Notification_userId_isRead_createdAt_idx"
ON "Notification"("userId", "isRead", "createdAt");

CREATE INDEX IF NOT EXISTS "Attendance_companyId_date_idx"
ON "Attendance"("companyId", "date");

CREATE INDEX IF NOT EXISTS "Attendance_companyId_employeeId_date_idx"
ON "Attendance"("companyId", "employeeId", "date");

CREATE INDEX IF NOT EXISTS "LeaveRequest_companyId_status_createdAt_idx"
ON "LeaveRequest"("companyId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "LeaveRequest_companyId_employeeId_createdAt_idx"
ON "LeaveRequest"("companyId", "employeeId", "createdAt");
