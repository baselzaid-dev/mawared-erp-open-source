package com.example.data.remote.api

import okhttp3.RequestBody
import okhttp3.ResponseBody
import retrofit2.http.*
import retrofit2.Response

interface AuthApi {
    @POST("/api/v2/auth/login")
    suspend fun login(@Body request: LoginRequestDto): Response<LoginResponseDto>

    /** Company Primary Owner self-service recovery initiate (public, enumeration-safe). */
    @POST("/api/v2/auth/owner-recovery/initiate")
    suspend fun initiateOwnerRecovery(
        @Body request: OwnerRecoveryInitiateRequestDto
    ): Response<OwnerRecoveryInitiateResponseDto>

    /** Company Primary Owner recovery confirm — no auto-login session. */
    @POST("/api/v2/auth/owner-recovery/confirm")
    suspend fun confirmOwnerRecovery(
        @Body request: OwnerRecoveryConfirmRequestDto
    ): Response<OwnerRecoveryConfirmResponseDto>

    @POST("/api/auth/refresh")
    suspend fun refresh(@Body request: RefreshRequestDto): Response<RefreshResponseDto>

    @POST("/api/auth/logout")
    suspend fun logout(@Body request: LogoutRequestDto): Response<Map<String, String>>

    @GET("/api/auth/me")
    suspend fun getMe(): Response<UserDto>

    @POST("/api/v2/auth/mfa/enroll/start")
    suspend fun startMfaEnrollment(
        @Body request: MfaChallengeRequestDto
    ): Response<MfaEnrollmentDto>

    @POST("/api/v2/auth/mfa/enroll/confirm")
    suspend fun confirmMfaEnrollment(
        @Body request: MfaVerifyRequestDto
    ): Response<LoginResponseDto>

    @POST("/api/v2/auth/mfa/verify")
    suspend fun verifyMfa(
        @Body request: MfaVerifyRequestDto
    ): Response<LoginResponseDto>
}

interface AuthorizationApi {
    @GET("/api/v2/authorization/effective")
    suspend fun getEffective(): Response<EffectiveAuthorizationDto>

    @GET("/api/v2/company/principals/manageable")
    suspend fun getManageablePrincipals(
        @Query("departmentId") departmentId: String?
    ): Response<List<ManageablePrincipalDto>>

    @GET("/api/v2/company/permissions/grantable")
    suspend fun getGrantablePermissions(
        @Query("targetUserId") targetUserId: String,
        @Query("departmentId") departmentId: String?
    ): Response<GrantablePermissionsDto>

    @POST("/api/v2/company/permissions/preview")
    suspend fun previewPermissionChanges(
        @Body request: PermissionPreviewRequestDto
    ): Response<PermissionPreviewDto>

    @POST("/api/v2/company/permissions/apply")
    suspend fun applyPermissionChanges(
        @Body request: PermissionApplyRequestDto
    ): Response<EffectiveAuthorizationDto>

    @GET("/api/v2/delegations")
    suspend fun getDelegations(): Response<List<TemporaryDelegationDto>>

    @POST("/api/v2/delegations")
    suspend fun createDelegation(@Body request: DelegationCreateRequestDto): Response<TemporaryDelegationDto>

    @POST("/api/v2/delegations/{id}/revoke")
    suspend fun revokeDelegation(
        @Path("id") id: String,
        @Body request: DelegationRevokeRequestDto
    ): Response<TemporaryDelegationDto>

    @POST("/api/v2/company/ownership/transfers/preview")
    suspend fun previewOwnershipTransfer(
        @Body request: OwnershipPreviewRequestDto
    ): Response<OwnershipTransferPreviewDto>

    @POST("/api/v2/company/ownership/transfers")
    suspend fun applyOwnershipTransfer(
        @Body request: OwnershipApplyRequestDto
    ): Response<OwnershipTransferResultDto>

    @POST("/api/v2/company/delegated-admins")
    suspend fun createDelegatedAdmin(
        @Body request: DelegatedAdminRequestDto
    ): Response<DelegatedAdminResultDto>

    @HTTP(method = "DELETE", path = "/api/v2/company/delegated-admins/{userId}", hasBody = true)
    suspend fun revokeDelegatedAdmin(
        @Path("userId") userId: String,
        @Body request: DelegatedAdminRevokeRequestDto
    ): Response<Unit>

    @GET("/api/v2/departments/{departmentId}/managers")
    suspend fun getDepartmentManagers(
        @Path("departmentId") departmentId: String
    ): Response<List<DepartmentManagerDto>>

