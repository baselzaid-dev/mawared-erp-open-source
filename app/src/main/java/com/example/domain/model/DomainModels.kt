package com.example.domain.model

data class Company(
    val id: String,
    val name: String,
    val logoUrl: String?,
    val status: String,
    val createdAt: Long
)

data class Department(
    val id: String,
    val companyId: String = "",
    val name: String,
    val managerId: String?,
    val isActive: Boolean = true,
    val managerName: String? = null,
    val activeEmployeeCount: Int = 0
)

data class EmployeeParams(
    val id: String,
    val companyId: String,
    val departmentId: String?,
    val employeeCode: String,
    val fullName: String,
    val jobTitle: String?,
    val phone: String?,
    val email: String?,
    val nationalIdOrIqama: String?,
    val basicSalary: Double,
    val allowances: Double,
    val deductions: Double,
    val status: String,
    val joiningDate: String?,
    val contractType: String?,
    val createdAt: Long,
    val updatedAt: Long,
    val departmentName: String? = null,
    val roleId: String? = null,
    val roleName: String? = null,
    val temporaryPassword: String? = null,
    /** Linked login user id when credentials already exist; null means create is still available. */
    val userId: String? = null,
    val credentialVersion: Int? = null,
    /** Server ISO timestamp required by archive/reactivate optimistic concurrency. */
    val updatedAtIso: String? = null,
    val archivedAtIso: String? = null
)

data class EmployeeUpdateForm(
    val name: String,
    val email: String,
    val employeeNum: String,
    val jobTitle: String,
    val joiningDate: String,
    val departmentId: String?,
    val roleId: String
)

data class SalaryEmployeeSummary(
    val id: String,
    val employeeNum: String,
    val name: String,
    val jobTitle: String,
    val departmentName: String?
)

data class SalaryRecordParams(
    val id: String,
    val employeeId: String,
    val baseSalary: String,
    val currency: String,
    val effectiveFrom: String,
    val effectiveTo: String?,
    val createdAt: String?
)

data class CurrentSalaryDetails(
    val employee: SalaryEmployeeSummary,
    val currentSalary: SalaryRecordParams?
)

data class SalaryHistoryDetails(
    val employee: SalaryEmployeeSummary,
    val history: List<SalaryRecordParams>
)

data class CreateSalaryRecordRequest(
    val baseSalary: String,
    val currency: String = "SAR",
    val effectiveFrom: String
)

data class DepartmentDraft(
    val name: String,
    val managerId: String?
)

data class DepartmentManagerCandidate(
    val userId: String,
    val employeeId: String,
    val name: String,
    val roleName: String,
    val departmentId: String?
)

data class UserAccount(
    val id: String,
    val companyId: String,
    val employeeId: String?,
    val username: String,
    val email: String,
    val roleId: String?,
    val isActive: Boolean,
    val lastLoginAt: Long?
)

data class Role(
    val id: String,
    val companyId: String,
    val name: String,
    val description: String?
)

data class CurrentSession(
    val companyId: String,
    val companyCode: String,
    val companyName: String,
    val userId: String,
    val employeeId: String?,
    val roleId: String?,
    val departmentId: String?,
    val permissions: Set<String>,
    val token: String? = null,
    // Long-lived refresh token (server rotates it on every refresh).
    // Persisted ONLY via EncryptedSessionStore — never in plaintext storage.
    val refreshToken: String? = null,
    val email: String = "",
    val name: String = "",
    val role: String = "",
    // Backend User.authorizationVersion mirrored for same-identity soft refresh.
    // Older encrypted sessions may still load as 0 until the next login/refresh.
    val authorizationVersion: Int = 0,
    /** When true, Android must show the forced password-change gate before normal routes. */
    val mustChangePassword: Boolean = false,
    /** Protected owners must complete backend MFA and may not use biometric-only unlock. */
    val mfaProtected: Boolean = false,
    val mfaVerifiedAt: String? = null
)

sealed interface AuthLoginResult {
    data class Authenticated(val session: CurrentSession) : AuthLoginResult
    data class MfaChallenge(
        val challengeToken: String,
        val enrollmentRequired: Boolean,
        val expiresAt: String,
        val companyCode: String,
        val companyName: String,
        val email: String,
        val name: String,
        val role: String
    ) : AuthLoginResult
}

