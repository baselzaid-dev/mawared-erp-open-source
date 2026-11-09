package com.example.domain.repository

import com.example.core.utils.AppResult
import com.example.domain.model.*
import kotlinx.coroutines.flow.Flow

interface EmployeeRepository {
    fun observeEmployees(): Flow<List<EmployeeParams>>
    fun observeEmployeeRoles(): Flow<List<com.example.domain.model.Role>>
    fun observeDepartments(): Flow<List<com.example.domain.model.Department>>
    fun observeDepartmentManagerCandidates(): Flow<List<com.example.domain.model.DepartmentManagerCandidate>>
    suspend fun refreshEmployees(): AppResult<Unit>
    suspend fun refreshEmployeeOptions(includeManagerCandidates: Boolean): AppResult<Unit>
    suspend fun getEmployee(id: String): AppResult<EmployeeParams>
    suspend fun createEmployee(employee: EmployeeParams): AppResult<Unit>
    suspend fun updateEmployee(id: String, employee: com.example.domain.model.EmployeeUpdateForm): AppResult<Unit>
    suspend fun createDepartment(department: com.example.domain.model.DepartmentDraft): AppResult<Unit>
    suspend fun updateDepartment(id: String, department: com.example.domain.model.DepartmentDraft): AppResult<Unit>
    suspend fun deactivateEmployee(id: String): AppResult<Unit>
    suspend fun getCurrentSalary(employeeId: String): AppResult<CurrentSalaryDetails>
    suspend fun getSalaryHistory(employeeId: String): AppResult<SalaryHistoryDetails>
    suspend fun createSalaryRecord(
        employeeId: String,
        request: CreateSalaryRecordRequest
    ): AppResult<SalaryRecordParams>
    fun clear()
}

interface AttendanceRepository {
    fun observeAttendanceRecords(): Flow<List<AttendanceRecordParams>>
    fun observeTodayAttendance(): Flow<List<AttendanceRecordParams>>
    fun observeEligibleEmployees(): Flow<List<AttendanceEligibleEmployee>>
    suspend fun clockIn(employeeId: String): AppResult<AttendanceRecordParams>
    suspend fun clockOut(employeeId: String): AppResult<AttendanceRecordParams>
    suspend fun createManualAttendance(request: ManualAttendanceRequest): AppResult<AttendanceRecordParams>
    suspend fun refreshAttendance(query: AttendanceQuery? = null): AppResult<Unit>
    suspend fun refreshEligibleEmployees(): AppResult<Unit>
    fun clear()
}

interface LeaveRepository {
    fun observeLeaveRequests(): Flow<List<LeaveRequestParams>>
    fun observeMyLeaveRequests(employeeId: String): Flow<List<LeaveRequestParams>>
    fun observeLeaveReport(): Flow<LeaveReportData>
    suspend fun submitLeaveRequest(request: LeaveRequestParams): AppResult<LeaveRequestParams>
    suspend fun approveLeaveRequest(
        requestId: String,
        note: String? = null,
        stage: LeaveApprovalStage = LeaveApprovalStage.HR
    ): AppResult<LeaveRequestParams>
    suspend fun rejectLeaveRequest(
        requestId: String,
        reason: String,
        stage: LeaveApprovalStage = LeaveApprovalStage.HR
    ): AppResult<LeaveRequestParams>
    suspend fun cancelLeaveRequest(requestId: String): AppResult<LeaveRequestParams>
    suspend fun refreshMyLeaveRequests(query: LeaveQuery = LeaveQuery()): AppResult<Unit>
    suspend fun refreshLeaveReview(): AppResult<Unit>
    suspend fun refreshLeaveReport(query: LeaveQuery): AppResult<Unit>
    suspend fun refreshLeaveRequests(): AppResult<Unit>
    fun clear()
}