    @POST("/api/v2/departments/{departmentId}/managers")
    suspend fun assignDepartmentManager(
        @Path("departmentId") departmentId: String,
        @Body request: DepartmentManagerRequestDto
    ): Response<DepartmentManagerDto>

    @POST("/api/v2/departments/{departmentId}/managers/{userId}/revoke")
    suspend fun revokeDepartmentManager(
        @Path("departmentId") departmentId: String,
        @Path("userId") userId: String,
        @Body request: DepartmentManagerRequestDto
    ): Response<Unit>
}

interface EmployeeApi {
    @GET("/api/employees")
    suspend fun getEmployees(): Response<List<EmployeeDto>>

    @POST("/api/employees")
    suspend fun createEmployee(@Body request: CreateEmployeeDto): Response<Map<String, String>>

    @PUT("/api/employees/{id}")
    suspend fun updateEmployee(
        @Path("id") id: String,
        @Body request: EmployeeUpdateRequestDto
    ): Response<EmployeeDto>

    @POST("/api/employees/{id}/deactivate")
    suspend fun deactivateEmployee(@Path("id") id: String): Response<Map<String, String>>

    @GET("/api/roles")
    suspend fun getRoles(): Response<List<RoleDto>>

    @GET("/api/departments")
    suspend fun getDepartments(): Response<List<DepartmentDto>>

    @POST("/api/departments")
    suspend fun createDepartment(@Body request: DepartmentRequestDto): Response<DepartmentDto>

    @PUT("/api/departments/{id}")
    suspend fun updateDepartment(
        @Path("id") id: String,
        @Body request: DepartmentRequestDto
    ): Response<DepartmentDto>

    @GET("/api/departments/manager-candidates")
    suspend fun getDepartmentManagerCandidates(): Response<List<DepartmentManagerCandidateDto>>

    @GET("/api/employees/{id}/salary")
    suspend fun getCurrentSalary(@Path("id") id: String): Response<CurrentSalaryResponseDto>

    @GET("/api/employees/{id}/salary/history")
    suspend fun getSalaryHistory(@Path("id") id: String): Response<SalaryHistoryResponseDto>

    @POST("/api/employees/{id}/salary")
    suspend fun createSalaryRecord(
        @Path("id") id: String,
        @Body request: CreateSalaryRecordDto
    ): Response<CurrentSalaryResponseDto>
}

interface LeaveApi {
    @POST("/api/leaves")
    suspend fun submitLeaveRequest(@Body request: LeaveRequestDto): Response<LeaveDto>

    @GET("/api/leaves/my")
    suspend fun getMyLeaves(
        @Query("from") from: String?,
        @Query("to") to: String?,
        @Query("status") status: String?,
        @Query("leaveType") leaveType: String?
    ): Response<List<LeaveDto>>

    @GET("/api/leaves/pending")
    suspend fun getPendingLeaves(): Response<List<LeaveDto>>

    @GET("/api/leaves/report")
    suspend fun getLeaveReport(
        @Query("from") from: String,
        @Query("to") to: String,
        @Query("status") status: String?,
        @Query("leaveType") leaveType: String?,
        @Query("employeeId") employeeId: String?
    ): Response<LeaveReportResponseDto>

    @POST("/api/leaves/{id}/cancel")
    suspend fun cancelLeave(@Path("id") id: String): Response<LeaveDto>

    @POST("/api/leaves/{id}/hr-approve")
    suspend fun hrApprove(@Path("id") id: String): Response<Map<String, String>>

    @POST("/api/leaves/{id}/hr-reject")
    suspend fun hrReject(@Path("id") id: String, @Body request: RejectRequestDto): Response<Map<String, String>>

    @POST("/api/leaves/{id}/admin-approve")
    suspend fun adminApprove(@Path("id") id: String): Response<Map<String, String>>

    @POST("/api/leaves/{id}/admin-reject")
    suspend fun adminReject(@Path("id") id: String, @Body request: RejectRequestDto): Response<Map<String, String>>
}

interface AttendanceApi {
    @POST("/api/attendance/clock-in")
    suspend fun clockIn(): Response<AttendanceDto>

    @POST("/api/attendance/clock-out")
    suspend fun clockOut(): Response<AttendanceDto>

    @GET("/api/attendance/my")
    suspend fun getMyAttendance(
        @Query("from") from: String?,
        @Query("to") to: String?
    ): Response<List<AttendanceDto>>

