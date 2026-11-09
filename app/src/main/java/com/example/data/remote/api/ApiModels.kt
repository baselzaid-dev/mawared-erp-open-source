package com.example.data.remote.api

import com.squareup.moshi.JsonClass

import com.squareup.moshi.Json

@JsonClass(generateAdapter = true)
data class LoginRequestDto(
    val companyCode: String,
    val identifier: String,
    val password: String
)

@JsonClass(generateAdapter = true)
data class OwnerRecoveryInitiateRequestDto(
    val companyCode: String,
    val ownerEmail: String
)

@JsonClass(generateAdapter = true)
data class OwnerRecoveryInitiateResponseDto(
    val status: String,
    val requestId: String
)

@JsonClass(generateAdapter = true)
data class OwnerRecoveryConfirmRequestDto(
    val resetToken: String,
    val newPassword: String
)

@JsonClass(generateAdapter = true)
data class OwnerRecoveryConfirmResponseDto(
    val status: String,
    val requestId: String
)

@JsonClass(generateAdapter = true)
data class LoginResponseDto(
    val accessToken: String? = null,
    val refreshToken: String? = null,
    val user: UserDto,
    val company: CompanyDto,
    val mfaRequired: Boolean = false,
    val enrollmentRequired: Boolean = false,
    val challengeToken: String? = null,
    val expiresAt: String? = null,
    val mfaVerifiedAt: String? = null,
    val backupCodes: List<String> = emptyList()
)

@JsonClass(generateAdapter = true)
data class CompanyDto(
    val id: String,
    val code: String,
    val name: String
)

@JsonClass(generateAdapter = true)
data class RefreshRequestDto(
    val refreshToken: String
)

@JsonClass(generateAdapter = true)
data class RefreshResponseDto(
    val token: String,
    val refreshToken: String? = null,
    val mustChangePassword: Boolean = false
)

@JsonClass(generateAdapter = true)
data class LogoutRequestDto(
    val refreshToken: String? = null
)

@JsonClass(generateAdapter = true)
data class UserDto(
    val id: String,
    val companyId: String? = null,
    val employeeId: String? = null,
    val name: String,
    val email: String,
    @Json(name = "role") val oldRole: String? = null,
    val roleId: String? = null,
    val roleName: String? = null,
    val permissions: List<String> = emptyList(),
    val mustChangePassword: Boolean = false,
    val temporaryPasswordExpiresAt: String? = null,
    val credentialVersion: Int? = null,
    val accountStatus: String? = null,
    val mfaRequired: Boolean = false,
    val mfaEnrolled: Boolean = false
)

@JsonClass(generateAdapter = true)
data class MfaChallengeRequestDto(
    val challengeToken: String
)

@JsonClass(generateAdapter = true)
data class MfaVerifyRequestDto(
    val challengeToken: String,
    val code: String
)

@JsonClass(generateAdapter = true)
data class MfaEnrollmentDto(
    val manualSecret: String,
    val otpauthUri: String,
    val expiresAt: String
)

@JsonClass(generateAdapter = true)
data class EmployeeDto(
    val id: String,
    val companyId: String,
    val employeeNum: String,
    val jobTitle: String?,
    val joiningDate: String?,
    val status: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val archivedAt: String? = null,
    val user: UserDto?,
    val department: DepartmentDto?
)

@JsonClass(generateAdapter = true)
data class DepartmentDto(
    val id: String,
    val name: String,
    val managerId: String? = null,
    val managerName: String? = null,
    val activeEmployeeCount: Int = 0
)

@JsonClass(generateAdapter = true)
data class CreateEmployeeDto(
    val email: String,
    val password: String,
    val name: String,
    val roleId: String,
    val employeeNum: String,
    val jobTitle: String,
    val joiningDate: String,
    val departmentId: String?
)

@JsonClass(generateAdapter = true)
data class EmployeeUpdateRequestDto(
    val name: String,
    val email: String,
    val employeeNum: String,
    val jobTitle: String,
    val joiningDate: String,
    val departmentId: String?,
    val roleId: String
)

@JsonClass(generateAdapter = true)
data class SalaryEmployeeSummaryDto(
    val id: String,
    val employeeNum: String,
    val name: String,
    val jobTitle: String,
    val departmentName: String?
)

@JsonClass(generateAdapter = true)
data class SalaryRecordDto(
    val id: String,
    val employeeId: String,
    val baseSalary: String,
    val currency: String,
    val effectiveFrom: String,
    val effectiveTo: String?,
    val createdAt: String? = null
)

@JsonClass(generateAdapter = true)
data class CurrentSalaryResponseDto(
    val employee: SalaryEmployeeSummaryDto,
    val currentSalary: SalaryRecordDto?,
    val createdSalary: SalaryRecordDto? = null
)

@JsonClass(generateAdapter = true)
data class SalaryHistoryResponseDto(
    val employee: SalaryEmployeeSummaryDto,
    val history: List<SalaryRecordDto>
)

@JsonClass(generateAdapter = true)
data class CreateSalaryRecordDto(
    val baseSalary: String,
    val currency: String = "SAR",
    val effectiveFrom: String
)

@JsonClass(generateAdapter = true)
data class DepartmentRequestDto(
    val name: String,
    val managerId: String?
)

@JsonClass(generateAdapter = true)
data class DepartmentManagerCandidateDto(
    val userId: String,
    val employeeId: String,
    val name: String,
    val roleName: String,
    val departmentId: String?
)

@JsonClass(generateAdapter = true)
data class RoleDto(
    val id: String,
    val name: String
)

@JsonClass(generateAdapter = true)
data class LeaveRequestDto(
    val leaveType: String,
    val startDate: String,
    val endDate: String,
    val reason: String?,
    val exitReentryRequested: Boolean = false,
    val visaFeePaid: Boolean = false
)