interface PayrollRepository {
    fun observePayrollPeriods(): Flow<List<PayrollPeriodParams>>
    fun observePayrollItems(periodId: String): Flow<List<PayrollItemParams>>
    suspend fun createPayrollPeriod(month: Int, year: Int): AppResult<PayrollPeriodParams>
    suspend fun calculatePayrollPeriod(
        periodId: String,
        recalculationReason: String? = null
    ): AppResult<PayrollCalculationResult>
    suspend fun loadPayrollItems(periodId: String): AppResult<PayrollItemsResult>
    suspend fun approvePayrollPeriod(periodId: String): AppResult<PayrollActionResult>
    suspend fun markPayrollPeriodPaid(periodId: String): AppResult<PayrollActionResult>
    suspend fun loadPayrollReport(periodId: String): AppResult<PayrollReportParams>
    suspend fun refreshPayroll(): AppResult<Unit>
    suspend fun getPayrollSummary(): AppResult<PayrollSummary>

    // Sprint 12H: payroll partial payments (v2) + exports.
    fun observePayrollPayments(periodId: String): Flow<List<PayrollPaymentParams>>
    suspend fun loadPayrollPayments(periodId: String): AppResult<List<PayrollPaymentParams>>
    suspend fun recordPayrollPayment(
        periodId: String,
        request: PayrollRecordPaymentRequest,
        idempotencyKey: String
    ): AppResult<PayrollPaymentActionResult>
    suspend fun voidPayrollPayment(
        periodId: String,
        paymentId: String,
        request: PayrollVoidPaymentRequest
    ): AppResult<PayrollPaymentActionResult>
    suspend fun exportPayrollPeriod(
        periodId: String,
        format: PayrollExportFormat,
        locale: String = "ar"
    ): AppResult<ReportExportPayload>

    fun clear()
}

interface AuthRepository {
    suspend fun login(companyCode: String, identifier: String, password: String): AppResult<AuthLoginResult>
    suspend fun startMfaEnrollment(challengeToken: String): AppResult<MfaEnrollment>
    suspend fun confirmMfaEnrollment(
        challengeToken: String,
        code: String
    ): AppResult<MfaAuthenticationResult>
    suspend fun verifyMfa(
        challengeToken: String,
        code: String
    ): AppResult<MfaAuthenticationResult>
    suspend fun initiateOwnerRecovery(
        request: OwnerRecoveryInitiateRequest
    ): AppResult<OwnerRecoveryInitiateResult>
    suspend fun confirmOwnerRecovery(
        request: OwnerRecoveryConfirmRequest
    ): AppResult<OwnerRecoveryConfirmResult>
    suspend fun logout(): AppResult<Unit>
    /** Clears active + remembered/biometric session without a remote revoke call. */
    fun clearLocalSessions()
    fun observeCurrentSession(): Flow<CurrentSession?>
    fun observeRememberedSession(): Flow<CurrentSession?>
    fun unlockRememberedSession(companyCode: String): AppResult<CurrentSession>
    fun currentSessionOrNull(): CurrentSession? = null
    fun updateAuthorizationSnapshot(authorizationVersion: Int, permissions: Set<String>): Boolean = false
}

interface PurchaseRepository {
    fun observePurchaseRequests(): Flow<List<PurchaseRequestParams>>
    fun observePurchaseOrders(): Flow<List<PurchaseOrderParams>>
    fun observePurchasingReport(): Flow<PurchasingReportParams?>
    suspend fun refreshPurchaseRequests(filters: PurchaseRequestFilters = PurchaseRequestFilters()): AppResult<Unit>
    suspend fun loadPurchaseRequest(id: String, scope: String? = null): AppResult<PurchaseRequestParams>
    suspend fun createPurchaseRequest(request: CreatePurchaseRequestParams): AppResult<PurchaseRequestParams>
    suspend fun reviewDepartment(id: String, action: String, note: String?): AppResult<PurchaseRequestParams>
    suspend fun reviewPurchasing(id: String, action: String, note: String?): AppResult<PurchaseRequestParams>
    suspend fun cancelPurchaseRequest(id: String, reason: String): AppResult<PurchaseRequestParams>
    suspend fun refreshPurchaseOrders(filters: PurchaseOrderFilters = PurchaseOrderFilters()): AppResult<Unit>
    suspend fun loadPurchaseOrder(id: String, scope: String? = null): AppResult<PurchaseOrderParams>
    suspend fun createPurchaseOrder(request: PurchaseOrderDraftParams): AppResult<PurchaseOrderParams>
    suspend fun updatePurchaseOrder(id: String, request: PurchaseOrderDraftParams): AppResult<PurchaseOrderParams>
    suspend fun issuePurchaseOrder(id: String): AppResult<PurchaseOrderParams>
    suspend fun receivePurchaseOrder(id: String, note: String?): AppResult<PurchaseOrderParams>
    suspend fun cancelPurchaseOrder(id: String, reason: String): AppResult<PurchaseOrderParams>
    suspend fun refreshPurchasingReport(from: String? = null, to: String? = null): AppResult<Unit>