    @GET("/api/attendance/all")
    suspend fun getAllAttendance(
        @Query("from") from: String?,
        @Query("to") to: String?,
        @Query("departmentId") departmentId: String?
    ): Response<List<AttendanceDto>>

    @GET("/api/attendance/eligible-employees")
    suspend fun getEligibleEmployees(): Response<List<AttendanceEligibleEmployeeDto>>

    @POST("/api/attendance/manual")
    suspend fun createManualAttendance(
        @Body request: ManualAttendanceRequestDto
    ): Response<AttendanceDto>

    @POST("/api/v2/attendance/{id}/corrections")
    suspend fun createCorrection(
        @Path("id") attendanceId: String,
        @Body body: AttendanceCorrectionCreateRequestDto
    ): Response<AttendanceCorrectionDto>

    @GET("/api/v2/attendance/corrections")
    suspend fun listCorrections(
        @Query("status") status: String? = null,
        @Query("employeeId") employeeId: String? = null,
        @Query("cursor") cursor: String? = null,
        @Query("limit") limit: Int? = null
    ): Response<AttendanceCorrectionListDto>

    @POST("/api/v2/attendance/corrections/{id}/decision")
    suspend fun decideCorrection(
        @Path("id") correctionId: String,
        @Header("Idempotency-Key") idempotencyKey: String,
        @Body body: AttendanceCorrectionDecisionRequestDto
    ): Response<AttendanceCorrectionDecisionResponseDto>

    @GET("/api/v2/attendance/exemptions")
    suspend fun listExemptions(
        @Query("status") status: String? = null,
        @Query("targetUserId") targetUserId: String? = null
    ): Response<AttendanceExemptionListDto>

    @POST("/api/v2/attendance/exemptions")
    suspend fun createExemption(
        @Header("Idempotency-Key") idempotencyKey: String,
        @Body body: AttendanceExemptionCreateRequestDto
    ): Response<AttendanceExemptionDto>

    @POST("/api/v2/attendance/exemptions/{id}/revoke")
    suspend fun revokeExemption(
        @Path("id") exemptionId: String,
        @Header("Idempotency-Key") idempotencyKey: String,
        @Body body: AttendanceExemptionRevokeRequestDto
    ): Response<AttendanceExemptionDto>
}

interface DashboardApi {
    @GET("/api/dashboard/stats")
    suspend fun getStats(): Response<DashboardStatsDto>
}

interface NotificationApi {
    @GET("/api/notifications")
    suspend fun getNotifications(): Response<List<NotificationDto>>

    @GET("/api/notifications/unread-count")
    suspend fun getUnreadCount(): Response<UnreadCountDto>

    @POST("/api/notifications/{id}/read")
    suspend fun markAsRead(@Path("id") id: String): Response<Map<String, Boolean>>

    @GET("/api/v2/notifications")
    suspend fun listV2(
        @Query("category") category: String? = null,
        @Query("read") read: String? = null,
        @Query("hidden") hidden: String? = null,
        @Query("cursor") cursor: String? = null,
        @Query("limit") limit: Int? = null
    ): Response<NotificationListResponseDto>

    @POST("/api/v2/notifications/{id}/read")
    suspend fun markAsReadV2(@Path("id") id: String): Response<NotificationDto>

    @POST("/api/v2/notifications/read-all")
    suspend fun markAllReadV2(
        @Body body: NotificationReadAllRequestDto = NotificationReadAllRequestDto()
    ): Response<NotificationReadAllResponseDto>

    @POST("/api/v2/notifications/{id}/hide")
    suspend fun hideV2(@Path("id") id: String): Response<Map<String, Boolean>>

    @GET("/api/v2/notifications/preferences")
    suspend fun getPreferencesV2(): Response<NotificationPreferencesResponseDto>

    @PUT("/api/v2/notifications/preferences")
    suspend fun putPreferencesV2(
        @Body body: NotificationPreferencesPutRequestDto
    ): Response<NotificationPreferencesResponseDto>
}

interface AiAssistantApi {
    @POST("/api/v1/ai/chat")
    suspend fun chat(@Body request: Map<String, String>): Response<Map<String, String>>
}


interface VendorApi {
    @GET("/api/vendors")
    suspend fun getVendors(
        @Query("status") status: String?,
        @Query("search") search: String?
    ): Response<VendorPageDto>

    @POST("/api/vendors")
    suspend fun createVendor(@Body request: VendorRequestDto): Response<VendorDto>