data class MfaEnrollment(
    val manualSecret: String,
    val otpauthUri: String,
    val expiresAt: String
)

data class MfaAuthenticationResult(
    val session: CurrentSession,
    val backupCodes: List<String> = emptyList()
)

data class AttendanceRecord(
    val id: String,
    val companyId: String,
    val employeeId: String,
    val date: String,
    val clockInTime: Long?,
    val clockOutTime: Long?,
    val status: String,
    val lateMinutes: Int,
    val overtimeMinutes: Int,
    val source: String,
    val locationLat: Double?,
    val locationLng: Double?,
    val createdAt: Long
)

/**
 * Display-ready attendance record used by the Attendance repository + UI layer
 * (mirrors EmployeeParams / PurchaseRequestParams). String ids/times keep it backend-friendly
 * and easy to render without resolving entities.
 *
 * status uses Arabic state strings: "حاضر" | "متأخر" | "غائب" | "إجازة" | "انصراف مبكر".
 * source examples: "بصمة" | "تطبيق" | "نظام" | "يدوي" | "معتمد".
 */
data class AttendanceRecordParams(
    val id: String,
    val companyId: String,
    val employeeId: String,
    val employeeName: String,
    val departmentName: String,
    val date: String,
    val clockInTime: String?,
    val clockOutTime: String?,
    val status: String,
    val lateMinutes: Int,
    val overtimeMinutes: Int,
    val source: String,
    val locationLat: Double?,
    val locationLng: Double?,
    val createdAt: String,
    val updatedAt: String?,
    val departmentId: String? = null
)

enum class AttendanceViewScope { OWN, DEPARTMENT, COMPANY }

enum class AttendanceRangePreset { TODAY, THIS_WEEK, THIS_MONTH, CUSTOM }

data class AttendanceDateRange(
    val preset: AttendanceRangePreset = AttendanceRangePreset.TODAY,
    val from: String,
    val to: String
)

data class AttendanceDepartmentOption(
    val id: String,
    val name: String
)

data class AttendanceQuery(
    val scope: AttendanceViewScope = AttendanceViewScope.OWN,
    val from: String? = null,
    val to: String? = null,
    val departmentId: String? = null
)

data class AttendanceEligibleEmployee(
    val employeeId: String,
    val employeeNum: String,
    val name: String,
    val departmentId: String?,
    val departmentName: String,
    val roleName: String?
)

data class ManualAttendanceRequest(
    val employeeId: String,
    val date: String,
    val status: String,
    val clockIn: String?,
    val clockOut: String?
)

data class AttendanceSummary(
    val present: Int = 0,
    val late: Int = 0,
    val absent: Int = 0,
    val missingClockOut: Int = 0,
    val completedWorkMinutes: Long = 0
)

data class LeaveRequestItem(
    val id: String,
    val companyId: String,
    val employeeId: String,
    val leaveType: String,
    val startDate: String,
    val endDate: String,
    val totalDays: Int,
    val reason: String?,
    val status: String,
    val currentApprovalStep: Int,
    val createdAt: Long
)

/**
 * Display-ready leave request used by the Leaves repository + UI layer
 * (mirrors EmployeeParams / PurchaseRequestParams / AttendanceRecordParams).
 *
 * leaveType: "سنوية" | "مرضية" | "طارئة" | "بدون راتب" | "دراسية".
 * status:    "قيد المراجعة" | "موافق عليها" | "مرفوضة" | "ملغاة".
 */
data class LeaveRequestParams(
    val id: String,
    val companyId: String,
    val employeeId: String,
    val employeeName: String,
    val departmentName: String,
    val leaveType: String,
    val startDate: String,
    val endDate: String,
    val totalDays: Int,
    val reason: String,
    val status: String,
    val currentApprovalStep: Int,
    val requestedAt: String,
    val approvedBy: String?,
    val approvedAt: String?,
    val rejectionReason: String?,
    val createdAt: String,
    val updatedAt: String?,
    // Annual-leave exit/re-entry visa: backend rejects annual + exitReentryRequested
    // without visaFeePaid (400). Defaults keep every existing constructor call valid.
    val exitReentryRequested: Boolean = false,
    val visaFeePaid: Boolean = false,
    // Canonical backend values are retained for authorization/state transitions;
    // Arabic labels remain in status/leaveType for display compatibility.
    val rawStatus: String = status,
    val rawLeaveType: String = leaveType
)

