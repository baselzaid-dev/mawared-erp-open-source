package com.example.ui

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.example.BuildConfig
import com.example.R
import com.example.core.auth.CompanyLoginRules
import com.example.core.network.UserSafeErrorMessages
import com.example.data.model.Employee
import com.example.data.model.PurchaseOrder
import com.example.data.model.Task
import com.example.data.demo.DemoLoginProfiles
import com.example.domain.model.canRecordPayment
import com.example.domain.model.isArchived
import com.example.domain.model.isPendingAdmin
import com.example.domain.model.supportsFormat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

sealed class LoggedInState {
    object PreLogin : LoggedInState()
    object BiometricChallenge : LoggedInState()
    object MfaChallenge : LoggedInState()
    /** Company Primary Owner forgot-password (company code + owner email). */
    object OwnerForgotPassword : LoggedInState()
    /** Owner reset confirmation — token lives in OwnerRecoveryController memory only. */
    object OwnerResetConfirm : LoggedInState()
    data class Authenticated(val userName: String, val userRole: String, val department: String) : LoggedInState()
}

/**
 * Lightweight display-only profile for the currently authenticated user.
 *
 * This is NEVER a source of authorization. Access decisions come only from
 * CurrentSession.permissions (see PermissionChecker). In DEMO_MODE these values are
 * mapped from the demo email; in production they should come from the backend.
 */
data class UserDisplayProfile(
    val fullName: String,
    val roleName: String,
    val departmentName: String,
    val email: String
)

data class AuthUiState(
    val isLoading: Boolean = false,
    val isLoggedIn: Boolean = false,
    val currentSession: com.example.domain.model.CurrentSession? = null,
    val userDisplayProfile: UserDisplayProfile? = null,
    val currentUserDisplayName: String = "",
    val currentUserRoleName: String = "",
    val currentDepartmentName: String = "",
    val errorMessage: String? = null,
    val hasRememberedSession: Boolean = false,
    val rememberedCompanyCode: String? = null,
    val isDemoMode: Boolean = BuildConfig.DEMO_MODE
)

data class EmployeesUiState(
    val isLoading: Boolean = false,
    val employees: List<Employee> = emptyList(),
    val employeeRecords: List<com.example.domain.model.EmployeeParams> = emptyList(),
    val roles: List<com.example.domain.model.Role> = emptyList(),
    val departments: List<com.example.domain.model.Department> = emptyList(),
    val managerCandidates: List<com.example.domain.model.DepartmentManagerCandidate> = emptyList(),
    val searchQuery: String = "",
    val departmentFilter: String = "الكل",
    val errorMessage: String? = null,
    val canView: Boolean = false,
    val canCreate: Boolean = false,
    val canUpdate: Boolean = false,
    val canChangeRoles: Boolean = false,
    val canDelete: Boolean = false,
    val canManageDepartments: Boolean = false,
    val canManageDepartmentManagers: Boolean = false,
    val canViewSalaryCompany: Boolean = false,
    val canManageSalary: Boolean = false,
    val canViewOwnerSalary: Boolean = false,
    val isEmpty: Boolean = true
)

data class SalaryUiState(
    val employeeId: String? = null,
    val employeeName: String = "",
    val currentSalary: com.example.domain.model.SalaryRecordParams? = null,
    val history: List<com.example.domain.model.SalaryRecordParams> = emptyList(),
    val isLoading: Boolean = false,
    val isSaving: Boolean = false,
    val canManage: Boolean = false,
    val errorMessage: String? = null
)

internal fun canManageDepartments(permissions: Set<String>): Boolean =
    permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL) ||
        permissions.contains(com.example.core.permissions.Permissions.HR_MANAGE)

internal fun canEditEmployees(permissions: Set<String>): Boolean =
    permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL) ||
        permissions.contains(com.example.core.permissions.Permissions.EMPLOYEES_UPDATE)

internal fun canManageCompanyPrincipals(permissions: Set<String>): Boolean =
    permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL) ||
        (
            permissions.contains(com.example.core.permissions.Permissions.EMPLOYEES_PERMISSIONS_MANAGE) &&
                permissions.contains(com.example.core.permissions.Permissions.PERMISSIONS_MANAGE_COMPANY)
            )

internal fun canChangeEmployeeRoles(permissions: Set<String>): Boolean =
    permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL) ||
        (
            permissions.contains(com.example.core.permissions.Permissions.EMPLOYEES_UPDATE) &&
                canManageCompanyPrincipals(permissions)
            )

internal fun canManageDepartmentManagers(permissions: Set<String>): Boolean =
    permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL) ||
        (
            permissions.contains(com.example.core.permissions.Permissions.HR_MANAGE) &&
                canManageCompanyPrincipals(permissions)
            )

internal fun canSubmitEmployeeRole(
    permissions: Set<String>,
    currentRoleId: String?,
    requestedRoleId: String?
): Boolean = currentRoleId == requestedRoleId || canChangeEmployeeRoles(permissions)

internal fun canSubmitDepartmentManager(
    permissions: Set<String>,
    currentDepartmentLoaded: Boolean,
    currentManagerId: String?,
    requestedManagerId: String?
): Boolean = currentDepartmentLoaded && (
    currentManagerId == requestedManagerId || canManageDepartmentManagers(permissions)
)

internal fun isProtectedAdminRole(roleName: String?): Boolean {
    val normalized = roleName?.trim()?.lowercase(Locale.ROOT).orEmpty()
    return normalized == "admin" ||
        normalized == "owner" ||
        normalized.contains("مالك") ||
        (normalized.contains("مدير") && normalized.contains("عام"))
}

internal fun canViewSalaryForTarget(permissions: Set<String>, roleName: String?): Boolean {
    val basePermission = permissions.contains(com.example.core.permissions.Permissions.SALARY_VIEW_COMPANY) ||
        permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL)
    if (!basePermission) return false
    return !isProtectedAdminRole(roleName) ||
        permissions.contains(com.example.core.permissions.Permissions.SALARY_VIEW_OWNER)
}

internal fun canManageSalaryForTarget(permissions: Set<String>, roleName: String?): Boolean {
    val basePermission = permissions.contains(com.example.core.permissions.Permissions.SALARY_MANAGE) ||
        permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL)
    if (!basePermission) return false
    return !isProtectedAdminRole(roleName) ||
        permissions.contains(com.example.core.permissions.Permissions.SALARY_VIEW_OWNER)
}

internal fun isValidSalaryAmount(value: String): Boolean {
    val normalized = value.trim()
    if (!Regex("^(0|[1-9]\\d{0,7})(\\.\\d{1,2})?$").matches(normalized)) return false
    return try {
        java.math.BigDecimal(normalized) <= java.math.BigDecimal("10000000")
    } catch (_: NumberFormatException) {
        false
    }
}

internal fun filterEmployeeRecords(
    employees: List<com.example.domain.model.EmployeeParams>,
    searchQuery: String,
    departmentFilter: String
): List<com.example.domain.model.EmployeeParams> = employees.filter { employee ->
    val matchesSearch = employee.fullName.contains(searchQuery, ignoreCase = true) ||
        employee.employeeCode.contains(searchQuery, ignoreCase = true) ||
        employee.jobTitle.orEmpty().contains(searchQuery, ignoreCase = true) ||
        employee.roleName.orEmpty().contains(searchQuery, ignoreCase = true) ||
        employee.email.orEmpty().contains(searchQuery, ignoreCase = true)
    val matchesDepartment = departmentFilter == "الكل" || employee.departmentName == departmentFilter
    matchesSearch && matchesDepartment
}

private data class EmployeeReferenceData(
    val roles: List<com.example.domain.model.Role>,
    val departments: List<com.example.domain.model.Department>,
    val managerCandidates: List<com.example.domain.model.DepartmentManagerCandidate>,
    val isLoading: Boolean
)

data class PurchasingUiState(
    val isLoading: Boolean = false,
    val isSubmitting: Boolean = false,
    val requests: List<com.example.domain.model.PurchaseRequestParams> = emptyList(),
    val orders: List<com.example.domain.model.PurchaseOrderParams> = emptyList(),
    val suppliers: List<com.example.domain.model.Supplier> = emptyList(),
    val report: com.example.domain.model.PurchasingReportParams? = null,
    val selectedMode: String = "own",
    val availableModes: List<String> = emptyList(),
    val statusFilter: String? = null,
    val errorMessage: String? = null,
    val canView: Boolean = false,
    val canCreate: Boolean = false,
    val canReviewDepartment: Boolean = false,
    val canApprove: Boolean = false,
    val canManageOrders: Boolean = false,
    val canReceive: Boolean = false,
    val canReport: Boolean = false,
    val canViewSuppliers: Boolean = false,
    val canManageSuppliers: Boolean = false,
    // Sprint 12I (M08): vendor archive/reactivate lifecycle — permission is vendors.archive.
    val canArchiveVendors: Boolean = false,
    val currentEmployeeId: String? = null,
    // Sprint 12I: purchasing admin override (v2) + purchasing exports (v2).
    val canAdminOverride: Boolean = false,
    val overrideTarget: com.example.domain.model.PurchaseRequestParams? = null,
    val overrideSubmitting: Boolean = false,
    val canExportPurchasing: Boolean = false,
    // Commercial Wave 2 (Operations Slice E1) — quotations, partial receipt, returns.
    val canManageQuotations: Boolean = false,
    val canCompareQuotations: Boolean = false,
    val canCreateReturns: Boolean = false,
    val canApproveReturns: Boolean = false,
    val exportingFormat: com.example.domain.model.PurchasingExportFormat? = null,
    val pendingExportShare: com.example.core.export.ReportShareFile? = null,
    val isEmpty: Boolean = true
)

private data class PurchasingData(
    val requests: List<com.example.domain.model.PurchaseRequestParams>,
    val orders: List<com.example.domain.model.PurchaseOrderParams>,
    val suppliers: List<com.example.domain.model.Supplier>,
    val report: com.example.domain.model.PurchasingReportParams?
)

private data class PurchasingRuntime(
    val loading: Boolean,
    val submitting: Boolean,
    val error: String?,
    val mode: String,
    val status: String?
)

private data class PurchasingOverrideExportRuntime(
    val overrideTargetId: String?,
    val overrideSubmitting: Boolean,
    val exportingFormat: com.example.domain.model.PurchasingExportFormat?,
    val pendingExportShare: com.example.core.export.ReportShareFile?
)

data class ChatUiState(
    val isLoading: Boolean = false,
    val isSearchingDirectory: Boolean = false,
    val isLoadingMessages: Boolean = false,
    val isOpeningConversation: Boolean = false,
    val isLoadingOlder: Boolean = false,
    val isSending: Boolean = false,
    val isPolling: Boolean = false,
    val isCreatingAnnouncement: Boolean = false,
    val isPinning: Boolean = false,
    val directoryQuery: String = "",
    val directoryResults: List<com.example.domain.model.ChatDirectoryUser> = emptyList(),
    val directoryHasLoaded: Boolean = false,
    val departments: List<com.example.domain.model.ChatDepartmentSummary> = emptyList(),
    val conversations: List<com.example.domain.model.ChatConversationParams> = emptyList(),
    val selectedConversation: com.example.domain.model.ChatConversationParams? = null,
    val messages: List<com.example.domain.model.ChatMessageParams> = emptyList(),
    val pins: List<com.example.domain.model.ChatPinnedMessageParams> = emptyList(),
    val nextMessageCursor: String? = null,
    val totalUnread: Int = 0,
    val messageDraft: String = "",
    val replyToMessageId: String? = null,
    val errorMessage: String? = null,
    val canUseChat: Boolean = false,
    val canCreateDirect: Boolean = false,
    val canCreateDepartment: Boolean = false,
    val canCreateAnnouncement: Boolean = false,
    val canPin: Boolean = false
) {
    val isEmpty: Boolean
        get() = conversations.isEmpty()
}

data class TrainingUiState(
    val isLoading: Boolean = false,
    val isSubmitting: Boolean = false,
    val courses: List<com.example.domain.model.TrainingCourseParams> = emptyList(),
    val assignments: List<com.example.domain.model.TrainingAssignmentParams> = emptyList(),
    val selectedCourse: com.example.domain.model.TrainingCourseParams? = null,
    val selectedAssignment: com.example.domain.model.TrainingAssignmentParams? = null,
    val eligibleEmployees: List<com.example.domain.model.TrainingEligibleEmployee> = emptyList(),
    val report: com.example.domain.model.TrainingReportParams? = null,
    val selectedMode: String = "own",
    val availableModes: List<String> = emptyList(),
    val courseStatusFilter: String? = null,
    val assignmentStatusFilter: String? = null,
    val categoryFilter: String? = null,
    val errorMessage: String? = null,
    val currentEmployeeId: String? = null,
    val canViewOwn: Boolean = false,
    val canViewDepartment: Boolean = false,
    val canViewCompany: Boolean = false,
    val canView: Boolean = false,
    val canManage: Boolean = false,
    val canAssign: Boolean = false,
    val canReview: Boolean = false,
    val canReport: Boolean = false,
    // Commercial P4 completion artifacts. Mirrors the backend guards exactly;
    // reading an evaluation needs its own key, not the training view scope.
    val canIssueCertificate: Boolean = false,
    val canCreateEvaluation: Boolean = false,
    val canViewEvaluation: Boolean = false,
    val isEmpty: Boolean = true
)

private data class TrainingData(
    val courses: List<com.example.domain.model.TrainingCourseParams>,
    val assignments: List<com.example.domain.model.TrainingAssignmentParams>,
    val eligibleEmployees: List<com.example.domain.model.TrainingEligibleEmployee>,
    val report: com.example.domain.model.TrainingReportParams?
)

private data class TrainingControls(
    val isLoading: Boolean = false,
    val isSubmitting: Boolean = false,
    val errorMessage: String? = null,
    val selectedMode: String = "own",
    val courseStatusFilter: String? = null,
    val assignmentStatusFilter: String? = null,
    val categoryFilter: String? = null,
    val selectedCourse: com.example.domain.model.TrainingCourseParams? = null,
    val selectedAssignment: com.example.domain.model.TrainingAssignmentParams? = null
)

internal fun trainingModesForPermissions(
    permissions: Set<String>,
    employeeId: String?
): List<String> {
    val admin = permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL)
    val company = admin || permissions.contains(com.example.core.permissions.Permissions.TRAINING_VIEW_COMPANY)
    val own = employeeId != null &&
        (admin || permissions.contains(com.example.core.permissions.Permissions.TRAINING_VIEW_OWN))
    val department = permissions.contains(com.example.core.permissions.Permissions.TRAINING_VIEW_DEPARTMENT)
    val review = admin || permissions.contains(com.example.core.permissions.Permissions.TRAINING_REVIEW)
    val report = admin || permissions.contains(com.example.core.permissions.Permissions.TRAINING_REPORT)
    return buildList {
        if (company) {
            add("courses")
            add("assignments")
            if (review) add("reviews")
            if (report) add("report")
        } else {
            if (own) add("own")
            if (department) add("department")
            if (report) add("report")
        }
    }
}

data class TasksUiState(
    val isLoading: Boolean = false,
    val isSubmitting: Boolean = false,
    val tasks: List<com.example.domain.model.TaskParams> = emptyList(),
    val eligibleEmployees: List<com.example.domain.model.TaskEligibleEmployee> = emptyList(),
    val selectedMode: String = "own",
    val availableModes: List<String> = emptyList(),
    val statusFilter: String? = null,
    val currentEmployeeId: String? = null,
    val errorMessage: String? = null,
    val canView: Boolean = false,
    val canCreate: Boolean = false,
    val canProgress: Boolean = false,
    val canReview: Boolean = false,
    val canCancel: Boolean = false,
    // Commercial P4. Mirrors the backend guards; hiding is never the protection.
    val canEdit: Boolean = false,
    val canComment: Boolean = false,
    val isEmpty: Boolean = true
)

private data class TaskControls(
    val isLoading: Boolean,
    val isSubmitting: Boolean,
    val errorMessage: String?,
    val selectedMode: String,
    val statusFilter: String?
)

data class AttendanceUiState(
    val isLoading: Boolean = false,
    val isSubmittingManual: Boolean = false,
    val records: List<com.example.domain.model.AttendanceRecordParams> = emptyList(),
    val todayRecords: List<com.example.domain.model.AttendanceRecordParams> = emptyList(),
    val eligibleEmployees: List<com.example.domain.model.AttendanceEligibleEmployee> = emptyList(),
    val availableDepartments: List<com.example.domain.model.AttendanceDepartmentOption> = emptyList(),
    val selectedDepartmentId: String? = null,
    val selectedStatusFilter: String = "الكل",
    val selectedRangePreset: com.example.domain.model.AttendanceRangePreset = com.example.domain.model.AttendanceRangePreset.TODAY,
    val fromDate: String = "",
    val toDate: String = "",
    val summary: com.example.domain.model.AttendanceSummary = com.example.domain.model.AttendanceSummary(),
    val errorMessage: String? = null,
    val canView: Boolean = false,
    val canClock: Boolean = false,
    val canManage: Boolean = false,
    val canSelectDepartment: Boolean = false,
    val isOwnScope: Boolean = true,
    val isEmpty: Boolean = true
)

data class LeavesUiState(
    val isLoading: Boolean = false,
    val requests: List<com.example.domain.model.LeaveRequestParams> = emptyList(),
    val myRequests: List<com.example.domain.model.LeaveRequestParams> = emptyList(),
    val reportRequests: List<com.example.domain.model.LeaveRequestParams> = emptyList(),
    val reportSummary: com.example.domain.model.LeaveReportSummary = com.example.domain.model.LeaveReportSummary(),
    val selectedMode: com.example.domain.model.LeaveScreenMode = com.example.domain.model.LeaveScreenMode.MY_REQUESTS,
    val selectedStatusFilter: String = "all",
    val selectedTypeFilter: String = "all",
    val fromDate: String = "",
    val toDate: String = "",
    val selectedEmployeeId: String? = null,
    val currentEmployeeId: String? = null,
    val cancelTarget: com.example.domain.model.LeaveRequestParams? = null,
    val errorMessage: String? = null,
    val canView: Boolean = false,
    val canCreate: Boolean = false,
    val canApprove: Boolean = false,
    val canManage: Boolean = false,
    val canReview: Boolean = false,
    val canReport: Boolean = false,
    val isEmpty: Boolean = true
)

private data class LeaveControlsState(
    val mode: com.example.domain.model.LeaveScreenMode,
    val status: String,
    val type: String,
    val from: String,
    val to: String,
    val employeeId: String?,
    val isLoading: Boolean,
    val error: String?,
    val cancelTarget: com.example.domain.model.LeaveRequestParams?
)

internal fun canReviewLeaves(permissions: Set<String>): Boolean =
    permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL) ||
        permissions.contains(com.example.core.permissions.Permissions.LEAVES_REVIEW)

internal fun canViewLeaveReport(permissions: Set<String>): Boolean =
    permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL) ||
        permissions.contains(com.example.core.permissions.Permissions.LEAVES_VIEW)

data class PayrollUiState(
    val isLoading: Boolean = false,
    val periods: List<com.example.domain.model.PayrollPeriodParams> = emptyList(),
    val selectedPeriod: com.example.domain.model.PayrollPeriodParams? = null,
    val selectedPeriodItems: List<com.example.domain.model.PayrollItemParams> = emptyList(),
    val selectedPeriodId: String? = null,
    val summary: com.example.domain.model.PayrollSummary? = null,
    val report: com.example.domain.model.PayrollReportParams? = null,
    val blockers: List<com.example.domain.model.PayrollBlockerParams> = emptyList(),
    val protectedEmployeeIssues: Int = 0,
    val protectedRowsHidden: Boolean = false,
    val protectedRowCount: Int = 0,
    val errorMessage: String? = null,
    val canView: Boolean = false,
    val canManage: Boolean = false,
    val canApprove: Boolean = false,
    val canReport: Boolean = false,
    val canPay: Boolean = false,
    val showCreateDialog: Boolean = false,
    val calculationTarget: com.example.domain.model.PayrollPeriodParams? = null,
    val approvalTarget: com.example.domain.model.PayrollPeriodParams? = null,
    val paidTarget: com.example.domain.model.PayrollPeriodParams? = null,
    val recalculationReason: String = "",
    // Sprint 12H: payroll partial payments (v2) + exports.
    val canViewPayments: Boolean = false,
    val canRecordPayment: Boolean = false,
    val canVoidPayment: Boolean = false,
    val canExportPayroll: Boolean = false,
    val payments: List<com.example.domain.model.PayrollPaymentParams> = emptyList(),
    val paymentsLoading: Boolean = false,
    val showRecordPaymentDialog: Boolean = false,
    val voidPaymentTarget: com.example.domain.model.PayrollPaymentParams? = null,
    val exportingFormat: com.example.domain.model.PayrollExportFormat? = null,
    val pendingPaymentExportShare: com.example.core.export.ReportShareFile? = null,
    val isEmpty: Boolean = true
)

private data class PayrollRuntimeState(
    val isLoading: Boolean = false,
    val selectedPeriodId: String? = null,
    val details: com.example.domain.model.PayrollItemsResult? = null,
    val summary: com.example.domain.model.PayrollSummary? = null,
    val report: com.example.domain.model.PayrollReportParams? = null,
    val blockers: List<com.example.domain.model.PayrollBlockerParams> = emptyList(),
    val protectedEmployeeIssues: Int = 0,
    val errorMessage: String? = null,
    val showCreateDialog: Boolean = false,
    val calculationTargetId: String? = null,
    val approvalTargetId: String? = null,
    val paidTargetId: String? = null,
    val recalculationReason: String = "",
    // Sprint 12H: payroll partial payments (v2) + exports.
    val payments: List<com.example.domain.model.PayrollPaymentParams> = emptyList(),
    val paymentsLoading: Boolean = false,
    val paymentsLoadedForPeriodId: String? = null,
    val showRecordPaymentDialog: Boolean = false,
    val recordPaymentIdempotencyKey: String = "",
    val voidPaymentTarget: com.example.domain.model.PayrollPaymentParams? = null,
    val exportingFormat: com.example.domain.model.PayrollExportFormat? = null,
    val pendingPaymentExportShare: com.example.core.export.ReportShareFile? = null
)

data class ReportsUiState(
    val isLoading: Boolean = false,
    val summary: com.example.domain.model.ReportsSummaryParams = com.example.domain.model.ReportsSummaryParams(),
    val financial: com.example.domain.model.FinancialReportParams = com.example.domain.model.FinancialReportParams(),
    val departmentReports: List<com.example.domain.model.DepartmentReportParams> = emptyList(),
    val selectedReportType: String = "",
    val errorMessage: String? = null,
    val canViewReports: Boolean = false,
    val canViewFinancialReports: Boolean = false,
    val canViewPayrollReport: Boolean = false,
    val payrollReport: com.example.domain.model.PayrollReportParams? = null,
    val payrollPeriods: List<com.example.domain.model.PayrollPeriodParams> = emptyList(),
    val catalog: List<com.example.domain.model.ReportCatalogItem> = emptyList(),
    val overview: com.example.domain.model.ReportOverview? = null,
    val detail: com.example.domain.model.ReportDetailParams? = null,
    val fromDate: String = "",
    val toDate: String = "",
    val selectedDepartmentId: String? = null,
    val selectedStatus: String? = null,
    val isExporting: Boolean = false,
    val pendingShare: com.example.core.export.ReportShareFile? = null,
    val isEmpty: Boolean = true
)

data class ReportTemplatesUiState(
    val isLoading: Boolean = false,
    val catalog: List<com.example.domain.model.ReportTemplateCatalogItem> = emptyList(),
    val selectedTemplate: com.example.domain.model.ReportTemplateCatalogItem? = null,
    val fromDate: String = "",
    val toDate: String = "",
    val departmentId: String? = null,
    val extraFilter: String? = null,
    val preview: com.example.domain.model.ReportTemplateDocument? = null,
    val savedTemplates: List<com.example.domain.model.SavedReportTemplate> = emptyList(),
    val savedLoading: Boolean = false,
    val showSavedTemplates: Boolean = false,
    val showSaveDialog: Boolean = false,
    val saveName: String = "",
    val exportingFormat: com.example.domain.model.ReportTemplateExportFormat? = null,
    val pendingShare: com.example.core.export.ReportShareFile? = null,
    val errorMessage: String? = null,
    val canManageSavedTemplates: Boolean = false,
    val canExportTemplates: Boolean = false
)

private data class ReportRuntimeState(
    val isLoading: Boolean = false,
    val catalog: List<com.example.domain.model.ReportCatalogItem> = emptyList(),
    val selectedType: String = "",
    val fromDate: String,
    val toDate: String,
    val selectedDepartmentId: String? = null,
    val selectedStatus: String? = null,
    val overview: com.example.domain.model.ReportOverview? = null,
    val detail: com.example.domain.model.ReportDetailParams? = null,
    val errorMessage: String? = null,
    val isExporting: Boolean = false,
    val pendingShare: com.example.core.export.ReportShareFile? = null
)

private data class ReportTemplateRuntimeState(
    val isLoading: Boolean = false,
    val catalog: List<com.example.domain.model.ReportTemplateCatalogItem> = emptyList(),
    val selectedKey: String = "",
    val fromDate: String,
    val toDate: String,
    val departmentId: String? = null,
    val extraFilter: String? = null,
    val preview: com.example.domain.model.ReportTemplateDocument? = null,
    val savedTemplates: List<com.example.domain.model.SavedReportTemplate> = emptyList(),
    val savedLoading: Boolean = false,
    val showSavedTemplates: Boolean = false,
    val showSaveDialog: Boolean = false,
    val saveName: String = "",
    val exportingFormat: com.example.domain.model.ReportTemplateExportFormat? = null,
    val pendingShare: com.example.core.export.ReportShareFile? = null,
    val errorMessage: String? = null
)

data class DashboardUiState(
    val isLoading: Boolean = false,
    val summary: com.example.domain.model.DashboardSummaryParams = com.example.domain.model.DashboardSummaryParams(),
    val alerts: List<com.example.domain.model.DashboardAlertParams> = emptyList(),
    val quickActions: List<com.example.domain.model.DashboardQuickActionParams> = emptyList(),
    val errorMessage: String? = null,
    val canViewDashboard: Boolean = true,
    val isEmpty: Boolean = true
)