    @PUT("/api/vendors/{id}")
    suspend fun updateVendor(@Path("id") id: String, @Body request: VendorRequestDto): Response<VendorDto>

    @PATCH("/api/vendors/{id}/status")
    suspend fun updateVendorStatus(@Path("id") id: String, @Body request: VendorStatusRequestDto): Response<VendorDto>

    // Sprint 12I (M08) — archive lifecycle, distinct from the active/inactive toggle above.
    @GET("/api/v2/vendors/{id}/lifecycle")
    suspend fun getVendorLifecycle(@Path("id") id: String): Response<VendorDto>

    @POST("/api/v2/vendors/{id}/archive")
    suspend fun archiveVendor(@Path("id") id: String, @Body request: VendorArchiveRequestDto): Response<VendorDto>

    @POST("/api/v2/vendors/{id}/reactivate")
    suspend fun reactivateVendor(@Path("id") id: String, @Body request: VendorReactivateRequestDto): Response<VendorDto>
}

interface PurchaseApi {
    @GET("/api/purchasing/requests")
    suspend fun getRequests(
        @Query("scope") scope: String?, @Query("status") status: String?,
        @Query("from") from: String?, @Query("to") to: String?,
        @Query("departmentId") departmentId: String?, @Query("requesterEmployeeId") requesterEmployeeId: String?
    ): Response<PurchaseRequestPageDto>

    @GET("/api/purchasing/requests/{id}")
    suspend fun getRequest(@Path("id") id: String, @Query("scope") scope: String?): Response<PurchaseRequestDto>

    @POST("/api/purchasing/requests")
    suspend fun createRequest(@Body request: CreatePurchaseRequestDto): Response<PurchaseRequestDto>

    @POST("/api/purchasing/requests/{id}/department-review")
    suspend fun reviewDepartment(@Path("id") id: String, @Body request: PurchasingReviewRequestDto): Response<PurchaseRequestDto>

    @POST("/api/purchasing/requests/{id}/purchasing-review")
    suspend fun reviewPurchasing(@Path("id") id: String, @Body request: PurchasingReviewRequestDto): Response<PurchaseRequestDto>

    @POST("/api/purchasing/requests/{id}/cancel")
    suspend fun cancelRequest(@Path("id") id: String, @Body request: PurchasingCancelRequestDto): Response<PurchaseRequestDto>

    @GET("/api/purchasing/orders")
    suspend fun getOrders(
        @Query("scope") scope: String?, @Query("status") status: String?,
        @Query("vendorId") vendorId: String?, @Query("requestId") requestId: String?,
        @Query("from") from: String?, @Query("to") to: String?
    ): Response<PurchaseOrderPageDto>

    @GET("/api/purchasing/orders/{id}")
    suspend fun getOrder(@Path("id") id: String, @Query("scope") scope: String?): Response<PurchaseOrderDto>

    @POST("/api/purchasing/orders")
    suspend fun createOrder(@Body request: CreatePurchaseOrderDto): Response<PurchaseOrderDto>

    @PUT("/api/purchasing/orders/{id}")
    suspend fun updateOrder(@Path("id") id: String, @Body request: UpdatePurchaseOrderDto): Response<PurchaseOrderDto>

    @POST("/api/purchasing/orders/{id}/issue")
    suspend fun issueOrder(@Path("id") id: String): Response<PurchaseOrderDto>

    @POST("/api/purchasing/orders/{id}/receive")
    suspend fun receiveOrder(@Path("id") id: String, @Body request: ReceivePurchaseOrderDto): Response<PurchaseOrderDto>

    @POST("/api/purchasing/orders/{id}/cancel")
    suspend fun cancelOrder(@Path("id") id: String, @Body request: PurchasingCancelRequestDto): Response<PurchaseOrderDto>

    @GET("/api/purchasing/report")
    suspend fun getReport(@Query("from") from: String?, @Query("to") to: String?): Response<PurchasingReportDto>

    // ---- Sprint 12I: purchasing admin override (v2) + purchasing exports (v2) ----

    @POST("/api/v2/purchasing/requests/{id}/override")
    suspend fun overrideRequest(
        @Path("id") id: String,
        @Header("Idempotency-Key") idempotencyKey: String,
        @Body request: PurchasingOverrideRequestDto
    ): Response<PurchaseRequestDto>

    @Streaming
    @POST("/api/v2/purchasing/exports")
    suspend fun exportPurchasing(@Body request: PurchasingExportRequestDto): Response<ResponseBody>