    // Sprint 12I: purchasing admin override (v2) + purchasing exports (v2).
    suspend fun overridePurchaseRequest(
        id: String,
        action: String,
        reason: String,
        expectedUpdatedAt: String?,
        idempotencyKey: String
    ): AppResult<PurchaseRequestParams>

    suspend fun exportPurchasingReport(
        format: PurchasingExportFormat,
        locale: String = "ar"
    ): AppResult<ReportExportPayload>

    // ---- Commercial Wave 2 (Operations Slice E1) ----
    // The caller supplies the idempotency key so a retried submit replays the
    // stored result instead of creating a second financial effect.

    suspend fun listQuotations(requestId: String, status: String? = null): AppResult<List<SupplierQuotationParams>>

    suspend fun compareQuotations(requestId: String): AppResult<QuotationComparisonParams>

    suspend fun createQuotation(
        requestId: String,
        draft: SupplierQuotationDraft,
        idempotencyKey: String
    ): AppResult<SupplierQuotationParams>

    suspend fun submitQuotation(quotationId: String): AppResult<SupplierQuotationParams>

    suspend fun rejectQuotation(quotationId: String, reason: String): AppResult<SupplierQuotationParams>

    suspend fun selectQuotation(
        quotationId: String,
        reason: String,
        idempotencyKey: String
    ): AppResult<SupplierQuotationParams>

    suspend fun loadReceipts(orderId: String): AppResult<Pair<List<PurchaseReceiptParams>, OrderReceiptProgressParams?>>

    suspend fun recordReceipt(
        orderId: String,
        draft: PurchaseReceiptDraft,
        idempotencyKey: String
    ): AppResult<PurchaseReceiptResult>

    suspend fun listReturns(orderId: String): AppResult<List<PurchaseReturnParams>>

    suspend fun createReturn(
        orderId: String,
        draft: PurchaseReturnDraft,
        idempotencyKey: String
    ): AppResult<PurchaseReturnParams>

    suspend fun reviewReturn(
        returnId: String,
        action: String,
        note: String?,
        idempotencyKey: String
    ): AppResult<PurchaseReturnParams>

    fun clear()
}

interface SupplierRepository {
    fun observeSuppliers(): Flow<List<Supplier>>
    suspend fun refreshSuppliers(status: String? = "active", search: String? = null): AppResult<Unit>

    /** Merges active + inactive + archived vendors so the UI can show true vendor state (Sprint 12I). */
    suspend fun refreshSuppliersAllStatuses(search: String? = null): AppResult<Unit>
    suspend fun createSupplier(supplier: Supplier): AppResult<Unit>
    suspend fun updateSupplier(id: String, supplier: Supplier): AppResult<Unit>
    suspend fun setSupplierStatus(id: String, status: String): AppResult<Unit>

    /** Authoritative single-vendor read, including lifecycleVersion, for archive/reactivate concurrency. */
    suspend fun loadSupplierLifecycle(id: String): AppResult<Supplier>
    suspend fun archiveSupplier(id: String, request: VendorArchiveRequest): AppResult<Supplier>
    suspend fun reactivateSupplier(id: String, request: VendorReactivateRequest): AppResult<Supplier>
    fun clear()
}