enum class LeaveApprovalStage { HR, ADMIN }

enum class LeaveScreenMode { MY_REQUESTS, REVIEW, REPORT }

data class LeaveQuery(
    val from: String? = null,
    val to: String? = null,
    val status: String? = null,
    val leaveType: String? = null,
    val employeeId: String? = null
)

data class LeaveReportSummary(
    val total: Int = 0,
    val pendingHr: Int = 0,
    val pendingAdmin: Int = 0,
    val approved: Int = 0,
    val rejected: Int = 0,
    val cancelled: Int = 0,
    val totalDays: Int = 0
)

data class LeaveReportData(
    val summary: LeaveReportSummary = LeaveReportSummary(),
    val requests: List<LeaveRequestParams> = emptyList()
)

fun LeaveRequestParams.isPendingHr(): Boolean =
    rawStatus == "pending_hr" || (rawStatus == status && status == "قيد المراجعة" && currentApprovalStep == 1)

fun LeaveRequestParams.isPendingAdmin(): Boolean =
    rawStatus == "pending_admin" || (rawStatus == status && status == "قيد المراجعة" && currentApprovalStep == 2)

fun canCancelOwnLeave(request: LeaveRequestParams, currentEmployeeId: String?): Boolean =
    !currentEmployeeId.isNullOrBlank() && request.employeeId == currentEmployeeId && request.isPendingHr()

data class PayrollMoneySummary(
    val employeeCount: Int,
    val gross: String,
    val deductions: String,
    val net: String,
    val currency: String
)

data class PayrollPeriodParams(
    val id: String,
    val companyId: String,
    val month: Int,
    val year: Int,
    val status: String,
    val itemCount: Int = 0,
    val calculationVersion: Int = 0,
    val createdAt: String = "",
    val calculatedAt: String? = null,
    val approvedAt: String? = null,
    val paidAt: String? = null,
    val legacyWithoutItems: Boolean = false,
    val visibleSummary: PayrollMoneySummary? = null,
    val fullSummary: PayrollMoneySummary? = null,
    // Sprint 12H: populated once the payments (v2) endpoints have been called for this
    // period. Null/0 means "not yet loaded" — never inferred client-side.
    val paymentState: String? = null,
    val paymentVersion: Int = 0,
    val approvedNetTotal: String? = null,
    val protectedRowsHidden: Boolean = false,
    val protectedRowCount: Int = 0
)

data class PayrollItemParams(
    val id: String,
    val payrollPeriodId: String,
    val employeeId: String,
    val employeeName: String,
    val employeeNum: String,
    val departmentName: String?,
    val baseSalary: String,
    val grossPay: String,
    val totalDeductions: String,
    val netPay: String,
    val currency: String,
    val status: String,
    val calculatedAt: String? = null
)

data class PayrollItemsResult(
    val period: PayrollPeriodParams,
    val items: List<PayrollItemParams>,
    val visibleSummary: PayrollMoneySummary?,
    val fullSummary: PayrollMoneySummary?,
    val protectedRowsHidden: Boolean,
    val protectedRowCount: Int
)

data class PayrollCalculationResult(
    val details: PayrollItemsResult,
    val idempotent: Boolean,
    val recalculated: Boolean,
    val protectedEmployeeIssues: Int
)

data class PayrollActionResult(
    val period: PayrollPeriodParams,
    val message: String,
    val bankTransferProof: Boolean? = null
)

data class PayrollReportParams(
    val period: PayrollPeriodParams,
    val rows: List<PayrollItemParams>,
    val visibleSummary: PayrollMoneySummary?,
    val fullSummary: PayrollMoneySummary?,
    val protectedRowsHidden: Boolean,
    val protectedRowCount: Int
)

data class PayrollBlockerParams(
    val code: String,
    val message: String,
    val employeeId: String? = null,
    val employeeNum: String? = null,
    val employeeName: String? = null
)

class PayrollWorkflowException(
    message: String,
    val blockers: List<PayrollBlockerParams> = emptyList(),
    val protectedEmployeeIssues: Int = 0
) : Exception(message)