    // ---- Commercial Wave 2 (Operations Slice E1) ----
    // Every quantity- or award-changing call carries an Idempotency-Key so a
    // retry can never produce a second financial effect.

    @GET("/api/v2/purchasing/requests/{id}/quotations")
    suspend fun getQuotations(
        @Path("id") requestId: String,
        @Query("status") status: String? = null
    ): Response<SupplierQuotationPageDto>

    @GET("/api/v2/purchasing/requests/{id}/quotations/compare")
    suspend fun compareQuotations(@Path("id") requestId: String): Response<QuotationComparisonDto>

    @POST("/api/v2/purchasing/requests/{id}/quotations")
    suspend fun createQuotation(
        @Path("id") requestId: String,
        @Header("Idempotency-Key") idempotencyKey: String,
        @Body request: CreateSupplierQuotationDto
    ): Response<SupplierQuotationDto>

    @GET("/api/v2/purchasing/quotations/{id}")
    suspend fun getQuotation(@Path("id") quotationId: String): Response<SupplierQuotationDto>

    @POST("/api/v2/purchasing/quotations/{id}/submit")
    suspend fun submitQuotation(
        @Path("id") quotationId: String,
        @Body request: Map<String, String> = emptyMap()
    ): Response<SupplierQuotationDto>

    @POST("/api/v2/purchasing/quotations/{id}/reject")
    suspend fun rejectQuotation(
        @Path("id") quotationId: String,
        @Body request: RejectSupplierQuotationDto
    ): Response<SupplierQuotationDto>

    @POST("/api/v2/purchasing/quotations/{id}/select")
    suspend fun selectQuotation(
        @Path("id") quotationId: String,
        @Header("Idempotency-Key") idempotencyKey: String,
        @Body request: SelectSupplierQuotationDto
    ): Response<SupplierQuotationDto>

    @GET("/api/v2/purchasing/orders/{id}/receipts")
    suspend fun getReceipts(@Path("id") orderId: String): Response<PurchaseReceiptPageDto>

    @POST("/api/v2/purchasing/orders/{id}/receipts")
    suspend fun createReceipt(
        @Path("id") orderId: String,
        @Header("Idempotency-Key") idempotencyKey: String,
        @Body request: CreatePurchaseReceiptDto
    ): Response<CreatePurchaseReceiptResponseDto>

    @GET("/api/v2/purchasing/orders/{id}/returns")
    suspend fun getReturns(@Path("id") orderId: String): Response<PurchaseReturnPageDto>

    @POST("/api/v2/purchasing/orders/{id}/returns")
    suspend fun createReturn(
        @Path("id") orderId: String,
        @Header("Idempotency-Key") idempotencyKey: String,
        @Body request: CreatePurchaseReturnDto
    ): Response<PurchaseReturnDto>

    @POST("/api/v2/purchasing/returns/{id}/review")
    suspend fun reviewReturn(
        @Path("id") returnId: String,
        @Header("Idempotency-Key") idempotencyKey: String,
        @Body request: ReviewPurchaseReturnDto
    ): Response<PurchaseReturnDto>
}

interface PayrollApi {
    @GET("/api/payroll/periods")
    suspend fun getPeriods(): Response<List<PayrollPeriodDto>>

    @POST("/api/payroll/periods")
    suspend fun createPeriod(
        @Body request: CreatePayrollPeriodRequestDto
    ): Response<PayrollPeriodDto>

    @POST("/api/payroll/periods/{id}/calculate")
    suspend fun calculatePeriod(
        @Path("id") id: String,
        @Body request: PayrollCalculationRequestDto
    ): Response<PayrollCalculationResponseDto>

    @GET("/api/payroll/periods/{id}/items")
    suspend fun getPeriodItems(@Path("id") id: String): Response<PayrollItemsResponseDto>

    @POST("/api/payroll/periods/{id}/approve")
    suspend fun approvePeriod(@Path("id") id: String): Response<PayrollActionResponseDto>

    @POST("/api/payroll/periods/{id}/mark-paid")
    suspend fun markPeriodPaid(@Path("id") id: String): Response<PayrollActionResponseDto>

    @GET("/api/payroll/report")
    suspend fun getPayrollReport(
        @Query("periodId") periodId: String
    ): Response<PayrollReportResponseDto>

    // ---- Sprint 12H: payroll partial payments (v2) + exports ----

    @GET("/api/v2/payroll/periods/{id}/payments")
    suspend fun getPeriodPayments(@Path("id") id: String): Response<List<PayrollPaymentDto>>