@JsonClass(generateAdapter = true)
data class LeaveDto(
    val id: String,
    val employeeId: String,
    val leaveType: String,
    val startDate: String,
    val endDate: String,
    val totalDays: Int,
    val status: String,
    val reason: String?,
    val rejectionReason: String?,
    val employee: LeaveEmployeeSummaryDto? = null,
    val exitReentryRequested: Boolean = false,
    val visaFeePaid: Boolean = false,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@JsonClass(generateAdapter = true)
data class LeaveEmployeeSummaryDto(
    val id: String,
    val employeeNum: String,
    val name: String,
    val departmentId: String? = null,
    val department: DepartmentDto? = null
)

@JsonClass(generateAdapter = true)
data class LeaveSummaryDto(
    val total: Int,
    val pendingHr: Int,
    val pendingAdmin: Int,
    val approved: Int,
    val rejected: Int,
    val cancelled: Int,
    val totalDays: Int
)

@JsonClass(generateAdapter = true)
data class LeaveReportResponseDto(
    val summary: LeaveSummaryDto,
    val requests: List<LeaveDto>
)

@JsonClass(generateAdapter = true)
data class RejectRequestDto(
    val reason: String
)

@JsonClass(generateAdapter = true)
data class AttendanceDto(
    val id: String,
    val companyId: String? = null,
    val employeeId: String,
    val date: String,
    val clockIn: String?,
    val clockOut: String?,
    val status: String,
    val employee: EmployeeDto? = null,
    val version: Int? = null
)

@JsonClass(generateAdapter = true)
data class AttendanceCorrectionDto(
    val id: String,
    val attendanceId: String,
    val employeeId: String,
    val requestedByUserId: String,
    val requestedClockIn: String? = null,
    val requestedClockOut: String? = null,
    val reason: String,
    val status: String,
    val version: Int,
    val reviewedAt: String? = null,
    val decisionReason: String? = null,
    val createdAt: String,
    val updatedAt: String
)

@JsonClass(generateAdapter = true)
data class AttendanceCorrectionListDto(
    val items: List<AttendanceCorrectionDto>,
    val nextCursor: String? = null,
    val hasMore: Boolean = false
)

@JsonClass(generateAdapter = true)
data class AttendanceCorrectionCreateRequestDto(
    val clockIn: String? = null,
    val clockOut: String? = null,
    val reason: String,
    val expectedAttendanceVersion: Int
)

@JsonClass(generateAdapter = true)
data class AttendanceCorrectionDecisionRequestDto(
    val decision: String,
    val reason: String,
    val expectedVersion: Int
)

@JsonClass(generateAdapter = true)
data class AttendanceCorrectionDecisionResponseDto(
    val correction: AttendanceCorrectionDto,
    val attendance: AttendanceDto? = null
)

@JsonClass(generateAdapter = true)
data class AttendanceExemptionDto(
    val id: String,
    val userId: String,
    val employeeId: String? = null,
    val validFrom: String,
    val validUntil: String? = null,
    val reasonCategory: String,
    val note: String? = null,
    val status: String,
    val version: Int,
    val createdAt: String,
    val revokedAt: String? = null
)

@JsonClass(generateAdapter = true)
data class AttendanceExemptionListDto(
    val items: List<AttendanceExemptionDto>,
    val nextCursor: String? = null,
    val hasMore: Boolean = false
)

@JsonClass(generateAdapter = true)
data class AttendanceExemptionCreateRequestDto(
    val targetUserId: String,
    val validFrom: String,
    val validUntil: String? = null,
    val reasonCategory: String,
    val note: String? = null
)

@JsonClass(generateAdapter = true)
data class AttendanceExemptionRevokeRequestDto(
    val reason: String,
    val expectedVersion: Int
)

@JsonClass(generateAdapter = true)
data class AttendanceEligibleEmployeeDto(
    val employeeId: String,
    val employeeNum: String,
    val name: String,
    val departmentId: String?,
    val departmentName: String,
    val roleName: String? = null
)

@JsonClass(generateAdapter = true)
data class ManualAttendanceRequestDto(
    val employeeId: String,
    val date: String,
    val status: String,
    val clockIn: String?,
    val clockOut: String?
)

@JsonClass(generateAdapter = true)
data class DashboardStatsDto(
    val empCount: Int,
    val pendingLeaves: Int,
    val attCount: Int
)

@JsonClass(generateAdapter = true)
data class NotificationDto(
    val id: String,
    val title: String,
    val message: String,
    val isRead: Boolean,
    val createdAt: String,
    val category: String? = null,
    val readAt: String? = null,
    val hiddenAt: String? = null,
    val descriptor: NotificationDescriptorDto? = null
)

@JsonClass(generateAdapter = true)
data class NotificationDescriptorDto(
    val routeKey: String,
    val resourceType: String,
    val resourceId: String? = null,
    val filterJson: String? = null,
    val filterKey: String? = null,
    val filterValue: String? = null
)

@JsonClass(generateAdapter = true)
data class NotificationErrorResponseDto(
    val message: String? = null,
    val messageKey: String? = null
)

@JsonClass(generateAdapter = true)
data class NotificationListResponseDto(
    val items: List<NotificationDto>,
    val nextCursor: String? = null,
    val hasMore: Boolean = false
)

@JsonClass(generateAdapter = true)
data class NotificationReadAllRequestDto(
    val category: String? = null
)

@JsonClass(generateAdapter = true)
data class NotificationReadAllResponseDto(
    val updatedCount: Int
)

@JsonClass(generateAdapter = true)
data class NotificationPreferenceDto(
    val category: String,
    val inAppEnabled: Boolean,
    val mandatory: Boolean = false
)

@JsonClass(generateAdapter = true)
data class NotificationPreferencesResponseDto(
    val preferences: List<NotificationPreferenceDto>
)

@JsonClass(generateAdapter = true)
data class NotificationPreferencesPutRequestDto(
    val preferences: List<NotificationPreferencePutItemDto>
)

@JsonClass(generateAdapter = true)
data class NotificationPreferencePutItemDto(
    val category: String,
    val inAppEnabled: Boolean
)

@JsonClass(generateAdapter = true)
data class UnreadCountDto(
    val count: Int
)

@JsonClass(generateAdapter = true)
data class VendorDto(
    val id: String,
    val companyId: String,
    val name: String,
    val contact: String? = null,
    val email: String? = null,
    val taxNumber: String? = null,
    val category: String? = null,
    val status: String,
    val deactivatedAt: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    // Only populated by GET/POST /api/v2/vendors/:id/{lifecycle,archive,reactivate};
    // absent (defaulted) on the plain GET /api/vendors list shape.
    val lifecycleVersion: Int = 1,
    val archivedAt: String? = null,
    val archivedByUserId: String? = null,
    val archiveReason: String? = null
)

@JsonClass(generateAdapter = true)
data class VendorRequestDto(
    val name: String,
    val contact: String? = null,
    val email: String? = null,
    val taxNumber: String? = null,
    val category: String? = null
)

@JsonClass(generateAdapter = true)
data class VendorStatusRequestDto(val status: String)

@JsonClass(generateAdapter = true)
data class VendorPageDto(
    val items: List<VendorDto> = emptyList(),
    val page: Int = 1,
    val pageSize: Int = 25,
    val total: Int = 0
)

/** Body for POST /api/v2/vendors/:id/archive. */
@JsonClass(generateAdapter = true)
data class VendorArchiveRequestDto(
    val reason: String,
    val expectedVersion: Int
)

/** Body for POST /api/v2/vendors/:id/reactivate. */
@JsonClass(generateAdapter = true)
data class VendorReactivateRequestDto(
    val expectedVersion: Int,
    val reason: String? = null
)

/** Error shape used by vendorLifecycle.ts: `{ error, message, code, details? }`. */
@JsonClass(generateAdapter = true)
data class VendorLifecycleErrorResponseDto(
    val error: String? = null,
    val message: String? = null,
    val code: Int? = null
)

@JsonClass(generateAdapter = true)
data class PurchasingActorDto(val id: String, val name: String)

@JsonClass(generateAdapter = true)
data class PurchaseReviewDto(
    val reviewer: PurchasingActorDto? = null,
    val reviewedAt: String? = null,
    val note: String? = null
)

@JsonClass(generateAdapter = true)
data class PurchaseRequestLineDto(
    val id: String,
    val description: String,
    val category: String? = null,
    val quantity: String,
    val unit: String,
    val estimatedUnitPrice: String,
    val estimatedTotal: String
)

@JsonClass(generateAdapter = true)
data class PurchaseOrderSummaryDto(
    val id: String,
    val orderNumber: String,
    val status: String,
    val totalAmount: String,
    val currency: String,
    val createdAt: String? = null
)

@JsonClass(generateAdapter = true)
data class PurchaseRequestDto(
    val id: String,
    val companyId: String,
    val requestNumber: String,
    val requestedByEmployeeId: String,
    val requesterNameSnapshot: String,
    val requesterNumSnapshot: String,
    val departmentId: String? = null,
    val departmentNameSnapshot: String? = null,
    val title: String,
    val justification: String? = null,
    val neededByDate: String? = null,
    val status: String,
    val totalEstimated: String,
    val currency: String,
    val lines: List<PurchaseRequestLineDto> = emptyList(),
    val departmentReview: PurchaseReviewDto? = null,
    val purchasingReview: PurchaseReviewDto? = null,
    val rejectedAt: String? = null,
    val orders: List<PurchaseOrderSummaryDto> = emptyList(),
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@JsonClass(generateAdapter = true)
data class PurchaseRequestPageDto(
    val items: List<PurchaseRequestDto> = emptyList(),
    val page: Int = 1,
    val pageSize: Int = 25,
    val total: Int = 0
)

@JsonClass(generateAdapter = true)
data class PurchaseRequestLineInputDto(
    val description: String,
    val category: String? = null,
    val quantity: String,
    val unit: String,
    val estimatedUnitPrice: String
)

@JsonClass(generateAdapter = true)
data class CreatePurchaseRequestDto(
    val title: String,
    val justification: String? = null,
    val neededByDate: String? = null,
    val currency: String = "SAR",
    val lines: List<PurchaseRequestLineInputDto>
)

@JsonClass(generateAdapter = true)
data class PurchasingReviewRequestDto(val action: String, val note: String? = null)

@JsonClass(generateAdapter = true)
data class PurchasingCancelRequestDto(val cancellationReason: String)

@JsonClass(generateAdapter = true)
data class PurchaseOrderRequestSummaryDto(
    val id: String,
    val requestNumber: String,
    val title: String,
    val requesterNameSnapshot: String,
    val departmentNameSnapshot: String? = null,
    val status: String
)

@JsonClass(generateAdapter = true)
data class PurchaseOrderLineDto(
    val id: String,
    val requestLineId: String? = null,
    val descriptionSnapshot: String,
    val categorySnapshot: String? = null,
    val quantity: String,
    val unitSnapshot: String,
    val unitPrice: String,
    val lineTotal: String
)

@JsonClass(generateAdapter = true)
data class PurchaseOrderDto(
    val id: String,
    val companyId: String,
    val orderNumber: String,
    val purchaseRequestId: String,
    val request: PurchaseOrderRequestSummaryDto? = null,
    val vendorId: String,
    val vendorNameSnapshot: String,
    val vendorContactSnapshot: String? = null,
    val vendorEmailSnapshot: String? = null,
    val vendorTaxNumberSnapshot: String? = null,
    val status: String,
    val currency: String,
    val subtotal: String,
    val totalAmount: String,
    val lines: List<PurchaseOrderLineDto> = emptyList(),
    val issuedAt: String? = null,
    val receivedAt: String? = null,
    val receiptNote: String? = null,
    val cancelledAt: String? = null,
    val cancellationReason: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@JsonClass(generateAdapter = true)
data class PurchaseOrderPageDto(
    val items: List<PurchaseOrderDto> = emptyList(),
    val page: Int = 1,
    val pageSize: Int = 25,
    val total: Int = 0
)

@JsonClass(generateAdapter = true)
data class PurchaseOrderLineInputDto(
    val id: String? = null,
    val requestLineId: String? = null,
    val description: String,
    val category: String? = null,
    val quantity: String,
    val unit: String,
    val unitPrice: String
)

@JsonClass(generateAdapter = true)
data class CreatePurchaseOrderDto(
    val purchaseRequestId: String,
    val vendorId: String,
    val currency: String = "SAR",
    val lines: List<PurchaseOrderLineInputDto>
)

@JsonClass(generateAdapter = true)
data class UpdatePurchaseOrderDto(
    val vendorId: String,
    val currency: String = "SAR",
    val lines: List<PurchaseOrderLineInputDto>
)

@JsonClass(generateAdapter = true)
data class ReceivePurchaseOrderDto(val receiptNote: String? = null)

@JsonClass(generateAdapter = true)
data class PurchasingReportSummaryDto(
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

@JsonClass(generateAdapter = true)
data class PurchasingReportDto(val summary: PurchasingReportSummaryDto)

@JsonClass(generateAdapter = true)
data class PurchasingErrorDto(
    val error: String? = null,
    val message: String? = null,
    val code: Int? = null
)

// ---- Sprint 12I: purchasing admin override (v2) + purchasing exports (v2) ----

@JsonClass(generateAdapter = true)
data class PurchasingOverrideRequestDto(
    val action: String,
    val reason: String,
    val confirmation: String = "OVERRIDE",
    val expectedUpdatedAt: String? = null
)

/** Error shape returned by `/api/v2/purchasing/requests/{id}/override` (see backend/src/purchasingOverride.ts). */
@JsonClass(generateAdapter = true)
data class PurchasingOverrideErrorDto(
    val error: String? = null,
    val code: Int? = null,
    val message: String? = null,
    val messageKey: String? = null,
    val currentUpdatedAt: String? = null,
    val currentStatus: String? = null
)

@JsonClass(generateAdapter = true)
data class PurchasingExportRequestDto(
    val format: String,
    val locale: String? = null
)

// ---- Commercial Wave 2 (Operations Slice E1): quotations, receipts, returns ----
//
// Quantities and money stay decimal *strings* end to end. The Android client
// never parses them into Double: the backend owns all arithmetic, and the app
// only displays and compares them.

@JsonClass(generateAdapter = true)
data class SupplierQuotationLineDto(
    val id: String,
    val requestLineId: String? = null,
    val descriptionSnapshot: String,
    val categorySnapshot: String? = null,
    val quantity: String,
    val unitSnapshot: String,
    val unitPrice: String,
    val lineTotal: String,
    val leadTimeDays: Int? = null,
    val notes: String? = null
)

@JsonClass(generateAdapter = true)
data class SupplierQuotationSelectionDto(
    val actor: PurchasingActorDto? = null,
    val selectedAt: String? = null,
    val reason: String? = null
)

@JsonClass(generateAdapter = true)
data class SupplierQuotationRejectionDto(
    val actor: PurchasingActorDto? = null,
    val rejectedAt: String? = null,
    val reason: String? = null
)

@JsonClass(generateAdapter = true)
data class SupplierQuotationDto(
    val id: String,
    val companyId: String,
    val quotationNumber: String,
    val purchaseRequestId: String,
    val vendorId: String,
    val vendorNameSnapshot: String,
    val supplierReference: String? = null,
    val status: String,
    val version: Int = 1,
    val currency: String = "SAR",
    val subtotal: String = "0.00",
    val totalAmount: String = "0.00",
    val quotationDate: String? = null,
    val validUntilDate: String? = null,
    val expectedDeliveryDate: String? = null,
    val leadTimeDays: Int? = null,
    val paymentTerms: String? = null,
    val notes: String? = null,
    val lines: List<SupplierQuotationLineDto> = emptyList(),
    val createdBy: PurchasingActorDto? = null,
    val submittedAt: String? = null,
    val selection: SupplierQuotationSelectionDto? = null,
    val rejection: SupplierQuotationRejectionDto? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@JsonClass(generateAdapter = true)
data class SupplierQuotationPageDto(
    val items: List<SupplierQuotationDto> = emptyList(),
    val total: Int = 0
)

@JsonClass(generateAdapter = true)
data class SupplierQuotationLineInputDto(
    val requestLineId: String? = null,
    val description: String,
    val category: String? = null,
    val quantity: String,
    val unit: String,
    val unitPrice: String,
    val leadTimeDays: Int? = null,
    val notes: String? = null
)

@JsonClass(generateAdapter = true)
data class CreateSupplierQuotationDto(
    val vendorId: String,
    val supplierReference: String? = null,
    val currency: String = "SAR",
    val quotationDate: String? = null,
    val validUntilDate: String? = null,
    val expectedDeliveryDate: String? = null,
    val leadTimeDays: Int? = null,
    val paymentTerms: String? = null,
    val notes: String? = null,
    val lines: List<SupplierQuotationLineInputDto>
)

@JsonClass(generateAdapter = true)
data class SelectSupplierQuotationDto(
    val reason: String,
    val confirm: Boolean = true
)

@JsonClass(generateAdapter = true)
data class RejectSupplierQuotationDto(val reason: String)

@JsonClass(generateAdapter = true)
data class QuotationComparisonCellDto(
    val quotationId: String,
    val quotationNumber: String,
    val vendorId: String,
    val vendorNameSnapshot: String,
    val quoted: Boolean = false,
    val quantity: String? = null,
    val unit: String? = null,
    val unitPrice: String? = null,
    val lineTotal: String? = null,
    val leadTimeDays: Int? = null,
    val notes: String? = null
)

@JsonClass(generateAdapter = true)
data class QuotationComparisonRowDto(
    val requestLineId: String,
    val description: String,
    val requestedQuantity: String,
    val unit: String,
    val estimatedUnitPrice: String,
    val cells: List<QuotationComparisonCellDto> = emptyList()
)

/** Objective aggregates only — the backend never nominates a winning supplier. */
@JsonClass(generateAdapter = true)
data class QuotationComparisonTotalsDto(
    val currency: String = "SAR",
    val comparableQuotationCount: Int = 0,
    val lowestTotalAmount: String? = null,
    val highestTotalAmount: String? = null,
    val spreadAmount: String? = null
)

@JsonClass(generateAdapter = true)
data class QuotationComparisonRequestDto(
    val id: String,
    val requestNumber: String,
    val title: String,
    val status: String,
    val currency: String = "SAR",
    val totalEstimated: String = "0.00"
)

@JsonClass(generateAdapter = true)
data class QuotationComparisonDto(
    val generatedAt: String,
    val request: QuotationComparisonRequestDto,
    val quotations: List<SupplierQuotationDto> = emptyList(),
    val matrix: List<QuotationComparisonRowDto> = emptyList(),
    val totals: QuotationComparisonTotalsDto = QuotationComparisonTotalsDto(),
    val selectedQuotationId: String? = null
)

@JsonClass(generateAdapter = true)
data class PurchaseReceiptLineDto(
    val id: String,
    val purchaseOrderLineId: String,
    val quantity: String,
    val note: String? = null
)

@JsonClass(generateAdapter = true)
data class PurchaseReceiptDto(
    val id: String,
    val companyId: String,
    val purchaseOrderId: String,
    val receiptNumber: String,
    val receiptKind: String = "partial",
    val referenceNumber: String? = null,
    val note: String? = null,
    val receivedBy: PurchasingActorDto? = null,
    val receivedAt: String? = null,
    val overrideApplied: Boolean = false,
    val overrideReason: String? = null,
    val lines: List<PurchaseReceiptLineDto> = emptyList(),
    val createdAt: String? = null
)

@JsonClass(generateAdapter = true)
data class OrderLineProgressDto(
    val purchaseOrderLineId: String,
    val descriptionSnapshot: String,
    val unitSnapshot: String,
    val unitPrice: String = "0.00",
    val orderedQuantity: String = "0.000",
    val receivedQuantity: String = "0.000",
    val returnedQuantity: String = "0.000",
    val netReceivedQuantity: String = "0.000",
    val remainingQuantity: String = "0.000",
    val fullyReceived: Boolean = false
)

@JsonClass(generateAdapter = true)
data class OrderReceiptProgressDto(
    val purchaseOrderId: String,
    val fullyReceived: Boolean = false,
    val anyReceived: Boolean = false,
    val lines: List<OrderLineProgressDto> = emptyList()
)

@JsonClass(generateAdapter = true)
data class PurchaseReceiptPageDto(
    val items: List<PurchaseReceiptDto> = emptyList(),
    val total: Int = 0,
    val progress: OrderReceiptProgressDto? = null
)

@JsonClass(generateAdapter = true)
data class PurchaseReceiptLineInputDto(
    val purchaseOrderLineId: String,
    val quantity: String,
    val note: String? = null
)

/** Explicit, audited over-receipt. Absent unless the quantity really exceeds the remainder. */
@JsonClass(generateAdapter = true)
data class PurchaseReceiptOverrideDto(
    val reason: String,
    val confirmation: String = "OVERRIDE"
)

@JsonClass(generateAdapter = true)
data class CreatePurchaseReceiptDto(
    val lines: List<PurchaseReceiptLineInputDto>,
    val referenceNumber: String? = null,
    val note: String? = null,
    val override: PurchaseReceiptOverrideDto? = null
)

@JsonClass(generateAdapter = true)
data class CreatePurchaseReceiptResponseDto(
    val receipt: PurchaseReceiptDto,
    val progress: OrderReceiptProgressDto? = null
)

@JsonClass(generateAdapter = true)
data class PurchaseReturnLineDto(
    val id: String,
    val purchaseOrderLineId: String,
    val quantity: String,
    val note: String? = null
)

@JsonClass(generateAdapter = true)
data class PurchaseReturnReviewDto(
    val actor: PurchasingActorDto? = null,
    val reviewedAt: String? = null,
    val note: String? = null
)

@JsonClass(generateAdapter = true)
data class PurchaseReturnDto(
    val id: String,
    val companyId: String,
    val purchaseOrderId: String,
    val returnNumber: String,
    val status: String,
    val reasonCode: String,
    val note: String? = null,
    val createdBy: PurchasingActorDto? = null,
    val createdAt: String? = null,
    val review: PurchaseReturnReviewDto? = null,
    val lines: List<PurchaseReturnLineDto> = emptyList(),
    val updatedAt: String? = null
)

@JsonClass(generateAdapter = true)
data class PurchaseReturnPageDto(
    val items: List<PurchaseReturnDto> = emptyList(),
    val total: Int = 0
)

@JsonClass(generateAdapter = true)
data class PurchaseReturnLineInputDto(
    val purchaseOrderLineId: String,
    val quantity: String,
    val note: String? = null
)

@JsonClass(generateAdapter = true)
data class CreatePurchaseReturnDto(
    val reasonCode: String,
    val note: String? = null,
    val lines: List<PurchaseReturnLineInputDto>
)

@JsonClass(generateAdapter = true)
data class ReviewPurchaseReturnDto(
    val action: String,
    val note: String? = null
)

@JsonClass(generateAdapter = true)
data class PayrollPeriodDto(
    val id: String,
    val companyId: String,
    val month: Int,
    val year: Int,
    val status: String,
    val itemCount: Int = 0,
    val calculationVersion: Int = 0,
    val createdAt: String? = null,
    val calculatedAt: String? = null,
    val approvedAt: String? = null,
    val paidAt: String? = null,
    val legacyWithoutItems: Boolean = false,
    val visibleSummary: PayrollMoneySummaryDto? = null,
    val fullSummary: PayrollMoneySummaryDto? = null,
    val protectedRowsHidden: Boolean = false,
    val protectedRowCount: Int = 0
)

@JsonClass(generateAdapter = true)
data class PayrollMoneySummaryDto(
    val visibleEmployeeCount: Int,
    val visibleGross: String,
    val visibleDeductions: String,
    val visibleNet: String,
    val currency: String
)

@JsonClass(generateAdapter = true)
data class PayrollItemDto(
    val id: String,
    val payrollPeriodId: String,
    val employeeId: String,
    val employeeName: String,
    val employeeNum: String,
    val departmentName: String? = null,
    val baseSalary: String,
    val grossPay: String,
    val totalDeductions: String,
    val netPay: String,
    val currency: String,
    val status: String,
    val calculatedAt: String? = null
)

@JsonClass(generateAdapter = true)
data class CreatePayrollPeriodRequestDto(
    val month: Int,
    val year: Int
)

@JsonClass(generateAdapter = true)
data class PayrollCalculationRequestDto(
    val recalculationReason: String? = null
)

@JsonClass(generateAdapter = true)
data class PayrollItemsResponseDto(
    val period: PayrollPeriodDto,
    val items: List<PayrollItemDto>,
    val visibleSummary: PayrollMoneySummaryDto? = null,
    val fullSummary: PayrollMoneySummaryDto? = null,
    val protectedRowsHidden: Boolean = false,
    val protectedRowCount: Int = 0
)

@JsonClass(generateAdapter = true)
data class PayrollCalculationResponseDto(
    val period: PayrollPeriodDto,
    val items: List<PayrollItemDto>,
    val visibleSummary: PayrollMoneySummaryDto? = null,
    val fullSummary: PayrollMoneySummaryDto? = null,
    val protectedRowsHidden: Boolean = false,
    val protectedRowCount: Int = 0,
    val idempotent: Boolean,
    val recalculated: Boolean,
    val protectedEmployeeIssues: Int = 0
)

@JsonClass(generateAdapter = true)
data class PayrollActionResponseDto(
    val period: PayrollPeriodDto,
    val message: String,
    val bankTransferProof: Boolean? = null
)

@JsonClass(generateAdapter = true)
data class PayrollReportResponseDto(
    val period: PayrollPeriodDto,
    val rows: List<PayrollItemDto>,
    val visibleSummary: PayrollMoneySummaryDto? = null,
    val fullSummary: PayrollMoneySummaryDto? = null,
    val protectedRowsHidden: Boolean = false,
    val protectedRowCount: Int = 0
)

@JsonClass(generateAdapter = true)
data class PayrollBlockerDto(
    val code: String,
    val message: String,
    val employeeId: String? = null,
    val employeeNum: String? = null,
    val employeeName: String? = null
)

@JsonClass(generateAdapter = true)
data class PayrollErrorDetailsDto(
    val issues: List<PayrollBlockerDto> = emptyList(),
    val protectedEmployeeIssues: Int = 0
)

@JsonClass(generateAdapter = true)
data class PayrollErrorResponseDto(
    val error: String? = null,
    val message: String? = null,
    val details: PayrollErrorDetailsDto? = null
)

// ---- Sprint 12H: payroll partial payments (v2) + exports ----

@JsonClass(generateAdapter = true)
data class PayrollPaymentDto(
    val id: String,
    val companyId: String,
    val payrollPeriodId: String,
    val amount: String,
    val currency: String,
    val paymentDate: String,
    val reference: String? = null,
    val note: String? = null,
    val status: String,
    val idempotencyKey: String,
    val recordedByUserId: String,
    val createdAt: String? = null,
    val voidedAt: String? = null,
    val voidedByUserId: String? = null,
    val voidReason: String? = null,
    val isLegacyMigration: Boolean = false
)

/** Period shape returned by the payments record/void endpoints — a superset of PayrollPeriodDto. */
@JsonClass(generateAdapter = true)
data class PayrollPeriodPaymentSummaryDto(
    val id: String,
    val companyId: String,
    val month: Int,
    val year: Int,
    val status: String,
    val numericLabel: String,
    val paymentState: String,
    val paymentVersion: Int = 0,
    val calculationVersion: Int = 0,
    val createdAt: String? = null,
    val calculatedAt: String? = null,
    val approvedAt: String? = null,
    val paidAt: String? = null,
    val legacyWithoutItems: Boolean = false,
    val itemCount: Int = 0,
    val visibleSummary: PayrollMoneySummaryDto? = null,
    val protectedRowsHidden: Boolean = false,
    val protectedRowCount: Int = 0,
    val approvedNetTotal: String? = null,
    val fullSummary: PayrollMoneySummaryDto? = null
)

@JsonClass(generateAdapter = true)
data class PayrollRecordPaymentRequestDto(
    val amount: String,
    val currency: String,
    val paymentDate: String,
    val reference: String? = null,
    val note: String? = null,
    val expectedVersion: Int
)

@JsonClass(generateAdapter = true)
data class PayrollVoidPaymentRequestDto(
    val reason: String,
    val expectedVersion: Int
)

@JsonClass(generateAdapter = true)
data class PayrollPaymentActionResponseDto(
    val payment: PayrollPaymentDto,
    val period: PayrollPeriodPaymentSummaryDto
)

/** Error shape used by the payments endpoints: `{ code, messageKey, fieldErrors? }`. */
@JsonClass(generateAdapter = true)
data class PayrollPaymentErrorResponseDto(
    val code: String? = null,
    val messageKey: String? = null,
    val fieldErrors: Map<String, String>? = null
)

@JsonClass(generateAdapter = true)
data class PayrollExportRequestDto(
    val format: String,
    val locale: String? = null
)

@JsonClass(generateAdapter = true)
data class TaskActorDto(
    val id: String,
    val name: String
)

@JsonClass(generateAdapter = true)
data class TaskAssignmentEmployeeDto(
    val id: String,
    val employeeNum: String,
    val name: String,
    val departmentId: String? = null,
    val departmentName: String? = null
)

@JsonClass(generateAdapter = true)
data class TaskAssignmentDto(
    val id: String,
    val taskId: String,
    val employee: TaskAssignmentEmployeeDto,
    val status: String,
    val completionDetails: String? = null,
    val submittedAt: String? = null,
    val reviewer: TaskActorDto? = null,
    val reviewedAt: String? = null,
    val reviewNote: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@JsonClass(generateAdapter = true)
data class TaskDto(
    val id: String,
    val companyId: String,
    val title: String,
    val description: String? = null,
    val priority: String,
    val dueDate: String? = null,
    val status: String,
    val creator: TaskActorDto,
    val assignments: List<TaskAssignmentDto> = emptyList(),
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@JsonClass(generateAdapter = true)
data class TaskEligibleEmployeeDto(
    val employeeId: String,
    val employeeNum: String,
    val name: String,
    val departmentId: String? = null,
    val departmentName: String? = null
)

@JsonClass(generateAdapter = true)
data class CreateTaskRequestDto(
    val title: String,
    val description: String? = null,
    val priority: String,
    val dueDate: String? = null,
    val employeeIds: List<String>
)

@JsonClass(generateAdapter = true)
data class TaskCommentDto(
    val id: String,
    val taskId: String,
    val body: String,
    val author: TaskActorDto,
    val createdAt: String? = null
)

@JsonClass(generateAdapter = true)
data class TaskCommentPageDto(
    val items: List<TaskCommentDto> = emptyList(),
    val nextCursor: String? = null,
    val hasMore: Boolean = false
)

@JsonClass(generateAdapter = true)
data class CreateTaskCommentRequestDto(
    val body: String
)

@JsonClass(generateAdapter = true)
data class TaskProgressRequestDto(
    val status: String,
    val completionDetails: String? = null
)

@JsonClass(generateAdapter = true)
data class TaskReviewRequestDto(
    val action: String,
    val reviewNote: String? = null
)

@JsonClass(generateAdapter = true)
data class TaskReviewResponseDto(
    val assignment: TaskAssignmentDto,
    val taskStatus: String
)

@JsonClass(generateAdapter = true)
data class TaskErrorResponseDto(
    val error: String? = null,
    val message: String? = null,
    val code: Int? = null
)

@JsonClass(generateAdapter = true)
data class ChatDirectoryUserDto(
    val userId: String,
    val displayName: String,
    val title: String? = null,
    val employeeId: String? = null,
    val departmentId: String? = null,
    val departmentName: String? = null,
    val roleName: String,
    val status: String? = "active"
)

@JsonClass(generateAdapter = true)
data class ChatSenderDto(
    val userId: String,
    val displayName: String,
    val roleName: String,
    val departmentName: String? = null
)

@JsonClass(generateAdapter = true)
data class ChatDepartmentDto(
    val id: String,
    val name: String
)

@JsonClass(generateAdapter = true)
data class ChatReadStateDto(
    val active: Boolean,
    val lastReadAt: String? = null
)

@JsonClass(generateAdapter = true)
data class ChatConversationDto(
    val id: String,
    val type: String,
    val title: String,
    val peer: ChatDirectoryUserDto? = null,
    val department: ChatDepartmentDto? = null,
    val lastMessagePreview: String? = null,
    val lastMessageAt: String? = null,
    val lastSender: ChatSenderDto? = null,
    val unreadCount: Int = 0,
    val readState: ChatReadStateDto? = null,
    val createdAt: String? = null,
    val repliesEnabled: Boolean? = null
)

@JsonClass(generateAdapter = true)
data class ChatMessageDto(
    val id: String,
    val conversationId: String,
    val sender: ChatSenderDto,
    val body: String,
    val createdAt: String,
    val isOwn: Boolean,
    val replyToMessageId: String? = null,
    val attachments: List<ChatAttachmentDto> = emptyList()
)

@JsonClass(generateAdapter = true)
data class ChatAttachmentDto(
    val id: String,
    val originalFilename: String,
    val contentType: String,
    val byteSize: Int
)

@JsonClass(generateAdapter = true)
data class ChatConversationPageDto(
    val items: List<ChatConversationDto> = emptyList(),
    val nextOffset: Int? = null
)

@JsonClass(generateAdapter = true)
data class ChatMessagePageDto(
    val items: List<ChatMessageDto> = emptyList(),
    val nextCursor: String? = null,
    val order: String = "chronological"
)

@JsonClass(generateAdapter = true)
data class ChatReadResultDto(
    val conversationId: String,
    val unreadCount: Int
)

@JsonClass(generateAdapter = true)
data class ChatUnreadCountDto(
    val unreadCount: Int
)

@JsonClass(generateAdapter = true)
data class ChatOpenDirectRequestDto(
    val userId: String
)

@JsonClass(generateAdapter = true)
data class ChatSendMessageRequestDto(
    val body: String,
    val replyToMessageId: String? = null
)

@JsonClass(generateAdapter = true)
data class ChatCreateAnnouncementRequestDto(
    val title: String,
    val body: String? = null
)

@JsonClass(generateAdapter = true)
data class ChatPinMessageRequestDto(
    val messageId: String
)

@JsonClass(generateAdapter = true)
data class ChatPinnedMessageDto(
    val id: String,
    val conversationId: String,
    val messageId: String,
    val pinnedByUserId: String? = null,
    val pinnedAt: String? = null
)

@JsonClass(generateAdapter = true)
data class ChatPinnedMessagePageDto(
    val items: List<ChatPinnedMessageDto> = emptyList()
)

@JsonClass(generateAdapter = true)
data class ChatErrorResponseDto(
    val error: String? = null,
    val message: String? = null,
    val code: Int? = null
)

@JsonClass(generateAdapter = true)
data class TrainingResourceDto(
    val id: String,
    val title: String,
    val type: String,
    val url: String,
    val sortOrder: Int
)

@JsonClass(generateAdapter = true)
data class TrainingAssignmentSummaryDto(
    val total: Int = 0,
    val assigned: Int = 0,
    @Json(name = "in_progress") val inProgress: Int = 0,
    val submitted: Int = 0,
    val completed: Int = 0,
    val returned: Int = 0,
    val cancelled: Int = 0
)

@JsonClass(generateAdapter = true)
data class TrainingCourseSummaryDto(
    val id: String,
    val courseCode: String,
    val title: String,
    val category: String? = null,
    val instructorName: String? = null,
    val deliveryMode: String,
    val location: String? = null,
    val startDate: String? = null,
    val endDate: String? = null,
    val durationHours: Int? = null,
    val status: String
)

@JsonClass(generateAdapter = true)
data class TrainingEmployeeSnapshotDto(
    val employeeId: String,
    val employeeNum: String,
    val displayName: String,
    val departmentId: String? = null,
    val departmentName: String? = null
)

@JsonClass(generateAdapter = true)
data class TrainingCancellationDto(
    val cancelledAt: String? = null,
    val reason: String? = null
)

@JsonClass(generateAdapter = true)
data class TrainingAssignmentDto(
    val id: String,
    val companyId: String? = null,
    val courseId: String,
    val course: TrainingCourseSummaryDto? = null,
    val employee: TrainingEmployeeSnapshotDto,
    val status: String,
    val progressPercent: Int,
    val assignedAt: String? = null,
    val startedAt: String? = null,
    val submittedAt: String? = null,
    val completedAt: String? = null,
    val reviewedAt: String? = null,
    val reviewNote: String? = null,
    val score: Int? = null,
    val cancellation: TrainingCancellationDto? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

/**
 * Commercial P4 — internal completion certificate. Snapshot fields are frozen
 * server side at issue time, so a later course rename never rewrites an already
 * issued certificate. Internal company record only; no external accreditation.
 */
@JsonClass(generateAdapter = true)
data class TrainingCertificateDto(
    val id: String,
    val assignmentId: String,
    val courseId: String,
    val employeeId: String,
    val serialNumber: String,
    val courseTitle: String,
    val employeeName: String,
    val employeeNum: String,
    val completedAt: String? = null,
    val issuedBy: TaskActorDto? = null,
    val issuedAt: String? = null
)

/**
 * Commercial P4 — reviewer evaluation. Reading one needs
 * `training.evaluation.view`; the ordinary training scope is not enough,
 * because this is a performance-adjacent judgment.
 */
@JsonClass(generateAdapter = true)
data class TrainingEvaluationDto(
    val id: String,
    val assignmentId: String,
    val courseId: String,
    val employeeId: String,
    val effectivenessScore: Int,
    val knowledgeScore: Int,
    val applicationScore: Int,
    val recommendation: String,
    val comment: String? = null,
    val evaluatedBy: TaskActorDto? = null,
    val evaluatedAt: String? = null
)

@JsonClass(generateAdapter = true)
data class CreateTrainingEvaluationRequestDto(
    val effectivenessScore: Int,
    val knowledgeScore: Int,
    val applicationScore: Int,
    val recommendation: String,
    val comment: String? = null
)

@JsonClass(generateAdapter = true)
data class TrainingCourseDto(
    val id: String,
    val companyId: String? = null,
    val courseCode: String,
    val title: String,
    val description: String? = null,
    val category: String? = null,
    val instructorName: String? = null,
    val deliveryMode: String,
    val location: String? = null,
    val startDate: String? = null,
    val endDate: String? = null,
    val durationHours: Int? = null,
    val capacity: Int? = null,
    val status: String,
    val resources: List<TrainingResourceDto> = emptyList(),
    val assignmentSummary: TrainingAssignmentSummaryDto = TrainingAssignmentSummaryDto(),
    val ownAssignment: TrainingAssignmentDto? = null,
    val createdAt: String? = null,
    val publishedAt: String? = null,
    val completedAt: String? = null,
    val cancelledAt: String? = null,
    val archivedAt: String? = null,
    val updatedAt: String? = null
)

@JsonClass(generateAdapter = true)
data class TrainingCoursePageDto(
    val items: List<TrainingCourseDto> = emptyList(),
    val page: Int,
    val pageSize: Int,
    val total: Int
)

@JsonClass(generateAdapter = true)
data class TrainingAssignmentPageDto(
    val items: List<TrainingAssignmentDto> = emptyList(),
    val page: Int,
    val pageSize: Int,
    val total: Int
)

@JsonClass(generateAdapter = true)
data class TrainingEligibleEmployeeDto(
    val employeeId: String,
    val employeeNum: String,
    val displayName: String,
    val departmentId: String? = null,
    val departmentName: String? = null,
    val roleName: String? = null
)

@JsonClass(generateAdapter = true)
data class TrainingResourceRequestDto(
    val title: String,
    val type: String,
    val url: String,
    val sortOrder: Int? = null
)

@JsonClass(generateAdapter = true)
data class TrainingCourseRequestDto(
    val title: String,
    val description: String? = null,
    val category: String? = null,
    val instructorName: String? = null,
    val deliveryMode: String,
    val location: String? = null,
    val startDate: String? = null,
    val endDate: String? = null,
    val durationHours: Int? = null,
    val capacity: Int? = null,
    val resources: List<TrainingResourceRequestDto> = emptyList()
)

@JsonClass(generateAdapter = true)
data class TrainingBulkAssignmentRequestDto(val employeeIds: List<String>)

@JsonClass(generateAdapter = true)
data class TrainingProgressRequestDto(val progressPercent: Int)

@JsonClass(generateAdapter = true)
data class TrainingSubmitRequestDto(val completionNote: String? = null)

@JsonClass(generateAdapter = true)
data class TrainingReviewRequestDto(
    val action: String,
    val score: Int? = null,
    val reviewNote: String? = null
)

@JsonClass(generateAdapter = true)
data class TrainingCancellationRequestDto(val cancellationReason: String)

@JsonClass(generateAdapter = true)
data class TrainingReportSummaryDto(
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
    val averageScore: String? = null
)

@JsonClass(generateAdapter = true)
data class TrainingReportCourseRowDto(
    val id: String,
    val courseCode: String,
    val title: String,
    val category: String? = null,
    val instructorName: String? = null,
    val deliveryMode: String,
    val location: String? = null,
    val startDate: String? = null,
    val endDate: String? = null,
    val durationHours: Int? = null,
    val status: String,
    val assignmentSummary: TrainingAssignmentSummaryDto = TrainingAssignmentSummaryDto()
)

@JsonClass(generateAdapter = true)
data class TrainingReportAssignmentRowDto(
    val id: String,
    val courseId: String,
    val employee: TrainingEmployeeSnapshotDto,
    val status: String
)

@JsonClass(generateAdapter = true)
data class TrainingReportDepartmentRowDto(
    val departmentId: String? = null,
    val departmentName: String? = null,
    val assignmentCount: Int,
    val completedCount: Int,
    val completionRatePercent: Double
)

@JsonClass(generateAdapter = true)
data class TrainingReportDto(
    val summary: TrainingReportSummaryDto,
    val courses: List<TrainingReportCourseRowDto> = emptyList(),
    val assignments: List<TrainingReportAssignmentRowDto> = emptyList(),
    val departments: List<TrainingReportDepartmentRowDto> = emptyList()
)

@JsonClass(generateAdapter = true)
data class TrainingErrorResponseDto(
    val error: String? = null,
    val message: String? = null,
    val code: Int? = null
)

@JsonClass(generateAdapter = true)
data class TrainingTimelineEventDto(
    val at: String,
    val type: String,
    val summary: String
)

@JsonClass(generateAdapter = true)
data class TrainingTimelineDto(
    val courseId: String,
    val events: List<TrainingTimelineEventDto> = emptyList()
)

@JsonClass(generateAdapter = true)
data class TrainingExportRequestDto(
    val format: String,
    val locale: String = "ar",
    val scope: String? = null,
    val from: String? = null,
    val to: String? = null,
    val courseStatus: String? = null,
    val assignmentStatus: String? = null,
    val category: String? = null,
    val departmentId: String? = null
)

@JsonClass(generateAdapter = true)
data class ReportCatalogItemDto(
    val type: String,
    val title: String,
    val description: String,
    val availableScopes: List<String> = emptyList(),
    val supportedFilters: List<String> = emptyList(),
    val exportAvailable: Boolean = false,
    val containsFinancialData: Boolean = false,
    val maximumRangeDays: Int = 366
)

@JsonClass(generateAdapter = true)
data class ReportRangeDto(
    val from: String,
    val to: String
)

@JsonClass(generateAdapter = true)
data class ReportScopeDto(
    val kind: String,
    val departmentId: String? = null
)

@JsonClass(generateAdapter = true)
data class ReportOverviewSectionDto(
    val title: String,
    val metrics: Map<String, Any?> = emptyMap(),
    val protectedRowsHidden: Boolean = false
)

@JsonClass(generateAdapter = true)
data class ReportOverviewDto(
    val generatedAt: String,
    val dateRange: ReportRangeDto,
    val scope: ReportScopeDto,
    val sections: Map<String, ReportOverviewSectionDto> = emptyMap(),
    val unavailableSections: List<String> = emptyList(),
    val warnings: List<String> = emptyList()
)

@JsonClass(generateAdapter = true)
data class ReportPaginationDto(
    val page: Int,
    val pageSize: Int,
    val total: Int
)

@JsonClass(generateAdapter = true)
data class ReportDetailDto(
    val type: String,
    val generatedAt: String,
    val range: ReportRangeDto? = null,
    val scope: ReportScopeDto,
    val summary: Map<String, Any?> = emptyMap(),
    val rows: List<Map<String, Any?>> = emptyList(),
    val pagination: ReportPaginationDto,
    val warnings: List<String> = emptyList(),
    val protectedRowsHidden: Boolean = false,
    val protectedRowCount: Int = 0
)

@JsonClass(generateAdapter = true)
data class ReportExportRequestDto(
    val reportType: String,
    val filters: Map<String, String>,
    val format: String = "csv"
)

@JsonClass(generateAdapter = true)
data class ReportErrorResponseDto(
    val error: String? = null,
    val message: String? = null,
    val requestId: String? = null
)

/**
 * Sprint 12J — server-owned report template registry (catalog/preview/save/export).
 * See backend/src/reportTemplates.ts + reportTemplateExports.ts for the exact shapes.
 * Filters are always sent as strings from Android (dates, ids, statuses are all
 * string-typed in the UI); the backend's filter schema also accepts number/boolean/null
 * but no Android filter control ever produces those, so String is the only value type used.
 */
@JsonClass(generateAdapter = true)
data class ReportTemplateCatalogItemDto(
    val builtInKey: String,
    val version: Int,
    val kind: String,
    val modules: List<String> = emptyList(),
    val title: String,
    val description: String,
    val formats: List<String> = emptyList(),
    val maximumRangeDays: Int = 366
)

@JsonClass(generateAdapter = true)
data class ReportTemplateScopeRequestDto(
    val departmentId: String? = null
)

@JsonClass(generateAdapter = true)
data class ReportTemplatePreviewRequestDto(
    val builtInKey: String,
    val templateVersion: Int,
    val scope: ReportTemplateScopeRequestDto? = null,
    val filters: Map<String, String> = emptyMap()
)

@JsonClass(generateAdapter = true)
data class ReportTemplateSectionDto(
    val module: String,
    val title: String,
    val summary: Map<String, Any?> = emptyMap(),
    val rows: List<Map<String, Any?>> = emptyList(),
    val rowCount: Int = 0,
    val truncated: Boolean = false,
    val warnings: List<String> = emptyList()
)

@JsonClass(generateAdapter = true)
data class ReportTemplateDocumentDto(
    val builtInKey: String,
    val templateVersion: Int,
    val generatedAt: String,
    val scope: ReportScopeDto,
    val sections: List<ReportTemplateSectionDto> = emptyList(),
    val warnings: List<String> = emptyList()
)

@JsonClass(generateAdapter = true)
data class SavedReportTemplateDto(
    val id: String,
    val name: String,
    val builtInKey: String,
    val templateVersion: Int,
    val scope: ReportScopeDto,
    val filters: Map<String, Any?> = emptyMap(),
    val preferredFormat: String? = null,
    val archivedAt: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)

@JsonClass(generateAdapter = true)
data class CreateSavedReportTemplateRequestDto(
    val name: String,
    val builtInKey: String,
    val templateVersion: Int? = null,
    val scope: ReportTemplateScopeRequestDto? = null,
    val filters: Map<String, String> = emptyMap(),
    val preferredFormat: String? = null
)

@JsonClass(generateAdapter = true)
data class ReportTemplateExportRequestDto(
    val builtInKey: String,
    val templateVersion: Int,
    val scope: ReportTemplateScopeRequestDto? = null,
    val filters: Map<String, String> = emptyMap(),
    val format: String,
    val locale: String? = null
)

/** Mirrors the {error, message, code, details?} shape sendError() uses in both template route files. */
@JsonClass(generateAdapter = true)
data class ReportTemplateErrorResponseDto(
    val error: String? = null,
    val message: String? = null,
    val code: Int? = null
)

@JsonClass(generateAdapter = true)
data class AttachmentUploadRequestDto(
    val purpose: String,
    val originalFilename: String,
    val contentType: String,
    val contentBase64: String,
    val purchaseOrderId: String? = null,
    val chatMessageId: String? = null,
    val conversationId: String? = null
)

@JsonClass(generateAdapter = true)
data class AttachmentMetadataDto(
    val id: String,
    val companyId: String? = null,
    val originalFilename: String,
    val contentType: String,
    val byteSize: Int,
    val sha256: String? = null,
    val uploadedByUserId: String? = null,
    val purpose: String,
    val purchaseOrderId: String? = null,
    val chatMessageId: String? = null,
    val createdAt: String? = null
)