const val PAYROLL_SECOND_PERSON_NOTICE =
    "يجب أن يكون المعتمد شخصاً مختلفاً عن منفذ الاحتساب."
const val PAYROLL_ADMIN_PAID_WARNING =
    "هذا تأكيد إداري ولا يمثل إثبات تحويل بنكي."
const val PAYROLL_PROTECTED_DATA_NOTICE =
    "توجد بيانات مالية محمية غير ظاهرة"

fun PayrollPeriodParams.arabicStatus(): String = when (status) {
    "draft" -> "مسودة"
    "calculated" -> "محتسبة"
    "approved" -> "معتمدة"
    "paid" -> "مدفوعة"
    else -> status
}

fun PayrollPeriodParams.canCalculate(): Boolean = status == "draft" || status == "calculated"
fun PayrollPeriodParams.canApprove(): Boolean = status == "calculated"
fun PayrollPeriodParams.canMarkPaid(): Boolean = status == "approved"
fun PayrollPeriodParams.canReport(): Boolean = status == "approved" || status == "paid"

data class PayrollSummary(
    val totalPeriods: Int,
    val approvedPeriods: Int,
    val paidPeriods: Int,
    val totalNetPayroll: String?,
    val totalEmployeesPaid: Int?
)

/**
 * Reports models — UI-friendly, consolidated from the already-migrated modules
 * (Employees / Purchasing / Attendance / Leaves / Payroll). Computed in the ViewModel,
 * never inside composables. No Room entities exposed.
 */
data class ReportsSummaryParams(
    val totalEmployees: Int = 0,
    val activeEmployees: Int = 0,
    val pendingLeaves: Int = 0,
    val approvedLeaves: Int = 0,
    val attendanceTodayCount: Int = 0,
    val absentTodayCount: Int = 0,
    val totalPurchaseOrders: Int = 0,
    val pendingPurchaseOrders: Int = 0,
    val approvedPurchaseOrders: Int = 0,
    val payrollPeriodsCount: Int = 0,
    val latestPayrollNetTotal: String? = null,
    val totalPayrollNetAmount: String? = null
)

data class FinancialReportParams(
    val totalPayroll: String? = null,
    val totalAllowances: String? = null,
    val totalDeductions: String? = null,
    val totalPurchasing: String = "0.00",
    val estimatedNetCost: String? = null,
    val latestPayrollPeriod: String? = null
)

data class DepartmentReportParams(
    val departmentName: String,
    val employeeCount: Int,
    val attendanceCount: Int,
    val leaveCount: Int,
    val payrollTotal: String? = null
)

data class ReportCatalogItem(
    val type: String,
    val title: String,
    val description: String,
    val availableScopes: List<String>,
    val supportedFilters: List<String>,
    val exportAvailable: Boolean,
    val containsFinancialData: Boolean,
    val maximumRangeDays: Int
)

data class ReportRange(
    val from: String,
    val to: String
)

data class ReportScope(
    val kind: String,
    val departmentId: String?
)

data class ReportOverviewSection(
    val title: String,
    val metrics: Map<String, String?>,
    val protectedRowsHidden: Boolean = false
)

data class ReportOverview(
    val generatedAt: String,
    val dateRange: ReportRange,
    val scope: ReportScope,
    val sections: Map<String, ReportOverviewSection>,
    val unavailableSections: List<String>,
    val warnings: List<String>
)

data class ReportPagination(
    val page: Int,
    val pageSize: Int,
    val total: Int
)

data class ReportDetailParams(
    val type: String,
    val generatedAt: String,
    val range: ReportRange?,
    val scope: ReportScope,
    val summary: Map<String, String?>,
    val rows: List<Map<String, String?>>,
    val pagination: ReportPagination,
    val warnings: List<String>,
    val protectedRowsHidden: Boolean = false,
    val protectedRowCount: Int = 0
)

data class ReportExportPayload(
    val bytes: ByteArray,
    val filename: String,
    val mimeType: String
)

/**
 * Dashboard models — UI-friendly, consolidated from the already-migrated modules.
 * Computed in the ViewModel (never inside composables). No Room entities exposed.
 */