    @POST("/api/v2/payroll/periods/{id}/payments")
    suspend fun recordPeriodPayment(
        @Path("id") id: String,
        @Header("Idempotency-Key") idempotencyKey: String,
        @Body request: PayrollRecordPaymentRequestDto
    ): Response<PayrollPaymentActionResponseDto>

    @POST("/api/v2/payroll/periods/{id}/payments/{paymentId}/void")
    suspend fun voidPeriodPayment(
        @Path("id") id: String,
        @Path("paymentId") paymentId: String,
        @Body request: PayrollVoidPaymentRequestDto
    ): Response<PayrollPaymentActionResponseDto>

    @Streaming
    @POST("/api/v2/payroll/periods/{id}/exports")
    suspend fun exportPeriod(
        @Path("id") id: String,
        @Body request: PayrollExportRequestDto
    ): Response<ResponseBody>
}

interface TaskApi {
    @GET("/api/tasks")
    suspend fun getTasks(
        @Query("scope") scope: String?,
        @Query("status") status: String?,
        @Query("priority") priority: String?,
        @Query("from") from: String?,
        @Query("to") to: String?,
        @Query("employeeId") employeeId: String?
    ): Response<List<TaskDto>>

    @GET("/api/tasks/{id}")
    suspend fun getTask(@Path("id") id: String): Response<TaskDto>

    @GET("/api/tasks/eligible-employees")
    suspend fun getEligibleEmployees(): Response<List<TaskEligibleEmployeeDto>>

    @POST("/api/tasks")
    suspend fun createTask(@Body request: CreateTaskRequestDto): Response<TaskDto>

    @PATCH("/api/task-assignments/{id}/progress")
    suspend fun updateProgress(
        @Path("id") id: String,
        @Body request: TaskProgressRequestDto
    ): Response<TaskAssignmentDto>

    @POST("/api/task-assignments/{id}/review")
    suspend fun reviewAssignment(
        @Path("id") id: String,
        @Body request: TaskReviewRequestDto
    ): Response<TaskReviewResponseDto>

    @POST("/api/tasks/{id}/cancel")
    suspend fun cancelTask(@Path("id") id: String): Response<TaskDto>

    // ---- Commercial P4 ----

    /**
     * Takes a pre-serialized body rather than a DTO: the edit contract needs to
     * distinguish an omitted field ("leave unchanged") from an explicit JSON
     * `null` ("clear it"), and Moshi's default writer drops null properties, so
     * a data class cannot express the difference. The repository builds the
     * exact key set with a null-serializing adapter.
     */
    @PATCH("/api/tasks/{id}")
    suspend fun updateTask(
        @Path("id") id: String,
        @Body request: RequestBody
    ): Response<TaskDto>

    /** Newest-first page; `cursor` walks backwards through older comments. */
    @GET("/api/tasks/{id}/comments")
    suspend fun getTaskComments(
        @Path("id") id: String,
        @Query("cursor") cursor: String? = null,
        @Query("limit") limit: Int? = null
    ): Response<TaskCommentPageDto>

    @POST("/api/tasks/{id}/comments")
    suspend fun createTaskComment(
        @Path("id") id: String,
        @Body request: CreateTaskCommentRequestDto
    ): Response<TaskCommentDto>
}

interface ChatApi {
    @GET("/api/chat/directory")
    suspend fun searchDirectory(
        @Query("query") query: String?,
        @Query("limit") limit: Int
    ): Response<List<ChatDirectoryUserDto>>

    @GET("/api/chat/departments")
    suspend fun getAccessibleDepartments(): Response<List<ChatDepartmentDto>>

    @GET("/api/chat/conversations")
    suspend fun getConversations(
        @Query("limit") limit: Int,
        @Query("offset") offset: Int
    ): Response<ChatConversationPageDto>

    @POST("/api/chat/direct")
    suspend fun openDirect(
        @Body request: ChatOpenDirectRequestDto
    ): Response<ChatConversationDto>

    @POST("/api/chat/departments/{departmentId}/open")
    suspend fun openDepartment(
        @Path("departmentId") departmentId: String
    ): Response<ChatConversationDto>

    @GET("/api/chat/conversations/{id}/messages")
    suspend fun getMessages(
        @Path("id") conversationId: String,
        @Query("before") before: String?,
        @Query("limit") limit: Int
    ): Response<ChatMessagePageDto>