interface ChatRepository {
    suspend fun searchDirectory(query: String = "", limit: Int = 30): AppResult<List<ChatDirectoryUser>>
    suspend fun listAccessibleDepartments(): AppResult<List<ChatDepartmentSummary>>
    suspend fun listConversations(limit: Int = 30, offset: Int = 0): AppResult<ChatConversationPage>
    suspend fun openDirect(userId: String): AppResult<ChatConversationParams>
    suspend fun openDepartment(departmentId: String): AppResult<ChatConversationParams>
    suspend fun loadMessages(
        conversationId: String,
        before: String? = null,
        limit: Int = 30
    ): AppResult<ChatMessagePage>
    suspend fun sendMessage(
        conversationId: String,
        body: String,
        replyToMessageId: String? = null
    ): AppResult<ChatMessageParams>
    suspend fun createAnnouncement(
        title: String,
        body: String? = null
    ): AppResult<ChatConversationParams>
    suspend fun listPins(conversationId: String): AppResult<List<ChatPinnedMessageParams>>
    suspend fun pinMessage(conversationId: String, messageId: String): AppResult<ChatPinnedMessageParams>
    suspend fun unpinMessage(conversationId: String, messageId: String): AppResult<Unit>
    suspend fun markRead(conversationId: String): AppResult<ChatReadResult>
    suspend fun getUnreadCount(): AppResult<Int>
    fun setCurrentUser(userId: String, name: String, role: String, department: String?)
    fun clear()
}

interface TaskRepository {
    fun observeTasks(): Flow<List<TaskParams>>
    fun observeEligibleEmployees(): Flow<List<TaskEligibleEmployee>>
    suspend fun refreshTasks(filters: TaskFilters = TaskFilters()): AppResult<Unit>
    suspend fun loadTask(taskId: String): AppResult<TaskParams>
    suspend fun loadEligibleEmployees(): AppResult<Unit>
    suspend fun createTask(request: CreateTaskRequestParams): AppResult<TaskParams>
    suspend fun updateProgress(
        assignmentId: String,
        status: String,
        completionDetails: String? = null
    ): AppResult<TaskAssignmentParams>
    suspend fun reviewAssignment(
        assignmentId: String,
        action: String,
        reviewNote: String? = null
    ): AppResult<TaskReviewResult>
    suspend fun cancelTask(taskId: String): AppResult<TaskParams>

    // ---- Commercial P4 ----

    /**
     * `expectedUpdatedAt` is the optimistic-concurrency token from the task the
     * caller is editing; a concurrent edit surfaces as a conflict error instead
     * of silently overwriting.
     *
     * `title` and `priority` are plain nullable "unchanged if null", because the
     * backend does not accept a null for either. `description` and `dueDate` ARE
     * clearable, so they take [TaskFieldEdit] to keep "leave alone" and "set to
     * empty" distinguishable on the wire.
     */
    suspend fun updateTask(
        taskId: String,
        expectedUpdatedAt: String,
        title: String? = null,
        priority: String? = null,
        description: TaskFieldEdit<String> = TaskFieldEdit.Unchanged,
        dueDate: TaskFieldEdit<String> = TaskFieldEdit.Unchanged
    ): AppResult<TaskParams>
    suspend fun loadComments(
        taskId: String,
        cursor: String? = null,
        limit: Int? = null
    ): AppResult<TaskCommentPageParams>
    suspend fun addComment(taskId: String, body: String): AppResult<TaskCommentParams>
    fun clear()
}