data class DashboardSummaryParams(
    val totalEmployees: Int = 0,
    val activeEmployees: Int = 0,
    val presentToday: Int = 0,
    val absentToday: Int = 0,
    val pendingLeaves: Int = 0,
    val pendingPurchaseRequests: Int = 0,
    val payrollPeriodsCount: Int = 0,
    val latestPayrollNetTotal: String? = null,
    // Extra (beyond the minimum spec) so the budget ring chart needs no inline calculation.
    val approvedPurchaseAmount: String = "0.00"
)

data class DashboardAlertParams(
    val id: String,
    val title: String,
    val message: String,
    val type: String,
    val priority: String
)

data class DashboardQuickActionParams(
    val id: String,
    val title: String,
    val targetTab: Int,
    val enabled: Boolean
)

/**
 * Chat models — UI-friendly, repository-backed (mirror the other migrated *Params models).
 * No Room entities exposed. isMine is resolved against the current session.
 */
data class ChatDirectoryUser(
    val userId: String,
    val displayName: String,
    val title: String?,
    val employeeId: String?,
    val departmentId: String?,
    val departmentName: String?,
    val roleName: String,
    val status: String = "active"
)

data class ChatSender(
    val userId: String,
    val displayName: String,
    val roleName: String,
    val departmentName: String?
)

data class ChatDepartmentSummary(
    val id: String,
    val name: String
)

data class ChatReadState(
    val active: Boolean,
    val lastReadAt: String?
)

data class ChatConversationParams(
    val id: String,
    val type: String,
    val title: String,
    val peer: ChatDirectoryUser?,
    val department: ChatDepartmentSummary?,
    val lastMessagePreview: String?,
    val lastMessageAt: String?,
    val lastSender: ChatSender?,
    val unreadCount: Int,
    val readState: ChatReadState?,
    val createdAt: String?,
    val repliesEnabled: Boolean = true
)

data class ChatMessageParams(
    val id: String,
    val conversationId: String,
    val sender: ChatSender,
    val body: String,
    val createdAt: String,
    val isOwn: Boolean,
    val replyToMessageId: String? = null,
    val attachments: List<ChatAttachmentParams> = emptyList()
)

data class ChatAttachmentParams(
    val id: String,
    val originalFilename: String,
    val contentType: String,
    val byteSize: Int
)

data class ChatPinnedMessageParams(
    val id: String,
    val conversationId: String,
    val messageId: String,
    val pinnedByUserId: String?,
    val pinnedAt: String?
)

data class ChatCreateAnnouncementRequest(
    val title: String,
    val body: String? = null
)

data class ChatConversationPage(
    val items: List<ChatConversationParams>,
    val nextOffset: Int?
)

data class ChatMessagePage(
    val items: List<ChatMessageParams>,
    val nextCursor: String?,
    val order: String
)

data class ChatReadResult(
    val conversationId: String,
    val unreadCount: Int
)

data class Supplier(
    val id: String,
    val companyId: String,
    val name: String,
    val phone: String?,
    val email: String?,
    val taxNumber: String?,
    val category: String?,
    val status: String,
    val deactivatedAt: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    // Sprint 12I (M08) — vendor archive lifecycle. Not returned by GET /api/vendors
    // (list), only by GET/POST /api/v2/vendors/:id/{lifecycle,archive,reactivate}.
    val lifecycleVersion: Int = 1,
    val archivedAt: String? = null,
    val archivedByUserId: String? = null,
    val archiveReason: String? = null
)

data class PurchasingActor(
    val id: String,
    val name: String
)

data class PurchaseReviewParams(
    val reviewer: PurchasingActor?,
    val reviewedAt: String?,
    val note: String?
)

data class PurchaseRequestLineParams(
    val id: String,
    val description: String,
    val category: String?,
    val quantity: String,
    val unit: String,
    val estimatedUnitPrice: String,
    val estimatedTotal: String
)

data class PurchaseOrderSummaryParams(
    val id: String,
    val orderNumber: String,
    val status: String,
    val totalAmount: String,
    val currency: String,
    val createdAt: String?
)