    @POST("/api/chat/conversations/{id}/messages")
    suspend fun sendMessage(
        @Path("id") conversationId: String,
        @Body request: ChatSendMessageRequestDto
    ): Response<ChatMessageDto>

    @POST("/api/chat/conversations/{id}/read")
    suspend fun markRead(
        @Path("id") conversationId: String
    ): Response<ChatReadResultDto>

    @GET("/api/chat/unread-count")
    suspend fun getUnreadCount(): Response<ChatUnreadCountDto>

    @POST("/api/chat/announcements")
    suspend fun createAnnouncement(
        @Body request: ChatCreateAnnouncementRequestDto
    ): Response<ChatConversationDto>

    @GET("/api/chat/conversations/{id}/pins")
    suspend fun getPins(
        @Path("id") conversationId: String
    ): Response<ChatPinnedMessagePageDto>

    @POST("/api/chat/conversations/{id}/pins")
    suspend fun pinMessage(
        @Path("id") conversationId: String,
        @Body request: ChatPinMessageRequestDto
    ): Response<ChatPinnedMessageDto>

    @DELETE("/api/chat/conversations/{id}/pins/{messageId}")
    suspend fun unpinMessage(
        @Path("id") conversationId: String,
        @Path("messageId") messageId: String
    ): Response<Unit>
}

interface TrainingApi {
    @GET("/api/training/courses")
    suspend fun getCourses(
        @Query("scope") scope: String?,
        @Query("status") status: String?,
        @Query("category") category: String?,
        @Query("from") from: String?,
        @Query("to") to: String?,
        @Query("query") query: String?
    ): Response<TrainingCoursePageDto>

    @GET("/api/training/courses/{id}")
    suspend fun getCourse(
        @Path("id") id: String,
        @Query("scope") scope: String?
    ): Response<TrainingCourseDto>

    @POST("/api/training/courses")
    suspend fun createCourse(@Body request: TrainingCourseRequestDto): Response<TrainingCourseDto>

    @PUT("/api/training/courses/{id}")
    suspend fun updateCourse(
        @Path("id") id: String,
        @Body request: TrainingCourseRequestDto
    ): Response<TrainingCourseDto>

    @POST("/api/training/courses/{id}/publish")
    suspend fun publishCourse(@Path("id") id: String): Response<TrainingCourseDto>

    @POST("/api/training/courses/{id}/complete")
    suspend fun completeCourse(@Path("id") id: String): Response<TrainingCourseDto>

    @POST("/api/training/courses/{id}/cancel")
    suspend fun cancelCourse(
        @Path("id") id: String,
        @Body request: TrainingCancellationRequestDto
    ): Response<TrainingCourseDto>

    @POST("/api/training/courses/{id}/archive")
    suspend fun archiveCourse(@Path("id") id: String): Response<TrainingCourseDto>

    @GET("/api/training/assignments")
    suspend fun getAssignments(
        @Query("scope") scope: String?,
        @Query("status") status: String?,
        @Query("courseId") courseId: String?,
        @Query("departmentId") departmentId: String?,
        @Query("employeeId") employeeId: String?,
        @Query("from") from: String?,
        @Query("to") to: String?
    ): Response<TrainingAssignmentPageDto>

    @GET("/api/training/assignments/{id}")
    suspend fun getAssignment(
        @Path("id") id: String,
        @Query("scope") scope: String?
    ): Response<TrainingAssignmentDto>

    @GET("/api/training/eligible-employees")
    suspend fun getEligibleEmployees(
        @Query("query") query: String?,
        @Query("departmentId") departmentId: String?
    ): Response<List<TrainingEligibleEmployeeDto>>

    @POST("/api/training/courses/{id}/assignments")
    suspend fun assignCourse(
        @Path("id") id: String,
        @Body request: TrainingBulkAssignmentRequestDto
    ): Response<List<TrainingAssignmentDto>>

    @PATCH("/api/training/assignments/{id}/progress")
    suspend fun updateProgress(
        @Path("id") id: String,
        @Body request: TrainingProgressRequestDto
    ): Response<TrainingAssignmentDto>

    @POST("/api/training/assignments/{id}/submit")
    suspend fun submitAssignment(
        @Path("id") id: String,
        @Body request: TrainingSubmitRequestDto
    ): Response<TrainingAssignmentDto>

    @POST("/api/training/assignments/{id}/review")
    suspend fun reviewAssignment(
        @Path("id") id: String,
        @Body request: TrainingReviewRequestDto
    ): Response<TrainingAssignmentDto>