interface TrainingRepository {
    fun observeCourses(): Flow<List<TrainingCourseParams>>
    fun observeAssignments(): Flow<List<TrainingAssignmentParams>>
    fun observeMyAssignments(employeeId: String): Flow<List<TrainingAssignmentParams>>
    fun observeEligibleEmployees(): Flow<List<TrainingEligibleEmployee>>
    fun observeReport(): Flow<TrainingReportParams?>
    suspend fun refreshCourses(filters: TrainingCourseFilters = TrainingCourseFilters()): AppResult<Unit>
    suspend fun refreshAssignments(filters: TrainingAssignmentFilters = TrainingAssignmentFilters()): AppResult<Unit>
    suspend fun loadCourse(courseId: String, scope: String? = null): AppResult<TrainingCourseParams>
    suspend fun loadAssignment(assignmentId: String, scope: String? = null): AppResult<TrainingAssignmentParams>
    suspend fun loadEligibleEmployees(query: String? = null, departmentId: String? = null): AppResult<Unit>
    suspend fun createCourse(request: TrainingCourseRequestParams): AppResult<TrainingCourseParams>
    suspend fun updateCourse(courseId: String, request: TrainingCourseRequestParams): AppResult<TrainingCourseParams>
    suspend fun publishCourse(courseId: String): AppResult<TrainingCourseParams>
    suspend fun assignCourse(courseId: String, employeeIds: List<String>): AppResult<List<TrainingAssignmentParams>>
    suspend fun updateAssignmentProgress(assignmentId: String, progressPercent: Int): AppResult<TrainingAssignmentParams>
    suspend fun submitAssignment(assignmentId: String, completionNote: String? = null): AppResult<TrainingAssignmentParams>
    suspend fun reviewAssignment(
        assignmentId: String,
        action: String,
        score: Int? = null,
        reviewNote: String? = null
    ): AppResult<TrainingAssignmentParams>
    suspend fun cancelAssignment(assignmentId: String, reason: String): AppResult<TrainingAssignmentParams>
    suspend fun completeCourse(courseId: String): AppResult<TrainingCourseParams>
    suspend fun cancelCourse(courseId: String, reason: String): AppResult<TrainingCourseParams>
    suspend fun archiveCourse(courseId: String): AppResult<TrainingCourseParams>
    suspend fun loadReport(filters: TrainingReportFilters = TrainingReportFilters()): AppResult<TrainingReportParams>
    suspend fun loadCourseTimeline(courseId: String, scope: String? = null): AppResult<TrainingTimelineParams>
    suspend fun exportReport(
        format: TrainingExportFormat,
        filters: TrainingReportFilters = TrainingReportFilters(),
        locale: String = "ar"
    ): AppResult<ReportExportPayload>
    suspend fun refreshTraining(): AppResult<Unit>

    // ---- Commercial P4 completion artifacts ----

    /** Idempotent: an exact retry replays the existing certificate. */
    suspend fun issueCertificate(assignmentId: String): AppResult<TrainingCertificateParams>
    suspend fun loadCertificate(assignmentId: String): AppResult<TrainingCertificateParams>
    /** A second evaluation is a conflict, never an overwrite. */
    suspend fun createEvaluation(
        assignmentId: String,
        request: TrainingEvaluationRequestParams
    ): AppResult<TrainingEvaluationParams>
    suspend fun loadEvaluation(assignmentId: String): AppResult<TrainingEvaluationParams>
    fun clear()
}

interface ReportRepository {
    suspend fun loadCatalog(): AppResult<List<ReportCatalogItem>>
    suspend fun loadOverview(
        from: String,
        to: String,
        departmentId: String? = null
    ): AppResult<ReportOverview>
    suspend fun loadDetail(
        type: String,
        filters: Map<String, String>
    ): AppResult<ReportDetailParams>
    suspend fun exportCsv(
        type: String,
        filters: Map<String, String>
    ): AppResult<ReportExportPayload>
    fun clear()

    // Sprint 12J: server-owned report template registry (catalog/preview/save/export).
    suspend fun loadTemplateCatalog(): AppResult<List<ReportTemplateCatalogItem>>
    suspend fun previewTemplate(
        builtInKey: String,
        templateVersion: Int,
        departmentId: String?,
        filters: Map<String, String>
    ): AppResult<ReportTemplateDocument>
    suspend fun loadSavedTemplates(includeArchived: Boolean = false): AppResult<List<SavedReportTemplate>>
    suspend fun saveTemplate(request: SaveReportTemplateRequest): AppResult<SavedReportTemplate>
    suspend fun archiveSavedTemplate(id: String): AppResult<SavedReportTemplate>
    suspend fun exportTemplate(
        builtInKey: String,
        templateVersion: Int,
        departmentId: String?,
        filters: Map<String, String>,
        format: ReportTemplateExportFormat,
        locale: String = "ar"
    ): AppResult<ReportExportPayload>
}