data class PurchaseRequestParams(
    val id: String,
    val companyId: String,
    val requestNumber: String,
    val requestedByEmployeeId: String,
    val requesterNameSnapshot: String,
    val requesterNumSnapshot: String,
    val departmentId: String?,
    val departmentNameSnapshot: String?,
    val title: String,
    val justification: String?,
    val neededByDate: String?,
    val status: String,
    val totalEstimated: String,
    val currency: String,
    val lines: List<PurchaseRequestLineParams>,
    val departmentReview: PurchaseReviewParams?,
    val purchasingReview: PurchaseReviewParams?,
    val rejectedAt: String?,
    val orders: List<PurchaseOrderSummaryParams>,
    val createdAt: String?,
    val updatedAt: String?
)

data class PurchaseRequestLineInput(
    val description: String,
    val category: String? = null,
    val quantity: String,
    val unit: String,
    val estimatedUnitPrice: String
)

data class CreatePurchaseRequestParams(
    val title: String,
    val justification: String? = null,
    val neededByDate: String? = null,
    val lines: List<PurchaseRequestLineInput>,
    val currency: String = "SAR"
)

data class PurchaseRequestFilters(
    val scope: String? = null,
    val status: String? = null,
    val from: String? = null,
    val to: String? = null,
    val departmentId: String? = null,
    val requesterEmployeeId: String? = null
)

data class PurchaseOrderLineInput(
    val id: String? = null,
    val requestLineId: String? = null,
    val description: String,
    val category: String? = null,
    val quantity: String,
    val unit: String,
    val unitPrice: String
)

data class PurchaseOrderLineParams(
    val id: String,
    val requestLineId: String?,
    val descriptionSnapshot: String,
    val categorySnapshot: String?,
    val quantity: String,
    val unitSnapshot: String,
    val unitPrice: String,
    val lineTotal: String
)

data class PurchaseOrderParams(
    val id: String,
    val companyId: String,
    val orderNumber: String,
    val purchaseRequestId: String,
    val requestNumber: String?,
    val requestTitle: String?,
    val requesterNameSnapshot: String?,
    val departmentNameSnapshot: String?,
    val vendorId: String,
    val vendorNameSnapshot: String,
    val vendorContactSnapshot: String?,
    val vendorEmailSnapshot: String?,
    val vendorTaxNumberSnapshot: String?,
    val status: String,
    val currency: String,
    val subtotal: String,
    val totalAmount: String,
    val lines: List<PurchaseOrderLineParams>,
    val issuedAt: String?,
    val receivedAt: String?,
    val receiptNote: String?,
    val cancelledAt: String?,
    val cancellationReason: String?,
    val createdAt: String?,
    val updatedAt: String?
)

data class PurchaseOrderDraftParams(
    val purchaseRequestId: String,
    val vendorId: String,
    val lines: List<PurchaseOrderLineInput>,
    val currency: String = "SAR"
)

data class PurchaseOrderFilters(
    val scope: String? = null,
    val status: String? = null,
    val vendorId: String? = null,
    val requestId: String? = null,
    val from: String? = null,
    val to: String? = null
)

data class PurchasingReportSummary(
    val requestCount: Int = 0,
    val pendingDepartmentCount: Int = 0,
    val pendingPurchasingCount: Int = 0,
    val approvedCount: Int = 0,
    val orderedCount: Int = 0,
    val receivedCount: Int = 0,
    val orderCount: Int = 0,
    val estimatedTotal: String = "0.00",
    val orderedTotal: String = "0.00",
    val receivedTotal: String = "0.00",
    val currency: String = "SAR"
)

data class PurchasingReportParams(
    val summary: PurchasingReportSummary,
    val requests: List<PurchaseRequestParams> = emptyList(),
    val orders: List<PurchaseOrderParams> = emptyList()
)

data class TaskParams(
    val id: String,
    val companyId: String,
    val title: String,
    val description: String?,
    val status: String,
    val priority: String?,
    val assignedToId: String?,
    val assignedToName: String?,
    val departmentName: String?,
    val dueDate: String?,
    val createdById: String?,
    val createdByName: String?,
    val createdAt: String?,
    val updatedAt: String?,
    val assignments: List<TaskAssignmentParams> = emptyList()
)

/**
 * Commercial P4 — distinguishes "leave this field alone" from "set it to this
 * value", where the value may legitimately be null meaning "clear it".
 *
 * This exists because Moshi omits null properties when writing, so a plain
 * nullable parameter cannot express an explicit JSON `null`. Without it, an
 * Android user could never clear a task's description or due date: the field
 * would simply vanish from the request and the backend would read that as
 * "unchanged" — and if clearing were the only edit, the request would carry no
 * changed field at all and be rejected outright.
 */