    @POST("/api/training/assignments/{id}/cancel")
    suspend fun cancelAssignment(
        @Path("id") id: String,
        @Body request: TrainingCancellationRequestDto
    ): Response<TrainingAssignmentDto>

    // ---- Commercial P4 completion artifacts ----

    /** Idempotent server side: an exact retry replays the existing certificate. */
    @POST("/api/training/assignments/{id}/certificate")
    suspend fun issueCertificate(@Path("id") id: String): Response<TrainingCertificateDto>

    @GET("/api/training/assignments/{id}/certificate")
    suspend fun getCertificate(@Path("id") id: String): Response<TrainingCertificateDto>

    /** A second evaluation is a 409 conflict, never an overwrite. */
    @POST("/api/training/assignments/{id}/evaluation")
    suspend fun createEvaluation(
        @Path("id") id: String,
        @Body request: CreateTrainingEvaluationRequestDto
    ): Response<TrainingEvaluationDto>

    @GET("/api/training/assignments/{id}/evaluation")
    suspend fun getEvaluation(@Path("id") id: String): Response<TrainingEvaluationDto>

    @GET("/api/training/report")
    suspend fun getReport(
        @Query("scope") scope: String?,
        @Query("from") from: String?,
        @Query("to") to: String?,
        @Query("courseStatus") courseStatus: String?,
        @Query("assignmentStatus") assignmentStatus: String?,
        @Query("category") category: String?,
        @Query("departmentId") departmentId: String?
    ): Response<TrainingReportDto>

    @GET("/api/training/courses/{id}/timeline")
    suspend fun getCourseTimeline(
        @Path("id") id: String,
        @Query("scope") scope: String?
    ): Response<TrainingTimelineDto>

    @Streaming
    @POST("/api/training/exports")
    suspend fun exportReport(
        @Body request: TrainingExportRequestDto
    ): Response<ResponseBody>
}

interface ReportApi {
    @GET("/api/reports/catalog")
    suspend fun getCatalog(): Response<List<ReportCatalogItemDto>>

    @GET("/api/reports/overview")
    suspend fun getOverview(
        @Query("from") from: String,
        @Query("to") to: String,
        @Query("departmentId") departmentId: String?
    ): Response<ReportOverviewDto>

    @GET("/api/reports/{type}")
    suspend fun getReport(
        @Path("type") type: String,
        @QueryMap filters: Map<String, String>
    ): Response<ReportDetailDto>

    @Streaming
    @POST("/api/reports/export")
    suspend fun exportCsv(
        @Body request: ReportExportRequestDto
    ): Response<ResponseBody>

    // ---- Sprint 12J: server-owned report template registry (v2) ----

    @GET("/api/v2/reports/templates")
    suspend fun getTemplateCatalog(): Response<List<ReportTemplateCatalogItemDto>>

    @POST("/api/v2/reports/templates/preview")
    suspend fun previewTemplate(
        @Body request: ReportTemplatePreviewRequestDto
    ): Response<ReportTemplateDocumentDto>

    @GET("/api/v2/reports/saved-templates")
    suspend fun getSavedTemplates(
        @Query("includeArchived") includeArchived: Boolean? = null
    ): Response<List<SavedReportTemplateDto>>

    @POST("/api/v2/reports/saved-templates")
    suspend fun createSavedTemplate(
        @Body request: CreateSavedReportTemplateRequestDto
    ): Response<SavedReportTemplateDto>

    @POST("/api/v2/reports/saved-templates/{id}/archive")
    suspend fun archiveSavedTemplate(@Path("id") id: String): Response<SavedReportTemplateDto>

    @Streaming
    @POST("/api/v2/reports/templates/exports")
    suspend fun exportTemplate(
        @Body request: ReportTemplateExportRequestDto
    ): Response<ResponseBody>
}

interface AttachmentApi {
    @POST("/api/attachments")
    suspend fun upload(@Body request: AttachmentUploadRequestDto): Response<AttachmentMetadataDto>

    @GET("/api/attachments")
    suspend fun list(
        @Query("purchaseOrderId") purchaseOrderId: String? = null,
        @Query("chatMessageId") chatMessageId: String? = null,
        @Query("purpose") purpose: String? = null
    ): Response<List<AttachmentMetadataDto>>

    @GET("/api/attachments/{id}")
    suspend fun metadata(@Path("id") id: String): Response<AttachmentMetadataDto>

    @Streaming
    @GET("/api/attachments/{id}/content")
    suspend fun content(@Path("id") id: String): Response<ResponseBody>
}