class MawaredViewModel(
    application: Application,
    private val authRepository: com.example.domain.repository.AuthRepository,
    private val employeeRepository: com.example.domain.repository.EmployeeRepository,
    private val purchaseRepository: com.example.domain.repository.PurchaseRepository,
    private val supplierRepository: com.example.domain.repository.SupplierRepository,
    private val attendanceRepository: com.example.domain.repository.AttendanceRepository,
    private val attendanceCorrectionRepository: com.example.domain.repository.AttendanceCorrectionRepository,
    private val attendanceExemptionRepository: com.example.domain.repository.AttendanceExemptionRepository,
    private val leaveRepository: com.example.domain.repository.LeaveRepository,
    private val payrollRepository: com.example.domain.repository.PayrollRepository,
    private val chatRepository: com.example.domain.repository.ChatRepository,
    private val taskRepository: com.example.domain.repository.TaskRepository,
    private val trainingRepository: com.example.domain.repository.TrainingRepository,
    private val reportRepository: com.example.domain.repository.ReportRepository,
    authorizationRepository: com.example.domain.repository.AuthorizationRepository,
    private val credentialRepository: com.example.domain.repository.CredentialRepository,
    private val sessionRepository: com.example.domain.repository.SessionRepository,
    private val notificationInboxRepository: com.example.domain.repository.NotificationInboxRepository,
    private val aiAssistantApi: com.example.data.remote.api.AiAssistantApi,
    globalSearchRepository: com.example.domain.repository.GlobalSearchRepository,
    timelineRepository: com.example.domain.repository.TimelineRepository
) : AndroidViewModel(application) {

    val authorization = AuthorizationCoordinator(authorizationRepository, viewModelScope)
    private val authorizationSessionController = AuthorizationSessionController()

    val forcedPasswordChangeController = ForcedPasswordChangeController(
        repository = credentialRepository,
        scope = viewModelScope,
        onPasswordChanged = {
            // Server revoked other sessions; this device must sign in with the new password.
            logOut()
        }
    )

    val ownerRecoveryController = OwnerRecoveryController(
        authRepository = authRepository,
        scope = viewModelScope,
        onConfirmSuccess = {
            // Stale remembered/biometric sessions already cleared by confirm; keep login fields.
            inputPassword = ""
        }
    )

    val sessionListController = SessionListController(
        repository = sessionRepository,
        scope = viewModelScope
    )

    // Sprint 12L: federated global search (server enforces all source scoping).
    val globalSearchController = GlobalSearchController(
        repository = globalSearchRepository,
        scope = viewModelScope
    )

    // Sprint 12L: shared timeline viewer (leave / purchasing / employee / training).
    val timelineController = TimelineController(
        repository = timelineRepository,
        scope = viewModelScope
    )

    fun openTimeline(
        kind: com.example.domain.model.TimelineKind,
        id: String
    ) {
        timelineController.open(kind, id)
    }

    val employeeSecurityController = EmployeeSecurityController(
        repository = credentialRepository,
        scope = viewModelScope,
        onMutated = {
            val permissions = authUiState.value.currentSession?.permissions ?: emptySet()
            val canLoadManagerCandidates = canManageDepartmentManagers(permissions)
            employeeRepository.refreshEmployees()
            employeeRepository.refreshEmployeeOptions(canLoadManagerCandidates)
        }
    )

    val vendorLifecycleController = VendorLifecycleController(
        repository = supplierRepository,
        scope = viewModelScope,
        onMutated = { supplierRepository.refreshSuppliersAllStatuses() }
    )

    /** Commercial Wave 2 — quotations, partial receipt and returns. */
    val purchasingWave2Controller = PurchasingWave2Controller(
        repository = purchaseRepository,
        scope = viewModelScope
    )

    private fun resetSecurityControllers() {
        forcedPasswordChangeController.reset()
        ownerRecoveryController.reset()
        sessionListController.reset()
        employeeSecurityController.reset()
        vendorLifecycleController.reset()
        purchasingWave2Controller.reset()
        globalSearchController.reset()
        timelineController.reset()
    }

    fun openOwnerForgotPassword() {
        if (_loginState.value is LoggedInState.Authenticated) return
        ownerRecoveryController.openForgot(inputCompanyCode)
        _loginState.value = LoggedInState.OwnerForgotPassword
    }

    fun openOwnerResetConfirm(
        tokenFromDeepLink: String? = null,
        deepLinkRejected: Boolean = false,
        companyCode: String? = inputCompanyCode.ifBlank {
            ownerRecoveryController.retainedCompanyCode()
        }
    ) {
        if (_loginState.value is LoggedInState.Authenticated) return
        val retained = companyCode?.takeIf { it.isNotBlank() } ?: inputCompanyCode
        if (retained.isNotBlank()) {
            inputCompanyCode = CompanyLoginRules.normalizeCompanyCode(retained)
                .filter { it in 'A'..'Z' || it in '0'..'9' || it == '-' }
                .take(32)
        }
        ownerRecoveryController.openReset(
            companyCode = inputCompanyCode.ifBlank { null },
            tokenFromDeepLink = tokenFromDeepLink,
            deepLinkRejected = deepLinkRejected
        )
        _loginState.value = LoggedInState.OwnerResetConfirm
    }

    fun handleOwnerRecoveryDeepLink(uri: android.net.Uri?) {
        when (val parsed = com.example.core.auth.OwnerRecoveryDeepLink.parse(uri)) {
            is com.example.core.auth.OwnerRecoveryDeepLink.ParseResult.Accepted -> {
                openOwnerResetConfirm(tokenFromDeepLink = parsed.token, deepLinkRejected = false)
            }
            com.example.core.auth.OwnerRecoveryDeepLink.ParseResult.ManualFallback -> {
                openOwnerResetConfirm(tokenFromDeepLink = null, deepLinkRejected = true)
            }
            com.example.core.auth.OwnerRecoveryDeepLink.ParseResult.NotOwnerRecovery -> Unit
        }
    }

    fun leaveOwnerRecoveryToLogin(retainCompanyCode: Boolean = true) {
        val retained = if (retainCompanyCode) {
            ownerRecoveryController.retainedCompanyCode() ?: inputCompanyCode
        } else {
            ""
        }
        ownerRecoveryController.leaveReset()
        ownerRecoveryController.reset()
        if (retained.isNotBlank()) {
            inputCompanyCode = retained
        }
        inputPassword = ""
        _loginState.value = LoggedInState.PreLogin
    }

    private val notificationInboxController = NotificationInboxController(
        repository = notificationInboxRepository,
        scope = viewModelScope,
        onNavigate = { descriptor -> navigateFromResourceDescriptor(descriptor) },
        onOpenPreferencesScreen = { openNotificationPreferences() }
    )
    val notificationInboxState = notificationInboxController.state
    val notificationInboxActions: NotificationCenterActions = notificationInboxController

    val notificationPreferencesController = NotificationPreferencesController(
        repository = notificationInboxRepository.asNotificationPreferencesRepository(),
        scope = viewModelScope
    )

    private val myWorkController = MyWorkController(
        leaveRepository = leaveRepository,
        taskRepository = taskRepository,
        attendanceRepository = attendanceRepository
    )
    private val _myWorkUiState = MutableStateFlow<MyWorkUiState>(MyWorkUiState.Loading)
    val myWorkUiState: StateFlow<MyWorkUiState> = _myWorkUiState.asStateFlow()
    var myWorkCategoryFilter by mutableStateOf<String?>(null)
        private set
    var showNotificationPreferences by mutableStateOf(false)
        private set
    var pendingDeepLinkResourceId by mutableStateOf<String?>(null)
        private set
    var pendingDeepLinkKind by mutableStateOf<String?>(null)
        private set
    var focusedEmployeeId by mutableStateOf<String?>(null)
        private set
    var focusedLeaveId by mutableStateOf<String?>(null)
        private set
    var focusedTaskId by mutableStateOf<String?>(null)
        private set
    var focusedPurchaseRequestId by mutableStateOf<String?>(null)
        private set
    var focusedVendor by mutableStateOf<com.example.domain.model.Supplier?>(null)
        private set
    var focusedTrainingCourseId by mutableStateOf<String?>(null)
        private set

    enum class AttendanceWorkflowPanel { RECORDS, CORRECTIONS, EXEMPTIONS }

    var attendanceWorkflowPanel by mutableStateOf(AttendanceWorkflowPanel.RECORDS)
        private set

    val attendanceCorrectionController = AttendanceCorrectionController(
        repository = attendanceCorrectionRepository,
        scope = viewModelScope,
        permissionsProvider = { authUiState.value.currentSession?.permissions ?: emptySet() },
        currentUserIdProvider = { authUiState.value.currentSession?.userId },
        onNavigate = { descriptor -> navigateFromResourceDescriptor(descriptor) }
    )

    val attendanceExemptionController = AttendanceExemptionController(
        repository = attendanceExemptionRepository,
        scope = viewModelScope,
        permissionsProvider = { authUiState.value.currentSession?.permissions ?: emptySet() }
    )

    fun selectAttendanceWorkflowPanel(panel: AttendanceWorkflowPanel) {
        attendanceWorkflowPanel = panel
        when (panel) {
            AttendanceWorkflowPanel.RECORDS -> Unit
            AttendanceWorkflowPanel.CORRECTIONS -> attendanceCorrectionController.load()
            AttendanceWorkflowPanel.EXEMPTIONS -> {
                viewModelScope.launch {
                    employeeRepository.refreshEmployeeOptions(includeManagerCandidates = true)
                    syncAttendanceExemptionTargets()
                    attendanceExemptionController.load()
                }
            }
        }
    }

    private suspend fun syncAttendanceExemptionTargets() {
        val sessionUserId = authUiState.value.currentSession?.userId
        val departments = employeesUiState.value.departments.associateBy { it.id }
        val managerCandidates = employeeRepository.observeDepartmentManagerCandidates()
            .first()
        val fromManagers = managerCandidates
            .asSequence()
            .filter { it.userId != sessionUserId }
            .map {
                com.example.domain.model.AttendanceExemptionTarget(
                    userId = it.userId,
                    name = it.name,
                    departmentName = departments[it.departmentId]?.name ?: it.roleName,
                    employeeId = it.employeeId
                )
            }
        val fromPrincipals = authorization.state.value.principals
            .asSequence()
            .filter { it.userId != sessionUserId }
            .map {
                com.example.domain.model.AttendanceExemptionTarget(
                    userId = it.userId,
                    name = it.name,
                    departmentName = departments[it.departmentId]?.name.orEmpty(),
                    employeeId = it.employeeId
                )
            }
        attendanceExemptionController.setEligibleTargets(
            (fromManagers + fromPrincipals).distinctBy { it.userId }.toList()
        )
    }

    init {
        authorization.onEffectiveAuthorizationLoaded = { effective ->
            syncSessionAuthorizationFromEffective(effective)
        }
    }

    private val reportExportStore = com.example.core.export.ReportExportStore(application)
    private val payrollExportStore = PayrollExportStore(application)
    private val purchasingExportStore = PurchasingExportStore(application)
    private val trainingExportStore = PayrollExportStore(application)

    // Theme state
    var isDarkTheme by mutableStateOf(true)
        private set

    fun toggleTheme() {
        isDarkTheme = !isDarkTheme
    }

    // Current Login/Auth State flow.
    // LEGACY_UI_COMPATIBILITY_ONLY: _loginState only drives the pre-auth challenge screens
    // (PreLogin / BiometricChallenge / MfaChallenge). It is NOT the source of authorization.
    private val _loginState = MutableStateFlow<LoggedInState>(LoggedInState.PreLogin)
    val loginState: StateFlow<LoggedInState> = _loginState.asStateFlow()

    // Email of the user who last logged in. In DEMO_MODE it is mapped to a display profile.
    // It is NEVER used for authorization — permissions come from CurrentSession only.
    private val _loggedInIdentifier = MutableStateFlow<String?>(null)

    private val _authUiState = MutableStateFlow(AuthUiState())
    val authUiState: StateFlow<AuthUiState> = combine(
        _authUiState,
        authRepository.observeCurrentSession(),
        authRepository.observeRememberedSession(),
        _loggedInIdentifier
    ) { state, session, remembered, identifier ->
        if (session != null) {
            // DEMO_MODE: resolve the friendly display profile from the demo email.
            // Production (DEMO_MODE=false): this should come from the backend (left null here).
            val resolvedIdentifier = identifier ?: session.email
            val profile: UserDisplayProfile? = if (BuildConfig.DEMO_MODE) {
                DemoLoginProfiles.find(session.companyCode, resolvedIdentifier)?.let {
                    UserDisplayProfile(
                        fullName = it.fullName,
                        roleName = it.roleName,
                        departmentName = it.departmentName,
                        email = it.identifier
                    )
                }
            } else {
                null
            }
            state.copy(
                isLoggedIn = true,
                currentSession = session,
                userDisplayProfile = profile,
                currentUserDisplayName = profile?.fullName ?: session.name,
                currentUserRoleName = profile?.roleName ?: session.role,
                currentDepartmentName = profile?.departmentName ?: "",
                hasRememberedSession = remembered != null,
                rememberedCompanyCode = remembered?.companyCode
            )
        } else {
            state.copy(
                isLoggedIn = false,
                currentSession = null,
                userDisplayProfile = null,
                currentUserDisplayName = "",
                currentUserRoleName = "",
                currentDepartmentName = "",
                hasRememberedSession = remembered != null,
                rememberedCompanyCode = remembered?.companyCode
            )
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), AuthUiState())

    // 2FA code and inputs
    var inputCompanyCode by mutableStateOf("")
    var inputIdentifier by mutableStateOf("")
    var inputPassword by mutableStateOf("")
    var inputMfaCode by mutableStateOf("")
    var mfaError by mutableStateOf("")
    var mfaEnrollment by mutableStateOf<com.example.domain.model.MfaEnrollment?>(null)
        private set
    var mfaBackupCodes by mutableStateOf<List<String>>(emptyList())
        private set
    private var pendingMfaChallenge:
        com.example.domain.model.AuthLoginResult.MfaChallenge? = null
    var selectedDemoUserIndex by mutableStateOf(0)

    // Alert Notification Toast Manager
    var activeAlertMessage by mutableStateOf<String?>(null)
        private set

    fun showNotification(message: String) {
        activeAlertMessage = message
    }

    fun dismissNotification() {
        activeAlertMessage = null
    }

    // In-app Navigation State
    // Tabs: 0 = Dashboard (لوحة التحكم), 1 = Employees (الموظفين), 2 = Procurement (المشتريات),
    // 3 = Reports (التقارير المالية), 4 = Chat (الدردشة الداخلية), 5 = Tasks (المهام اليومية), 6 = Support (الدعم الفني)
    var currentSelectedTab by mutableStateOf(0)

    fun openNotificationCenter(category: String? = null) {
        currentSelectedTab = MawaredNavigation.TAB_NOTIFICATIONS
        if (category != null) {
            notificationInboxController.onCategorySelected(category)
        }
        notificationInboxController.load()
    }

    fun openNotificationPreferences() {
        showNotificationPreferences = true
        notificationPreferencesController.load()
    }

    fun closeNotificationPreferences() {
        showNotificationPreferences = false
    }

    fun openMyWork(category: String? = null) {
        myWorkCategoryFilter = category
        currentSelectedTab = MawaredNavigation.TAB_MY_WORK
        refreshMyWork()
    }

    fun refreshMyWork() {
        viewModelScope.launch {
            _myWorkUiState.value = MyWorkUiState.Loading
            val session = authUiState.value.currentSession
            if (session == null) {
                _myWorkUiState.value = MyWorkUiState.Error("الجلسة غير متاحة.")
                return@launch
            }
            _myWorkUiState.value = myWorkController.load(
                MyWorkController.LoadRequest(
                    session = session,
                    category = myWorkCategoryFilter
                )
            )
        }
    }

    fun onMyWorkCategorySelected(category: String?) {
        myWorkCategoryFilter = category
        refreshMyWork()
    }

    fun navigateFromResourceDescriptor(descriptor: com.example.ui.navigation.ResourceDescriptor?) {
        if (descriptor == null) {
            showNotification("لا يتوفر هدف تنقل لهذا العنصر.")
            return
        }
        navigateTypedDestination(
            com.example.ui.navigation.NavigationCoordinator.resolveDestination(descriptor)
        )
    }

    fun navigateTypedDestination(destination: com.example.ui.navigation.TypedDestination) {
        clearTypedResourceFocus()
        when (destination) {
            is com.example.ui.navigation.TypedDestination.Dashboard ->
                currentSelectedTab = MawaredNavigation.TAB_DASHBOARD
            is com.example.ui.navigation.TypedDestination.MyWork ->
                openMyWork(destination.category)
            is com.example.ui.navigation.TypedDestination.Notifications ->
                openNotificationCenter(destination.category)
            is com.example.ui.navigation.TypedDestination.Attendance -> {
                attendanceWorkflowPanel = AttendanceWorkflowPanel.RECORDS
                currentSelectedTab = MawaredNavigation.TAB_ATTENDANCE
            }
            is com.example.ui.navigation.TypedDestination.AttendanceCorrections -> {
                currentSelectedTab = MawaredNavigation.TAB_ATTENDANCE
                selectAttendanceWorkflowPanel(AttendanceWorkflowPanel.CORRECTIONS)
            }
            is com.example.ui.navigation.TypedDestination.AttendanceExemptions -> {
                currentSelectedTab = MawaredNavigation.TAB_ATTENDANCE
                selectAttendanceWorkflowPanel(AttendanceWorkflowPanel.EXEMPTIONS)
            }
            is com.example.ui.navigation.TypedDestination.AttendanceCorrectionDetail -> {
                pendingDeepLinkKind = "attendance_correction"
                pendingDeepLinkResourceId = destination.correctionId
                currentSelectedTab = MawaredNavigation.TAB_ATTENDANCE
                selectAttendanceWorkflowPanel(AttendanceWorkflowPanel.CORRECTIONS)
            }
            is com.example.ui.navigation.TypedDestination.Employees -> {
                focusedEmployeeId = destination.employeeId
                currentSelectedTab = MawaredNavigation.TAB_EMPLOYEES
                destination.employeeId?.let(::loadFocusedEmployee)
            }
            is com.example.ui.navigation.TypedDestination.LeaveDetail -> {
                pendingDeepLinkKind = "leave"
                pendingDeepLinkResourceId = destination.leaveId
                focusedLeaveId = destination.leaveId
                currentSelectedTab = MawaredNavigation.TAB_LEAVES
                refreshLeaveRequests()
            }
            is com.example.ui.navigation.TypedDestination.TaskDetail -> {
                pendingDeepLinkKind = "task"
                pendingDeepLinkResourceId = destination.taskId
                focusedTaskId = destination.taskId
                currentSelectedTab = MawaredNavigation.TAB_TASKS
                loadFocusedTask(destination.taskId)
            }
            is com.example.ui.navigation.TypedDestination.Chat -> {
                currentSelectedTab = MawaredNavigation.TAB_CHAT
                destination.conversationId?.let(::loadFocusedChatConversation)
            }
            is com.example.ui.navigation.TypedDestination.Reports ->
                currentSelectedTab = MawaredNavigation.TAB_REPORTS
            is com.example.ui.navigation.TypedDestination.Purchasing -> {
                focusedPurchaseRequestId = destination.requestId
                currentSelectedTab = MawaredNavigation.TAB_PURCHASING
                destination.requestId?.let(::loadFocusedPurchaseRequest)
            }
            is com.example.ui.navigation.TypedDestination.Vendors -> {
                currentSelectedTab = MawaredNavigation.TAB_PURCHASING
                destination.vendorId?.let(::loadFocusedVendor)
            }
            is com.example.ui.navigation.TypedDestination.Training -> {
                focusedTrainingCourseId = destination.courseId
                currentSelectedTab = MawaredNavigation.TAB_TRAINING
                destination.courseId?.let(::loadFocusedTrainingCourse)
            }
            is com.example.ui.navigation.TypedDestination.Payroll ->
                currentSelectedTab = MawaredNavigation.TAB_PAYROLL
            is com.example.ui.navigation.TypedDestination.Sessions ->
                currentSelectedTab = MawaredNavigation.TAB_SECURITY_SESSIONS
            is com.example.ui.navigation.TypedDestination.Unavailable ->
                showNotification("هذا الرابط غير متاح حالياً.")
            is com.example.ui.navigation.TypedDestination.Stale ->
                showNotification("هذا الرابط لم يعد صالحاً.")
        }
    }

    fun clearTypedResourceFocus() {
        focusedEmployeeId = null
        focusedLeaveId = null
        focusedTaskId = null
        focusedPurchaseRequestId = null
        focusedVendor = null
        focusedTrainingCourseId = null
        pendingDeepLinkKind = null
        pendingDeepLinkResourceId = null
    }

    private fun loadFocusedEmployee(employeeId: String) {
        viewModelScope.launch {
            employeeRepository.refreshEmployees()
            if (employeeRepository.getEmployee(employeeId) is com.example.core.utils.AppResult.Error) {
                focusedEmployeeId = null
                showNotification("هذا السجل غير متاح حالياً.")
            }
        }
    }

    private fun loadFocusedTask(taskId: String) {
        viewModelScope.launch {
            if (taskRepository.loadTask(taskId) is com.example.core.utils.AppResult.Error) {
                focusedTaskId = null
                showNotification("هذا السجل غير متاح حالياً.")
            }
        }
    }

    private fun loadFocusedPurchaseRequest(requestId: String) {
        viewModelScope.launch {
            if (purchaseRepository.loadPurchaseRequest(requestId) is com.example.core.utils.AppResult.Error) {
                focusedPurchaseRequestId = null
                showNotification("هذا السجل غير متاح حالياً.")
            }
        }
    }

    private fun loadFocusedVendor(vendorId: String) {
        viewModelScope.launch {
            when (val result = supplierRepository.loadSupplierLifecycle(vendorId)) {
                is com.example.core.utils.AppResult.Success -> focusedVendor = result.data
                is com.example.core.utils.AppResult.Error -> {
                    focusedVendor = null
                    showNotification("هذا السجل غير متاح حالياً.")
                }
                com.example.core.utils.AppResult.Loading -> Unit
            }
        }
    }

    private fun loadFocusedTrainingCourse(courseId: String) {
        selectTrainingMode("courses")
        viewModelScope.launch {
            if (trainingRepository.loadCourse(courseId) is com.example.core.utils.AppResult.Error) {
                focusedTrainingCourseId = null
                showNotification("هذا السجل غير متاح حالياً.")
            }
        }
    }

    private fun loadFocusedChatConversation(conversationId: String) {
        viewModelScope.launch {
            refreshChatData()
            if (_chatUiState.value.conversations.none { it.id == conversationId }) {
                showNotification("هذا السجل غير متاح حالياً.")
                return@launch
            }
            openChatConversation(conversationId)
        }
    }

    // Filters & Search State (reactive). Read via *UiState; mutate via the functions below.
    private val _employeeSearchQuery = MutableStateFlow("")
    private val _employeeDeptFilter = MutableStateFlow("الكل")
    private val _employeeLoading = MutableStateFlow(false)
    private val _salaryUiState = MutableStateFlow(SalaryUiState())
    val salaryUiState: StateFlow<SalaryUiState> = _salaryUiState.asStateFlow()
    private val _purchasingLoading = MutableStateFlow(false)
    private val _purchasingSubmitting = MutableStateFlow(false)
    private val _purchasingError = MutableStateFlow<String?>(null)
    private val _purchasingMode = MutableStateFlow("own")
    private val _purchasingStatus = MutableStateFlow<String?>(null)
    // Sprint 12I: purchasing admin override (v2) + purchasing exports (v2).
    private val _purchasingOverrideTargetId = MutableStateFlow<String?>(null)
    private val _purchasingOverrideSubmitting = MutableStateFlow(false)
    private val _purchasingExportingFormat = MutableStateFlow<com.example.domain.model.PurchasingExportFormat?>(null)
    private val _purchasingPendingExportShare = MutableStateFlow<com.example.core.export.ReportShareFile?>(null)
    private val initialAttendanceRange = attendanceRangeFor(
        com.example.domain.model.AttendanceRangePreset.TODAY
    )
    private val _attendanceDepartmentFilter = MutableStateFlow<String?>(null)
    private val _attendanceStatusFilter = MutableStateFlow("الكل")
    private val _attendanceRangePreset = MutableStateFlow(initialAttendanceRange.preset)
    private val _attendanceFromDate = MutableStateFlow(initialAttendanceRange.from)
    private val _attendanceToDate = MutableStateFlow(initialAttendanceRange.to)
    private val _attendanceLoading = MutableStateFlow(false)
    private val _attendanceManualSubmitting = MutableStateFlow(false)
    private val _attendanceError = MutableStateFlow<String?>(null)
    private val _leaveMode = MutableStateFlow(com.example.domain.model.LeaveScreenMode.MY_REQUESTS)
    private val _leaveStatusFilter = MutableStateFlow("all")
    private val _leaveTypeFilter = MutableStateFlow("all")
    private val _leaveFromDate = MutableStateFlow("")
    private val _leaveToDate = MutableStateFlow("")
    private val _leaveEmployeeFilter = MutableStateFlow<String?>(null)
    private val _leaveLoading = MutableStateFlow(false)
    private val _leaveError = MutableStateFlow<String?>(null)
    private val _leaveCancelTarget = MutableStateFlow<com.example.domain.model.LeaveRequestParams?>(null)
    private val _payrollRuntime = MutableStateFlow(PayrollRuntimeState())
    private val _reportRuntime = MutableStateFlow(freshReportRuntime())
    private val _reportTemplateRuntime = MutableStateFlow(freshReportTemplateRuntime())

    private fun freshReportRuntime(): ReportRuntimeState {
        val formatter = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }
        val end = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        val start = (end.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, -29) }
        return ReportRuntimeState(
            fromDate = formatter.format(start.time),
            toDate = formatter.format(end.time)
        )
    }

    private fun freshReportTemplateRuntime(): ReportTemplateRuntimeState {
        val base = freshReportRuntime()
        return ReportTemplateRuntimeState(
            fromDate = base.fromDate,
            toDate = base.toDate
        )
    }

    fun updateEmployeeSearchQuery(query: String) {
        focusedEmployeeId = null
        _employeeSearchQuery.value = query
    }

    fun updateEmployeeDepartmentFilter(department: String) {
        focusedEmployeeId = null
        _employeeDeptFilter.value = department
    }

    fun updatePurchasingMode(mode: String) {
        _purchasingMode.value = mode
        refreshPurchasing()
    }

    fun updatePurchasingStatus(status: String?) {
        _purchasingStatus.value = status
        refreshPurchasing()
    }

    fun updateAttendanceDepartmentFilter(departmentId: String?) {
        _attendanceDepartmentFilter.value = departmentId
    }

    fun updateAttendanceStatusFilter(status: String) {
        _attendanceStatusFilter.value = status
    }

    fun updateAttendanceRangePreset(preset: com.example.domain.model.AttendanceRangePreset) {
        if (preset == com.example.domain.model.AttendanceRangePreset.CUSTOM) return
        val range = attendanceRangeFor(preset)
        _attendanceRangePreset.value = range.preset
        _attendanceFromDate.value = range.from
        _attendanceToDate.value = range.to
        refreshAttendance()
    }

    fun updateAttendanceCustomRange(from: String, to: String) {
        if (!isIsoAttendanceDate(from) || !isIsoAttendanceDate(to) || from > to) {
            showNotification("تاريخ البداية يجب ألا يكون بعد تاريخ النهاية.")
            return
        }
        _attendanceRangePreset.value = com.example.domain.model.AttendanceRangePreset.CUSTOM
        _attendanceFromDate.value = from
        _attendanceToDate.value = to
        refreshAttendance()
    }

    fun updateLeaveStatusFilter(status: String) {
        _leaveStatusFilter.value = status
    }

    fun updateLeaveTypeFilter(type: String) {
        _leaveTypeFilter.value = type
    }

    fun updateLeaveEmployeeFilter(employeeId: String?) {
        _leaveEmployeeFilter.value = employeeId
    }

    fun updateLeaveDateRange(from: String, to: String): Boolean {
        if (from.isBlank() && to.isBlank() && _leaveMode.value != com.example.domain.model.LeaveScreenMode.REPORT) {
            _leaveFromDate.value = ""
            _leaveToDate.value = ""
            return true
        }
        val fromMs = com.example.core.utils.DateUtils.epochMillisFromIso(from)
        val toMs = com.example.core.utils.DateUtils.epochMillisFromIso(to)
        val inclusiveDays = if (fromMs != null && toMs != null) ((toMs - fromMs) / 86_400_000L) + 1 else -1
        if (fromMs == null || toMs == null || fromMs > toMs || inclusiveDays > 366) {
            _leaveError.value = if (inclusiveDays > 366) {
                "نطاق التاريخ يجب ألا يتجاوز 366 يوماً."
            } else {
                "تاريخ البداية يجب ألا يكون بعد تاريخ النهاية."
            }
            return false
        }
        _leaveFromDate.value = from
        _leaveToDate.value = to
        _leaveError.value = null
        return true
    }

    fun selectPayrollPeriod(periodId: String) {
        _payrollRuntime.update {
            it.copy(
                selectedPeriodId = periodId,
                details = null,
                report = null,
                blockers = emptyList(),
                protectedEmployeeIssues = 0,
                errorMessage = null,
                payments = emptyList(),
                paymentsLoadedForPeriodId = null,
                voidPaymentTarget = null
            )
        }
        loadPayrollItems(periodId)
        loadPayrollPayments(periodId)
    }

    fun updateSelectedReportType(type: String) {
        selectReportType(type)
    }

    private val _chatUiState = MutableStateFlow(ChatUiState())
    private var chatPollingJob: Job? = null
    private var chatDirectorySearchJob: Job? = null
    private var chatDirectorySearchSeq: Int = 0
    private var chatPollRequestRunning = false
    private var activeChatSessionKey: String? = null
    private var activeTrainingSessionKey: String? = null
    private var activeReportSessionKey: String? = null

    private fun resetCompanyScopedDataIfNeeded(
        session: com.example.domain.model.CurrentSession?
    ) {
        authorizationSessionController.bindSession(session) {
            authorization.reset()
            resetSecurityControllers()
            employeeRepository.clear()
            attendanceRepository.clear()
            leaveRepository.clear()
            payrollRepository.clear()
            purchaseRepository.clear()
            supplierRepository.clear()
            taskRepository.clear()

            _employeeSearchQuery.value = ""
            _employeeDeptFilter.value = "الكل"
            _salaryUiState.value = SalaryUiState()
            _purchasingMode.value = "own"
            _purchasingStatus.value = null
            _purchasingError.value = null
            _purchasingOverrideTargetId.value = null
            _purchasingOverrideSubmitting.value = false
            _purchasingExportingFormat.value = null
            _purchasingPendingExportShare.value = null
            _attendanceDepartmentFilter.value = null
            _attendanceStatusFilter.value = "الكل"
            val attendanceRange = attendanceRangeFor(
                com.example.domain.model.AttendanceRangePreset.TODAY
            )
            _attendanceRangePreset.value = attendanceRange.preset
            _attendanceFromDate.value = attendanceRange.from
            _attendanceToDate.value = attendanceRange.to
            _attendanceError.value = null
            _leaveMode.value = com.example.domain.model.LeaveScreenMode.MY_REQUESTS
            _leaveStatusFilter.value = "all"
            _leaveTypeFilter.value = "all"
            _leaveFromDate.value = ""
            _leaveToDate.value = ""
            _leaveEmployeeFilter.value = null
            _leaveError.value = null
            _payrollRuntime.value = PayrollRuntimeState()
        }
    }

    /**
     * Same-identity soft refresh: reload effective authorization and sync
     * CurrentSession.permissions / authorizationVersion without clearing company data.
     */
    fun refreshAuthorizationForCurrentSession(departmentId: String? = null) {
        authorization.refresh(departmentId)
    }

    private fun syncSessionAuthorizationFromEffective(
        effective: com.example.domain.model.EffectiveAuthorization
    ) {
        val session = authRepository.currentSessionOrNull() ?: return
        authorizationSessionController.ingestEffectiveAuthorization(session, effective) { version, permissions ->
            authRepository.updateAuthorizationSnapshot(version, permissions)
        }
    }

    // ---------------- AUTHENTICATION OPERATIONS ----------------

    // DEMO_MODE-only convenience: pre-fills the email for the selected demo login profile.
    // The selector itself is only shown when BuildConfig.DEMO_MODE == true.
    fun selectDemoUser(index: Int) {
        selectedDemoUserIndex = index
        val profile = DemoLoginProfiles.profiles.getOrNull(index)
        inputCompanyCode = profile?.companyCode ?: ""
        inputIdentifier = profile?.identifier ?: ""
        inputPassword = profile?.password ?: ""
    }

    fun initBiometricLogin() {
        viewModelScope.launch {
            val remembered = authRepository.observeRememberedSession().first()
            if (CompanyLoginRules.matchesRememberedCompany(inputCompanyCode, remembered?.companyCode)) {
                _loginState.value = LoggedInState.BiometricChallenge
            } else {
                showNotification(getApplication<Application>().getString(R.string.biometric_company_mismatch))
            }
        }
    }

    fun approveBiometrics() {
        val result = authRepository.unlockRememberedSession(inputCompanyCode)
        if (result is com.example.core.utils.AppResult.Success) {
            val session = result.data
            if (session.mfaProtected) {
                viewModelScope.launch { authRepository.logout() }
                showNotification(getApplication<Application>().getString(R.string.mfa_biometric_blocked))
                _loginState.value = LoggedInState.PreLogin
                return
            }
            resetCompanyScopedDataIfNeeded(session)
            _loggedInIdentifier.value = session.email
            val demoProfile = if (BuildConfig.DEMO_MODE) {
                DemoLoginProfiles.find(session.companyCode, session.email)
            } else null
            _loginState.value = LoggedInState.Authenticated(
                userName = demoProfile?.fullName ?: session.name,
                userRole = demoProfile?.roleName ?: session.role,
                department = demoProfile?.departmentName ?: ""
            )
            refreshCoreDataAfterLogin()
            currentSelectedTab = landingTabForPermissions(session.permissions)
        } else {
            showNotification(getApplication<Application>().getString(R.string.biometric_unlock_failed))
            _loginState.value = LoggedInState.PreLogin
        }
    }

    fun verifyMfa() {
        if (inputMfaCode.isEmpty()) {
            mfaError = "يجب إدخال رمز التحقق (MFA) للمتابعة."
            return
        }

        if (BuildConfig.DEMO_MODE && inputMfaCode == "1234") {
            val identifier = _loggedInIdentifier.value ?: inputIdentifier
            val demoProfile = DemoLoginProfiles.find(inputCompanyCode, identifier)
            _loginState.value = LoggedInState.Authenticated(
                userName = demoProfile?.fullName ?: identifier,
                userRole = demoProfile?.roleName ?: "",
                department = demoProfile?.departmentName ?: ""
            )
            inputMfaCode = ""
            mfaError = ""
            viewModelScope.launch {
                val session = authRepository.observeCurrentSession().first()
                if (session != null) {
                    refreshCoreDataAfterLogin()
                    currentSelectedTab = landingTabForPermissions(session.permissions)
                }
            }
            return
        }
        if (BuildConfig.DEMO_MODE) {
            mfaError = "رمز التحقق غير صحيح"
            return
        }

        val challenge = pendingMfaChallenge ?: run {
            mfaError = getApplication<Application>().getString(R.string.mfa_challenge_missing)
            return
        }
        viewModelScope.launch {
            _authUiState.update { it.copy(isLoading = true, errorMessage = null) }
            val result = if (challenge.enrollmentRequired) {
                authRepository.confirmMfaEnrollment(challenge.challengeToken, inputMfaCode)
            } else {
                authRepository.verifyMfa(challenge.challengeToken, inputMfaCode)
            }
            when (result) {
                is com.example.core.utils.AppResult.Success -> {
                    inputMfaCode = ""
                    mfaError = ""
                    mfaBackupCodes = result.data.backupCodes
                    if (mfaBackupCodes.isEmpty()) {
                        finishAuthenticatedLogin(result.data.session)
                    } else {
                        _authUiState.update { it.copy(isLoading = false, errorMessage = null) }
                    }
                }
                is com.example.core.utils.AppResult.Error -> {
                    val message = when (result.exception.message) {
                        "auth.mfa_invalid_code" ->
                            getApplication<Application>().getString(R.string.mfa_invalid_code)
                        "auth.mfa_rate_limited" ->
                            getApplication<Application>().getString(R.string.mfa_rate_limited)
                        else -> getApplication<Application>().getString(R.string.mfa_verification_failed)
                    }
                    mfaError = message
                    _authUiState.update { it.copy(isLoading = false, errorMessage = message) }
                }
                com.example.core.utils.AppResult.Loading -> Unit
            }
        }
    }

    fun confirmMfaBackupCodesSaved() {
        val session = authRepository.currentSessionOrNull() ?: return
        mfaBackupCodes = emptyList()
        finishAuthenticatedLogin(session)
    }

    private fun finishAuthenticatedLogin(session: com.example.domain.model.CurrentSession) {
        resetCompanyScopedDataIfNeeded(session)
        inputCompanyCode = session.companyCode
        _loggedInIdentifier.value = session.email
        pendingMfaChallenge = null
        mfaEnrollment = null
        _loginState.value = LoggedInState.Authenticated(
            userName = session.name,
            userRole = session.role,
            department = ""
        )
        refreshCoreDataAfterLogin()
        currentSelectedTab = landingTabForPermissions(session.permissions)
        _authUiState.update { it.copy(isLoading = false, errorMessage = null) }
    }

    fun login(companyCode: String, identifier: String, password: String) {
        val isLoading = _authUiState.value.isLoading
        if (!CompanyLoginRules.canSubmit(companyCode, identifier, password, isLoading)) {
            if (isLoading) return
            _authUiState.update {
                it.copy(
                    errorMessage = getApplication<Application>().getString(R.string.login_fields_required)
                )
            }
            return
        }
        _authUiState.update { it.copy(isLoading = true, errorMessage = null) }
        viewModelScope.launch {
            try {
                val result = authRepository.login(companyCode, identifier, password)
                if (result is com.example.core.utils.AppResult.Success) {
                    _loggedInIdentifier.value = identifier
                    when (val outcome = result.data) {
                        is com.example.domain.model.AuthLoginResult.Authenticated -> {
                            if (BuildConfig.DEMO_MODE) {
                                resetCompanyScopedDataIfNeeded(outcome.session)
                                inputCompanyCode = outcome.session.companyCode
                                _loginState.value = LoggedInState.MfaChallenge
                                inputMfaCode = ""
                                mfaError = ""
                                _authUiState.update {
                                    it.copy(isLoading = false, errorMessage = null)
                                }
                            } else {
                                finishAuthenticatedLogin(outcome.session)
                            }
                        }
                        is com.example.domain.model.AuthLoginResult.MfaChallenge -> {
                            pendingMfaChallenge = outcome
                            inputCompanyCode = outcome.companyCode
                            inputMfaCode = ""
                            mfaError = ""
                            mfaBackupCodes = emptyList()
                            mfaEnrollment = null
                            if (outcome.enrollmentRequired) {
                                when (
                                    val enrollment = authRepository.startMfaEnrollment(
                                        outcome.challengeToken
                                    )
                                ) {
                                    is com.example.core.utils.AppResult.Success ->
                                        mfaEnrollment = enrollment.data
                                    is com.example.core.utils.AppResult.Error -> {
                                        val message = getApplication<Application>()
                                            .getString(R.string.mfa_enrollment_failed)
                                        mfaError = message
                                        _authUiState.update {
                                            it.copy(isLoading = false, errorMessage = message)
                                        }
                                        return@launch
                                    }
                                    com.example.core.utils.AppResult.Loading -> Unit
                                }
                            }
                            _loginState.value = LoggedInState.MfaChallenge
                            _authUiState.update { it.copy(isLoading = false, errorMessage = null) }
                        }
                    }
                } else {
                    val error = result as com.example.core.utils.AppResult.Error
                    val errorMsg = mapLoginError(error.appError, error.exception)
                    mfaError = errorMsg
                    _authUiState.update { it.copy(isLoading = false, errorMessage = errorMsg) }
                }
            } catch (e: Exception) {
                val errorMsg = mapLoginError(null, e)
                mfaError = errorMsg
                _authUiState.update { it.copy(isLoading = false, errorMessage = errorMsg) }
            }
        }
    }

    companion object {
        /**
         * Maps a login failure to a user-facing Arabic message. HTTP 400/401 mean
         * the credentials were rejected (NOT a connectivity problem), so we must not
         * show "فشل الاتصال بالخادم" for those. Real network/DNS/timeout failures and
         * unknown errors keep the connection message.
         */
        fun mapLoginError(appError: com.example.core.utils.AppError?, exception: Exception?): String {
            val isParsingError = exception is com.squareup.moshi.JsonDataException ||
                exception?.message?.contains("Expected") == true
            if (isParsingError) return "خطأ في قراءة استجابة الخادم"

            return when (appError) {
                is com.example.core.utils.AppError.ServerError -> when (appError.code) {
                    400, 401 -> "بيانات الدخول غير صحيحة"
                    429 -> appError.message.ifBlank { "محاولات كثيرة. حاول مرة أخرى لاحقاً." }
                    in 500..599 -> UserSafeErrorMessages.unexpectedServerError(appError.supportRequestId)
                    else -> "فشل الاتصال بالخادم. تأكد من الاتصال والبيانات."
                }
                com.example.core.utils.AppError.Unauthorized -> "بيانات الدخول غير صحيحة"
                else -> "فشل الاتصال بالخادم. تأكد من الاتصال والبيانات."
            }
        }

        // Tab indices used by MawaredAppDashboardContent's `when (tabIndex)`.
        const val TAB_DASHBOARD = 0
        const val TAB_ATTENDANCE = 9

        /**
         * Maps a failed clock-in to an Arabic message. The most common case is the
         * backend 400 "Already clocked in today" — an informational state, not a
         * real failure. Other Arabic server messages are shown as-is; anything else
         * falls back to the generic attendance error.
         */
        fun mapClockInError(error: com.example.core.utils.AppResult.Error): String {
            val serverMessage =
                (error.appError as? com.example.core.utils.AppError.ServerError)?.message
                    ?: error.exception.message
            if (!serverMessage.isNullOrBlank()) {
                if (serverMessage.contains("Already clocked in", ignoreCase = true)) {
                    return "لقد سجّلت حضورك اليوم بالفعل."
                }
                if (serverMessage.contains("not available", ignoreCase = true) ||
                    serverMessage.contains("غير متاح")) {
                    return "تسجيل الحضور غير متاح لحساب المدير العام."
                }
                // Show a backend Arabic message directly.
                if (serverMessage.any { it in '؀'..'ۿ' }) return serverMessage
            }
            return "حدث خطأ أثناء تسجيل الحضور."
        }

        /**
         * Maps a failed leave submission to an Arabic message. Prefers a backend
         * Arabic message (validation / visa-fee / end-before-start). Known English
         * backend responses (sick-leave cap, generic 500) are translated. As a last
         * resort any non-blank server message is shown rather than hidden behind a
         * generic error; only network failures use the generic fallback.
         */
        fun mapLeaveSubmitError(error: com.example.core.utils.AppResult.Error): String {
            val serverMessage =
                (error.appError as? com.example.core.utils.AppError.ServerError)?.message
            val generic = "حدث خطأ أثناء تقديم طلب الإجازة."
            if (serverMessage.isNullOrBlank()) return generic
            // Arabic message from backend — show as-is.
            if (serverMessage.any { it in '؀'..'ۿ' }) return serverMessage
            // Known English backend messages → Arabic.
            if (serverMessage.contains("sick leave days remaining", ignoreCase = true)) {
                return "لقد تجاوزت الحد المسموح للإجازات المرضية هذا العام."
            }
            if (serverMessage.contains("Failed to request leave", ignoreCase = true)) {
                return generic
            }
            return generic
        }

        /**
         * Chooses the landing tab after login. A self-service employee (has
         * dashboard.self and is neither the owner/admin nor HR) lands on the
         * Attendance screen so clock-in/out is the first thing they see.
         * Everyone else keeps the Dashboard.
         */
        fun landingTabForPermissions(permissions: Set<String>): Int {
            val isSelfServiceEmployee =
                permissions.contains(com.example.core.permissions.Permissions.DASHBOARD_SELF) &&
                    !permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL) &&
                    !permissions.contains(com.example.core.permissions.Permissions.HR_VIEW)
            return if (isSelfServiceEmployee) TAB_ATTENDANCE else TAB_DASHBOARD
        }

        fun attendanceScopeFor(
            permissions: Set<String>
        ): com.example.domain.model.AttendanceViewScope = when {
            permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL) ||
                permissions.contains(com.example.core.permissions.Permissions.ATTENDANCE_VIEW) ->
                com.example.domain.model.AttendanceViewScope.COMPANY
            permissions.contains(com.example.core.permissions.Permissions.ATTENDANCE_VIEW_DEPARTMENT) ->
                com.example.domain.model.AttendanceViewScope.DEPARTMENT
            else -> com.example.domain.model.AttendanceViewScope.OWN
        }

        fun attendanceRangeFor(
            preset: com.example.domain.model.AttendanceRangePreset,
            now: Date = Date()
        ): com.example.domain.model.AttendanceDateRange {
            val zone = TimeZone.getTimeZone("UTC")
            val end = Calendar.getInstance(zone, Locale.US).apply {
                time = now
                set(Calendar.HOUR_OF_DAY, 0)
                set(Calendar.MINUTE, 0)
                set(Calendar.SECOND, 0)
                set(Calendar.MILLISECOND, 0)
            }
            val start = end.clone() as Calendar
            when (preset) {
                com.example.domain.model.AttendanceRangePreset.THIS_WEEK -> {
                    val daysSinceSunday = (start.get(Calendar.DAY_OF_WEEK) - Calendar.SUNDAY + 7) % 7
                    start.add(Calendar.DAY_OF_MONTH, -daysSinceSunday)
                }
                com.example.domain.model.AttendanceRangePreset.THIS_MONTH ->
                    start.set(Calendar.DAY_OF_MONTH, 1)
                else -> Unit
            }
            val formatter = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = zone }
            return com.example.domain.model.AttendanceDateRange(
                preset = preset,
                from = formatter.format(start.time),
                to = formatter.format(end.time)
            )
        }

        fun isIsoAttendanceDate(value: String): Boolean {
            if (!Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(value)) return false
            return try {
                SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
                    isLenient = false
                    timeZone = TimeZone.getTimeZone("UTC")
                }.parse(value) != null
            } catch (_: Exception) {
                false
            }
        }

        fun calculateAttendanceSummary(
            records: List<com.example.domain.model.AttendanceRecordParams>
        ): com.example.domain.model.AttendanceSummary {
            var completedMinutes = 0L
            records.forEach { record ->
                val start = attendanceMinutes(record.clockInTime)
                val end = attendanceMinutes(record.clockOutTime)
                if (start != null && end != null && end >= start) {
                    completedMinutes += (end - start)
                }
            }
            return com.example.domain.model.AttendanceSummary(
                present = records.count { it.status == "حاضر" },
                late = records.count { it.status == "متأخر" },
                absent = records.count { it.status == "غائب" },
                missingClockOut = records.count {
                    it.status in setOf("حاضر", "متأخر") &&
                        !it.clockInTime.isNullOrBlank() && it.clockOutTime.isNullOrBlank()
                },
                completedWorkMinutes = completedMinutes
            )
        }

        private fun attendanceMinutes(value: String?): Long? {
            if (value == null || !Regex("^([01]\\d|2[0-3]):[0-5]\\d$").matches(value)) return null
            val parts = value.split(':').map(String::toLong)
            return parts[0] * 60 + parts[1]
        }

        fun mapAttendanceActionError(error: com.example.core.utils.AppResult.Error): String {
            val serverError = error.appError as? com.example.core.utils.AppError.ServerError
            val message = serverError?.message ?: error.exception.message
            if (!message.isNullOrBlank() && message.any { it in '\u0600'..'\u06FF' }) return message
            return when (serverError?.code) {
                403 -> "لا تملك صلاحية تنفيذ هذا الإجراء."
                409 -> "يوجد سجل حضور لهذا الموظف في هذا اليوم مسبقاً."
                400 -> "بيانات سجل الحضور غير صالحة."
                else -> "تعذر تنفيذ عملية الحضور. تحقق من الاتصال وحاول مرة أخرى."
            }
        }
    }

    fun logOut() {
        resetCompanyScopedDataIfNeeded(null)
        resetSecurityControllers()
        notificationInboxController.reset()
        attendanceCorrectionController.reset()
        attendanceExemptionController.reset()
        attendanceWorkflowPanel = AttendanceWorkflowPanel.RECORDS
        showNotificationPreferences = false
        myWorkCategoryFilter = null
        _myWorkUiState.value = MyWorkUiState.Loading
        clearTypedResourceFocus()
        stopChatPolling()
        cancelChatDirectorySearch()
        chatRepository.clear()
        _chatUiState.value = ChatUiState()
        trainingRepository.clear()
        _trainingControls.value = TrainingControls()
        _trainingTimelineState.value = TrainingTimelineUiState()
        _trainingExportState.value = TrainingExportUiState()
        _trainingPendingExportShare.value = null
        activeTrainingSessionKey = null
        pendingMfaChallenge = null
        mfaEnrollment = null
        mfaBackupCodes = emptyList()
        inputMfaCode = ""
        mfaError = ""
        reportRepository.clear()
        reportExportStore.clear()
        _reportRuntime.value = freshReportRuntime()
        _reportTemplateRuntime.value = freshReportTemplateRuntime()
        activeReportSessionKey = null
        viewModelScope.launch {
            authRepository.logout()
            _loggedInIdentifier.value = null
            inputCompanyCode = ""
            inputIdentifier = ""
            inputPassword = ""
            _loginState.value = LoggedInState.PreLogin
            currentSelectedTab = 0
        }
    }

    // ---------------- DATA FLOWS FROM REPOSITORY ----------------

    // 1. Employees flow with real role/department reference data.
    private val employeeReferenceData = combine(
        employeeRepository.observeEmployeeRoles(),
        employeeRepository.observeDepartments(),
        employeeRepository.observeDepartmentManagerCandidates(),
        _employeeLoading
    ) { roles, departments, candidates, isLoading ->
        EmployeeReferenceData(roles, departments, candidates, isLoading)
    }

    val employeesUiState: StateFlow<EmployeesUiState> = combine(
        employeeRepository.observeEmployees(),
        _employeeSearchQuery,
        _employeeDeptFilter,
        authUiState,
        employeeReferenceData
    ) { list, searchQuery, deptFilter, authState, references ->
        val filteredRecords = filterEmployeeRecords(list, searchQuery, deptFilter)
        val mappedList = filteredRecords.map { params ->
            Employee(
                id = params.id,
                name = params.fullName,
                email = params.email.orEmpty(),
                phone = params.phone.orEmpty(),
                role = params.jobTitle ?: params.roleName ?: "موظف",
                department = params.departmentName ?: "بدون قسم",
                basicSalary = params.basicSalary,
                allowances = params.allowances,
                deductions = params.deductions,
                joinedDate = params.joiningDate.orEmpty(),
                status = params.status
            )
        }

        val permissions = authState.currentSession?.permissions ?: emptySet()
        val checker = com.example.core.permissions.PermissionChecker(permissions)
        EmployeesUiState(
            isLoading = references.isLoading,
            employees = mappedList,
            employeeRecords = filteredRecords,
            roles = references.roles,
            departments = references.departments,
            managerCandidates = if (canManageDepartmentManagers(permissions)) references.managerCandidates else emptyList(),
            searchQuery = searchQuery,
            departmentFilter = deptFilter,
            canView = checker.hasPermission(checker.HR_EMPLOYEE_VIEW),
            canCreate = checker.hasPermission(checker.HR_EMPLOYEE_CREATE),
            canUpdate = canEditEmployees(permissions),
            canChangeRoles = canChangeEmployeeRoles(permissions),
            canDelete = checker.hasPermission(checker.HR_EMPLOYEE_DELETE),
            canManageDepartments = canManageDepartments(permissions),
            canManageDepartmentManagers = canManageDepartmentManagers(permissions),
            canViewSalaryCompany = permissions.contains(com.example.core.permissions.Permissions.SALARY_VIEW_COMPANY) ||
                permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL),
            canManageSalary = permissions.contains(com.example.core.permissions.Permissions.SALARY_MANAGE) ||
                permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL),
            canViewOwnerSalary = permissions.contains(com.example.core.permissions.Permissions.SALARY_VIEW_OWNER),
            isEmpty = mappedList.isEmpty()
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), EmployeesUiState())

    // LEGACY_UI_COMPATIBILITY_ONLY: filteredEmployees is now used ONLY by the still-legacy Training
    // screen and the AI context. Dashboard/Employees/Reports no longer use it. Remove when Training
    // and AI are migrated.
    val filteredEmployees: StateFlow<List<Employee>> = employeesUiState.map { it.employees }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val purchasingData = combine(
        purchaseRepository.observePurchaseRequests(),
        purchaseRepository.observePurchaseOrders(),
        supplierRepository.observeSuppliers(),
        purchaseRepository.observePurchasingReport()
    ) { requests, orders, suppliers, report -> PurchasingData(requests, orders, suppliers, report) }

    private val purchasingRuntime = combine(
        _purchasingLoading, _purchasingSubmitting, _purchasingError, _purchasingMode, _purchasingStatus
    ) { loading, submitting, error, mode, status -> PurchasingRuntime(loading, submitting, error, mode, status) }

    private val purchasingOverrideExportRuntime = combine(
        _purchasingOverrideTargetId, _purchasingOverrideSubmitting, _purchasingExportingFormat, _purchasingPendingExportShare
    ) { targetId, submitting, format, share -> PurchasingOverrideExportRuntime(targetId, submitting, format, share) }

    val purchasingUiState: StateFlow<PurchasingUiState> = combine(
        purchasingData, authUiState, purchasingRuntime, purchasingOverrideExportRuntime
    ) { data, authState, runtime, extraRuntime ->
        val permissions = authState.currentSession?.permissions ?: emptySet()
        val checker = com.example.core.permissions.PermissionChecker(authState.currentSession?.permissions ?: emptySet())
        val modes = buildList {
            if (authState.currentSession?.employeeId != null && checker.hasPermission(com.example.core.permissions.Permissions.PURCHASING_VIEW_OWN)) add("own")
            if (permissions.contains(com.example.core.permissions.Permissions.PURCHASING_VIEW_DEPARTMENT)) add("department")
            if (permissions.contains(com.example.core.permissions.Permissions.PURCHASING_VIEW) ||
                permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL)) add("company")
        }
        val selectedMode = runtime.mode.takeIf { it in modes } ?: modes.firstOrNull() ?: "own"
        PurchasingUiState(
            isLoading = runtime.loading,
            isSubmitting = runtime.submitting,
            requests = data.requests,
            orders = data.orders,
            suppliers = data.suppliers,
            report = data.report,
            selectedMode = selectedMode,
            availableModes = modes,
            statusFilter = runtime.status,
            errorMessage = runtime.error,
            canView = modes.isNotEmpty() || checker.hasPermission(checker.PURCHASING_REPORT) ||
                checker.hasPermission(checker.PURCHASING_SUPPLIER_VIEW),
            canCreate = checker.hasPermission(checker.PURCHASING_REQUEST_CREATE),
            canReviewDepartment = checker.hasPermission(checker.PURCHASING_DEPARTMENT_REVIEW),
            canApprove = checker.hasPermission(checker.PURCHASING_REQUEST_APPROVE),
            canManageOrders = checker.hasPermission(checker.PURCHASING_ORDER_MANAGE),
            canReceive = checker.hasPermission(checker.PURCHASING_ORDER_RECEIVE),
            canReport = checker.hasPermission(checker.PURCHASING_REPORT),
            canViewSuppliers = checker.hasPermission(checker.PURCHASING_SUPPLIER_VIEW),
            canManageSuppliers = checker.hasPermission(checker.PURCHASING_SUPPLIER_MANAGE),
            canArchiveVendors = checker.hasPermission(com.example.core.permissions.Permissions.VENDORS_ARCHIVE),
            currentEmployeeId = authState.currentSession?.employeeId,
            canAdminOverride = checker.hasPermission(com.example.core.permissions.Permissions.PURCHASING_ADMIN_OVERRIDE),
            canManageQuotations = checker.hasPermission(checker.PURCHASING_QUOTATION_MANAGE),
            canCompareQuotations = checker.hasPermission(checker.PURCHASING_QUOTATION_COMPARE),
            canCreateReturns = checker.hasPermission(checker.PURCHASING_RETURN_CREATE),
            canApproveReturns = checker.hasPermission(checker.PURCHASING_RETURN_APPROVE),
            overrideTarget = data.requests.find { it.id == extraRuntime.overrideTargetId },
            overrideSubmitting = extraRuntime.overrideSubmitting,
            canExportPurchasing = checker.hasAllPermissions(
                listOf(
                    com.example.core.permissions.Permissions.PURCHASING_REPORT,
                    com.example.core.permissions.Permissions.REPORTS_EXPORT
                )
            ),
            exportingFormat = extraRuntime.exportingFormat,
            pendingExportShare = extraRuntime.pendingExportShare,
            isEmpty = data.requests.isEmpty() && data.orders.isEmpty()
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), PurchasingUiState())

    // LEGACY_UI_COMPATIBILITY_ONLY_FOR_AI_CONTEXT: filteredPurchaseOrders is now used ONLY by the
    // AI context (Dashboard/Procurement/Reports no longer use it). Remove when AI is migrated.
    val filteredPurchaseOrders: StateFlow<List<PurchaseOrder>> =
        purchasingUiState.map { state -> state.requests.map { request ->
            PurchaseOrder(
                id = request.id,
                title = request.title,
                requester = request.requesterNameSnapshot,
                department = request.departmentNameSnapshot.orEmpty(),
                amount = request.totalEstimated,
                date = request.neededByDate ?: request.createdAt.orEmpty(),
                status = request.status,
                category = request.lines.firstOrNull()?.category.orEmpty()
            )
        } }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    // 3. Tasks UI State (repository-based: TaskRepository → Mock/Api by DEMO_MODE).
    // The screens still render the legacy Task shape, so domain tasks are mapped
    // via toLegacyTask(); the raw domain list is kept for status-aware actions.
    private val _taskLoading = MutableStateFlow(false)
    private val _taskSubmitting = MutableStateFlow(false)
    private val _taskError = MutableStateFlow<String?>(null)
    private val _taskMode = MutableStateFlow("own")
    private val _taskStatusFilter = MutableStateFlow<String?>(null)
    private val taskControls = combine(
        _taskLoading,
        _taskSubmitting,
        _taskError,
        _taskMode,
        _taskStatusFilter
    ) { loading, submitting, error, mode, status ->
        TaskControls(loading, submitting, error, mode, status)
    }

    val tasksUiState: StateFlow<TasksUiState> = combine(
        taskRepository.observeTasks(),
        taskRepository.observeEligibleEmployees(),
        authUiState,
        taskControls
    ) { domainTasks, eligibleEmployees, authState, controls ->
        val session = authState.currentSession
        val permissions = session?.permissions ?: emptySet()
        val checker = com.example.core.permissions.PermissionChecker(permissions)
        val admin = permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL)
        val hasOwn = permissions.contains(com.example.core.permissions.Permissions.TASKS_VIEW_OWN)
        val hasDepartment = permissions.contains(com.example.core.permissions.Permissions.TASKS_VIEW_DEPARTMENT)
        val hasCompany = permissions.contains(com.example.core.permissions.Permissions.TASKS_VIEW_COMPANY)
        val modes = buildList {
            if (session?.employeeId != null && (admin || hasOwn || hasDepartment || hasCompany)) add("own")
            if (hasDepartment) add("department")
            if (admin || hasCompany) add("company")
        }
        val selectedMode = controls.selectedMode.takeIf { it in modes } ?: modes.firstOrNull() ?: "own"
        TasksUiState(
            isLoading = controls.isLoading,
            isSubmitting = controls.isSubmitting,
            tasks = domainTasks,
            eligibleEmployees = eligibleEmployees,
            selectedMode = selectedMode,
            availableModes = modes,
            statusFilter = controls.statusFilter,
            currentEmployeeId = session?.employeeId,
            errorMessage = controls.errorMessage,
            canView = modes.isNotEmpty(),
            canCreate = checker.hasPermission(com.example.core.permissions.Permissions.TASKS_CREATE),
            canProgress = session?.employeeId != null,
            canReview = checker.hasPermission(com.example.core.permissions.Permissions.TASKS_REVIEW),
            canCancel = checker.hasPermission(com.example.core.permissions.Permissions.TASKS_CREATE) ||
                checker.hasPermission(com.example.core.permissions.Permissions.TASKS_REVIEW),
            canEdit = checker.hasPermission(com.example.core.permissions.Permissions.TASKS_EDIT),
            canComment = checker.hasPermission(com.example.core.permissions.Permissions.TASKS_COMMENT_CREATE),
            isEmpty = domainTasks.isEmpty()
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), TasksUiState())

    val chatUiState: StateFlow<ChatUiState> = _chatUiState.asStateFlow()

    // 5. Training UI State. API mode renders scoped domain models directly;
    // demo mode follows the same repository contract with deterministic data.
    private val _trainingControls = MutableStateFlow(TrainingControls())
    private val _trainingTimelineState = MutableStateFlow(TrainingTimelineUiState())
    private val _trainingExportState = MutableStateFlow(TrainingExportUiState())
    private val _trainingPendingExportShare =
        MutableStateFlow<com.example.core.export.ReportShareFile?>(null)
    val trainingTimelineState: StateFlow<TrainingTimelineUiState> = _trainingTimelineState.asStateFlow()
    val trainingExportState: StateFlow<TrainingExportUiState> = _trainingExportState.asStateFlow()
    val trainingPendingExportShare: StateFlow<com.example.core.export.ReportShareFile?> =
        _trainingPendingExportShare.asStateFlow()
    private val trainingData = combine(
        trainingRepository.observeCourses(),
        trainingRepository.observeAssignments(),
        trainingRepository.observeEligibleEmployees(),
        trainingRepository.observeReport()
    ) { courses, assignments, eligibleEmployees, report ->
        TrainingData(courses, assignments, eligibleEmployees, report)
    }

    val trainingUiState: StateFlow<TrainingUiState> = combine(
        trainingData,
        authUiState,
        _trainingControls
    ) { data, authState, controls ->
        val session = authState.currentSession
        val permissions = session?.permissions ?: emptySet()
        val checker = com.example.core.permissions.PermissionChecker(permissions)
        val admin = permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL)
        val canViewOwn = session?.employeeId != null &&
            (admin || permissions.contains(com.example.core.permissions.Permissions.TRAINING_VIEW_OWN))
        val canViewDepartment = permissions.contains(com.example.core.permissions.Permissions.TRAINING_VIEW_DEPARTMENT)
        val canViewCompany = admin || permissions.contains(com.example.core.permissions.Permissions.TRAINING_VIEW_COMPANY)
        val canManage = checker.hasPermission(com.example.core.permissions.Permissions.TRAINING_MANAGE)
        val canAssign = checker.hasPermission(com.example.core.permissions.Permissions.TRAINING_ASSIGN)
        val canReview = checker.hasPermission(com.example.core.permissions.Permissions.TRAINING_REVIEW)
        val canReport = checker.hasPermission(com.example.core.permissions.Permissions.TRAINING_REPORT)
        val modes = trainingModesForPermissions(permissions, session?.employeeId)
        val selectedMode = controls.selectedMode.takeIf { it in modes } ?: modes.firstOrNull() ?: "own"
        val empty = when (selectedMode) {
            "courses" -> data.courses.isEmpty()
            "report" -> data.report == null
            "reviews" -> data.assignments.none { it.status == "submitted" }
            else -> data.assignments.isEmpty()
        }
        TrainingUiState(
            isLoading = controls.isLoading,
            isSubmitting = controls.isSubmitting,
            courses = data.courses,
            assignments = data.assignments,
            selectedCourse = controls.selectedCourse,
            selectedAssignment = controls.selectedAssignment,
            eligibleEmployees = data.eligibleEmployees,
            report = data.report,
            selectedMode = selectedMode,
            availableModes = modes,
            courseStatusFilter = controls.courseStatusFilter,
            assignmentStatusFilter = controls.assignmentStatusFilter,
            categoryFilter = controls.categoryFilter,
            errorMessage = controls.errorMessage,
            currentEmployeeId = session?.employeeId,
            canViewOwn = canViewOwn,
            canViewDepartment = canViewDepartment,
            canViewCompany = canViewCompany,
            canView = modes.isNotEmpty(),
            canManage = canManage,
            canAssign = canAssign,
            canReview = canReview,
            canReport = canReport,
            canIssueCertificate = checker.hasPermission(
                com.example.core.permissions.Permissions.TRAINING_CERTIFICATE_ISSUE
            ),
            canCreateEvaluation = checker.hasPermission(
                com.example.core.permissions.Permissions.TRAINING_EVALUATION_CREATE
            ),
            canViewEvaluation = checker.hasPermission(
                com.example.core.permissions.Permissions.TRAINING_EVALUATION_VIEW
            ),
            isEmpty = empty
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), TrainingUiState())

    private data class AttendanceFilters(
        val departmentId: String?,
        val status: String,
        val rangePreset: com.example.domain.model.AttendanceRangePreset,
        val from: String,
        val to: String
    )

    private data class AttendanceData(
        val allRecords: List<com.example.domain.model.AttendanceRecordParams>,
        val todayRecords: List<com.example.domain.model.AttendanceRecordParams>,
        val eligibleEmployees: List<com.example.domain.model.AttendanceEligibleEmployee>,
        val filters: AttendanceFilters
    )

    private val attendanceFilters = combine(
        _attendanceDepartmentFilter,
        _attendanceStatusFilter,
        _attendanceRangePreset,
        _attendanceFromDate,
        _attendanceToDate
    ) { departmentId, status, preset, from, to ->
        AttendanceFilters(departmentId, status, preset, from, to)
    }

    private val attendanceData = combine(
        attendanceRepository.observeAttendanceRecords(),
        attendanceRepository.observeTodayAttendance(),
        attendanceRepository.observeEligibleEmployees(),
        attendanceFilters
    ) { allRecords, todayRecords, eligibleEmployees, filters ->
        AttendanceData(allRecords, todayRecords, eligibleEmployees, filters)
    }

    // Attendance records are already tenant/privacy scoped by the backend. These filters only
    // narrow that authorized result for display and summary calculations.
    val attendanceUiState: StateFlow<AttendanceUiState> = combine(
        attendanceData,
        authUiState,
        _attendanceLoading,
        _attendanceManualSubmitting,
        _attendanceError
    ) { data, authState, isLoading, isSubmittingManual, error ->
        val departments = data.allRecords.mapNotNull { record ->
            record.departmentName.takeIf { it.isNotBlank() }?.let { name ->
                com.example.domain.model.AttendanceDepartmentOption(
                    id = record.departmentId ?: name,
                    name = name
                )
            }
        }.distinctBy { it.id }.sortedBy { it.name }
        val selectedDepartment = data.filters.departmentId
            ?.takeIf { id -> departments.any { it.id == id } }
        val filtered = data.allRecords.filter { record ->
            val recordDepartmentId = record.departmentId ?: record.departmentName
            (selectedDepartment == null || recordDepartmentId == selectedDepartment) &&
                (data.filters.status == "الكل" || record.status == data.filters.status)
        }
        val todayFiltered = data.todayRecords.filter { record ->
            selectedDepartment == null || (record.departmentId ?: record.departmentName) == selectedDepartment
        }
        val rawPermissions = authState.currentSession?.permissions ?: emptySet()
        val checker = com.example.core.permissions.PermissionChecker(rawPermissions)
        val scope = attendanceScopeFor(rawPermissions)
        val canManage = checker.hasPermission(checker.HR_ATTENDANCE_MANAGE)
        val canClockSelf = rawPermissions.contains(com.example.core.permissions.Permissions.ATTENDANCE_CLOCK) &&
            !rawPermissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL)
        AttendanceUiState(
            isLoading = isLoading,
            isSubmittingManual = isSubmittingManual,
            records = filtered,
            todayRecords = todayFiltered,
            eligibleEmployees = if (canManage) data.eligibleEmployees else emptyList(),
            availableDepartments = departments,
            selectedDepartmentId = selectedDepartment,
            selectedStatusFilter = data.filters.status,
            selectedRangePreset = data.filters.rangePreset,
            fromDate = data.filters.from,
            toDate = data.filters.to,
            summary = calculateAttendanceSummary(filtered),
            errorMessage = error,
            canView = checker.hasPermission(checker.HR_ATTENDANCE_VIEW) || canManage,
            canClock = canClockSelf,
            canManage = canManage,
            canSelectDepartment = scope != com.example.domain.model.AttendanceViewScope.OWN,
            isOwnScope = scope == com.example.domain.model.AttendanceViewScope.OWN,
            isEmpty = filtered.isEmpty()
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), AttendanceUiState())

    // 7. Leaves: own requests, review queue, and company report remain distinct.
    // Direct permission checks are intentional: leaves.view_own opens the screen
    // but must never unlock the review queue or company report.
    private val myLeavesFlow: kotlinx.coroutines.flow.Flow<List<com.example.domain.model.LeaveRequestParams>> =
        authUiState.flatMapLatest { st ->
            val empId = st.currentSession?.employeeId?.toString()
            if (empId.isNullOrBlank()) kotlinx.coroutines.flow.flowOf(emptyList())
            else leaveRepository.observeMyLeaveRequests(empId)
        }

    private fun canonicalLeaveStatus(request: com.example.domain.model.LeaveRequestParams): String =
        when (request.rawStatus) {
            "pending_hr", "pending_admin", "approved", "rejected", "cancelled" -> request.rawStatus
            else -> when (request.status) {
                "موافق عليها" -> "approved"
                "مرفوضة" -> "rejected"
                "ملغاة" -> "cancelled"
                else -> if (request.currentApprovalStep == 2) "pending_admin" else "pending_hr"
            }
        }

    private fun canonicalLeaveType(request: com.example.domain.model.LeaveRequestParams): String =
        when (request.rawLeaveType) {
            "annual", "سنوية" -> "annual"
            "sick", "مرضية" -> "sick"
            "special", "طارئة" -> "special"
            "unpaid", "بدون راتب" -> "unpaid"
            "study", "دراسية" -> "study"
            else -> request.rawLeaveType
        }

    private fun leaveMatchesFilters(
        request: com.example.domain.model.LeaveRequestParams,
        controls: LeaveControlsState,
        includeEmployee: Boolean
    ): Boolean {
        val statusMatches = controls.status == "all" || canonicalLeaveStatus(request) == controls.status
        val typeMatches = controls.type == "all" || canonicalLeaveType(request) == controls.type
        val dateMatches = (controls.from.isBlank() || request.endDate.take(10) >= controls.from) &&
            (controls.to.isBlank() || request.startDate.take(10) <= controls.to)
        val employeeMatches = !includeEmployee || controls.employeeId == null ||
            request.employeeId == controls.employeeId
        return statusMatches && typeMatches && dateMatches && employeeMatches
    }

    private val leavePrimaryControls = combine(
        _leaveMode,
        _leaveStatusFilter,
        _leaveTypeFilter,
        _leaveFromDate,
        _leaveToDate
    ) { mode, status, type, from, to ->
        LeaveControlsState(mode, status, type, from, to, null, false, null, null)
    }

    private val leaveControls = combine(
        leavePrimaryControls,
        _leaveEmployeeFilter,
        _leaveLoading,
        _leaveError,
        _leaveCancelTarget
    ) { primary, employeeId, loading, error, cancelTarget ->
        primary.copy(
            employeeId = employeeId,
            isLoading = loading,
            error = error,
            cancelTarget = cancelTarget
        )
    }

    val leavesUiState: StateFlow<LeavesUiState> = combine(
        leaveRepository.observeLeaveRequests(),
        myLeavesFlow,
        leaveRepository.observeLeaveReport(),
        leaveControls,
        authUiState
    ) { reviewRequests, myRequestsRaw, report, controls, authState ->
        val permissions = authState.currentSession?.permissions ?: emptySet()
        val isAdmin = permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL)
        val canReview = canReviewLeaves(permissions)
        val canReport = canViewLeaveReport(permissions)
        val canCreate = isAdmin || permissions.contains(com.example.core.permissions.Permissions.LEAVES_CREATE)
        val canApprove = isAdmin || permissions.contains(com.example.core.permissions.Permissions.LEAVES_APPROVE)
        val effectiveMode = when {
            controls.mode == com.example.domain.model.LeaveScreenMode.REVIEW && !canReview ->
                com.example.domain.model.LeaveScreenMode.MY_REQUESTS
            controls.mode == com.example.domain.model.LeaveScreenMode.REPORT && !canReport ->
                com.example.domain.model.LeaveScreenMode.MY_REQUESTS
            else -> controls.mode
        }
        val filteredReview = reviewRequests.filter { leaveMatchesFilters(it, controls, false) }
        val filteredMine = myRequestsRaw.filter { leaveMatchesFilters(it, controls, false) }
        // Report rows and summary come from the same server-filtered result set.
        // Draft UI filters take effect together only after the user taps Apply.
        val filteredReport = report.requests
        val activeList = when (effectiveMode) {
            com.example.domain.model.LeaveScreenMode.MY_REQUESTS -> filteredMine
            com.example.domain.model.LeaveScreenMode.REVIEW -> filteredReview
            com.example.domain.model.LeaveScreenMode.REPORT -> filteredReport
        }
        LeavesUiState(
            isLoading = controls.isLoading,
            requests = filteredReview,
            myRequests = filteredMine,
            reportRequests = filteredReport,
            reportSummary = report.summary,
            selectedMode = effectiveMode,
            selectedStatusFilter = controls.status,
            selectedTypeFilter = controls.type,
            fromDate = controls.from,
            toDate = controls.to,
            selectedEmployeeId = controls.employeeId,
            currentEmployeeId = authState.currentSession?.employeeId?.toString(),
            cancelTarget = controls.cancelTarget,
            errorMessage = controls.error,
            canView = authState.currentSession != null,
            canCreate = canCreate,
            canApprove = canApprove,
            canManage = canReview,
            canReview = canReview,
            canReport = canReport,
            isEmpty = activeList.isEmpty()
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), LeavesUiState())

    // 8. Payroll UI state. Raw workflow states and String money come from the backend contract.
    val payrollUiState: StateFlow<PayrollUiState> = combine(
        payrollRepository.observePayrollPeriods(),
        _payrollRuntime,
        authUiState
    ) { periods, runtime, authState ->
        val checker = com.example.core.permissions.PermissionChecker(authState.currentSession?.permissions ?: emptySet())
        val selected = periods.firstOrNull { it.id == runtime.selectedPeriodId }
        val details = runtime.details?.takeIf { it.period.id == runtime.selectedPeriodId }
        PayrollUiState(
            isLoading = runtime.isLoading,
            periods = periods,
            selectedPeriod = selected,
            selectedPeriodItems = details?.items.orEmpty(),
            selectedPeriodId = runtime.selectedPeriodId,
            summary = runtime.summary,
            report = runtime.report,
            blockers = runtime.blockers,
            protectedEmployeeIssues = runtime.protectedEmployeeIssues,
            protectedRowsHidden = details?.protectedRowsHidden
                ?: selected?.protectedRowsHidden
                ?: false,
            protectedRowCount = details?.protectedRowCount
                ?: selected?.protectedRowCount
                ?: 0,
            errorMessage = runtime.errorMessage,
            canView = checker.hasPermission(com.example.core.permissions.Permissions.PAYROLL_VIEW),
            canManage = checker.hasPermission(com.example.core.permissions.Permissions.PAYROLL_MANAGE),
            canApprove = checker.hasPermission(com.example.core.permissions.Permissions.PAYROLL_APPROVE),
            canReport = checker.hasPermission(com.example.core.permissions.Permissions.PAYROLL_REPORT),
            canPay = checker.hasPermission(com.example.core.permissions.Permissions.PAYROLL_PAY),
            showCreateDialog = runtime.showCreateDialog,
            calculationTarget = periods.firstOrNull { it.id == runtime.calculationTargetId },
            approvalTarget = periods.firstOrNull { it.id == runtime.approvalTargetId },
            paidTarget = periods.firstOrNull { it.id == runtime.paidTargetId },
            recalculationReason = runtime.recalculationReason,
            canViewPayments = checker.hasPermission(com.example.core.permissions.Permissions.PAYROLL_PAYMENTS_VIEW),
            canRecordPayment = checker.hasPermission(com.example.core.permissions.Permissions.PAYROLL_PAYMENTS_RECORD),
            canVoidPayment = checker.hasPermission(com.example.core.permissions.Permissions.PAYROLL_PAYMENTS_VOID),
            canExportPayroll = checker.hasAllPermissions(
                listOf(
                    com.example.core.permissions.Permissions.PAYROLL_REPORT,
                    com.example.core.permissions.Permissions.REPORTS_EXPORT
                )
            ),
            payments = runtime.payments.takeIf { runtime.paymentsLoadedForPeriodId == runtime.selectedPeriodId }.orEmpty(),
            paymentsLoading = runtime.paymentsLoading,
            showRecordPaymentDialog = runtime.showRecordPaymentDialog,
            voidPaymentTarget = runtime.voidPaymentTarget,
            exportingFormat = runtime.exportingFormat,
            pendingPaymentExportShare = runtime.pendingPaymentExportShare,
            isEmpty = periods.isEmpty()
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), PayrollUiState())

    // 9. The Reports screen is API-driven. The legacy aggregate below remains only as
    // dashboard input until the dashboard receives its own server contract.
    private val payrollReportsInput = combine(
        payrollRepository.observePayrollPeriods(),
        _payrollRuntime
    ) { periods, runtime -> periods to runtime }

    private val purchasingReportsInput = combine(
        purchaseRepository.observePurchaseRequests(),
        purchaseRepository.observePurchasingReport()
    ) { requests, report -> requests to report }

    val reportsUiState: StateFlow<ReportsUiState> = combine(
        employeeRepository.observeEmployees(),
        purchasingReportsInput,
        attendanceRepository.observeTodayAttendance(),
        leaveRepository.observeLeaveRequests(),
        payrollReportsInput
    ) { emps, purchasing, todayAtt, leaves, payroll ->
        buildReportsData(
            emps,
            purchasing.first,
            purchasing.second,
            todayAtt,
            leaves,
            payroll.second.report,
            payroll.second.summary,
            payroll.first
        )
    }.combine(authUiState) { data, auth ->
        Pair(data, auth)
    }.combine(_reportRuntime) { pair, runtime ->
        Triple(pair.first, pair.second, runtime)
    }.map { triple ->
        val data = triple.first
        val auth = triple.second
        val runtime = triple.third
        val permissions = auth.currentSession?.permissions ?: emptySet()
        val checker = com.example.core.permissions.PermissionChecker(auth.currentSession?.permissions ?: emptySet())
        val canViewPayrollReport = checker.hasPermission(com.example.core.permissions.Permissions.PAYROLL_REPORT)
        val reportEntryPermissions = setOf(
            com.example.core.permissions.Permissions.REPORTS_VIEW,
            com.example.core.permissions.Permissions.REPORTS_FINANCE,
            com.example.core.permissions.Permissions.ATTENDANCE_VIEW,
            com.example.core.permissions.Permissions.ATTENDANCE_VIEW_DEPARTMENT,
            com.example.core.permissions.Permissions.LEAVES_VIEW,
            com.example.core.permissions.Permissions.TASKS_VIEW_DEPARTMENT,
            com.example.core.permissions.Permissions.TASKS_VIEW_COMPANY,
            com.example.core.permissions.Permissions.PAYROLL_REPORT,
            com.example.core.permissions.Permissions.PURCHASING_REPORT,
            com.example.core.permissions.Permissions.TRAINING_REPORT
        )
        val canOpenReports = permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL) ||
            permissions.any(reportEntryPermissions::contains)
        ReportsUiState(
            isLoading = runtime.isLoading,
            summary = data.summary,
            financial = data.financial,
            departmentReports = data.departments,
            selectedReportType = runtime.selectedType,
            errorMessage = runtime.errorMessage,
            canViewReports = canOpenReports,
            canViewFinancialReports = runtime.catalog.any { it.containsFinancialData } ||
                checker.hasPermission(checker.REPORTS_FINANCIAL_VIEW) || canViewPayrollReport,
            canViewPayrollReport = canViewPayrollReport,
            payrollReport = data.payrollReport,
            payrollPeriods = data.payrollPeriods,
            catalog = runtime.catalog,
            overview = runtime.overview,
            detail = runtime.detail,
            fromDate = runtime.fromDate,
            toDate = runtime.toDate,
            selectedDepartmentId = runtime.selectedDepartmentId,
            selectedStatus = runtime.selectedStatus,
            isExporting = runtime.isExporting,
            pendingShare = runtime.pendingShare,
            isEmpty = runtime.catalog.isEmpty()
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), ReportsUiState())

    val reportTemplatesUiState: StateFlow<ReportTemplatesUiState> = combine(
        _reportTemplateRuntime,
        authUiState
    ) { runtime, auth ->
        val permissions = auth.currentSession?.permissions ?: emptySet()
        val checker = com.example.core.permissions.PermissionChecker(permissions)
        val canManage = checker.hasPermission(com.example.core.permissions.Permissions.REPORTS_TEMPLATES_MANAGE)
        val canExport = checker.hasPermission(com.example.core.permissions.Permissions.REPORTS_EXPORT)
        val selected = runtime.catalog.firstOrNull { it.builtInKey == runtime.selectedKey }
        ReportTemplatesUiState(
            isLoading = runtime.isLoading,
            catalog = runtime.catalog,
            selectedTemplate = selected,
            fromDate = runtime.fromDate,
            toDate = runtime.toDate,
            departmentId = runtime.departmentId,
            extraFilter = runtime.extraFilter,
            preview = runtime.preview,
            savedTemplates = runtime.savedTemplates,
            savedLoading = runtime.savedLoading,
            showSavedTemplates = runtime.showSavedTemplates,
            showSaveDialog = runtime.showSaveDialog,
            saveName = runtime.saveName,
            exportingFormat = runtime.exportingFormat,
            pendingShare = runtime.pendingShare,
            errorMessage = runtime.errorMessage,
            canManageSavedTemplates = canManage,
            canExportTemplates = canExport
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), ReportTemplatesUiState())

    // Pure mapper: consolidate migrated-module data into report params (no UI, no side effects).
    private data class ReportsData(
        val summary: com.example.domain.model.ReportsSummaryParams,
        val financial: com.example.domain.model.FinancialReportParams,
        val departments: List<com.example.domain.model.DepartmentReportParams>,
        val payrollReport: com.example.domain.model.PayrollReportParams?,
        val payrollPeriods: List<com.example.domain.model.PayrollPeriodParams>
    )

    private fun sumPayrollMoney(values: List<String>): String? {
        if (values.isEmpty()) return null
        return values.mapNotNull { it.toBigDecimalOrNull() }
            .takeIf { it.size == values.size }
            ?.fold(java.math.BigDecimal.ZERO, java.math.BigDecimal::add)
            ?.setScale(2, java.math.RoundingMode.UNNECESSARY)
            ?.toPlainString()
    }

    private fun buildReportsData(
        emps: List<com.example.domain.model.EmployeeParams>,
        pos: List<com.example.domain.model.PurchaseRequestParams>,
        purchasingReport: com.example.domain.model.PurchasingReportParams?,
        todayAtt: List<com.example.domain.model.AttendanceRecordParams>,
        leaves: List<com.example.domain.model.LeaveRequestParams>,
        payrollReport: com.example.domain.model.PayrollReportParams?,
        payrollSummary: com.example.domain.model.PayrollSummary?,
        payrollPeriods: List<com.example.domain.model.PayrollPeriodParams>
    ): ReportsData {
        val present = setOf("حاضر", "متأخر", "انصراف مبكر")
        val summary = com.example.domain.model.ReportsSummaryParams(
            totalEmployees = emps.size,
            activeEmployees = emps.count { it.status.equals("ACTIVE", true) || it.status == "نشط" },
            pendingLeaves = leaves.count { it.status == "قيد المراجعة" },
            approvedLeaves = leaves.count { it.status == "موافق عليها" },
            attendanceTodayCount = todayAtt.count { it.status in present },
            absentTodayCount = todayAtt.count { it.status == "غائب" },
            totalPurchaseOrders = pos.size,
            pendingPurchaseOrders = pos.count { it.status == "pending_department" || it.status == "pending_purchasing" },
            approvedPurchaseOrders = pos.count { it.status == "approved" || it.status == "ordered" || it.status == "received" },
            payrollPeriodsCount = payrollSummary?.totalPeriods ?: 0,
            latestPayrollNetTotal = payrollReport?.visibleSummary?.net,
            totalPayrollNetAmount = payrollSummary?.totalNetPayroll
        )
        val approvedPurchasing = purchasingReport?.summary?.orderedTotal ?: "0.00"
        val totalPayroll = payrollReport?.visibleSummary?.net
        val estimatedNetCost = totalPayroll?.toBigDecimalOrNull()
            ?.add(approvedPurchasing.toBigDecimalOrNull() ?: java.math.BigDecimal.ZERO)
            ?.setScale(2, java.math.RoundingMode.HALF_UP)
            ?.toPlainString()
        val financial = com.example.domain.model.FinancialReportParams(
            totalPayroll = totalPayroll,
            totalAllowances = null,
            totalDeductions = payrollReport?.visibleSummary?.deductions,
            totalPurchasing = approvedPurchasing,
            estimatedNetCost = estimatedNetCost,
            latestPayrollPeriod = payrollReport?.period?.let { "${it.month}/${it.year}" }
        )
        val reportRows = payrollReport?.rows.orEmpty()
        val deptNames = (todayAtt.map { it.departmentName } + reportRows.mapNotNull { it.departmentName } +
            leaves.map { it.departmentName }).filter { it.isNotBlank() }.distinct()
        val departments = deptNames.map { dept ->
            val departmentPayroll = sumPayrollMoney(
                reportRows.filter { it.departmentName == dept }.map { it.netPay }
            )
            com.example.domain.model.DepartmentReportParams(
                departmentName = dept,
                employeeCount = (todayAtt.filter { it.departmentName == dept }.map { it.employeeId } +
                    reportRows.filter { it.departmentName == dept }.map { it.employeeId }).distinct().size,
                attendanceCount = todayAtt.count { it.departmentName == dept && it.status in present },
                leaveCount = leaves.count { it.departmentName == dept },
                payrollTotal = departmentPayroll
            )
        }.sortedByDescending { it.payrollTotal?.toBigDecimalOrNull() ?: java.math.BigDecimal.ZERO }
        return ReportsData(summary, financial, departments, payrollReport, payrollPeriods)
    }

    fun refreshReports() {
        viewModelScope.launch {
            _reportRuntime.update { it.copy(isLoading = true, errorMessage = null) }
            when (val result = reportRepository.loadCatalog()) {
                is com.example.core.utils.AppResult.Success -> {
                    val current = _reportRuntime.value
                    val selected = current.selectedType.takeIf { type ->
                        result.data.any { it.type == type }
                    } ?: result.data.firstOrNull { it.type == "overview" }?.type
                        ?: result.data.firstOrNull()?.type.orEmpty()
                    _reportRuntime.update {
                        it.copy(
                            catalog = result.data,
                            selectedType = selected,
                            selectedDepartmentId = null,
                            selectedStatus = null,
                            overview = null,
                            detail = null,
                            errorMessage = null
                        )
                    }
                    if (selected.isBlank()) {
                        _reportRuntime.update { it.copy(isLoading = false) }
                    } else {
                        loadSelectedReport()
                    }
                }
                is com.example.core.utils.AppResult.Error -> _reportRuntime.update {
                    it.copy(
                        isLoading = false,
                        catalog = emptyList(),
                        selectedType = "",
                        overview = null,
                        detail = null,
                        errorMessage = errorText(result, "تعذر تحميل مركز التقارير")
                    )
                }
                else -> Unit
            }
        }
    }

    fun selectReportType(type: String) {
        if (_reportRuntime.value.catalog.none { it.type == type }) return
        _reportRuntime.update {
            it.copy(
                selectedType = type,
                selectedDepartmentId = null,
                selectedStatus = null,
                overview = null,
                detail = null,
                errorMessage = null
            )
        }
        refreshReportPreview()
    }

    fun updateReportDateRange(from: String, to: String): Boolean {
        val selected = _reportRuntime.value.catalog.firstOrNull {
            it.type == _reportRuntime.value.selectedType
        }
        val maximumDays = selected?.maximumRangeDays ?: 366
        val formatter = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
            isLenient = false
            timeZone = TimeZone.getTimeZone("UTC")
        }
        val fromDate = runCatching { formatter.parse(from) }.getOrNull()
        val toDate = runCatching { formatter.parse(to) }.getOrNull()
        val days = if (fromDate != null && toDate != null) {
            ((toDate.time - fromDate.time) / 86_400_000L) + 1
        } else -1
        if (fromDate == null || toDate == null || days !in 1..maximumDays.toLong()) {
            showNotification("اختر نطاق تاريخ صالحاً لا يتجاوز $maximumDays يوماً.")
            return false
        }
        _reportRuntime.update { it.copy(fromDate = from, toDate = to, errorMessage = null) }
        refreshReportPreview()
        return true
    }

    fun updateReportDepartment(departmentId: String?) {
        _reportRuntime.update {
            it.copy(selectedDepartmentId = departmentId, overview = null, detail = null, errorMessage = null)
        }
        refreshReportPreview()
    }

    fun updateReportStatus(status: String?) {
        _reportRuntime.update {
            it.copy(selectedStatus = status, overview = null, detail = null, errorMessage = null)
        }
        refreshReportPreview()
    }

    fun refreshReportPreview() {
        if (_reportRuntime.value.selectedType.isBlank()) return
        viewModelScope.launch { loadSelectedReport() }
    }

    fun exportSelectedReport() {
        val runtime = _reportRuntime.value
        val catalogItem = runtime.catalog.firstOrNull { it.type == runtime.selectedType }
        if (catalogItem == null || !catalogItem.exportAvailable || runtime.selectedType == "overview") {
            showNotification("تصدير هذا التقرير غير متاح لحسابك.")
            return
        }
        if (runtime.isExporting) return
        viewModelScope.launch {
            _reportRuntime.update { it.copy(isExporting = true, errorMessage = null) }
            when (val result = reportRepository.exportCsv(runtime.selectedType, reportFilters(runtime))) {
                is com.example.core.utils.AppResult.Success -> {
                    try {
                        val share = withContext(Dispatchers.IO) {
                            reportExportStore.save(result.data)
                        }
                        _reportRuntime.update {
                            it.copy(isExporting = false, pendingShare = share, errorMessage = null)
                        }
                    } catch (_: Exception) {
                        _reportRuntime.update {
                            it.copy(
                                isExporting = false,
                                errorMessage = "تعذر حفظ ملف التقرير للمشاركة"
                            )
                        }
                    }
                }
                is com.example.core.utils.AppResult.Error -> _reportRuntime.update {
                    it.copy(
                        isExporting = false,
                        errorMessage = errorText(result, "تعذر تصدير التقرير")
                    )
                }
                else -> Unit
            }
        }
    }

    fun consumeReportShare() {
        _reportRuntime.update { it.copy(pendingShare = null) }
    }

    fun refreshReportTemplates() {
        viewModelScope.launch {
            _reportTemplateRuntime.update { it.copy(isLoading = true, errorMessage = null) }
            when (val result = reportRepository.loadTemplateCatalog()) {
                is com.example.core.utils.AppResult.Success -> {
                    val current = _reportTemplateRuntime.value
                    val selected = current.selectedKey.takeIf { key ->
                        result.data.any { it.builtInKey == key }
                    } ?: result.data.firstOrNull()?.builtInKey.orEmpty()
                    _reportTemplateRuntime.update {
                        it.copy(
                            isLoading = false,
                            catalog = result.data,
                            selectedKey = selected,
                            preview = null,
                            errorMessage = null
                        )
                    }
                }
                is com.example.core.utils.AppResult.Error -> _reportTemplateRuntime.update {
                    it.copy(
                        isLoading = false,
                        catalog = emptyList(),
                        selectedKey = "",
                        preview = null,
                        errorMessage = errorText(result, "تعذر تحميل قوالب التقارير")
                    )
                }
                else -> Unit
            }
        }
    }

    fun selectReportTemplate(builtInKey: String) {
        if (_reportTemplateRuntime.value.catalog.none { it.builtInKey == builtInKey }) return
        _reportTemplateRuntime.update {
            it.copy(
                selectedKey = builtInKey,
                departmentId = null,
                extraFilter = null,
                preview = null,
                errorMessage = null
            )
        }
    }

    fun updateReportTemplateDateRange(from: String, to: String): Boolean {
        val selected = _reportTemplateRuntime.value.catalog.firstOrNull {
            it.builtInKey == _reportTemplateRuntime.value.selectedKey
        }
        val maximumDays = selected?.maximumRangeDays ?: 366
        val formatter = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
            isLenient = false
            timeZone = TimeZone.getTimeZone("UTC")
        }
        val fromDate = runCatching { formatter.parse(from) }.getOrNull()
        val toDate = runCatching { formatter.parse(to) }.getOrNull()
        val days = if (fromDate != null && toDate != null) {
            ((toDate.time - fromDate.time) / 86_400_000L) + 1
        } else -1
        if (fromDate == null || toDate == null || days !in 1..maximumDays.toLong()) {
            showNotification("اختر نطاق تاريخ صالحاً لا يتجاوز $maximumDays يوماً.")
            return false
        }
        _reportTemplateRuntime.update {
            it.copy(fromDate = from, toDate = to, preview = null, errorMessage = null)
        }
        return true
    }

    fun updateReportTemplateDepartment(departmentId: String?) {
        _reportTemplateRuntime.update {
            it.copy(departmentId = departmentId, preview = null, errorMessage = null)
        }
    }

    fun updateReportTemplateExtraFilter(value: String?) {
        _reportTemplateRuntime.update {
            it.copy(extraFilter = value, preview = null, errorMessage = null)
        }
    }

    fun previewSelectedReportTemplate() {
        val runtime = _reportTemplateRuntime.value
        val template = runtime.catalog.firstOrNull { it.builtInKey == runtime.selectedKey } ?: return
        viewModelScope.launch {
            _reportTemplateRuntime.update { it.copy(isLoading = true, errorMessage = null) }
            when (val result = reportRepository.previewTemplate(
                builtInKey = template.builtInKey,
                templateVersion = template.version,
                departmentId = runtime.departmentId,
                filters = reportTemplateFilters(runtime, template)
            )) {
                is com.example.core.utils.AppResult.Success -> _reportTemplateRuntime.update {
                    it.copy(isLoading = false, preview = result.data, errorMessage = null)
                }
                is com.example.core.utils.AppResult.Error -> _reportTemplateRuntime.update {
                    it.copy(
                        isLoading = false,
                        preview = null,
                        errorMessage = errorText(result, "تعذر معاينة القالب")
                    )
                }
                else -> Unit
            }
        }
    }

    fun exportSelectedReportTemplate(format: com.example.domain.model.ReportTemplateExportFormat) {
        val runtime = _reportTemplateRuntime.value
        val template = runtime.catalog.firstOrNull { it.builtInKey == runtime.selectedKey } ?: return
        if (!template.supportsFormat(format)) {
            showNotification("صيغة التصدير غير مدعومة لهذا القالب.")
            return
        }
        if (runtime.exportingFormat != null) return
        viewModelScope.launch {
            _reportTemplateRuntime.update { it.copy(exportingFormat = format, errorMessage = null) }
            when (val result = reportRepository.exportTemplate(
                builtInKey = template.builtInKey,
                templateVersion = template.version,
                departmentId = runtime.departmentId,
                filters = reportTemplateFilters(runtime, template),
                format = format
            )) {
                is com.example.core.utils.AppResult.Success -> {
                    try {
                        val share = withContext(Dispatchers.IO) {
                            payrollExportStore.save(result.data)
                        }
                        _reportTemplateRuntime.update {
                            it.copy(exportingFormat = null, pendingShare = share, errorMessage = null)
                        }
                    } catch (_: Exception) {
                        _reportTemplateRuntime.update {
                            it.copy(
                                exportingFormat = null,
                                errorMessage = "تعذر حفظ ملف التصدير للمشاركة"
                            )
                        }
                    }
                }
                is com.example.core.utils.AppResult.Error -> _reportTemplateRuntime.update {
                    it.copy(
                        exportingFormat = null,
                        errorMessage = errorText(result, "تعذر تصدير القالب")
                    )
                }
                else -> Unit
            }
        }
    }

    fun consumeReportTemplateShare() {
        _reportTemplateRuntime.update { it.copy(pendingShare = null) }
    }

    fun toggleSavedReportTemplates(show: Boolean) {
        _reportTemplateRuntime.update { it.copy(showSavedTemplates = show) }
        if (show) refreshSavedReportTemplates()
    }

    fun refreshSavedReportTemplates(includeArchived: Boolean = false) {
        viewModelScope.launch {
            _reportTemplateRuntime.update { it.copy(savedLoading = true, errorMessage = null) }
            when (val result = reportRepository.loadSavedTemplates(includeArchived)) {
                is com.example.core.utils.AppResult.Success -> _reportTemplateRuntime.update {
                    it.copy(savedLoading = false, savedTemplates = result.data, errorMessage = null)
                }
                is com.example.core.utils.AppResult.Error -> _reportTemplateRuntime.update {
                    it.copy(
                        savedLoading = false,
                        errorMessage = errorText(result, "تعذر تحميل القوالب المحفوظة")
                    )
                }
                else -> Unit
            }
        }
    }

    fun openSaveReportTemplateDialog() {
        _reportTemplateRuntime.update { it.copy(showSaveDialog = true, saveName = "", errorMessage = null) }
    }

    fun dismissSaveReportTemplateDialog() {
        _reportTemplateRuntime.update { it.copy(showSaveDialog = false, saveName = "") }
    }

    fun updateSaveReportTemplateName(name: String) {
        _reportTemplateRuntime.update { it.copy(saveName = name.take(120)) }
    }

    fun saveSelectedReportTemplate(preferredFormat: com.example.domain.model.ReportTemplateExportFormat?) {
        val runtime = _reportTemplateRuntime.value
        val template = runtime.catalog.firstOrNull { it.builtInKey == runtime.selectedKey } ?: return
        val name = runtime.saveName.trim()
        if (name.isBlank()) {
            showNotification("أدخل اسماً للقالب المحفوظ.")
            return
        }
        viewModelScope.launch {
            _reportTemplateRuntime.update { it.copy(isLoading = true, errorMessage = null) }
            when (val result = reportRepository.saveTemplate(
                com.example.domain.model.SaveReportTemplateRequest(
                    name = name,
                    builtInKey = template.builtInKey,
                    templateVersion = template.version,
                    departmentId = runtime.departmentId,
                    filters = reportTemplateFilters(runtime, template),
                    preferredFormat = preferredFormat
                )
            )) {
                is com.example.core.utils.AppResult.Success -> {
                    _reportTemplateRuntime.update {
                        it.copy(
                            isLoading = false,
                            showSaveDialog = false,
                            saveName = "",
                            errorMessage = null
                        )
                    }
                    showNotification("تم حفظ القالب بنجاح.")
                    if (runtime.showSavedTemplates) refreshSavedReportTemplates()
                }
                is com.example.core.utils.AppResult.Error -> _reportTemplateRuntime.update {
                    it.copy(
                        isLoading = false,
                        errorMessage = errorText(result, "تعذر حفظ القالب")
                    )
                }
                else -> Unit
            }
        }
    }

    fun archiveSavedReportTemplate(id: String) {
        viewModelScope.launch {
            when (val result = reportRepository.archiveSavedTemplate(id)) {
                is com.example.core.utils.AppResult.Success -> {
                    showNotification("تم أرشفة القالب المحفوظ.")
                    refreshSavedReportTemplates(includeArchived = _reportTemplateRuntime.value.savedTemplates.any {
                        it.isArchived()
                    })
                }
                is com.example.core.utils.AppResult.Error -> _reportTemplateRuntime.update {
                    it.copy(errorMessage = errorText(result, "تعذر أرشفة القالب المحفوظ"))
                }
                else -> Unit
            }
        }
    }

    fun applySavedReportTemplate(saved: com.example.domain.model.SavedReportTemplate) {
        if (_reportTemplateRuntime.value.catalog.none { it.builtInKey == saved.builtInKey }) {
            showNotification("القالب المحفوظ غير متاح لصلاحياتك الحالية.")
            return
        }
        _reportTemplateRuntime.update {
            it.copy(
                selectedKey = saved.builtInKey,
                departmentId = saved.scope.departmentId,
                fromDate = saved.filters["from"] ?: it.fromDate,
                toDate = saved.filters["to"] ?: it.toDate,
                extraFilter = saved.filters.entries.firstOrNull { entry ->
                    entry.key !in setOf("from", "to", "departmentId")
                }?.value,
                preview = null,
                errorMessage = null,
                showSavedTemplates = false
            )
        }
        previewSelectedReportTemplate()
    }

    private fun reportTemplateFilters(
        runtime: ReportTemplateRuntimeState,
        template: com.example.domain.model.ReportTemplateCatalogItem
    ): Map<String, String> = buildMap {
        if (!template.modules.contains("payroll")) {
            put("from", runtime.fromDate)
            put("to", runtime.toDate)
        }
        runtime.departmentId?.let { put("departmentId", it) }
        com.example.domain.model.reportTemplateExtraFilterKey(template.modules)?.let { key ->
            runtime.extraFilter?.let { put(key, it) }
        }
    }

    private suspend fun loadSelectedReport() {
        val runtime = _reportRuntime.value
        val expectedType = runtime.selectedType
        if (expectedType.isBlank()) return
        _reportRuntime.update { it.copy(isLoading = true, errorMessage = null) }
        if (expectedType == "overview") {
            when (val result = reportRepository.loadOverview(
                runtime.fromDate,
                runtime.toDate,
                runtime.selectedDepartmentId
            )) {
                is com.example.core.utils.AppResult.Success -> if (_reportRuntime.value.selectedType == expectedType) {
                    _reportRuntime.update {
                        it.copy(isLoading = false, overview = result.data, detail = null, errorMessage = null)
                    }
                }
                is com.example.core.utils.AppResult.Error -> if (_reportRuntime.value.selectedType == expectedType) {
                    _reportRuntime.update {
                        it.copy(isLoading = false, overview = null, errorMessage = errorText(result, "تعذر تحميل ملخص التقارير"))
                    }
                }
                else -> Unit
            }
        } else {
            when (val result = reportRepository.loadDetail(expectedType, reportFilters(runtime))) {
                is com.example.core.utils.AppResult.Success -> if (_reportRuntime.value.selectedType == expectedType) {
                    _reportRuntime.update {
                        it.copy(isLoading = false, detail = result.data, overview = null, errorMessage = null)
                    }
                }
                is com.example.core.utils.AppResult.Error -> if (_reportRuntime.value.selectedType == expectedType) {
                    _reportRuntime.update {
                        it.copy(isLoading = false, detail = null, errorMessage = errorText(result, "تعذر تحميل التقرير"))
                    }
                }
                else -> Unit
            }
        }
    }

    private fun reportFilters(runtime: ReportRuntimeState): Map<String, String> = buildMap {
        if (runtime.selectedType != "payroll") {
            put("from", runtime.fromDate)
            put("to", runtime.toDate)
        }
        runtime.selectedDepartmentId?.let { put("departmentId", it) }
        val statusKey = when (runtime.selectedType) {
            "attendance", "leaves", "tasks" -> "status"
            "purchasing" -> "requestStatus"
            "training" -> "courseStatus"
            else -> null
        }
        if (statusKey != null) runtime.selectedStatus?.let { put(statusKey, it) }
    }

    // 10. Dashboard UI State — consolidates the already-migrated modules. Reuses reportsUiState
    //     (which already aggregates Employees/Purchasing/Attendance/Leaves/Payroll from the
    //     repositories) plus each module's canView for permission-aware quick actions. All values
    //     are computed in buildDashboardState (a mapper), never inside composables. No legacy aliases.
    val dashboardUiState: StateFlow<DashboardUiState> = combine(
        reportsUiState,
        employeesUiState,
        purchasingUiState,
        attendanceUiState,
        leavesUiState
    ) { reports, emp, pur, att, lea ->
        DashInputs(reports, emp, pur, att, lea)
    }.combine(payrollUiState) { di, pay ->
        buildDashboardState(di, pay)
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), DashboardUiState())

    private data class DashInputs(
        val reports: ReportsUiState,
        val emp: EmployeesUiState,
        val pur: PurchasingUiState,
        val att: AttendanceUiState,
        val lea: LeavesUiState
    )

    private fun buildDashboardState(di: DashInputs, pay: PayrollUiState): DashboardUiState {
        val rs = di.reports.summary
        val summary = com.example.domain.model.DashboardSummaryParams(
            totalEmployees = rs.totalEmployees,
            activeEmployees = rs.activeEmployees,
            presentToday = rs.attendanceTodayCount,
            absentToday = rs.absentTodayCount,
            pendingLeaves = rs.pendingLeaves,
            pendingPurchaseRequests = rs.pendingPurchaseOrders,
            payrollPeriodsCount = rs.payrollPeriodsCount,
            latestPayrollNetTotal = rs.latestPayrollNetTotal,
            approvedPurchaseAmount = di.reports.financial.totalPurchasing
        )
        val alerts = buildList {
            if (rs.pendingLeaves > 0) add(com.example.domain.model.DashboardAlertParams(
                "alert-leaves", "طلبات إجازات معلقة", "لديك ${rs.pendingLeaves} طلب إجازة بانتظار المراجعة.", "leave", "عالية"))
            if (rs.pendingPurchaseOrders > 0) add(com.example.domain.model.DashboardAlertParams(
                "alert-po", "طلبات شراء معلقة", "${rs.pendingPurchaseOrders} طلب شراء بانتظار الاعتماد.", "purchasing", "متوسطة"))
            if (rs.absentTodayCount > 0) add(com.example.domain.model.DashboardAlertParams(
                "alert-absent", "غياب اليوم", "${rs.absentTodayCount} موظف مسجل كغائب اليوم.", "attendance", "متوسطة"))
            if (pay.periods.any { it.status == "محتسبة" }) add(com.example.domain.model.DashboardAlertParams(
                "alert-payroll", "مسير رواتب بانتظار الاعتماد", "توجد فترة رواتب محتسبة تنتظر الاعتماد.", "payroll", "عالية"))
        }
        val quickActions = listOf(
            com.example.domain.model.DashboardQuickActionParams("qa-employees", "الموظفون", 1, di.emp.canView),
            com.example.domain.model.DashboardQuickActionParams("qa-attendance", "الحضور", 9, di.att.canView),
            com.example.domain.model.DashboardQuickActionParams("qa-leaves", "الإجازات", 10, di.lea.canView),
            com.example.domain.model.DashboardQuickActionParams("qa-purchasing", "المشتريات", 2, di.pur.canView),
            com.example.domain.model.DashboardQuickActionParams("qa-payroll", "الرواتب", 11, pay.canView),
            com.example.domain.model.DashboardQuickActionParams("qa-reports", "التقارير", 3, di.reports.canViewReports || di.reports.canViewFinancialReports)
        )
        return DashboardUiState(
            isLoading = false,
            summary = summary,
            alerts = alerts,
            quickActions = quickActions,
            canViewDashboard = true,
            isEmpty = summary.totalEmployees == 0 && alerts.isEmpty()
        )
    }

    fun refreshDashboard() {
        viewModelScope.launch {
            employeeRepository.refreshEmployees()
            refreshPurchasingData()
            attendanceRepository.refreshAttendance()
            leaveRepository.refreshLeaveRequests()
            payrollRepository.refreshPayroll()
            updatePayrollSummary()
            loadLatestPayrollReport()
        }
    }

    // ---------------- DATABASE WRITE INITIALIZATIONS ----------------

    init {
        viewModelScope.launch {
            // Best-effort refresh; errors (e.g. unimplemented backend) are ignored on init.
            val restoredSession = authRepository.observeCurrentSession().first()
            employeeRepository.refreshEmployees()
            if (restoredSession != null) refreshPurchasingData(restoredSession.permissions)
            attendanceRepository.refreshAttendance(
                attendanceQueryForPermissions(restoredSession?.permissions ?: emptySet())
            )
            if (restoredSession != null &&
                com.example.core.permissions.PermissionChecker(restoredSession.permissions)
                    .hasPermission(com.example.core.permissions.Permissions.ATTENDANCE_MANAGE)
            ) {
                attendanceRepository.refreshEligibleEmployees()
            }
            leaveRepository.refreshLeaveRequests()
            payrollRepository.refreshPayroll()
            taskRepository.refreshTasks()
            trainingRepository.refreshTraining()
            updatePayrollSummary()
            loadLatestPayrollReport()
        }
        viewModelScope.launch {
            authUiState.collect { st ->
                val p = st.userDisplayProfile
                val session = st.currentSession
                resetCompanyScopedDataIfNeeded(session)
                val canUseChat = com.example.core.permissions.PermissionChecker(
                    session?.permissions ?: emptySet()
                ).hasPermission(com.example.core.permissions.Permissions.CHAT_VIEW)
                val sessionKey = session?.let { "${it.companyId}:${it.userId}" }
                val sessionChanged = sessionKey != activeChatSessionKey
                val trainingSessionChanged = sessionKey != activeTrainingSessionKey
                val reportSessionChanged = sessionKey != activeReportSessionKey
                if (sessionChanged) {
                    stopChatPolling()
                    cancelChatDirectorySearch()
                    chatRepository.clear()
                    _chatUiState.value = chatAccessState(canUseChat)
                    activeChatSessionKey = sessionKey
                } else if (!canUseChat) {
                    // Same-identity soft refresh may strip chat access; fail closed.
                    stopChatPolling()
                    cancelChatDirectorySearch()
                    chatRepository.clear()
                    _chatUiState.value = chatAccessState(false)
                } else {
                    val access = chatAccessState(true)
                    _chatUiState.update {
                        it.copy(
                            canUseChat = true,
                            canCreateDirect = access.canCreateDirect,
                            canCreateDepartment = access.canCreateDepartment,
                            canCreateAnnouncement = access.canCreateAnnouncement,
                            canPin = access.canPin
                        )
                    }
                }
                if (trainingSessionChanged) {
                    trainingRepository.clear()
                    _trainingControls.value = TrainingControls()
                    _trainingTimelineState.value = TrainingTimelineUiState()
                    _trainingExportState.value = TrainingExportUiState()
                    _trainingPendingExportShare.value = null
                    activeTrainingSessionKey = sessionKey
                }
                if (reportSessionChanged) {
                    reportRepository.clear()
                    reportExportStore.clear()
                    _reportRuntime.value = freshReportRuntime()
                    _reportTemplateRuntime.value = freshReportTemplateRuntime()
                    activeReportSessionKey = sessionKey
                }
                chatRepository.setCurrentUser(
                    userId = session?.userId ?: "",
                    name = p?.fullName ?: st.currentUserDisplayName,
                    role = p?.roleName ?: st.currentUserRoleName,
                    department = p?.departmentName
                )
                if (sessionChanged && session != null && canUseChat) {
                    refreshChat()
                }
                if (trainingSessionChanged && session != null) {
                    val permissions = session.permissions
                    val initialMode = when {
                        permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL) ||
                            permissions.contains(com.example.core.permissions.Permissions.TRAINING_VIEW_COMPANY) -> "courses"
                        session.employeeId != null &&
                            permissions.contains(com.example.core.permissions.Permissions.TRAINING_VIEW_OWN) -> "own"
                        permissions.contains(com.example.core.permissions.Permissions.TRAINING_VIEW_DEPARTMENT) -> "department"
                        else -> "own"
                    }
                    refreshTraining(initialMode)
                }
                if (reportSessionChanged && session != null) {
                    refreshReports()
                }
            }
        }
    }

    // Re-fetch the core lists after a successful login. The init-block refresh
    // runs before authentication (no token), so those calls fail silently and
    // leave the screens empty until the user triggers another action.
    private fun refreshCoreDataAfterLogin() {
        viewModelScope.launch {
            refreshAuthorizationForCurrentSession()
            val permissions = authUiState.value.currentSession?.permissions ?: emptySet()
            val checker = com.example.core.permissions.PermissionChecker(permissions)
            val canViewEmployees = checker.hasPermission(com.example.core.permissions.Permissions.EMPLOYEES_VIEW)
            val canManageEmployeeDepartments = canManageDepartments(permissions)
            val canLoadManagerCandidates = canManageDepartmentManagers(permissions)
            if (canViewEmployees) {
                employeeRepository.refreshEmployees()
            }
            if (canViewEmployees || canManageEmployeeDepartments) {
                employeeRepository.refreshEmployeeOptions(canLoadManagerCandidates)
            }
            refreshAttendanceRepository()
            if (attendanceChecker().hasPermission(attendanceChecker().HR_ATTENDANCE_MANAGE)) {
                attendanceRepository.refreshEligibleEmployees()
            }
            leaveRepository.refreshLeaveRequests()
        }
    }

    /** Public refresh for the Employees screen (LaunchedEffect + refresh button). */
    fun refreshEmployees() {
        viewModelScope.launch {
            _employeeLoading.value = true
            try {
                val permissions = authUiState.value.currentSession?.permissions ?: emptySet()
                val checker = com.example.core.permissions.PermissionChecker(permissions)
                val canViewEmployees = checker.hasPermission(com.example.core.permissions.Permissions.EMPLOYEES_VIEW)
                val canManageEmployeeDepartments = canManageDepartments(permissions)
                val canLoadManagerCandidates = canManageDepartmentManagers(permissions)
                val result = if (canViewEmployees) {
                    employeeRepository.refreshEmployees()
                } else {
                    com.example.core.utils.AppResult.Success(Unit)
                }
                val optionsResult = if (canViewEmployees || canManageEmployeeDepartments) {
                    employeeRepository.refreshEmployeeOptions(canLoadManagerCandidates)
                } else {
                    com.example.core.utils.AppResult.Success(Unit)
                }
                if (result is com.example.core.utils.AppResult.Error ||
                    optionsResult is com.example.core.utils.AppResult.Error
                ) {
                    showNotification("تعذّر تحديث قائمة الموظفين (الخادم غير متصل).")
                }
            } finally {
                _employeeLoading.value = false
            }
        }
    }

    // ---------------- EMPLOYEE WORKFLOWS (Permissions checked) ----------------

    fun addEmployee(
        name: String,
        email: String,
        temporaryPassword: String,
        phone: String,
        role: String,
        department: String,
        status: String
    ) {
        val checker = com.example.core.permissions.PermissionChecker(authUiState.value.currentSession?.permissions ?: emptySet())
        if (checker.hasPermission(checker.HR_EMPLOYEE_CREATE)) {
            viewModelScope.launch {
                val newEmp = com.example.domain.model.EmployeeParams(
                    id = "0",
                    companyId = authUiState.value.currentSession?.companyId ?: "1",
                    departmentId = if (department.contains("موارد")) "1" else if (department.contains("IT")) "2" else "3",
                    employeeCode = "EMP${(100..999).random()}",
                    fullName = name,
                    jobTitle = role,
                    phone = phone,
                    email = email,
                    nationalIdOrIqama = "",
                    // Salary is managed separately through effective-dated records.
                    basicSalary = 0.0,
                    allowances = 0.0,
                    deductions = 0.0,
                    status = status,
                    joiningDate = "2026-06-12",
                    contractType = "FULL_TIME",
                    createdAt = System.currentTimeMillis(),
                    updatedAt = System.currentTimeMillis(),
                    temporaryPassword = temporaryPassword
                )
                val result = employeeRepository.createEmployee(newEmp)
                if (result is com.example.core.utils.AppResult.Success) {
                    // Salary is not persisted to the backend yet, so do not claim it
                    // was linked to payroll (that was misleading during QA).
                    showNotification("تمت إضافة الموظف الجديد $name بنجاح.")
                } else {
                    val serverMessage =
                        ((result as? com.example.core.utils.AppResult.Error)?.appError
                            as? com.example.core.utils.AppError.ServerError)?.message
                    showNotification(
                        if (!serverMessage.isNullOrBlank() && serverMessage.any { it in '؀'..'ۿ' }) serverMessage
                        else "حدث خطأ أثناء إضافة الموظف."
                    )
                }
            }
        } else {
            showNotification("خطأ: لا تمتلك الصلاحية الكافية لإضافة موظف!")
        }
    }

    private fun employeeActionError(
        result: com.example.core.utils.AppResult.Error,
        fallback: String
    ): String {
        val serverMessage = (result.appError as? com.example.core.utils.AppError.ServerError)?.message
        return if (!serverMessage.isNullOrBlank() && serverMessage.any { it in '\u0600'..'\u06ff' }) {
            serverMessage
        } else {
            fallback
        }
    }

    fun updateEmployeeDetails(
        employeeId: String,
        update: com.example.domain.model.EmployeeUpdateForm
    ) {
        val permissions = authUiState.value.currentSession?.permissions ?: emptySet()
        if (!canEditEmployees(permissions)) {
            showNotification("لا تملك صلاحية تعديل بيانات الموظفين.")
            return
        }
        val currentRoleId = employeesUiState.value.employeeRecords
            .firstOrNull { it.id == employeeId }
            ?.roleId
        if (!canSubmitEmployeeRole(permissions, currentRoleId, update.roleId)) {
            showNotification("لا تملك صلاحية تغيير دور الموظف.")
            return
        }
        viewModelScope.launch {
            _employeeLoading.value = true
            try {
                when (val result = employeeRepository.updateEmployee(employeeId, update)) {
                    is com.example.core.utils.AppResult.Success ->
                        showNotification("تم تحديث بيانات الموظف بنجاح.")
                    is com.example.core.utils.AppResult.Error ->
                        showNotification(employeeActionError(result, "تعذّر تحديث بيانات الموظف."))
                    else -> Unit
                }
            } finally {
                _employeeLoading.value = false
            }
        }
    }

    fun createDepartment(name: String, managerId: String?) {
        val permissions = authUiState.value.currentSession?.permissions ?: emptySet()
        if (!canManageDepartments(permissions)) {
            showNotification("لا تملك صلاحية إدارة الأقسام.")
            return
        }
        if (managerId != null && !canManageDepartmentManagers(permissions)) {
            showNotification("لا تملك صلاحية تعيين مدير للقسم.")
            return
        }
        viewModelScope.launch {
            _employeeLoading.value = true
            try {
                when (val result = employeeRepository.createDepartment(
                    com.example.domain.model.DepartmentDraft(name.trim(), managerId)
                )) {
                    is com.example.core.utils.AppResult.Success -> {
                        val refreshResult = employeeRepository.refreshEmployeeOptions(
                            canManageDepartmentManagers(permissions)
                        )
                        if (refreshResult is com.example.core.utils.AppResult.Error) {
                            showNotification("تم إنشاء القسم، لكن تعذّر تحديث القائمة. أعد المحاولة.")
                        } else {
                            showNotification("تم إنشاء القسم بنجاح.")
                        }
                    }
                    is com.example.core.utils.AppResult.Error ->
                        showNotification(employeeActionError(result, "تعذّر إنشاء القسم."))
                    else -> Unit
                }
            } finally {
                _employeeLoading.value = false
            }
        }
    }

    fun updateDepartment(id: String, name: String, managerId: String?) {
        val permissions = authUiState.value.currentSession?.permissions ?: emptySet()
        if (!canManageDepartments(permissions)) {
            showNotification("لا تملك صلاحية إدارة الأقسام.")
            return
        }
        val currentDepartment = employeesUiState.value.departments.firstOrNull { it.id == id }
        if (!canSubmitDepartmentManager(
                permissions,
                currentDepartmentLoaded = currentDepartment != null,
                currentManagerId = currentDepartment?.managerId,
                requestedManagerId = managerId
            )
        ) {
            showNotification("لا تملك صلاحية تغيير مدير القسم.")
            return
        }
        viewModelScope.launch {
            _employeeLoading.value = true
            try {
                when (val result = employeeRepository.updateDepartment(
                    id,
                    com.example.domain.model.DepartmentDraft(name.trim(), managerId)
                )) {
                    is com.example.core.utils.AppResult.Success -> {
                        val refreshResult = employeeRepository.refreshEmployeeOptions(
                            canManageDepartmentManagers(permissions)
                        )
                        if (refreshResult is com.example.core.utils.AppResult.Error) {
                            showNotification("تم تحديث القسم، لكن تعذّر تحديث القائمة. أعد المحاولة.")
                        } else {
                            showNotification("تم تحديث القسم بنجاح.")
                        }
                    }
                    is com.example.core.utils.AppResult.Error ->
                        showNotification(employeeActionError(result, "تعذّر تحديث القسم."))
                    else -> Unit
                }
            } finally {
                _employeeLoading.value = false
            }
        }
    }

    fun removeEmployee(id: String, name: String) {
        val checker = com.example.core.permissions.PermissionChecker(authUiState.value.currentSession?.permissions ?: emptySet())
        if (checker.hasPermission(checker.HR_EMPLOYEE_DELETE)) {
            viewModelScope.launch {
                val result = employeeRepository.deactivateEmployee(id)
                if (result is com.example.core.utils.AppResult.Success) {
                    showNotification("تم إيقاف الموظف $name بنجاح من قاعدة البيانات.")
                } else {
                    val serverMessage =
                        ((result as? com.example.core.utils.AppResult.Error)?.appError
                            as? com.example.core.utils.AppError.ServerError)?.message
                    showNotification(
                        if (!serverMessage.isNullOrBlank() && serverMessage.any { it in '؀'..'ۿ' }) serverMessage
                        else "حدث خطأ أثناء إيقاف الموظف."
                    )
                }
            }
        } else {
            showNotification("خطأ: يتوجب توفر صلاحيات المدير!")
        }
    }

    private suspend fun refreshSalaryDetails(employeeId: String) {
        val currentResult = employeeRepository.getCurrentSalary(employeeId)
        val historyResult = employeeRepository.getSalaryHistory(employeeId)
        if (_salaryUiState.value.employeeId != employeeId) return

        if (currentResult is com.example.core.utils.AppResult.Success &&
            historyResult is com.example.core.utils.AppResult.Success
        ) {
            _salaryUiState.update {
                it.copy(
                    currentSalary = currentResult.data.currentSalary,
                    history = historyResult.data.history,
                    isLoading = false,
                    isSaving = false,
                    errorMessage = null
                )
            }
            return
        }

        val error = (currentResult as? com.example.core.utils.AppResult.Error)
            ?: (historyResult as? com.example.core.utils.AppResult.Error)
        _salaryUiState.update {
            it.copy(
                isLoading = false,
                isSaving = false,
                errorMessage = error?.let { salaryError ->
                    employeeActionError(salaryError, "تعذّر تحميل بيانات الراتب.")
                } ?: "تعذّر تحميل بيانات الراتب."
            )
        }
    }

    fun loadEmployeeSalary(employee: com.example.domain.model.EmployeeParams) {
        val permissions = authUiState.value.currentSession?.permissions ?: emptySet()
        if (!canViewSalaryForTarget(permissions, employee.roleName)) {
            showNotification("لا تملك صلاحية عرض راتب هذا الموظف.")
            return
        }
        _salaryUiState.value = SalaryUiState(
            employeeId = employee.id,
            employeeName = employee.fullName,
            isLoading = true,
            canManage = canManageSalaryForTarget(permissions, employee.roleName)
        )
        viewModelScope.launch { refreshSalaryDetails(employee.id) }
    }

    fun closeEmployeeSalary() {
        _salaryUiState.value = SalaryUiState()
    }

    fun createEmployeeSalary(employeeId: String, amount: String, effectiveFrom: String) {
        val employee = employeesUiState.value.employeeRecords.firstOrNull { it.id == employeeId }
        val permissions = authUiState.value.currentSession?.permissions ?: emptySet()
        if (employee == null || !canManageSalaryForTarget(permissions, employee.roleName)) {
            showNotification("لا تملك صلاحية تعديل راتب هذا الموظف.")
            return
        }
        if (!isValidSalaryAmount(amount)) {
            _salaryUiState.update { it.copy(errorMessage = "أدخل راتباً صالحاً بحد أقصى منزلتين عشريتين.") }
            return
        }
        if (!isIsoAttendanceDate(effectiveFrom)) {
            _salaryUiState.update { it.copy(errorMessage = "تاريخ سريان الراتب غير صالح.") }
            return
        }

        _salaryUiState.update { it.copy(isSaving = true, errorMessage = null) }
        viewModelScope.launch {
            when (val result = employeeRepository.createSalaryRecord(
                employeeId,
                com.example.domain.model.CreateSalaryRecordRequest(
                    baseSalary = amount.trim(),
                    effectiveFrom = effectiveFrom
                )
            )) {
                is com.example.core.utils.AppResult.Success -> {
                    showNotification("تم حفظ سجل الراتب بنجاح.")
                    _salaryUiState.update { it.copy(isLoading = true, isSaving = false) }
                    refreshSalaryDetails(employeeId)
                }
                is com.example.core.utils.AppResult.Error -> {
                    _salaryUiState.update {
                        it.copy(
                            isSaving = false,
                            errorMessage = employeeActionError(result, "تعذّر حفظ سجل الراتب.")
                        )
                    }
                }
                else -> Unit
            }
        }
    }

    // ---------------- PROCUREMENT WORKFLOWS (repository-based, permission-keyed) ----------------

    private fun purchasingChecker() =
        com.example.core.permissions.PermissionChecker(authUiState.value.currentSession?.permissions ?: emptySet())

    private suspend fun refreshPurchasingData(
        permissions: Set<String> = authUiState.value.currentSession?.permissions ?: emptySet()
    ) {
        val checker = com.example.core.permissions.PermissionChecker(permissions)
        val mode = when {
            _purchasingMode.value == "company" && (permissions.contains(com.example.core.permissions.Permissions.PURCHASING_VIEW) || permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL)) -> "company"
            _purchasingMode.value == "department" && permissions.contains(com.example.core.permissions.Permissions.PURCHASING_VIEW_DEPARTMENT) -> "department"
            else -> "own"
        }
        if (checker.hasPermission(com.example.core.permissions.Permissions.PURCHASING_VIEW)) {
            purchaseRepository.refreshPurchaseRequests(com.example.domain.model.PurchaseRequestFilters(scope = mode, status = _purchasingStatus.value))
            purchaseRepository.refreshPurchaseOrders(com.example.domain.model.PurchaseOrderFilters(scope = mode, status = _purchasingStatus.value))
        }
        if (checker.hasPermission(com.example.core.permissions.Permissions.VENDORS_VIEW)) supplierRepository.refreshSuppliersAllStatuses()
        if (checker.hasPermission(com.example.core.permissions.Permissions.PURCHASING_REPORT)) purchaseRepository.refreshPurchasingReport()
    }

    fun refreshPurchasing() {
        viewModelScope.launch {
            _purchasingLoading.value = true
            _purchasingError.value = null
            try { refreshPurchasingData() } finally { _purchasingLoading.value = false }
        }
    }

    private fun purchasingError(result: com.example.core.utils.AppResult<*>, fallback: String): String =
        (result as? com.example.core.utils.AppResult.Error)?.exception?.message?.takeIf { it.isNotBlank() } ?: fallback

    private fun runPurchasingAction(success: String, fallback: String, action: suspend () -> com.example.core.utils.AppResult<*>) {
        viewModelScope.launch {
            _purchasingSubmitting.value = true
            _purchasingError.value = null
            val result = action()
            if (result is com.example.core.utils.AppResult.Success) {
                showNotification(success)
                refreshPurchasingData()
            } else {
                val message = purchasingError(result, fallback)
                _purchasingError.value = message
                showNotification(message)
            }
            _purchasingSubmitting.value = false
        }
    }

    fun createPurchaseRequest(request: com.example.domain.model.CreatePurchaseRequestParams) =
        runPurchasingAction("تم إرسال طلب الشراء للمراجعة.", "تعذر إنشاء طلب الشراء") {
            purchaseRepository.createPurchaseRequest(request)
        }

    fun reviewPurchaseRequest(id: String, departmentStage: Boolean, action: String, note: String?) =
        runPurchasingAction(if (action == "approve") "تمت الموافقة على الطلب." else "تم رفض الطلب.", "تعذرت مراجعة الطلب") {
            if (departmentStage) purchaseRepository.reviewDepartment(id, action, note)
            else purchaseRepository.reviewPurchasing(id, action, note)
        }

    fun cancelPurchaseRequest(id: String, reason: String) =
        runPurchasingAction("تم إلغاء طلب الشراء مع الاحتفاظ بسجله.", "تعذر إلغاء الطلب") {
            purchaseRepository.cancelPurchaseRequest(id, reason)
        }

    fun createPurchaseOrder(request: com.example.domain.model.PurchaseOrderDraftParams) =
        runPurchasingAction("تم إنشاء مسودة أمر الشراء.", "تعذر إنشاء أمر الشراء") {
            purchaseRepository.createPurchaseOrder(request)
        }

    fun updatePurchaseOrder(id: String, request: com.example.domain.model.PurchaseOrderDraftParams) =
        runPurchasingAction("تم تحديث مسودة أمر الشراء.", "تعذر تحديث أمر الشراء") {
            purchaseRepository.updatePurchaseOrder(id, request)
        }

    fun issuePurchaseOrder(id: String) = runPurchasingAction("تم إصدار أمر الشراء.", "تعذر إصدار الأمر") {
        purchaseRepository.issuePurchaseOrder(id)
    }

    fun receivePurchaseOrder(id: String, note: String?) = runPurchasingAction("تم تسجيل الاستلام الإداري.", "تعذر استلام الأمر") {
        purchaseRepository.receivePurchaseOrder(id, note)
    }

    fun cancelPurchaseOrder(id: String, reason: String) = runPurchasingAction("تم إلغاء أمر الشراء مع الاحتفاظ بسجله.", "تعذر إلغاء الأمر") {
        purchaseRepository.cancelPurchaseOrder(id, reason)
    }

    // ---------------- PURCHASING ADMIN OVERRIDE + EXPORTS (Sprint 12I) ----------------

    fun openPurchasingOverrideDialog(request: com.example.domain.model.PurchaseRequestParams) {
        if (!purchasingChecker().hasPermission(com.example.core.permissions.Permissions.PURCHASING_ADMIN_OVERRIDE)) {
            showNotification("لا تمتلك صلاحية الإجراء الإداري الاستثنائي على طلبات الشراء.")
            return
        }
        _purchasingError.value = null
        _purchasingOverrideTargetId.value = request.id
    }

    fun dismissPurchasingOverrideDialog() {
        _purchasingOverrideTargetId.value = null
    }

    /**
     * Sends the second-confirmation override to `/api/v2/purchasing/requests/{id}/override`
     * with a fresh Idempotency-Key. On a documented outcome (self-forbidden 403 / stale
     * version 412 / illegal transition or active-order conflict 409) the exact backend
     * message is surfaced — never a generic "something went wrong" — and the list is
     * refreshed so the dialog reflects the current status/updatedAt before retrying.
     */
    fun submitPurchasingOverride(requestId: String, action: String, reason: String, expectedUpdatedAt: String?) {
        if (!purchasingChecker().hasPermission(com.example.core.permissions.Permissions.PURCHASING_ADMIN_OVERRIDE)) {
            showNotification("لا تمتلك صلاحية الإجراء الإداري الاستثنائي على طلبات الشراء.")
            return
        }
        if (reason.isBlank()) {
            showNotification("سبب الإجراء الإداري مطلوب.")
            return
        }
        if (_purchasingOverrideSubmitting.value) return
        viewModelScope.launch {
            _purchasingOverrideSubmitting.value = true
            _purchasingError.value = null
            val idempotencyKey = UUID.randomUUID().toString()
            when (
                val result = purchaseRepository.overridePurchaseRequest(
                    requestId, action, reason.trim(), expectedUpdatedAt, idempotencyKey
                )
            ) {
                is com.example.core.utils.AppResult.Success -> {
                    _purchasingOverrideTargetId.value = null
                    showNotification(
                        when (action) {
                            "approve" -> "تم اعتماد طلب الشراء عبر إجراء إداري استثنائي."
                            "reject" -> "تم رفض طلب الشراء عبر إجراء إداري استثنائي."
                            else -> "تم إلغاء طلب الشراء عبر إجراء إداري استثنائي."
                        }
                    )
                    refreshPurchasingData()
                }
                is com.example.core.utils.AppResult.Error -> {
                    val outcome = result.exception as? com.example.domain.model.PurchasingOverrideException
                    val message = outcome?.message?.takeIf { it.isNotBlank() }
                        ?: purchasingError(result, "تعذر تنفيذ الإجراء الإداري")
                    _purchasingError.value = message
                    showNotification(message)
                    // Stale version / already-transitioned / active-order conflicts mean the
                    // list is out of date — refresh so the next attempt sees reality.
                    if (outcome?.code in setOf("VersionMismatch", "IllegalTransition", "PurchaseRequestStateConflict", "ActiveOrderExists")) {
                        refreshPurchasingData()
                    }
                }
                else -> Unit
            }
            _purchasingOverrideSubmitting.value = false
        }
    }

    fun exportPurchasingReport(format: com.example.domain.model.PurchasingExportFormat) {
        if (!purchasingChecker().hasAllPermissions(
                listOf(
                    com.example.core.permissions.Permissions.PURCHASING_REPORT,
                    com.example.core.permissions.Permissions.REPORTS_EXPORT
                )
            )
        ) {
            showNotification("لا تمتلك صلاحية تصدير تقرير المشتريات.")
            return
        }
        if (_purchasingExportingFormat.value != null) return
        viewModelScope.launch {
            _purchasingExportingFormat.value = format
            _purchasingError.value = null
            when (val result = purchaseRepository.exportPurchasingReport(format)) {
                is com.example.core.utils.AppResult.Success -> {
                    try {
                        val share = withContext(Dispatchers.IO) { purchasingExportStore.save(result.data) }
                        _purchasingExportingFormat.value = null
                        _purchasingPendingExportShare.value = share
                    } catch (_: Exception) {
                        _purchasingExportingFormat.value = null
                        _purchasingError.value = "تعذر حفظ ملف التصدير للمشاركة"
                        showNotification("تعذر حفظ ملف التصدير للمشاركة")
                    }
                }
                is com.example.core.utils.AppResult.Error -> {
                    _purchasingExportingFormat.value = null
                    val message = purchasingError(result, "تعذر تصدير تقرير المشتريات")
                    _purchasingError.value = message
                    showNotification(message)
                }
                else -> Unit
            }
        }
    }

    fun consumePurchasingExportShare() {
        _purchasingPendingExportShare.value = null
    }

    fun createSupplier(supplier: com.example.domain.model.Supplier) = runPurchasingAction("تمت إضافة المورد.", "تعذر إضافة المورد") {
        supplierRepository.createSupplier(supplier)
    }

    fun updateSupplier(id: String, supplier: com.example.domain.model.Supplier) = runPurchasingAction("تم تحديث المورد.", "تعذر تحديث المورد") {
        supplierRepository.updateSupplier(id, supplier)
    }

    fun setSupplierStatus(id: String, status: String) = runPurchasingAction(
        if (status == "active") "تم تفعيل المورد." else "تم تعطيل المورد.", "تعذر تغيير حالة المورد"
    ) { supplierRepository.setSupplierStatus(id, status) }

    // ---------------- ATTENDANCE WORKFLOWS (repository-based, permission-keyed) ----------------

    private fun attendanceChecker() =
        com.example.core.permissions.PermissionChecker(authUiState.value.currentSession?.permissions ?: emptySet())

    private fun currentEmployeeId(): String =
        authUiState.value.currentSession?.employeeId?.toString() ?: ""

    private fun attendanceQueryForPermissions(
        permissions: Set<String>
    ): com.example.domain.model.AttendanceQuery = com.example.domain.model.AttendanceQuery(
            scope = attendanceScopeFor(permissions),
            from = _attendanceFromDate.value,
            to = _attendanceToDate.value
        )

    private fun currentAttendanceQuery(): com.example.domain.model.AttendanceQuery =
        attendanceQueryForPermissions(authUiState.value.currentSession?.permissions ?: emptySet())

    private suspend fun refreshAttendanceRepository(): com.example.core.utils.AppResult<Unit> =
        attendanceRepository.refreshAttendance(currentAttendanceQuery())

    fun clockInCurrentUser() {
        val rawPerms = authUiState.value.currentSession?.permissions ?: emptySet()
        // The general manager (admin.full) cannot self-clock — mirrors the backend 403.
        val canClock = rawPerms.contains(com.example.core.permissions.Permissions.ATTENDANCE_CLOCK) &&
            !rawPerms.contains(com.example.core.permissions.Permissions.ADMIN_FULL)
        if (!canClock) {
            showNotification("تسجيل الحضور غير متاح لحساب المدير العام.")
            return
        }
        val empId = currentEmployeeId()
        if (empId.isBlank()) {
            showNotification("تعذّر تحديد هوية الموظف الحالي.")
            return
        }
        viewModelScope.launch {
            val result = attendanceRepository.clockIn(empId)
            if (result is com.example.core.utils.AppResult.Success) {
                showNotification("تم تسجيل حضورك بنجاح في تمام ${result.data.clockInTime}.")
            } else {
                showNotification(mapClockInError(result as com.example.core.utils.AppResult.Error))
            }
        }
    }

    fun clockOutCurrentUser() {
        val checker = attendanceChecker()
        val rawPerms = authUiState.value.currentSession?.permissions ?: emptySet()
        val canClock = rawPerms.contains(com.example.core.permissions.Permissions.ATTENDANCE_CLOCK) &&
            !rawPerms.contains(com.example.core.permissions.Permissions.ADMIN_FULL)
        if (!canClock) {
            showNotification("تسجيل الانصراف غير متاح لحساب المدير العام.")
            return
        }
        val empId = currentEmployeeId()
        if (empId.isBlank()) {
            showNotification("تعذّر تحديد هوية الموظف الحالي.")
            return
        }
        viewModelScope.launch {
            val result = attendanceRepository.clockOut(empId)
            if (result is com.example.core.utils.AppResult.Success) {
                showNotification("تم تسجيل انصرافك في تمام ${result.data.clockOutTime}.")
            } else {
                val msg = (result as? com.example.core.utils.AppResult.Error)?.exception?.message
                showNotification(msg ?: "حدث خطأ أثناء تسجيل الانصراف.")
            }
        }
    }

    fun createManualAttendance(
        employeeId: String,
        date: String,
        status: String,
        clockInTime: String?,
        clockOutTime: String?
    ) {
        val checker = attendanceChecker()
        if (!checker.hasPermission(checker.HR_ATTENDANCE_MANAGE)) {
            showNotification("لا تملك صلاحية الإدخال اليدوي للحضور.")
            return
        }
        val selectedEmployee = attendanceUiState.value.eligibleEmployees
            .firstOrNull { it.employeeId == employeeId }
        if (selectedEmployee == null || !isIsoAttendanceDate(date)) {
            showNotification("اختر موظفاً وتاريخاً صالحين.")
            return
        }
        viewModelScope.launch {
            _attendanceManualSubmitting.value = true
            val result = attendanceRepository.createManualAttendance(
                com.example.domain.model.ManualAttendanceRequest(
                    employeeId = employeeId,
                    date = date,
                    status = status,
                    clockIn = clockInTime,
                    clockOut = clockOutTime
                )
            )
            if (result is com.example.core.utils.AppResult.Success) {
                _attendanceError.value = null
                showNotification("تمت إضافة سجل حضور ${selectedEmployee.name} بنجاح.")
            } else {
                val message = mapAttendanceActionError(result as com.example.core.utils.AppResult.Error)
                _attendanceError.value = message
                showNotification(message)
            }
            _attendanceManualSubmitting.value = false
        }
    }

    fun refreshAttendance() {
        viewModelScope.launch {
            _attendanceLoading.value = true
            _attendanceError.value = null
            val result = refreshAttendanceRepository()
            if (result is com.example.core.utils.AppResult.Error) {
                val message = mapAttendanceActionError(result)
                _attendanceError.value = message
                showNotification(message)
            } else if (attendanceChecker().hasPermission(attendanceChecker().HR_ATTENDANCE_MANAGE)) {
                val eligibleResult = attendanceRepository.refreshEligibleEmployees()
                if (eligibleResult is com.example.core.utils.AppResult.Error) {
                    _attendanceError.value = mapAttendanceActionError(eligibleResult)
                }
            }
            _attendanceLoading.value = false
        }
    }

    // ---------------- LEAVE WORKFLOWS (repository-based, permission-keyed) ----------------

    private fun hasDirectLeavePermission(permission: String): Boolean {
        val permissions = authUiState.value.currentSession?.permissions ?: emptySet()
        return permissions.contains(com.example.core.permissions.Permissions.ADMIN_FULL) ||
            permissions.contains(permission)
    }

    private fun leaveActionError(
        result: com.example.core.utils.AppResult.Error,
        fallback: String
    ): String {
        val serverMessage = (result.appError as? com.example.core.utils.AppError.ServerError)?.message
        return serverMessage?.takeIf { it.isNotBlank() }
            ?: result.exception.message?.takeIf { it.isNotBlank() }
            ?: fallback
    }

    private fun defaultLeaveReportRange(): Pair<String, String> {
        val to = com.example.core.utils.DateUtils.todayIso()
        val from = com.example.core.utils.DateUtils.isoFromEpochMillis(
            System.currentTimeMillis() - (89L * 86_400_000L)
        )
        return from to to
    }

    private fun currentLeaveQuery(includeEmployee: Boolean): com.example.domain.model.LeaveQuery =
        com.example.domain.model.LeaveQuery(
            from = _leaveFromDate.value.takeIf { it.isNotBlank() },
            to = _leaveToDate.value.takeIf { it.isNotBlank() },
            status = _leaveStatusFilter.value.takeUnless { it == "all" },
            leaveType = _leaveTypeFilter.value.takeUnless { it == "all" },
            employeeId = _leaveEmployeeFilter.value.takeIf { includeEmployee }
        )

    private suspend fun refreshCurrentLeaveMode(): com.example.core.utils.AppResult<Unit> {
        _leaveLoading.value = true
        _leaveError.value = null
        val result = when (_leaveMode.value) {
            com.example.domain.model.LeaveScreenMode.MY_REQUESTS ->
                leaveRepository.refreshMyLeaveRequests(currentLeaveQuery(includeEmployee = false))
            com.example.domain.model.LeaveScreenMode.REVIEW ->
                leaveRepository.refreshLeaveReview()
            com.example.domain.model.LeaveScreenMode.REPORT ->
                leaveRepository.refreshLeaveReport(currentLeaveQuery(includeEmployee = true))
        }
        if (result is com.example.core.utils.AppResult.Error) {
            _leaveError.value = leaveActionError(result, "تعذّر تحديث بيانات الإجازات.")
        }
        _leaveLoading.value = false
        return result
    }

    fun selectLeaveMode(mode: com.example.domain.model.LeaveScreenMode) {
        val allowed = when (mode) {
            com.example.domain.model.LeaveScreenMode.MY_REQUESTS -> true
            com.example.domain.model.LeaveScreenMode.REVIEW ->
                canReviewLeaves(authUiState.value.currentSession?.permissions ?: emptySet())
            com.example.domain.model.LeaveScreenMode.REPORT ->
                canViewLeaveReport(authUiState.value.currentSession?.permissions ?: emptySet())
        }
        if (!allowed) {
            showNotification("لا تمتلك صلاحية الوصول إلى هذا القسم.")
            return
        }
        _leaveMode.value = mode
        _leaveEmployeeFilter.value = null
        if (mode == com.example.domain.model.LeaveScreenMode.REPORT &&
            (_leaveFromDate.value.isBlank() || _leaveToDate.value.isBlank())
        ) {
            val (from, to) = defaultLeaveReportRange()
            _leaveFromDate.value = from
            _leaveToDate.value = to
        }
        refreshLeaveRequests()
    }

    fun applyLeaveFilters() {
        if (_leaveMode.value == com.example.domain.model.LeaveScreenMode.REPORT &&
            (_leaveFromDate.value.isBlank() || _leaveToDate.value.isBlank())
        ) {
            _leaveError.value = "يجب تحديد تاريخي البداية والنهاية."
            return
        }
        refreshLeaveRequests()
    }

    fun clearLeaveFilters() {
        _leaveStatusFilter.value = "all"
        _leaveTypeFilter.value = "all"
        _leaveEmployeeFilter.value = null
        if (_leaveMode.value == com.example.domain.model.LeaveScreenMode.REPORT) {
            val (from, to) = defaultLeaveReportRange()
            _leaveFromDate.value = from
            _leaveToDate.value = to
        } else {
            _leaveFromDate.value = ""
            _leaveToDate.value = ""
        }
        refreshLeaveRequests()
    }

    fun submitLeaveRequest(
        leaveType: String,
        startDate: String,
        endDate: String,
        totalDays: Int,
        reason: String,
        exitReentryRequested: Boolean = false,
        visaFeePaid: Boolean = false
    ) {
        if (!hasDirectLeavePermission(com.example.core.permissions.Permissions.LEAVES_CREATE)) {
            showNotification("خطأ: لا تمتلك صلاحية تقديم طلب إجازة!")
            return
        }
        if (currentEmployeeId().isBlank()) {
            showNotification("لا يوجد ملف موظف مرتبط بهذا الحساب.")
            return
        }
        val profile = authUiState.value.userDisplayProfile
        viewModelScope.launch {
            val request = com.example.domain.model.LeaveRequestParams(
                id = "",
                companyId = authUiState.value.currentSession?.companyId?.toString() ?: "1",
                employeeId = currentEmployeeId().ifBlank { "0" },
                employeeName = profile?.fullName ?: authUiState.value.currentUserDisplayName,
                departmentName = profile?.departmentName ?: authUiState.value.currentDepartmentName,
                leaveType = leaveType,
                startDate = startDate,
                endDate = endDate,
                totalDays = totalDays,
                reason = reason,
                status = "قيد المراجعة",
                currentApprovalStep = 1,
                requestedAt = "",
                approvedBy = null,
                approvedAt = null,
                rejectionReason = null,
                createdAt = "",
                updatedAt = null,
                exitReentryRequested = exitReentryRequested,
                visaFeePaid = visaFeePaid,
                rawStatus = "pending_hr",
                rawLeaveType = leaveType
            )
            val result = leaveRepository.submitLeaveRequest(request)
            if (result is com.example.core.utils.AppResult.Success) {
                showNotification("تم تقديم طلب الإجازة ($leaveType) بنجاح وهو الآن قيد المراجعة.")
                _leaveMode.value = com.example.domain.model.LeaveScreenMode.MY_REQUESTS
                refreshCurrentLeaveMode()
            } else {
                showNotification(mapLeaveSubmitError(result as com.example.core.utils.AppResult.Error))
            }
        }
    }

    fun approveLeaveRequest(
        request: com.example.domain.model.LeaveRequestParams,
        note: String? = null
    ) {
        val stage = if (request.isPendingAdmin()) {
            com.example.domain.model.LeaveApprovalStage.ADMIN
        } else {
            com.example.domain.model.LeaveApprovalStage.HR
        }
        val allowed = when (stage) {
            com.example.domain.model.LeaveApprovalStage.ADMIN ->
                hasDirectLeavePermission(com.example.core.permissions.Permissions.ADMIN_FULL)
            com.example.domain.model.LeaveApprovalStage.HR ->
                hasDirectLeavePermission(com.example.core.permissions.Permissions.LEAVES_APPROVE)
        }
        if (!allowed) {
            showNotification("خطأ: لا تمتلك صلاحية اعتماد طلبات الإجازات!")
            return
        }
        if (request.employeeId == currentEmployeeId()) {
            showNotification("لا يمكنك اعتماد طلب إجازتك الشخصي.")
            return
        }
        val approver = note ?: authUiState.value.userDisplayProfile?.fullName
        viewModelScope.launch {
            val result = leaveRepository.approveLeaveRequest(request.id, approver, stage)
            if (result is com.example.core.utils.AppResult.Success) {
                showNotification(
                    if (result.data.rawStatus == "pending_admin")
                        "تمت موافقة الموارد البشرية وتحويل الطلب للإدارة."
                    else "تمت الموافقة على طلب الإجازة."
                )
                refreshCurrentLeaveMode()
            } else {
                showNotification(leaveActionError(result as com.example.core.utils.AppResult.Error, "حدث خطأ أثناء اعتماد الطلب."))
            }
        }
    }

    fun rejectLeaveRequest(request: com.example.domain.model.LeaveRequestParams, reason: String) {
        val stage = if (request.isPendingAdmin()) {
            com.example.domain.model.LeaveApprovalStage.ADMIN
        } else {
            com.example.domain.model.LeaveApprovalStage.HR
        }
        val allowed = when (stage) {
            com.example.domain.model.LeaveApprovalStage.ADMIN ->
                hasDirectLeavePermission(com.example.core.permissions.Permissions.ADMIN_FULL)
            com.example.domain.model.LeaveApprovalStage.HR ->
                hasDirectLeavePermission(com.example.core.permissions.Permissions.LEAVES_APPROVE)
        }
        if (!allowed) {
            showNotification("خطأ: لا تمتلك صلاحية رفض طلبات الإجازات!")
            return
        }
        if (request.employeeId == currentEmployeeId()) {
            showNotification("لا يمكنك رفض طلب إجازتك الشخصي.")
            return
        }
        viewModelScope.launch {
            val result = leaveRepository.rejectLeaveRequest(request.id, reason, stage)
            if (result is com.example.core.utils.AppResult.Success) {
                showNotification("تم رفض طلب الإجازة.")
                refreshCurrentLeaveMode()
            } else {
                showNotification(leaveActionError(result as com.example.core.utils.AppResult.Error, "حدث خطأ أثناء رفض الطلب."))
            }
        }
    }

    fun requestLeaveCancellation(request: com.example.domain.model.LeaveRequestParams) {
        if (!com.example.domain.model.canCancelOwnLeave(request, currentEmployeeId())) {
            showNotification("يمكن إلغاء طلبك فقط أثناء مراجعة الموارد البشرية.")
            return
        }
        _leaveCancelTarget.value = request
    }

    fun dismissLeaveCancellation() {
        _leaveCancelTarget.value = null
    }

    fun confirmLeaveCancellation() {
        val request = _leaveCancelTarget.value ?: return
        _leaveCancelTarget.value = null
        viewModelScope.launch {
            _leaveLoading.value = true
            val result = leaveRepository.cancelLeaveRequest(request.id)
            if (result is com.example.core.utils.AppResult.Success) {
                showNotification("تم إلغاء طلب الإجازة.")
                _leaveMode.value = com.example.domain.model.LeaveScreenMode.MY_REQUESTS
                refreshCurrentLeaveMode()
            } else {
                _leaveLoading.value = false
                val error = leaveActionError(result as com.example.core.utils.AppResult.Error, "حدث خطأ أثناء إلغاء الطلب.")
                _leaveError.value = error
                showNotification(error)
            }
        }
    }

    fun refreshLeaveRequests() {
        viewModelScope.launch {
            refreshCurrentLeaveMode()
        }
    }

    // ---------------- PAYROLL WORKFLOWS (repository-based, permission-keyed) ----------------

    private fun payrollChecker() =
        com.example.core.permissions.PermissionChecker(authUiState.value.currentSession?.permissions ?: emptySet())

    private suspend fun updatePayrollSummary() {
        val result = payrollRepository.getPayrollSummary()
        if (result is com.example.core.utils.AppResult.Success) {
            _payrollRuntime.update { it.copy(summary = result.data) }
        }
    }

    private fun applyPayrollError(
        result: com.example.core.utils.AppResult.Error,
        fallback: String
    ) {
        val workflow = result.exception as? com.example.domain.model.PayrollWorkflowException
        val message = result.exception.message?.takeIf { it.isNotBlank() } ?: fallback
        _payrollRuntime.update {
            it.copy(
                isLoading = false,
                errorMessage = message,
                blockers = workflow?.blockers.orEmpty(),
                protectedEmployeeIssues = workflow?.protectedEmployeeIssues ?: 0
            )
        }
        showNotification(message)
    }

    fun openPayrollCreateDialog() {
        if (!payrollChecker().hasPermission(com.example.core.permissions.Permissions.PAYROLL_MANAGE)) {
            showNotification("لا تمتلك صلاحية إنشاء فترة رواتب.")
            return
        }
        _payrollRuntime.update { it.copy(showCreateDialog = true, errorMessage = null) }
    }

    fun dismissPayrollDialogs() {
        _payrollRuntime.update {
            it.copy(
                showCreateDialog = false,
                calculationTargetId = null,
                approvalTargetId = null,
                paidTargetId = null,
                recalculationReason = "",
                showRecordPaymentDialog = false,
                recordPaymentIdempotencyKey = "",
                voidPaymentTarget = null
            )
        }
    }

    fun createPayrollPeriod(month: Int, year: Int) {
        if (!payrollChecker().hasPermission(com.example.core.permissions.Permissions.PAYROLL_MANAGE)) {
            showNotification("لا تمتلك صلاحية إنشاء فترة رواتب.")
            return
        }
        viewModelScope.launch {
            _payrollRuntime.update { it.copy(isLoading = true, errorMessage = null) }
            when (val result = payrollRepository.createPayrollPeriod(month, year)) {
                is com.example.core.utils.AppResult.Success -> {
                    _payrollRuntime.update {
                        it.copy(
                            isLoading = false,
                            showCreateDialog = false,
                            selectedPeriodId = result.data.id,
                            details = null
                        )
                    }
                    updatePayrollSummary()
                    loadPayrollItems(result.data.id)
                    showNotification("تم إنشاء فترة رواتب ${result.data.month}/${result.data.year} كمسودة.")
                }
                is com.example.core.utils.AppResult.Error -> applyPayrollError(
                    result,
                    "تعذر إنشاء فترة الرواتب"
                )
                else -> Unit
            }
        }
    }

    private fun loadPayrollItems(periodId: String) {
        viewModelScope.launch {
            _payrollRuntime.update { it.copy(isLoading = true, errorMessage = null) }
            when (val result = payrollRepository.loadPayrollItems(periodId)) {
                is com.example.core.utils.AppResult.Success -> _payrollRuntime.update {
                    it.copy(
                        isLoading = false,
                        details = result.data,
                        blockers = emptyList(),
                        protectedEmployeeIssues = 0
                    )
                }
                is com.example.core.utils.AppResult.Error -> applyPayrollError(
                    result,
                    "تعذر تحميل عناصر الرواتب"
                )
                else -> Unit
            }
        }
    }

    fun requestPayrollCalculation(periodId: String) {
        if (!payrollChecker().hasPermission(com.example.core.permissions.Permissions.PAYROLL_MANAGE)) {
            showNotification("لا تمتلك صلاحية احتساب الرواتب.")
            return
        }
        _payrollRuntime.update {
            it.copy(calculationTargetId = periodId, recalculationReason = "", errorMessage = null)
        }
    }

    fun updatePayrollRecalculationReason(reason: String) {
        _payrollRuntime.update { it.copy(recalculationReason = reason.take(500)) }
    }

    fun confirmPayrollCalculation() {
        val runtime = _payrollRuntime.value
        val periodId = runtime.calculationTargetId ?: return
        viewModelScope.launch {
            _payrollRuntime.update { it.copy(isLoading = true, errorMessage = null) }
            when (val result = payrollRepository.calculatePayrollPeriod(
                periodId,
                runtime.recalculationReason.trim().takeIf { it.isNotEmpty() }
            )) {
                is com.example.core.utils.AppResult.Success -> {
                    _payrollRuntime.update {
                        it.copy(
                            isLoading = false,
                            selectedPeriodId = periodId,
                            details = result.data.details,
                            calculationTargetId = null,
                            recalculationReason = "",
                            blockers = emptyList(),
                            protectedEmployeeIssues = result.data.protectedEmployeeIssues,
                            errorMessage = null
                        )
                    }
                    updatePayrollSummary()
                    val message = when {
                        result.data.idempotent -> "الاحتساب مطابق للبيانات الحالية ولم تتم إعادة كتابة العناصر."
                        result.data.recalculated -> "تمت إعادة احتساب فترة الرواتب بنجاح."
                        else -> "تم احتساب فترة الرواتب بنجاح."
                    }
                    showNotification(message)
                }
                is com.example.core.utils.AppResult.Error -> applyPayrollError(
                    result,
                    "تعذر احتساب فترة الرواتب"
                )
                else -> Unit
            }
        }
    }

    fun requestPayrollApproval(periodId: String) {
        if (!payrollChecker().hasPermission(com.example.core.permissions.Permissions.PAYROLL_APPROVE)) {
            showNotification("لا تمتلك صلاحية اعتماد فترة الرواتب.")
            return
        }
        _payrollRuntime.update { it.copy(approvalTargetId = periodId, errorMessage = null) }
    }

    fun confirmPayrollApproval() {
        val periodId = _payrollRuntime.value.approvalTargetId ?: return
        viewModelScope.launch {
            _payrollRuntime.update { it.copy(isLoading = true, errorMessage = null) }
            when (val result = payrollRepository.approvePayrollPeriod(periodId)) {
                is com.example.core.utils.AppResult.Success -> {
                    _payrollRuntime.update {
                        it.copy(isLoading = false, approvalTargetId = null, errorMessage = null)
                    }
                    updatePayrollSummary()
                    if (payrollChecker().hasPermission(com.example.core.permissions.Permissions.PAYROLL_REPORT)) {
                        loadPayrollReport(periodId)
                    }
                    showNotification(result.data.message)
                }
                is com.example.core.utils.AppResult.Error -> applyPayrollError(
                    result,
                    "تعذر اعتماد فترة الرواتب"
                )
                else -> Unit
            }
        }
    }

    fun requestPayrollPaid(periodId: String) {
        if (!payrollChecker().hasPermission(com.example.core.permissions.Permissions.PAYROLL_PAY)) {
            showNotification("لا تمتلك صلاحية تأكيد دفع فترة الرواتب.")
            return
        }
        _payrollRuntime.update { it.copy(paidTargetId = periodId, errorMessage = null) }
    }

    fun confirmPayrollPaid() {
        val periodId = _payrollRuntime.value.paidTargetId ?: return
        viewModelScope.launch {
            _payrollRuntime.update { it.copy(isLoading = true, errorMessage = null) }
            when (val result = payrollRepository.markPayrollPeriodPaid(periodId)) {
                is com.example.core.utils.AppResult.Success -> {
                    _payrollRuntime.update {
                        it.copy(isLoading = false, paidTargetId = null, errorMessage = null)
                    }
                    updatePayrollSummary()
                    if (payrollChecker().hasPermission(com.example.core.permissions.Permissions.PAYROLL_REPORT)) {
                        loadPayrollReport(periodId)
                    }
                    showNotification(result.data.message)
                }
                is com.example.core.utils.AppResult.Error -> applyPayrollError(
                    result,
                    "تعذر تأكيد حالة الدفع"
                )
                else -> Unit
            }
        }
    }

    fun loadPayrollReport(periodId: String) {
        if (!payrollChecker().hasPermission(com.example.core.permissions.Permissions.PAYROLL_REPORT)) {
            showNotification("لا تمتلك صلاحية عرض تقرير الرواتب.")
            return
        }
        viewModelScope.launch {
            _payrollRuntime.update { it.copy(isLoading = true, errorMessage = null) }
            when (val result = payrollRepository.loadPayrollReport(periodId)) {
                is com.example.core.utils.AppResult.Success -> _payrollRuntime.update {
                    it.copy(isLoading = false, report = result.data, errorMessage = null)
                }
                is com.example.core.utils.AppResult.Error -> applyPayrollError(
                    result,
                    "تعذر تحميل تقرير الرواتب"
                )
                else -> Unit
            }
        }
    }

    private suspend fun loadLatestPayrollReport() {
        if (!payrollChecker().hasPermission(com.example.core.permissions.Permissions.PAYROLL_REPORT)) return
        val latest = payrollRepository.observePayrollPeriods().first()
            .filter { it.status == "approved" || it.status == "paid" }
            .maxByOrNull { it.year * 12 + it.month }
            ?: return
        when (val result = payrollRepository.loadPayrollReport(latest.id)) {
            is com.example.core.utils.AppResult.Success -> _payrollRuntime.update {
                it.copy(report = result.data, errorMessage = null)
            }
            is com.example.core.utils.AppResult.Error -> applyPayrollError(
                result,
                "تعذر تحميل أحدث تقرير رواتب"
            )
            else -> Unit
        }
    }

    fun refreshPayroll() {
        viewModelScope.launch {
            _payrollRuntime.update { it.copy(isLoading = true, errorMessage = null) }
            when (val result = payrollRepository.refreshPayroll()) {
                is com.example.core.utils.AppResult.Success -> {
                    updatePayrollSummary()
                    val selected = _payrollRuntime.value.selectedPeriodId
                    if (selected != null) {
                        loadPayrollItems(selected)
                        loadPayrollPayments(selected)
                    }
                    _payrollRuntime.update { it.copy(isLoading = false) }
                }
                is com.example.core.utils.AppResult.Error -> applyPayrollError(
                    result,
                    "تعذر تحديث بيانات الرواتب"
                )
                else -> Unit
            }
        }
    }

    // ---------------- PAYROLL PARTIAL PAYMENTS + EXPORTS (Sprint 12H, v2) ----------------

    private fun loadPayrollPayments(periodId: String) {
        if (!payrollChecker().hasPermission(com.example.core.permissions.Permissions.PAYROLL_PAYMENTS_VIEW)) return
        viewModelScope.launch {
            _payrollRuntime.update { it.copy(paymentsLoading = true) }
            when (val result = payrollRepository.loadPayrollPayments(periodId)) {
                is com.example.core.utils.AppResult.Success -> _payrollRuntime.update {
                    it.copy(
                        paymentsLoading = false,
                        payments = result.data,
                        paymentsLoadedForPeriodId = periodId
                    )
                }
                is com.example.core.utils.AppResult.Error -> {
                    _payrollRuntime.update { it.copy(paymentsLoading = false) }
                    applyPayrollError(result, "تعذر تحميل دفعات الرواتب")
                }
                else -> Unit
            }
        }
    }

    fun openRecordPaymentDialog() {
        val periodId = _payrollRuntime.value.selectedPeriodId
        val period = periodId?.let { id -> payrollUiState.value.periods.firstOrNull { it.id == id } }
        if (!payrollChecker().hasPermission(com.example.core.permissions.Permissions.PAYROLL_PAYMENTS_RECORD)) {
            showNotification("لا تمتلك صلاحية تسجيل دفعات الرواتب.")
            return
        }
        if (period == null || !period.canRecordPayment()) {
            showNotification("اختر فترة رواتب معتمدة أو مدفوعة أولاً.")
            return
        }
        _payrollRuntime.update {
            it.copy(
                showRecordPaymentDialog = true,
                recordPaymentIdempotencyKey = UUID.randomUUID().toString(),
                errorMessage = null
            )
        }
    }

    /**
     * `amount` stays a raw String end-to-end (never Double/Float) — the server is the
     * single source of truth for validation, rounding, and the overpayment check.
     */
    fun submitPayrollPayment(amount: String, paymentDate: String, reference: String?, note: String?) {
        val periodId = _payrollRuntime.value.selectedPeriodId
        if (periodId == null) {
            showNotification("اختر فترة رواتب أولاً.")
            return
        }
        val trimmedAmount = amount.trim()
        val parsedAmount = trimmedAmount.toBigDecimalOrNull()
        if (parsedAmount == null || parsedAmount <= java.math.BigDecimal.ZERO) {
            showNotification("أدخل قيمة دفعة صحيحة أكبر من صفر.")
            return
        }
        if (paymentDate.isBlank()) {
            showNotification("أدخل تاريخ الدفعة.")
            return
        }
        val idempotencyKey = _payrollRuntime.value.recordPaymentIdempotencyKey
            .ifBlank { UUID.randomUUID().toString() }
        viewModelScope.launch {
            val period = payrollRepository.observePayrollPeriods().first().firstOrNull { it.id == periodId }
            if (period == null) {
                showNotification("فترة الرواتب غير موجودة.")
                return@launch
            }
            _payrollRuntime.update { it.copy(isLoading = true, errorMessage = null) }
            when (
                val result = payrollRepository.recordPayrollPayment(
                    periodId,
                    com.example.domain.model.PayrollRecordPaymentRequest(
                        amount = trimmedAmount,
                        currency = "SAR",
                        paymentDate = paymentDate,
                        reference = reference?.trim()?.takeIf { it.isNotEmpty() },
                        note = note?.trim()?.takeIf { it.isNotEmpty() },
                        expectedVersion = period.paymentVersion
                    ),
                    idempotencyKey
                )
            ) {
                is com.example.core.utils.AppResult.Success -> {
                    _payrollRuntime.update {
                        it.copy(
                            isLoading = false,
                            showRecordPaymentDialog = false,
                            recordPaymentIdempotencyKey = "",
                            errorMessage = null
                        )
                    }
                    loadPayrollPayments(periodId)
                    updatePayrollSummary()
                    showNotification("تم تسجيل الدفعة بنجاح.")
                }
                is com.example.core.utils.AppResult.Error -> applyPayrollError(result, "تعذر تسجيل الدفعة")
                else -> Unit
            }
        }
    }

    fun requestVoidPayment(payment: com.example.domain.model.PayrollPaymentParams) {
        if (!payrollChecker().hasPermission(com.example.core.permissions.Permissions.PAYROLL_PAYMENTS_VOID)) {
            showNotification("لا تمتلك صلاحية إلغاء دفعات الرواتب.")
            return
        }
        _payrollRuntime.update { it.copy(voidPaymentTarget = payment, errorMessage = null) }
    }

    fun confirmVoidPayment(reason: String) {
        val periodId = _payrollRuntime.value.selectedPeriodId
        val target = _payrollRuntime.value.voidPaymentTarget
        if (periodId == null || target == null) return
        if (reason.trim().isEmpty()) {
            showNotification("أدخل سبب إلغاء الدفعة.")
            return
        }
        viewModelScope.launch {
            val period = payrollRepository.observePayrollPeriods().first().firstOrNull { it.id == periodId }
            if (period == null) {
                showNotification("فترة الرواتب غير موجودة.")
                return@launch
            }
            _payrollRuntime.update { it.copy(isLoading = true, errorMessage = null) }
            when (
                val result = payrollRepository.voidPayrollPayment(
                    periodId,
                    target.id,
                    com.example.domain.model.PayrollVoidPaymentRequest(
                        reason = reason.trim(),
                        expectedVersion = period.paymentVersion
                    )
                )
            ) {
                is com.example.core.utils.AppResult.Success -> {
                    _payrollRuntime.update {
                        it.copy(isLoading = false, voidPaymentTarget = null, errorMessage = null)
                    }
                    loadPayrollPayments(periodId)
                    updatePayrollSummary()
                    showNotification("تم إلغاء الدفعة.")
                }
                is com.example.core.utils.AppResult.Error -> applyPayrollError(result, "تعذر إلغاء الدفعة")
                else -> Unit
            }
        }
    }

    fun exportPayrollPeriod(format: com.example.domain.model.PayrollExportFormat) {
        val periodId = _payrollRuntime.value.selectedPeriodId
        if (periodId == null) {
            showNotification("اختر فترة رواتب أولاً.")
            return
        }
        if (!payrollChecker().hasAllPermissions(
                listOf(
                    com.example.core.permissions.Permissions.PAYROLL_REPORT,
                    com.example.core.permissions.Permissions.REPORTS_EXPORT
                )
            )
        ) {
            showNotification("لا تمتلك صلاحية تصدير مسير الرواتب.")
            return
        }
        if (_payrollRuntime.value.exportingFormat != null) return
        viewModelScope.launch {
            _payrollRuntime.update { it.copy(exportingFormat = format, errorMessage = null) }
            when (val result = payrollRepository.exportPayrollPeriod(periodId, format)) {
                is com.example.core.utils.AppResult.Success -> {
                    try {
                        val share = withContext(Dispatchers.IO) { payrollExportStore.save(result.data) }
                        _payrollRuntime.update {
                            it.copy(exportingFormat = null, pendingPaymentExportShare = share, errorMessage = null)
                        }
                    } catch (_: Exception) {
                        _payrollRuntime.update {
                            it.copy(exportingFormat = null, errorMessage = "تعذر حفظ ملف التصدير للمشاركة")
                        }
                    }
                }
                is com.example.core.utils.AppResult.Error -> {
                    _payrollRuntime.update { it.copy(exportingFormat = null) }
                    applyPayrollError(result, "تعذر تصدير مسير الرواتب")
                }
                else -> Unit
            }
        }
    }

    fun consumePayrollExportShare() {
        _payrollRuntime.update { it.copy(pendingPaymentExportShare = null) }
    }

    // ---------------- CHAT WORKFLOWS ----------------

    private fun hasChatPermission(): Boolean = com.example.core.permissions.PermissionChecker(
        authUiState.value.currentSession?.permissions ?: emptySet()
    ).hasPermission(com.example.core.permissions.Permissions.CHAT_VIEW)

    private fun chatAccessState(canUseChat: Boolean): ChatUiState {
        val permissions = authUiState.value.currentSession?.permissions ?: emptySet()
        val checker = com.example.core.permissions.PermissionChecker(permissions)
        return ChatUiState(
            canUseChat = canUseChat,
            canCreateDirect = canUseChat &&
                checker.hasPermission(com.example.core.permissions.Permissions.CHAT_CREATE_DIRECT),
            canCreateDepartment = canUseChat &&
                checker.hasPermission(com.example.core.permissions.Permissions.CHAT_CREATE_DEPARTMENT),
            canCreateAnnouncement = canUseChat &&
                checker.hasPermission(com.example.core.permissions.Permissions.CHAT_CREATE_COMPANY_ANNOUNCEMENT),
            canPin = canUseChat &&
                checker.hasPermission(com.example.core.permissions.Permissions.CHAT_PIN)
        )
    }

    private fun stopChatPolling() {
        chatPollingJob?.cancel()
        chatPollingJob = null
        chatPollRequestRunning = false
        _chatUiState.update { it.copy(isPolling = false) }
    }

    private fun cancelChatDirectorySearch() {
        chatDirectorySearchJob?.cancel()
        chatDirectorySearchJob = null
        chatDirectorySearchSeq += 1
    }

    private suspend fun refreshChatData(showLoading: Boolean = true) {
        val sessionKey = activeChatSessionKey ?: return
        if (!hasChatPermission()) {
            _chatUiState.value = chatAccessState(false)
            return
        }
        if (_chatUiState.value.isLoading) return
        if (showLoading) {
            val access = chatAccessState(true)
            _chatUiState.update {
                it.copy(
                    isLoading = true,
                    errorMessage = null,
                    canUseChat = true,
                    canCreateDirect = access.canCreateDirect,
                    canCreateDepartment = access.canCreateDepartment,
                    canCreateAnnouncement = access.canCreateAnnouncement,
                    canPin = access.canPin
                )
            }
        }

        var errorMessage: String? = null
        when (val result = chatRepository.listConversations()) {
            is com.example.core.utils.AppResult.Success -> if (activeChatSessionKey == sessionKey) {
                _chatUiState.update { state ->
                    val selected = state.selectedConversation?.id?.let { selectedId ->
                        result.data.items.firstOrNull { it.id == selectedId }
                    } ?: state.selectedConversation
                    state.copy(conversations = result.data.items, selectedConversation = selected)
                }
            }
            is com.example.core.utils.AppResult.Error -> {
                errorMessage = errorText(result, "تعذّر تحميل المحادثات")
            }
            else -> Unit
        }
        when (val result = chatRepository.listAccessibleDepartments()) {
            is com.example.core.utils.AppResult.Success -> if (activeChatSessionKey == sessionKey) {
                _chatUiState.update { it.copy(departments = result.data) }
            }
            is com.example.core.utils.AppResult.Error -> if (errorMessage == null) {
                errorMessage = errorText(result, "تعذّر تحميل قنوات الأقسام")
            }
            else -> Unit
        }
        when (val result = chatRepository.getUnreadCount()) {
            is com.example.core.utils.AppResult.Success -> if (activeChatSessionKey == sessionKey) {
                _chatUiState.update { it.copy(totalUnread = result.data) }
            }
            is com.example.core.utils.AppResult.Error -> if (errorMessage == null) {
                errorMessage = errorText(result, "تعذّر تحميل الرسائل غير المقروءة")
            }
            else -> Unit
        }
        if (activeChatSessionKey == sessionKey) {
            _chatUiState.update { it.copy(isLoading = false, errorMessage = errorMessage) }
        }
    }

    fun updateChatDraft(text: String) {
        _chatUiState.update { it.copy(messageDraft = text, errorMessage = null) }
    }

    fun updateChatDirectoryQuery(text: String) {
        _chatUiState.update { it.copy(directoryQuery = text.take(100), errorMessage = null) }
    }

    fun ensureChatDirectoryBrowse() {
        val state = _chatUiState.value
        if (!state.canUseChat || !state.canCreateDirect) return
        if (state.directoryHasLoaded || state.isSearchingDirectory) return
        searchChatDirectory()
    }

    fun clearChatDirectoryTransientState() {
        cancelChatDirectorySearch()
        _chatUiState.update {
            it.copy(
                directoryQuery = "",
                directoryResults = emptyList(),
                directoryHasLoaded = false,
                isSearchingDirectory = false,
                isOpeningConversation = false,
                errorMessage = null
            )
        }
    }

    fun searchChatDirectory() {
        val sessionKey = activeChatSessionKey ?: return
        if (!hasChatPermission()) return
        val query = _chatUiState.value.directoryQuery
        val seq = ++chatDirectorySearchSeq
        chatDirectorySearchJob?.cancel()
        _chatUiState.update { it.copy(isSearchingDirectory = true, errorMessage = null) }
        chatDirectorySearchJob = viewModelScope.launch {
            when (val result = chatRepository.searchDirectory(query)) {
                is com.example.core.utils.AppResult.Success -> {
                    if (activeChatSessionKey != sessionKey || seq != chatDirectorySearchSeq) return@launch
                    _chatUiState.update {
                        it.copy(
                            isSearchingDirectory = false,
                            directoryResults = result.data,
                            directoryHasLoaded = true,
                            errorMessage = null
                        )
                    }
                }
                is com.example.core.utils.AppResult.Error -> {
                    if (activeChatSessionKey != sessionKey || seq != chatDirectorySearchSeq) return@launch
                    _chatUiState.update {
                        it.copy(
                            isSearchingDirectory = false,
                            directoryHasLoaded = true,
                            errorMessage = errorText(result, "تعذّر البحث في دليل الموظفين")
                        )
                    }
                }
                else -> Unit
            }
        }
    }

    fun openDirectChat(userId: String) {
        val sessionKey = activeChatSessionKey ?: return
        val state = _chatUiState.value
        if (!ChatUiRules.canStartDirect(
            canCreateDirect = state.canCreateDirect,
            isOpening = state.isOpeningConversation,
            userId = userId,
            isLoadingMessages = state.isLoadingMessages
        )) {
            if (!state.canCreateDirect && state.canUseChat) {
                _chatUiState.update {
                    it.copy(errorMessage = "يمكنك عرض المحادثات، لكن ليس لديك صلاحية بدء محادثة مباشرة.")
                }
            }
            return
        }
        _chatUiState.update {
            it.copy(
                isOpeningConversation = true,
                isLoadingMessages = true,
                errorMessage = null
            )
        }
        viewModelScope.launch {
            finishOpeningConversation(chatRepository.openDirect(userId), sessionKey)
        }
    }

    fun openDepartmentChat(departmentId: String) {
        val sessionKey = activeChatSessionKey ?: return
        val state = _chatUiState.value
        if (!ChatUiRules.canStartDepartment(
                canCreateDepartment = state.canCreateDepartment,
                isOpening = state.isOpeningConversation,
                departmentId = departmentId,
                isLoadingMessages = state.isLoadingMessages
            )
        ) {
            if (!state.canCreateDepartment && state.canUseChat) {
                _chatUiState.update {
                    it.copy(errorMessage = "يمكنك عرض المحادثات، لكن ليس لديك صلاحية فتح قناة قسم.")
                }
            }
            return
        }
        _chatUiState.update {
            it.copy(
                isOpeningConversation = true,
                isLoadingMessages = true,
                errorMessage = null
            )
        }
        viewModelScope.launch {
            finishOpeningConversation(chatRepository.openDepartment(departmentId), sessionKey)
        }
    }

    fun openChatConversation(conversationId: String) {
        val sessionKey = activeChatSessionKey ?: return
        val conversation = _chatUiState.value.conversations.firstOrNull { it.id == conversationId }
            ?: return
        if (_chatUiState.value.isLoadingMessages || _chatUiState.value.isOpeningConversation) return
        _chatUiState.update { it.copy(isLoadingMessages = true, errorMessage = null) }
        viewModelScope.launch {
            loadConversation(conversation, sessionKey)
        }
    }

    private suspend fun finishOpeningConversation(
        result: com.example.core.utils.AppResult<com.example.domain.model.ChatConversationParams>,
        sessionKey: String
    ) {
        when (result) {
            is com.example.core.utils.AppResult.Success -> loadConversation(result.data, sessionKey)
            is com.example.core.utils.AppResult.Error -> if (activeChatSessionKey == sessionKey) {
                _chatUiState.update {
                    it.copy(
                        isOpeningConversation = false,
                        isLoadingMessages = false,
                        errorMessage = errorText(result, "تعذّر فتح المحادثة")
                    )
                }
            }
            else -> Unit
        }
    }

    private suspend fun loadConversation(
        conversation: com.example.domain.model.ChatConversationParams,
        sessionKey: String
    ) {
        if (activeChatSessionKey != sessionKey) return
        _chatUiState.update {
            it.copy(
                selectedConversation = conversation,
                messages = emptyList(),
                pins = emptyList(),
                nextMessageCursor = null,
                replyToMessageId = null,
                errorMessage = null
            )
        }
        when (val result = chatRepository.loadMessages(conversation.id)) {
            is com.example.core.utils.AppResult.Success -> if (activeChatSessionKey == sessionKey) {
                _chatUiState.update {
                    it.copy(
                        isOpeningConversation = false,
                        isLoadingMessages = false,
                        messages = result.data.items,
                        nextMessageCursor = result.data.nextCursor,
                        errorMessage = null
                    )
                }
                markConversationReadInternal(conversation.id, sessionKey)
                refreshChatPinsInternal(conversation.id, sessionKey)
                refreshChatMetadata(sessionKey)
            }
            is com.example.core.utils.AppResult.Error -> if (activeChatSessionKey == sessionKey) {
                _chatUiState.update {
                    it.copy(
                        isOpeningConversation = false,
                        isLoadingMessages = false,
                        errorMessage = errorText(result, "تعذّر تحميل الرسائل")
                    )
                }
            }
            else -> Unit
        }
    }

    fun closeChatConversation() {
        stopChatPolling()
        _chatUiState.update {
            it.copy(
                selectedConversation = null,
                messages = emptyList(),
                pins = emptyList(),
                nextMessageCursor = null,
                messageDraft = "",
                replyToMessageId = null,
                isLoadingMessages = false,
                isOpeningConversation = false,
                isLoadingOlder = false,
                isPinning = false,
                errorMessage = null
            )
        }
    }

    fun setChatReplyToMessage(messageId: String?) {
        val conversation = _chatUiState.value.selectedConversation ?: return
        if (messageId != null && !ChatUiRules.canComposeWithPeer(
            conversation.repliesEnabled,
            conversation.peer?.status
        )) return
        _chatUiState.update { it.copy(replyToMessageId = messageId, errorMessage = null) }
    }

    fun createChatAnnouncement(title: String, body: String? = null) {
        val state = _chatUiState.value
        if (!state.canCreateAnnouncement) {
            _chatUiState.update { it.copy(errorMessage = "لا تملك صلاحية إنشاء إعلان") }
            return
        }
        if (!ChatUiRules.canCreateAnnouncement(state.canCreateAnnouncement, state.isCreatingAnnouncement, title)) {
            return
        }
        val sessionKey = activeChatSessionKey ?: return
        _chatUiState.update { it.copy(isCreatingAnnouncement = true, errorMessage = null) }
        viewModelScope.launch {
            when (val result = chatRepository.createAnnouncement(title.trim(), body?.trim()?.ifBlank { null })) {
                is com.example.core.utils.AppResult.Success -> if (activeChatSessionKey == sessionKey) {
                    _chatUiState.update { it.copy(isCreatingAnnouncement = false) }
                    refreshChatData(showLoading = false)
                    loadConversation(result.data, sessionKey)
                }
                is com.example.core.utils.AppResult.Error -> if (activeChatSessionKey == sessionKey) {
                    _chatUiState.update {
                        it.copy(
                            isCreatingAnnouncement = false,
                            errorMessage = errorText(result, "تعذّر إنشاء الإعلان")
                        )
                    }
                }
                else -> Unit
            }
        }
    }

    fun refreshChatPins() {
        val conversationId = _chatUiState.value.selectedConversation?.id ?: return
        val sessionKey = activeChatSessionKey ?: return
        viewModelScope.launch {
            refreshChatPinsInternal(conversationId, sessionKey)
        }
    }

    private suspend fun refreshChatPinsInternal(conversationId: String, sessionKey: String) {
        when (val result = chatRepository.listPins(conversationId)) {
            is com.example.core.utils.AppResult.Success -> if (activeChatSessionKey == sessionKey) {
                _chatUiState.update { current ->
                    if (current.selectedConversation?.id != conversationId) current
                    else current.copy(pins = result.data, errorMessage = current.errorMessage)
                }
            }
            is com.example.core.utils.AppResult.Error -> if (activeChatSessionKey == sessionKey) {
                _chatUiState.update {
                    if (it.selectedConversation?.id != conversationId) it
                    else it.copy(errorMessage = errorText(result, "تعذّر تحميل الرسائل المثبتة"))
                }
            }
            else -> Unit
        }
    }

    fun pinChatMessage(messageId: String) {
        val state = _chatUiState.value
        val conversationId = state.selectedConversation?.id ?: return
        if (!ChatUiRules.canPinMessage(
                state.canPin,
                state.isPinning,
                messageId,
                alreadyPinned = state.pins.any { it.messageId == messageId }
            )
        ) {
            return
        }
        val sessionKey = activeChatSessionKey ?: return
        _chatUiState.update { it.copy(isPinning = true, errorMessage = null) }
        viewModelScope.launch {
            when (val result = chatRepository.pinMessage(conversationId, messageId)) {
                is com.example.core.utils.AppResult.Success -> if (activeChatSessionKey == sessionKey) {
                    _chatUiState.update { it.copy(isPinning = false) }
                    refreshChatPinsInternal(conversationId, sessionKey)
                }
                is com.example.core.utils.AppResult.Error -> if (activeChatSessionKey == sessionKey) {
                    _chatUiState.update {
                        it.copy(
                            isPinning = false,
                            errorMessage = errorText(result, "تعذّر تثبيت الرسالة")
                        )
                    }
                }
                else -> Unit
            }
        }
    }

    fun unpinChatMessage(messageId: String) {
        val state = _chatUiState.value
        val conversationId = state.selectedConversation?.id ?: return
        if (!ChatUiRules.canUnpinMessage(
                state.canPin,
                state.isPinning,
                messageId,
                isPinned = state.pins.any { it.messageId == messageId }
            )
        ) {
            return
        }
        val sessionKey = activeChatSessionKey ?: return
        _chatUiState.update { it.copy(isPinning = true, errorMessage = null) }
        viewModelScope.launch {
            when (val result = chatRepository.unpinMessage(conversationId, messageId)) {
                is com.example.core.utils.AppResult.Success -> if (activeChatSessionKey == sessionKey) {
                    _chatUiState.update { it.copy(isPinning = false) }
                    refreshChatPinsInternal(conversationId, sessionKey)
                }
                is com.example.core.utils.AppResult.Error -> if (activeChatSessionKey == sessionKey) {
                    _chatUiState.update {
                        it.copy(
                            isPinning = false,
                            errorMessage = errorText(result, "تعذّر إلغاء تثبيت الرسالة")
                        )
                    }
                }
                else -> Unit
            }
        }
    }

    fun loadOlderChatMessages() {
        val state = _chatUiState.value
        val conversationId = state.selectedConversation?.id ?: return
        val cursor = state.nextMessageCursor ?: return
        val sessionKey = activeChatSessionKey ?: return
        if (state.isLoadingOlder || state.isLoadingMessages) return
        _chatUiState.update { it.copy(isLoadingOlder = true, errorMessage = null) }
        viewModelScope.launch {
            when (val result = chatRepository.loadMessages(conversationId, cursor)) {
                is com.example.core.utils.AppResult.Success -> if (activeChatSessionKey == sessionKey) {
                    _chatUiState.update {
                        it.copy(
                            isLoadingOlder = false,
                            messages = ChatUiRules.mergeMessages(result.data.items, it.messages),
                            nextMessageCursor = result.data.nextCursor
                        )
                    }
                }
                is com.example.core.utils.AppResult.Error -> if (activeChatSessionKey == sessionKey) {
                    _chatUiState.update {
                        it.copy(
                            isLoadingOlder = false,
                            errorMessage = errorText(result, "تعذّر تحميل الرسائل الأقدم")
                        )
                    }
                }
                else -> Unit
            }
        }
    }

    fun sendChatMessage(replyToMessageId: String? = null) {
        val state = _chatUiState.value
        val conversation = state.selectedConversation
        val conversationId = conversation?.id
        val repliesEnabled = ChatUiRules.canComposeWithPeer(
            conversation?.repliesEnabled ?: true,
            conversation?.peer?.status
        )
        val replyId = replyToMessageId ?: state.replyToMessageId
        if (!hasChatPermission()) {
            _chatUiState.update { it.copy(errorMessage = "لا تملك صلاحية استخدام المحادثة") }
            return
        }
        if (!ChatUiRules.canSend(state.messageDraft, state.isSending, conversationId, repliesEnabled)) {
            if (ChatUiRules.shouldShowInactivePeerBanner(conversation?.type.orEmpty(), conversation?.peer?.status)) {
                _chatUiState.update { it.copy(errorMessage = "الموظف غير نشط؛ الإرسال معطّل.") }
            } else if (!(conversation?.repliesEnabled ?: true)) {
                _chatUiState.update { it.copy(errorMessage = "الردود معطّلة في هذا الإعلان") }
            } else if (state.messageDraft.trim().length > 4000) {
                _chatUiState.update { it.copy(errorMessage = "يجب ألا تتجاوز الرسالة 4000 حرف") }
            }
            return
        }
        val sessionKey = activeChatSessionKey ?: return
        val content = state.messageDraft.trim()
        _chatUiState.update { it.copy(isSending = true, errorMessage = null) }
        viewModelScope.launch {
            when (val result = chatRepository.sendMessage(conversationId!!, content, replyId)) {
                is com.example.core.utils.AppResult.Success -> if (activeChatSessionKey == sessionKey) {
                    _chatUiState.update { current ->
                        val selected = current.selectedConversation?.copy(
                            lastMessagePreview = result.data.body.take(120),
                            lastMessageAt = result.data.createdAt,
                            lastSender = result.data.sender,
                            unreadCount = 0
                        )
                        current.copy(
                            isSending = false,
                            messageDraft = "",
                            replyToMessageId = null,
                            messages = ChatUiRules.mergeMessages(current.messages, listOf(result.data)),
                            selectedConversation = selected,
                            conversations = current.conversations.map {
                                if (it.id == selected?.id) selected else it
                            }.filterNotNull(),
                            errorMessage = null
                        )
                    }
                    refreshChatMetadata(sessionKey)
                }
                is com.example.core.utils.AppResult.Error -> if (activeChatSessionKey == sessionKey) {
                    _chatUiState.update {
                        it.copy(
                            isSending = false,
                            errorMessage = errorText(result, "تعذّر إرسال الرسالة")
                        )
                    }
                }
                else -> Unit
            }
        }
    }

    fun refreshChat() {
        viewModelScope.launch {
            refreshChatData()
        }
    }

    fun markSelectedConversationRead() {
        val conversationId = _chatUiState.value.selectedConversation?.id ?: return
        val sessionKey = activeChatSessionKey ?: return
        viewModelScope.launch {
            markConversationReadInternal(conversationId, sessionKey)
            refreshChatMetadata(sessionKey)
        }
    }

    private suspend fun markConversationReadInternal(conversationId: String, sessionKey: String) {
        when (chatRepository.markRead(conversationId)) {
            is com.example.core.utils.AppResult.Success -> if (activeChatSessionKey == sessionKey) {
                _chatUiState.update { state ->
                    val previousUnread = state.conversations
                        .firstOrNull { it.id == conversationId }
                        ?.unreadCount ?: state.selectedConversation?.unreadCount ?: 0
                    state.copy(
                        totalUnread = (state.totalUnread - previousUnread).coerceAtLeast(0),
                        selectedConversation = state.selectedConversation?.let {
                            if (it.id == conversationId) it.copy(unreadCount = 0) else it
                        },
                        conversations = state.conversations.map {
                            if (it.id == conversationId) it.copy(unreadCount = 0) else it
                        }
                    )
                }
            }
            else -> Unit
        }
    }

    private suspend fun refreshChatMetadata(sessionKey: String) {
        val conversationsResult = chatRepository.listConversations()
        val unreadResult = chatRepository.getUnreadCount()
        if (activeChatSessionKey != sessionKey) return
        if (conversationsResult is com.example.core.utils.AppResult.Success) {
            _chatUiState.update { state ->
                val selected = state.selectedConversation?.id?.let { selectedId ->
                    conversationsResult.data.items.firstOrNull { it.id == selectedId }
                } ?: state.selectedConversation
                state.copy(
                    conversations = conversationsResult.data.items,
                    selectedConversation = selected
                )
            }
        }
        if (unreadResult is com.example.core.utils.AppResult.Success) {
            _chatUiState.update { it.copy(totalUnread = unreadResult.data) }
        }
    }

    fun setChatConversationVisible(isVisible: Boolean) {
        if (!isVisible) {
            stopChatPolling()
            return
        }
        val state = _chatUiState.value
        if (chatPollingJob?.isActive == true || !ChatUiRules.shouldPoll(
                isVisible = true,
                canUseChat = state.canUseChat,
                conversationId = state.selectedConversation?.id,
                requestInProgress = chatPollRequestRunning
            )
        ) return
        chatPollingJob = viewModelScope.launch {
            _chatUiState.update { it.copy(isPolling = true) }
            try {
                while (isActive) {
                    delay(10_000)
                    val current = _chatUiState.value
                    if (!ChatUiRules.shouldPoll(
                            isVisible = true,
                            canUseChat = current.canUseChat,
                            conversationId = current.selectedConversation?.id,
                            requestInProgress = chatPollRequestRunning
                        )
                    ) continue
                    refreshCurrentChatForPolling()
                }
            } finally {
                _chatUiState.update { it.copy(isPolling = false) }
            }
        }
    }

    private suspend fun refreshCurrentChatForPolling() {
        if (chatPollRequestRunning) return
        val sessionKey = activeChatSessionKey ?: return
        val conversationId = _chatUiState.value.selectedConversation?.id ?: return
        chatPollRequestRunning = true
        try {
            when (val result = chatRepository.loadMessages(conversationId)) {
                is com.example.core.utils.AppResult.Success -> if (activeChatSessionKey == sessionKey) {
                    _chatUiState.update {
                        it.copy(messages = ChatUiRules.mergeMessages(it.messages, result.data.items))
                    }
                    markConversationReadInternal(conversationId, sessionKey)
                    refreshChatMetadata(sessionKey)
                }
                is com.example.core.utils.AppResult.Error -> if (activeChatSessionKey == sessionKey) {
                    _chatUiState.update {
                        it.copy(errorMessage = errorText(result, "تعذّر تحديث المحادثة"))
                    }
                }
                else -> Unit
            }
        } finally {
            chatPollRequestRunning = false
        }
    }

    fun clearChatError() {
        _chatUiState.update { it.copy(errorMessage = null) }
    }

    // ---------------- TASK & NOTIFICATION WORKFLOWS ----------------

    private fun errorText(error: com.example.core.utils.AppResult.Error, fallback: String): String {
        val serverError = error.appError as? com.example.core.utils.AppError.ServerError
        // Unfinished pilot modules (backend returns 501) get a clean HR Pilot
        // message, never the raw English "... not implemented yet" text.
        if (serverError?.code == 501) {
            return "هذه الميزة غير متاحة في نسخة HR Pilot الحالية."
        }
        if (serverError != null && UserSafeErrorMessages.shouldExposeSupportId(serverError.code)) {
            return UserSafeErrorMessages.unexpectedServerError(serverError.supportRequestId)
        }
        // Prefer an Arabic server message, then an Arabic exception message,
        // otherwise the Arabic fallback (never a raw English string).
        val serverMessage = serverError?.message
        if (!serverMessage.isNullOrBlank() && serverMessage.any { it in '؀'..'ۿ' }) return serverMessage
        val exMessage = error.exception.message
        if (!exMessage.isNullOrBlank() && exMessage.any { it in '؀'..'ۿ' }) return exMessage
        return fallback
    }

    private fun taskFilters(mode: String = _taskMode.value): com.example.domain.model.TaskFilters {
        val session = authUiState.value.currentSession
        val permissions = session?.permissions ?: emptySet()
        val scope = when (mode) {
            "department" -> "department"
            "company" -> "company"
            else -> when {
                permissions.contains(com.example.core.permissions.Permissions.TASKS_VIEW_OWN) -> "own"
                permissions.contains(com.example.core.permissions.Permissions.TASKS_VIEW_DEPARTMENT) -> "department"
                else -> "company"
            }
        }
        return com.example.domain.model.TaskFilters(
            scope = scope,
            status = _taskStatusFilter.value,
            employeeId = session?.employeeId?.takeIf { mode == "own" }
        )
    }

    fun refreshTasks(mode: String = _taskMode.value) {
        _taskMode.value = mode
        viewModelScope.launch {
            _taskLoading.value = true
            _taskError.value = null
            when (val result = taskRepository.refreshTasks(taskFilters(mode))) {
                is com.example.core.utils.AppResult.Error ->
                    _taskError.value = errorText(result, "تعذّر تحميل المهام.")
                else -> Unit
            }
            _taskLoading.value = false
        }
    }

    fun selectTaskMode(mode: String) {
        if (mode == _taskMode.value && tasksUiState.value.tasks.isNotEmpty()) return
        refreshTasks(mode)
    }

    fun setTaskStatusFilter(status: String?) {
        _taskStatusFilter.value = status
        refreshTasks(_taskMode.value)
    }

    fun loadTaskEligibleEmployees() {
        viewModelScope.launch {
            _taskSubmitting.value = true
            _taskError.value = null
            when (val result = taskRepository.loadEligibleEmployees()) {
                is com.example.core.utils.AppResult.Error ->
                    _taskError.value = errorText(result, "تعذّر تحميل الموظفين المتاحين.")
                else -> Unit
            }
            _taskSubmitting.value = false
        }
    }

    fun createNewTask(
        title: String,
        description: String,
        priority: String,
        dueDate: String?,
        employeeIds: List<String>
    ) {
        viewModelScope.launch {
            _taskSubmitting.value = true
            _taskError.value = null
            val request = com.example.domain.model.CreateTaskRequestParams(
                title = title,
                description = description.takeIf { it.isNotBlank() },
                priority = priority,
                dueDate = dueDate,
                employeeIds = employeeIds
            )
            when (val result = taskRepository.createTask(request)) {
                is com.example.core.utils.AppResult.Success -> showNotification("تم إنشاء المهمة وإسنادها بنجاح.")
                is com.example.core.utils.AppResult.Error -> {
                    val message = errorText(result, "تعذّر إنشاء المهمة.")
                    _taskError.value = message
                    showNotification(message)
                }
                else -> Unit
            }
            _taskSubmitting.value = false
        }
    }

    fun startTaskAssignment(assignmentId: String) {
        updateTaskProgress(assignmentId, "in_progress", null)
    }

    fun submitTaskAssignment(assignmentId: String, completionDetails: String) {
        updateTaskProgress(assignmentId, "submitted", completionDetails)
    }

    private fun updateTaskProgress(assignmentId: String, status: String, completionDetails: String?) {
        viewModelScope.launch {
            _taskSubmitting.value = true
            _taskError.value = null
            when (val result = taskRepository.updateProgress(assignmentId, status, completionDetails)) {
                is com.example.core.utils.AppResult.Success -> showNotification(
                    if (status == "submitted") "تم تسليم المهمة للمراجعة." else "بدأ تنفيذ المهمة."
                )
                is com.example.core.utils.AppResult.Error -> {
                    val message = errorText(result, "تعذّر تحديث تقدم المهمة.")
                    _taskError.value = message
                    showNotification(message)
                }
                else -> Unit
            }
            _taskSubmitting.value = false
        }
    }

    fun reviewTaskAssignment(assignmentId: String, action: String, reviewNote: String?) {
        viewModelScope.launch {
            _taskSubmitting.value = true
            _taskError.value = null
            when (val result = taskRepository.reviewAssignment(assignmentId, action, reviewNote)) {
                is com.example.core.utils.AppResult.Success -> showNotification(
                    if (action == "accept") "تم قبول إنجاز المهمة." else "تمت إعادة المهمة للموظف."
                )
                is com.example.core.utils.AppResult.Error -> {
                    val message = errorText(result, "تعذّرت مراجعة المهمة.")
                    _taskError.value = message
                    showNotification(message)
                }
                else -> Unit
            }
            _taskSubmitting.value = false
        }
    }

    fun cancelTask(taskId: String) {
        viewModelScope.launch {
            _taskSubmitting.value = true
            _taskError.value = null
            when (val result = taskRepository.cancelTask(taskId)) {
                is com.example.core.utils.AppResult.Success -> showNotification("تم إلغاء المهمة مع الاحتفاظ بسجلها.")
                is com.example.core.utils.AppResult.Error -> {
                    val message = errorText(result, "تعذّر إلغاء المهمة.")
                    _taskError.value = message
                    showNotification(message)
                }
                else -> Unit
            }
            _taskSubmitting.value = false
        }
    }

    fun clearTaskError() {
        _taskError.value = null
    }

    // ---------------- COMMERCIAL P4: TASK EDIT AND COMMENTS ----------------

    private val _taskComments =
        MutableStateFlow<List<com.example.domain.model.TaskCommentParams>>(emptyList())
    val taskComments: StateFlow<List<com.example.domain.model.TaskCommentParams>> =
        _taskComments.asStateFlow()
    private val _taskCommentsLoading = MutableStateFlow(false)
    val taskCommentsLoading: StateFlow<Boolean> = _taskCommentsLoading.asStateFlow()

    /**
     * `expectedUpdatedAt` comes from the task row the user is looking at, so a
     * concurrent edit by someone else fails with a conflict rather than quietly
     * overwriting their change. `description` and `dueDate` use TaskFieldEdit so
     * "leave alone" and "clear" stay distinguishable all the way to the wire.
     */
    fun editTask(
        taskId: String,
        expectedUpdatedAt: String,
        title: String? = null,
        priority: String? = null,
        description: com.example.domain.model.TaskFieldEdit<String> =
            com.example.domain.model.TaskFieldEdit.Unchanged,
        dueDate: com.example.domain.model.TaskFieldEdit<String> =
            com.example.domain.model.TaskFieldEdit.Unchanged
    ) {
        viewModelScope.launch {
            _taskSubmitting.value = true
            _taskError.value = null
            val result = taskRepository.updateTask(
                taskId = taskId,
                expectedUpdatedAt = expectedUpdatedAt,
                title = title,
                priority = priority,
                description = description,
                dueDate = dueDate
            )
            when (result) {
                is com.example.core.utils.AppResult.Success -> showNotification("تم تحديث بيانات المهمة.")
                is com.example.core.utils.AppResult.Error -> {
                    val message = errorText(result, "تعذّر تعديل المهمة.")
                    _taskError.value = message
                    showNotification(message)
                }
                else -> Unit
            }
            _taskSubmitting.value = false
        }
    }

    fun loadTaskComments(taskId: String) {
        viewModelScope.launch {
            _taskCommentsLoading.value = true
            when (val result = taskRepository.loadComments(taskId, limit = 50)) {
                is com.example.core.utils.AppResult.Success -> _taskComments.value = result.data.items
                is com.example.core.utils.AppResult.Error -> {
                    _taskComments.value = emptyList()
                    _taskError.value = errorText(result, "تعذّر تحميل تعليقات المهمة.")
                }
                else -> Unit
            }
            _taskCommentsLoading.value = false
        }
    }

    fun addTaskComment(taskId: String, body: String) {
        val trimmed = body.trim()
        if (trimmed.isEmpty()) return
        viewModelScope.launch {
            _taskSubmitting.value = true
            _taskError.value = null
            when (val result = taskRepository.addComment(taskId, trimmed)) {
                is com.example.core.utils.AppResult.Success -> {
                    showNotification("تمت إضافة التعليق.")
                    loadTaskComments(taskId)
                }
                is com.example.core.utils.AppResult.Error -> {
                    val message = errorText(result, "تعذّرت إضافة التعليق.")
                    _taskError.value = message
                    showNotification(message)
                }
                else -> Unit
            }
            _taskSubmitting.value = false
        }
    }

    fun clearTaskComments() {
        _taskComments.value = emptyList()
    }

    // ---------------- PRIVATE LIVE SUPPORT CUSTOM DRAWER ----------------
    // Simple direct technical support simulator 24/7 (دعم فني على مدار الساعة)
    var isSupportDrawerOpen by mutableStateOf(false)
    val supportChatLogs = MutableStateFlow<List<Pair<String, String>>>(
        listOf(
            "الدعم الفني" to "أهلاً بك في الدعم الفني لـ ERP. كيف يمكنني خدمتك الفنية اليوم؟ نقف بجانبك ٢٤ ساعة لضمان استقرار العمل."
        )
    )
    var supportInputText by mutableStateOf("")

    fun sendSupportTicket() {
        val msg = supportInputText.trim()
        if (msg.isEmpty()) return
        val currentLogs = supportChatLogs.value.toMutableList()
        currentLogs.add("أنت" to msg)
        supportChatLogs.value = currentLogs
        supportInputText = ""

        viewModelScope.launch {
            kotlinx.coroutines.delay(1200)
            val reply = when {
                msg.contains("بصمة") || msg.contains("دخول") -> {
                    "الدعم الفني (24/7): لتفعيل البصمة على جهازك، يرجى التأكد من تسجيل بصمتك في إعدادات الهاتف أولاً وحفظ التحقق العائلي الثنائي."
                }
                msg.contains("تصدير") || msg.contains("تقرير") -> {
                    "الدعم الفني (24/7): لتنزيل الكشوفات، يرجى الذهاب لتبويب 'التقرير الشهري والرواتب' ثم الضغط على زر التصدير كـ Excel أو طباعة كـ PDF."
                }
                msg.contains("صلاحيات") || msg.contains("صلاحية") -> {
                    "الدعم الفني (24/7): لتثبيت أو إضافة صلاحيات جديدة لموظف، يرجى التبديل لملف مدير الموارد 'أحمد العتيبي' لتعديل كشفه."
                }
                else -> {
                    "الدعم الفني (24/7): تم توجيه التذكرة لفريق الدعم السحابي الفوري وسنقوم بالاتصال بك فوراً. شكراً لمساهمتك في تعزيز تجربة المستخدم!"
                }
            }
            val logsWithBot = supportChatLogs.value.toMutableList()
            logsWithBot.add("الدعم الفني" to reply)
            supportChatLogs.value = logsWithBot
        }
    }

    // ---------------- TRAINING WORKFLOWS ----------------

    private fun trainingScope(mode: String): String = when (mode) {
        "department" -> "department"
        "courses", "assignments", "reviews" -> "company"
        "report" -> if (trainingUiState.value.canViewCompany) "company" else "department"
        else -> "own"
    }

    fun loadTrainingCourseTimeline(courseId: String) {
        val trimmed = courseId.trim()
        if (trimmed.isEmpty()) return
        viewModelScope.launch {
            _trainingTimelineState.value = TrainingTimelineUiState(
                courseId = trimmed,
                isLoading = true,
                errorMessage = null
            )
            when (
                val result = trainingRepository.loadCourseTimeline(
                    trimmed,
                    trainingScope(_trainingControls.value.selectedMode)
                )
            ) {
                is com.example.core.utils.AppResult.Success -> {
                    _trainingTimelineState.value = TrainingTimelineUiState(
                        courseId = trimmed,
                        timeline = result.data,
                        isLoading = false
                    )
                }
                is com.example.core.utils.AppResult.Error -> {
                    _trainingTimelineState.value = TrainingTimelineUiState(
                        courseId = trimmed,
                        isLoading = false,
                        errorMessage = errorText(result, "تعذر تحميل الجدول الزمني للدورة.")
                    )
                }
                else -> Unit
            }
        }
    }

    // ---------------- COMMERCIAL P4: TRAINING COMPLETION ARTIFACTS ----------------

    private val _trainingCertificate =
        MutableStateFlow<com.example.domain.model.TrainingCertificateParams?>(null)
    val trainingCertificate: StateFlow<com.example.domain.model.TrainingCertificateParams?> =
        _trainingCertificate.asStateFlow()
    private val _trainingEvaluation =
        MutableStateFlow<com.example.domain.model.TrainingEvaluationParams?>(null)
    val trainingEvaluation: StateFlow<com.example.domain.model.TrainingEvaluationParams?> =
        _trainingEvaluation.asStateFlow()
    private val _trainingArtifactBusy = MutableStateFlow(false)
    val trainingArtifactBusy: StateFlow<Boolean> = _trainingArtifactBusy.asStateFlow()

    /**
     * Loads both completion artifacts for one assignment. A missing artifact is
     * a normal state (404 = not yet issued / not recorded), not an error, so a
     * failure just leaves the slot null rather than raising a banner. The
     * evaluation is not even requested without `training.evaluation.view`, so
     * the UI never provokes a 403 it would then have to explain away.
     */
    fun loadTrainingArtifacts(assignmentId: String) {
        viewModelScope.launch {
            _trainingArtifactBusy.value = true
            _trainingCertificate.value =
                (trainingRepository.loadCertificate(assignmentId)
                    as? com.example.core.utils.AppResult.Success)?.data
            val permissions = authUiState.value.currentSession?.permissions ?: emptySet()
            val mayReadEvaluation = com.example.core.permissions.PermissionChecker(permissions)
                .hasPermission(com.example.core.permissions.Permissions.TRAINING_EVALUATION_VIEW)
            _trainingEvaluation.value = if (mayReadEvaluation) {
                (trainingRepository.loadEvaluation(assignmentId)
                    as? com.example.core.utils.AppResult.Success)?.data
            } else null
            _trainingArtifactBusy.value = false
        }
    }

    /** Safe to press twice: the backend replays an already-issued certificate. */
    fun issueTrainingCertificate(assignmentId: String) {
        viewModelScope.launch {
            _trainingArtifactBusy.value = true
            when (val result = trainingRepository.issueCertificate(assignmentId)) {
                is com.example.core.utils.AppResult.Success -> {
                    _trainingCertificate.value = result.data
                    showNotification("تم إصدار شهادة إكمال التدريب.")
                }
                is com.example.core.utils.AppResult.Error ->
                    showNotification(errorText(result, "تعذر إصدار شهادة التدريب."))
                else -> Unit
            }
            _trainingArtifactBusy.value = false
        }
    }

    /** Not retry-safe by design: a second evaluation is a conflict, not an overwrite. */
    fun createTrainingEvaluation(
        assignmentId: String,
        request: com.example.domain.model.TrainingEvaluationRequestParams
    ) {
        viewModelScope.launch {
            _trainingArtifactBusy.value = true
            when (val result = trainingRepository.createEvaluation(assignmentId, request)) {
                is com.example.core.utils.AppResult.Success -> {
                    _trainingEvaluation.value = result.data
                    showNotification("تم تسجيل تقييم التدريب.")
                }
                is com.example.core.utils.AppResult.Error ->
                    showNotification(errorText(result, "تعذر تسجيل تقييم التدريب."))
                else -> Unit
            }
            _trainingArtifactBusy.value = false
        }
    }

    fun clearTrainingArtifacts() {
        _trainingCertificate.value = null
        _trainingEvaluation.value = null
    }

    fun exportTrainingReport(format: com.example.domain.model.TrainingExportFormat) {
        if (!trainingUiState.value.canReport) {
            showNotification("لا تمتلك صلاحية تصدير تقرير التدريب.")
            return
        }
        if (_trainingExportState.value.exportingFormat != null) return
        viewModelScope.launch {
            _trainingExportState.value = TrainingExportUiState(
                exportingFormat = format,
                progressMessage = "جاري تجهيز ملف التصدير…"
            )
            _trainingPendingExportShare.value = null
            val filters = com.example.domain.model.TrainingReportFilters(
                scope = trainingScope("report"),
                courseStatus = _trainingControls.value.courseStatusFilter,
                assignmentStatus = _trainingControls.value.assignmentStatusFilter,
                category = _trainingControls.value.categoryFilter
            )
            when (val result = trainingRepository.exportReport(format, filters, locale = "ar")) {
                is com.example.core.utils.AppResult.Success -> {
                    try {
                        val share = withContext(Dispatchers.IO) { trainingExportStore.save(result.data) }
                        _trainingPendingExportShare.value = share
                        _trainingExportState.value = TrainingExportUiState(
                            completionMessage = "تم تجهيز ملف التصدير (${format.apiValue.uppercase()})."
                        )
                    } catch (_: Exception) {
                        _trainingExportState.value = TrainingExportUiState(
                            errorMessage = "تعذر حفظ ملف التصدير للمشاركة"
                        )
                        showNotification("تعذر حفظ ملف التصدير للمشاركة")
                    }
                }
                is com.example.core.utils.AppResult.Error -> {
                    val message = errorText(result, "تعذر تصدير تقرير التدريب.")
                    _trainingExportState.value = TrainingExportUiState(errorMessage = message)
                    showNotification(message)
                }
                else -> Unit
            }
        }
    }

    fun clearTrainingExportMessage() {
        _trainingExportState.update {
            it.copy(progressMessage = null, completionMessage = null, errorMessage = null)
        }
    }

    fun consumeTrainingExportShare() {
        _trainingPendingExportShare.value = null
    }

    fun refreshTraining(mode: String = _trainingControls.value.selectedMode) {
        _trainingControls.update {
            it.copy(isLoading = true, errorMessage = null, selectedMode = mode)
        }
        viewModelScope.launch {
            val scope = trainingScope(mode)
            var error: String? = null
            if (mode == "report") {
                when (val result = trainingRepository.loadReport(
                    com.example.domain.model.TrainingReportFilters(
                        scope = scope,
                        courseStatus = _trainingControls.value.courseStatusFilter,
                        assignmentStatus = _trainingControls.value.assignmentStatusFilter,
                        category = _trainingControls.value.categoryFilter
                    )
                )) {
                    is com.example.core.utils.AppResult.Error ->
                        error = errorText(result, "تعذر تحميل تقرير التدريب.")
                    else -> Unit
                }
            } else {
                val courseResult = trainingRepository.refreshCourses(
                    com.example.domain.model.TrainingCourseFilters(
                        scope = scope,
                        status = _trainingControls.value.courseStatusFilter,
                        category = _trainingControls.value.categoryFilter
                    )
                )
                if (courseResult is com.example.core.utils.AppResult.Error) {
                    error = errorText(courseResult, "تعذر تحميل الدورات التدريبية.")
                }
                val assignmentResult = trainingRepository.refreshAssignments(
                    com.example.domain.model.TrainingAssignmentFilters(
                        scope = scope,
                        status = if (mode == "reviews") "submitted" else
                            _trainingControls.value.assignmentStatusFilter,
                        employeeId = authUiState.value.currentSession?.employeeId?.takeIf { scope == "own" }
                    )
                )
                if (assignmentResult is com.example.core.utils.AppResult.Error && error == null) {
                    error = errorText(assignmentResult, "تعذر تحميل تكليفات التدريب.")
                }
            }
            _trainingControls.update { it.copy(isLoading = false, errorMessage = error) }
        }
    }

    fun selectTrainingMode(mode: String) {
        if (mode == _trainingControls.value.selectedMode && !trainingUiState.value.isEmpty) return
        refreshTraining(mode)
    }

    fun setTrainingCourseStatusFilter(status: String?) {
        _trainingControls.update { it.copy(courseStatusFilter = status) }
        refreshTraining()
    }

    fun setTrainingAssignmentStatusFilter(status: String?) {
        _trainingControls.update { it.copy(assignmentStatusFilter = status) }
        refreshTraining()
    }

    fun setTrainingCategoryFilter(category: String?) {
        _trainingControls.update { it.copy(categoryFilter = category?.takeIf(String::isNotBlank)) }
        refreshTraining()
    }

    fun selectTrainingCourse(course: com.example.domain.model.TrainingCourseParams?) {
        _trainingControls.update { it.copy(selectedCourse = course) }
    }

    fun selectTrainingAssignment(assignment: com.example.domain.model.TrainingAssignmentParams?) {
        _trainingControls.update { it.copy(selectedAssignment = assignment) }
    }

    fun loadTrainingEligibleEmployees() {
        viewModelScope.launch {
            _trainingControls.update { it.copy(isSubmitting = true, errorMessage = null) }
            when (val result = trainingRepository.loadEligibleEmployees()) {
                is com.example.core.utils.AppResult.Error -> _trainingControls.update {
                    it.copy(errorMessage = errorText(result, "تعذر تحميل الموظفين المتاحين للتدريب."))
                }
                else -> Unit
            }
            _trainingControls.update { it.copy(isSubmitting = false) }
        }
    }

    fun saveTrainingCourse(
        courseId: String?,
        request: com.example.domain.model.TrainingCourseRequestParams
    ) {
        viewModelScope.launch {
            _trainingControls.update { it.copy(isSubmitting = true, errorMessage = null) }
            val result = if (courseId == null) {
                trainingRepository.createCourse(request)
            } else {
                trainingRepository.updateCourse(courseId, request)
            }
            when (result) {
                is com.example.core.utils.AppResult.Success -> {
                    _trainingControls.update { it.copy(selectedCourse = result.data) }
                    showNotification(if (courseId == null) "تم إنشاء مسودة الدورة." else "تم تحديث مسودة الدورة.")
                }
                is com.example.core.utils.AppResult.Error -> {
                    val message = errorText(result, "تعذر حفظ الدورة التدريبية.")
                    _trainingControls.update { it.copy(errorMessage = message) }
                    showNotification(message)
                }
                else -> Unit
            }
            _trainingControls.update { it.copy(isSubmitting = false) }
        }
    }

    private fun runTrainingAction(
        successMessage: String,
        fallback: String,
        action: suspend () -> com.example.core.utils.AppResult<*>
    ) {
        viewModelScope.launch {
            _trainingControls.update { it.copy(isSubmitting = true, errorMessage = null) }
            when (val result = action()) {
                is com.example.core.utils.AppResult.Success -> showNotification(successMessage)
                is com.example.core.utils.AppResult.Error -> {
                    val message = errorText(result, fallback)
                    _trainingControls.update { it.copy(errorMessage = message) }
                    showNotification(message)
                }
                else -> Unit
            }
            _trainingControls.update { it.copy(isSubmitting = false) }
        }
    }

    fun publishTrainingCourse(courseId: String) = runTrainingAction(
        "تم نشر الدورة التدريبية.", "تعذر نشر الدورة التدريبية."
    ) { trainingRepository.publishCourse(courseId) }

    fun assignTrainingCourse(courseId: String, employeeIds: List<String>) = runTrainingAction(
        "تم إسناد الدورة للموظفين المحددين.", "تعذر إسناد الدورة التدريبية."
    ) { trainingRepository.assignCourse(courseId, employeeIds) }

    fun updateTrainingProgress(assignmentId: String, progress: Int) = runTrainingAction(
        "تم تحديث تقدم التدريب.", "تعذر تحديث تقدم التدريب."
    ) { trainingRepository.updateAssignmentProgress(assignmentId, progress) }

    fun submitTrainingAssignment(assignmentId: String, note: String?) = runTrainingAction(
        "تم تسليم إكمال الدورة للمراجعة.", "تعذر تسليم إكمال الدورة."
    ) { trainingRepository.submitAssignment(assignmentId, note) }

    fun reviewTrainingAssignment(
        assignmentId: String,
        action: String,
        score: Int?,
        note: String?
    ) = runTrainingAction(
        if (action == "accept") "تم اعتماد إكمال التدريب." else "تمت إعادة الإكمال للموظف.",
        "تعذر مراجعة إكمال التدريب."
    ) { trainingRepository.reviewAssignment(assignmentId, action, score, note) }

    fun cancelTrainingAssignment(assignmentId: String, reason: String) = runTrainingAction(
        "تم إلغاء تكليف التدريب مع حفظ السجل.", "تعذر إلغاء تكليف التدريب."
    ) { trainingRepository.cancelAssignment(assignmentId, reason) }

    fun completeTrainingCourse(courseId: String) = runTrainingAction(
        "تم إكمال الدورة التدريبية.", "تعذر إكمال الدورة التدريبية."
    ) { trainingRepository.completeCourse(courseId) }

    fun cancelTrainingCourse(courseId: String, reason: String) = runTrainingAction(
        "تم إلغاء الدورة مع حفظ سجلها.", "تعذر إلغاء الدورة التدريبية."
    ) { trainingRepository.cancelCourse(courseId, reason) }

    fun archiveTrainingCourse(courseId: String) = runTrainingAction(
        "تمت أرشفة الدورة التدريبية.", "تعذر أرشفة الدورة التدريبية."
    ) { trainingRepository.archiveCourse(courseId) }

    fun clearTrainingError() {
        _trainingControls.update { it.copy(errorMessage = null) }
    }

    // ---------------- AI ASSISTANT SYSTEM (MANDATORY GEMINI AI COPILOT) ----------------
    data class AiMessage(
        val messageId: String = UUID.randomUUID().toString(),
        val sender: String, // "أنت" (User), "مساعد AI" (Assistant)
        val text: String,
        val timestamp: Long = System.currentTimeMillis()
    )

    private val _aiMessages = MutableStateFlow<List<AiMessage>>(
        listOf(
            AiMessage(
                sender = "مساعد AI",
                text = "مرحباً بك! أنا مساعد الذكاء الاصطناعي المالي والإداري المدمج في نظام Mawared ERP 🚀.\n\nبصفتي الوكيل الذكي، يمكنني مساعدتك في:\n• تحليل كشف الرواتب ومسيرات الأجور ومقارنتها.\n• كشف نواقص واعتمادات المشتريات المعلقة للشركة.\n• فحص برامج التدريب والتكليفات الموجهة وتحديد حالات التعثر للموظفين.\n• اقتراح مهام يومية عاجلة ودراسة الاستثناءات المالية والإدارية.\n\nكيف يمكنني دعم أعمالك اليوم؟"
            )
        )
    )
    val aiMessages: StateFlow<List<AiMessage>> = _aiMessages.asStateFlow()

    var aiInputText by mutableStateOf("")
    var isAiLoading by mutableStateOf(false)
    var aiErrorMessage by mutableStateOf<String?>(null)

    fun clearAiChat() {
        _aiMessages.value = listOf(
            AiMessage(
                sender = "مساعد AI",
                text = "تمت إعادة تهيئة قنوات الفهم للذكاء الاصطناعي. كيف أستطيع خدمتك كمسؤول أو موظف الآن؟"
            )
        )
        aiErrorMessage = null
    }

    fun submitAiPrompt() {
        val prompt = aiInputText.trim()
        if (prompt.isEmpty() || isAiLoading) return

        _aiMessages.value = _aiMessages.value + AiMessage(sender = "أنت", text = prompt)
        aiInputText = ""
        isAiLoading = true
        aiErrorMessage = null

        viewModelScope.launch {
            try {
                if (BuildConfig.DEMO_MODE) {
                    // AI assistant requires a live backend — not available in demo mode.
                    _aiMessages.value = _aiMessages.value + AiMessage(
                        sender = "مساعد AI",
                        text = "مساعد الذكاء الاصطناعي غير متاح في النسخة التجريبية. يرجى التواصل مع الدعم الفني لتفعيل الاشتراك."
                    )
                    isAiLoading = false
                    return@launch
                }

                // Production: the Gemini API key stays on the server.
                // The backend at /api/v1/ai/chat proxies the request and returns {"reply": "..."}.
                val response = aiAssistantApi.chat(mapOf("message" to prompt))
                if (response.isSuccessful) {
                    val reply = response.body()?.get("reply") ?: "عذراً، لم أستطع معالجة طلبك."
                    _aiMessages.value = _aiMessages.value + AiMessage(sender = "مساعد AI", text = reply)
                    isAiLoading = false
                } else if (response.code() == 503) {
                    // Provider key not configured on the server — a clean, expected state.
                    isAiLoading = false
                    _aiMessages.value = _aiMessages.value + AiMessage(
                        sender = "مساعد AI",
                        text = "خدمة الذكاء الاصطناعي غير مفعلة حالياً."
                    )
                } else {
                    throw Exception("خطأ من الخادم: ${response.code()}")
                }
            } catch (e: Exception) {
                aiErrorMessage = "خطأ في الاتصال بالذكاء الاصطناعي: ${e.localizedMessage}"
                isAiLoading = false
                _aiMessages.value = _aiMessages.value + AiMessage(
                    sender = "مساعد AI",
                    text = "عذراً، تعذّر الاتصال بالمساعد الذكي."
                )
            }
        }
    }

    // ---------------- ATTACHMENTS (Backend-authenticated; never Supabase from Android) ----------------
    var isAttachmentUploading by mutableStateOf(false)
        private set

    fun uploadPurchasingAttachment(uri: android.net.Uri, purchaseOrderId: String) {
        uploadAttachment(uri, purpose = "purchasing", purchaseOrderId = purchaseOrderId)
    }

    fun uploadChatAttachment(uri: android.net.Uri, conversationId: String) {
        uploadAttachment(uri, purpose = "chat", conversationId = conversationId)
    }

    fun openAttachment(id: String) {
        val repo = com.example.core.di.DependencyProvider.attachmentRepository
        if (repo == null) {
            showNotification(getApplication<Application>().getString(R.string.attachment_missing_viewer))
            return
        }
        viewModelScope.launch {
            when (val result = repo.downloadToCache(id)) {
                is com.example.core.utils.AppResult.Success -> {
                    try {
                        val intent = android.content.Intent.createChooser(
                            repo.openViewerIntent(result.data),
                            getApplication<Application>().getString(R.string.attachment_open)
                        )
                        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                        getApplication<Application>().startActivity(intent)
                    } catch (_: Exception) {
                        showNotification(getApplication<Application>().getString(R.string.attachment_missing_viewer))
                    }
                }
                is com.example.core.utils.AppResult.Error ->
                    showNotification(getApplication<Application>().getString(R.string.attachment_download_failed))
                else -> Unit
            }
        }
    }

    private fun uploadAttachment(
        uri: android.net.Uri,
        purpose: String,
        purchaseOrderId: String? = null,
        conversationId: String? = null
    ) {
        val repo = com.example.core.di.DependencyProvider.attachmentRepository
        if (repo == null || BuildConfig.DEMO_MODE) {
            showNotification(getApplication<Application>().getString(R.string.attachment_upload_failed))
            return
        }
        if (isAttachmentUploading) return
        isAttachmentUploading = true
        viewModelScope.launch {
            when (
                val result = repo.uploadFromUri(
                    uri = uri,
                    purpose = purpose,
                    purchaseOrderId = purchaseOrderId,
                    conversationId = conversationId
                )
            ) {
                is com.example.core.utils.AppResult.Success -> {
                    showNotification(getApplication<Application>().getString(R.string.attachment_upload_success))
                    if (purpose == "chat" && !conversationId.isNullOrBlank()) {
                        refreshCurrentChatForPolling()
                    }
                }
                is com.example.core.utils.AppResult.Error ->
                    showNotification(getApplication<Application>().getString(R.string.attachment_upload_failed))
                else -> Unit
            }
            isAttachmentUploading = false
        }
    }
}