sealed interface TaskFieldEdit<out T> {
    /** Field is absent from the request body. */
    data object Unchanged : TaskFieldEdit<Nothing>

    /** Field is present. A null [value] is an explicit clear. */
    data class Set<out T>(val value: T?) : TaskFieldEdit<T>
}

/** Commercial P4 — one message in a task's discussion thread. */
data class TaskCommentParams(
    val id: String,
    val taskId: String,
    val body: String,
    val authorId: String,
    val authorName: String,
    val createdAt: String?
)

/** Newest-first page; `nextCursor` walks backwards to older comments. */
data class TaskCommentPageParams(
    val items: List<TaskCommentParams> = emptyList(),
    val nextCursor: String? = null,
    val hasMore: Boolean = false
)

data class TaskAssignmentParams(
    val id: String,
    val taskId: String,
    val employeeId: String,
    val employeeNum: String,
    val employeeName: String,
    val departmentId: String?,
    val departmentName: String?,
    val status: String,
    val completionDetails: String?,
    val submittedAt: String?,
    val reviewedById: String?,
    val reviewedByName: String?,
    val reviewedAt: String?,
    val reviewNote: String?,
    val createdAt: String?,
    val updatedAt: String?
)

data class TaskEligibleEmployee(
    val employeeId: String,
    val employeeNum: String,
    val name: String,
    val departmentId: String?,
    val departmentName: String?
)

data class TaskFilters(
    val scope: String? = null,
    val status: String? = null,
    val priority: String? = null,
    val from: String? = null,
    val to: String? = null,
    val employeeId: String? = null
)

data class CreateTaskRequestParams(
    val title: String,
    val description: String?,
    val priority: String,
    val dueDate: String?,
    val employeeIds: List<String>
)

data class TaskReviewResult(
    val assignment: TaskAssignmentParams,
    val taskStatus: String
)

data class TrainingCourseParams(
    val id: String,
    val companyId: String?,
    val courseCode: String,
    val title: String,
    val description: String?,
    val category: String?,
    val instructorName: String?,
    val deliveryMode: String,
    val location: String?,
    val startDate: String?,
    val endDate: String?,
    val durationHours: Int?,
    val capacity: Int?,
    val status: String,
    val resources: List<TrainingResourceParams> = emptyList(),
    val assignmentSummary: TrainingAssignmentSummary = TrainingAssignmentSummary(),
    val ownAssignment: TrainingAssignmentParams? = null,
    val createdAt: String?,
    val publishedAt: String?,
    val completedAt: String?,
    val cancelledAt: String?,
    val archivedAt: String?,
    val updatedAt: String?
)

data class TrainingResourceParams(
    val id: String,
    val title: String,
    val type: String,
    val url: String,
    val sortOrder: Int
)

data class TrainingAssignmentSummary(
    val total: Int = 0,
    val assigned: Int = 0,
    val inProgress: Int = 0,
    val submitted: Int = 0,
    val completed: Int = 0,
    val returned: Int = 0,
    val cancelled: Int = 0
)

data class TrainingCourseSummaryParams(
    val id: String,
    val courseCode: String,
    val title: String,
    val category: String?,
    val instructorName: String?,
    val deliveryMode: String,
    val location: String?,
    val startDate: String?,
    val endDate: String?,
    val durationHours: Int?,
    val status: String
)

data class TrainingEmployeeSnapshot(
    val employeeId: String,
    val employeeNum: String,
    val displayName: String,
    val departmentId: String?,
    val departmentName: String?
)

data class TrainingCancellationParams(
    val cancelledAt: String?,
    val reason: String?
)

/** Commercial P4 — internal completion certificate (no external accreditation). */
data class TrainingCertificateParams(
    val id: String,
    val assignmentId: String,
    val courseId: String,
    val employeeId: String,
    val serialNumber: String,
    val courseTitle: String,
    val employeeName: String,
    val employeeNum: String,
    val completedAt: String?,
    val issuedById: String?,
    val issuedByName: String?,
    val issuedAt: String?
)