class MawaredViewModelFactory(
    private val application: Application,
    private val authRepository: com.example.domain.repository.AuthRepository,
    private val employeeRepository: com.example.domain.repository.EmployeeRepository,
    private val purchaseRepository: com.example.domain.repository.PurchaseRepository,
    private val supplierRepository: com.example.domain.repository.SupplierRepository,
    private val attendanceRepository: com.example.domain.repository.AttendanceRepository,
    private val attendanceCorrectionRepository: com.example.domain.repository.AttendanceCorrectionRepository,
    private val attendanceExemptionRepository: com.example.domain.repository.AttendanceExemptionRepository,
    private val leaveRepository: com.example.domain.repository.LeaveRepository,
    private val payrollRepository: com.example.domain.repository.PayrollRepository,
    private val chatRepository: com.example.domain.repository.ChatRepository,
    private val taskRepository: com.example.domain.repository.TaskRepository,
    private val trainingRepository: com.example.domain.repository.TrainingRepository,
    private val reportRepository: com.example.domain.repository.ReportRepository,
    private val authorizationRepository: com.example.domain.repository.AuthorizationRepository,
    private val credentialRepository: com.example.domain.repository.CredentialRepository,
    private val sessionRepository: com.example.domain.repository.SessionRepository,
    private val notificationInboxRepository: com.example.domain.repository.NotificationInboxRepository,
    private val aiAssistantApi: com.example.data.remote.api.AiAssistantApi,
    private val globalSearchRepository: com.example.domain.repository.GlobalSearchRepository,
    private val timelineRepository: com.example.domain.repository.TimelineRepository
) : ViewModelProvider.Factory {
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        if (modelClass.isAssignableFrom(MawaredViewModel::class.java)) {
            @Suppress("UNCHECKED_CAST")
            return MawaredViewModel(
                application,
                authRepository,
                employeeRepository,
                purchaseRepository,
                supplierRepository,
                attendanceRepository,
                attendanceCorrectionRepository,
                attendanceExemptionRepository,
                leaveRepository,
                payrollRepository,
                chatRepository,
                taskRepository,
                trainingRepository,
                reportRepository,
                authorizationRepository,
                credentialRepository,
                sessionRepository,
                notificationInboxRepository,
                aiAssistantApi,
                globalSearchRepository,
                timelineRepository
            ) as T
        }
        throw IllegalArgumentException("Unknown ViewModel class")
    }
}