/** Commercial P4 — reviewer evaluation; reading needs training.evaluation.view. */
data class TrainingEvaluationParams(
    val id: String,
    val assignmentId: String,
    val courseId: String,
    val employeeId: String,
    val effectivenessScore: Int,
    val knowledgeScore: Int,
    val applicationScore: Int,
    val recommendation: String,
    val comment: String?,
    val evaluatedById: String?,
    val evaluatedByName: String?,
    val evaluatedAt: String?
)

data class TrainingEvaluationRequestParams(
    val effectivenessScore: Int,
    val knowledgeScore: Int,
    val applicationScore: Int,
    val recommendation: String,
    val comment: String? = null
)

data class TrainingAssignmentParams(
    val id: String,
    val companyId: String?,
    val courseId: String,
    val course: TrainingCourseSummaryParams?,
    val employee: TrainingEmployeeSnapshot,
    val status: String,
    val progressPercent: Int,
    val assignedAt: String?,
    val startedAt: String?,
    val submittedAt: String?,
    val completedAt: String?,
    val reviewedAt: String?,
    val reviewNote: String?,
    val score: Int?,
    val cancellation: TrainingCancellationParams?,
    val createdAt: String?,
    val updatedAt: String?
)

data class TrainingEligibleEmployee(
    val employeeId: String,
    val employeeNum: String,
    val displayName: String,
    val departmentId: String?,
    val departmentName: String?,
    val roleName: String?
)

data class TrainingCourseFilters(
    val scope: String? = null,
    val status: String? = null,
    val category: String? = null,
    val from: String? = null,
    val to: String? = null,
    val query: String? = null
)

data class TrainingAssignmentFilters(
    val scope: String? = null,
    val status: String? = null,
    val courseId: String? = null,
    val departmentId: String? = null,
    val employeeId: String? = null,
    val from: String? = null,
    val to: String? = null
)

data class TrainingResourceRequestParams(
    val title: String,
    val type: String,
    val url: String,
    val sortOrder: Int? = null
)

data class TrainingCourseRequestParams(
    val title: String,
    val description: String?,
    val category: String?,
    val instructorName: String?,
    val deliveryMode: String,
    val location: String?,
    val startDate: String?,
    val endDate: String?,
    val durationHours: Int?,
    val capacity: Int?,
    val resources: List<TrainingResourceRequestParams>
)

data class TrainingReportFilters(
    val scope: String? = null,
    val from: String? = null,
    val to: String? = null,
    val courseStatus: String? = null,
    val assignmentStatus: String? = null,
    val category: String? = null,
    val departmentId: String? = null
)

data class TrainingReportSummary(
    val courseCount: Int,
    val draftCourseCount: Int,
    val publishedCourseCount: Int,
    val completedCourseCount: Int,
    val cancelledCourseCount: Int,
    val assignmentCount: Int,
    val assignedCount: Int,
    val inProgressCount: Int,
    val submittedCount: Int,
    val completedAssignmentCount: Int,
    val returnedCount: Int,
    val cancelledAssignmentCount: Int,
    val overdueCount: Int,
    val completionRatePercent: Double,
    val averageProgressPercent: Double,
    val averageScore: String?
)

data class TrainingReportCourseRow(
    val course: TrainingCourseSummaryParams,
    val assignmentSummary: TrainingAssignmentSummary
)

data class TrainingReportAssignmentRow(
    val id: String,
    val courseId: String,
    val employee: TrainingEmployeeSnapshot,
    val status: String
)

data class TrainingReportDepartmentRow(
    val departmentId: String?,
    val departmentName: String?,
    val assignmentCount: Int,
    val completedCount: Int,
    val completionRatePercent: Double
)

data class TrainingReportParams(
    val summary: TrainingReportSummary,
    val courses: List<TrainingReportCourseRow>,
    val assignments: List<TrainingReportAssignmentRow>,
    val departments: List<TrainingReportDepartmentRow>
)

data class TrainingTimelineEvent(
    val at: String,
    val type: String,
    val summary: String
)

data class TrainingTimelineParams(
    val courseId: String,
    val events: List<TrainingTimelineEvent>
)

enum class TrainingExportFormat(val apiValue: String, val fileExtension: String, val mimeType: String) {
    CSV("csv", "csv", "text/csv"),
    XLSX("xlsx", "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    PDF("pdf", "pdf", "application/pdf")
}
