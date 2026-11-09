package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.*
import com.example.domain.model.PayrollWorkflowException
import com.example.domain.model.Supplier
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

/** Configurable fake of the Retrofit VendorApi — no network, no server. */
private class FakeVendorApi(
    var vendors: List<VendorDto> = emptyList(),
    var failWith: Int? = null,
    var errorJson: String = "{}",
    var lifecycleVendor: VendorDto? = null,
    var archiveResponse: VendorDto? = null,
    var reactivateResponse: VendorDto? = null
) : VendorApi {
    var lastRequest: VendorRequestDto? = null
    var lastStatus: VendorStatusRequestDto? = null
    var lastArchiveRequest: VendorArchiveRequestDto? = null
    var lastReactivateRequest: VendorReactivateRequestDto? = null

    private fun <T> maybeFail(): Response<T>? =
        failWith?.let { Response.error(it, errorJson.toResponseBody("application/json".toMediaType())) }

    override suspend fun getVendors(status: String?, search: String?): Response<VendorPageDto> =
        maybeFail() ?: Response.success(VendorPageDto(vendors, total = vendors.size))

    override suspend fun createVendor(request: VendorRequestDto): Response<VendorDto> {
        lastRequest = request
        return maybeFail() ?: Response.success(
            VendorDto(id = "v-new", companyId = "c1", name = request.name, contact = request.contact, status = "active")
        )
    }

    override suspend fun updateVendor(id: String, request: VendorRequestDto): Response<VendorDto> {
        lastRequest = request
        return maybeFail() ?: Response.success(
            VendorDto(id = id, companyId = "c1", name = request.name, contact = request.contact, status = "active")
        )
    }

    override suspend fun updateVendorStatus(id: String, request: VendorStatusRequestDto): Response<VendorDto> {
        lastStatus = request
        return maybeFail() ?: Response.success(VendorDto(id, "c1", "مورد", status = request.status))
    }

    override suspend fun getVendorLifecycle(id: String): Response<VendorDto> =
        maybeFail() ?: Response.success(lifecycleVendor ?: VendorDto(id, "c1", "مورد", status = "active", lifecycleVersion = 1))

    override suspend fun archiveVendor(id: String, request: VendorArchiveRequestDto): Response<VendorDto> {
        lastArchiveRequest = request
        return maybeFail() ?: Response.success(
            archiveResponse ?: VendorDto(
                id, "c1", "مورد", status = "archived",
                lifecycleVersion = request.expectedVersion + 1,
                archiveReason = request.reason
            )
        )
    }

    override suspend fun reactivateVendor(id: String, request: VendorReactivateRequestDto): Response<VendorDto> {
        lastReactivateRequest = request
        return maybeFail() ?: Response.success(
            reactivateResponse ?: VendorDto(
                id, "c1", "مورد", status = "active",
                lifecycleVersion = request.expectedVersion + 1
            )
        )
    }
}

/** Configurable fake of the Retrofit PayrollApi. */
private class FakePayrollApi(
    var periods: List<PayrollPeriodDto> = emptyList(),
    var failWith: Int? = null,
    var errorJson: String = "{}"
) : PayrollApi {
    var lastCreate: CreatePayrollPeriodRequestDto? = null
    var lastCalculation: PayrollCalculationRequestDto? = null
    var getPeriodsCalls = 0
    var idempotent = false

    private val summary = PayrollMoneySummaryDto(1, "1000.00", "0.00", "1000.00", "SAR")
    private val item = PayrollItemDto(
        id = "item-1",
        payrollPeriodId = "pp1",
        employeeId = "e1",
        employeeName = "موظف",
        employeeNum = "EMP-1",
        departmentName = "الموارد البشرية",
        baseSalary = "1000.00",
        grossPay = "1000.00",
        totalDeductions = "0.00",
        netPay = "1000.00",
        currency = "SAR",
        status = "calculated"
    )

    private fun <T> maybeFail(): Response<T>? =
        failWith?.let { Response.error(it, errorJson.toResponseBody("application/json".toMediaType())) }

    override suspend fun getPeriods(): Response<List<PayrollPeriodDto>> {
        getPeriodsCalls += 1
        return maybeFail() ?: Response.success(periods)
    }

    override suspend fun createPeriod(request: CreatePayrollPeriodRequestDto): Response<PayrollPeriodDto> {
        lastCreate = request
        return maybeFail() ?: Response.success(
            PayrollPeriodDto("created", "c1", request.month, request.year, "draft")
        )
    }

    override suspend fun calculatePeriod(
        id: String,
        request: PayrollCalculationRequestDto
    ): Response<PayrollCalculationResponseDto> {
        lastCalculation = request
        return maybeFail() ?: Response.success(
            PayrollCalculationResponseDto(
                period = PayrollPeriodDto(
                    id, "c1", 7, 2026, "calculated",
                    itemCount = 1,
                    calculationVersion = 1,
                    visibleSummary = summary
                ),
                items = listOf(item.copy(payrollPeriodId = id)),
                visibleSummary = summary,
                idempotent = idempotent,
                recalculated = false
            )
        )
    }

    override suspend fun getPeriodItems(id: String): Response<PayrollItemsResponseDto> =
        maybeFail() ?: Response.success(
            PayrollItemsResponseDto(
                period = PayrollPeriodDto(id, "c1", 7, 2026, "calculated", itemCount = 1),
                items = listOf(item.copy(payrollPeriodId = id)),
                visibleSummary = summary,
                protectedRowsHidden = true,
                protectedRowCount = 1
            )
        )

    override suspend fun approvePeriod(id: String): Response<PayrollActionResponseDto> =
        maybeFail() ?: Response.success(
            PayrollActionResponseDto(
                PayrollPeriodDto(id, "c1", 7, 2026, "approved"),
                "تم اعتماد فترة الرواتب"
            )
        )

    override suspend fun markPeriodPaid(id: String): Response<PayrollActionResponseDto> =
        maybeFail() ?: Response.success(
            PayrollActionResponseDto(
                PayrollPeriodDto(id, "c1", 7, 2026, "paid"),
                "تم تأكيد حالة الدفع إدارياً",
                bankTransferProof = false
            )
        )

    override suspend fun getPayrollReport(periodId: String): Response<PayrollReportResponseDto> =
        maybeFail() ?: Response.success(
            PayrollReportResponseDto(
                period = PayrollPeriodDto(periodId, "c1", 7, 2026, "approved", itemCount = 1),
                rows = listOf(item.copy(payrollPeriodId = periodId)),
                visibleSummary = summary,
                protectedRowsHidden = true,
                protectedRowCount = 1
            )
        )

    // ---- Sprint 12H: payroll partial payments (v2) + exports ----

    var payments: List<PayrollPaymentDto> = emptyList()
    var lastIdempotencyKey: String? = null
    var lastRecordRequest: PayrollRecordPaymentRequestDto? = null
    var lastVoidRequest: PayrollVoidPaymentRequestDto? = null
    var lastExportRequest: PayrollExportRequestDto? = null
    var paymentActionResponse: PayrollPaymentActionResponseDto? = null
    var exportBody: ResponseBody? = null

    private fun samplePayment(id: String = "pay-1") = PayrollPaymentDto(
        id = id,
        companyId = "c1",
        payrollPeriodId = "pp1",
        amount = "500.00",
        currency = "SAR",
        paymentDate = "2026-07-01",
        status = "posted",
        idempotencyKey = "key-1",
        recordedByUserId = "u1",
        createdAt = "2026-07-01T09:00:00Z"
    )

    override suspend fun getPeriodPayments(id: String): Response<List<PayrollPaymentDto>> =
        maybeFail() ?: Response.success(payments)

    override suspend fun recordPeriodPayment(
        id: String,
        idempotencyKey: String,
        request: PayrollRecordPaymentRequestDto
    ): Response<PayrollPaymentActionResponseDto> {
        lastIdempotencyKey = idempotencyKey
        lastRecordRequest = request
        return maybeFail() ?: Response.success(
            paymentActionResponse ?: PayrollPaymentActionResponseDto(
                payment = samplePayment().copy(amount = request.amount, idempotencyKey = idempotencyKey),
                period = PayrollPeriodPaymentSummaryDto(
                    id = id,
                    companyId = "c1",
                    month = 7,
                    year = 2026,
                    status = "approved",
                    numericLabel = "2026-07",
                    paymentState = "partially_paid",
                    paymentVersion = 1
                )
            )
        )
    }

    override suspend fun voidPeriodPayment(
        id: String,
        paymentId: String,
        request: PayrollVoidPaymentRequestDto
    ): Response<PayrollPaymentActionResponseDto> {
        lastVoidRequest = request
        return maybeFail() ?: Response.success(
            paymentActionResponse ?: PayrollPaymentActionResponseDto(
                payment = samplePayment(paymentId).copy(status = "voided", voidReason = request.reason),
                period = PayrollPeriodPaymentSummaryDto(
                    id = id,
                    companyId = "c1",
                    month = 7,
                    year = 2026,
                    status = "approved",
                    numericLabel = "2026-07",
                    paymentState = "unpaid",
                    paymentVersion = 2
                )
            )
        )
    }

    override suspend fun exportPeriod(id: String, request: PayrollExportRequestDto): Response<ResponseBody> {
        lastExportRequest = request
        return maybeFail()
            ?: Response.success(exportBody ?: "col1,col2\nv1,v2".toResponseBody("text/csv".toMediaType()))
    }
}

private fun supplier(name: String = "مورد", phone: String? = "0791111111") = Supplier(
    id = "", companyId = "", name = name, phone = phone,
    email = null, taxNumber = null, category = null, status = "active"
)

class ApiSupplierRepositoryTest {

    @Test
    fun `refresh maps backend vendors into the suppliers stream`() = runTest {
        val api = FakeVendorApi(
            vendors = listOf(VendorDto(id = "v1", companyId = "c1", name = "مورد أ", contact = "079", status = "active"))
        )
        val repo = ApiSupplierRepository(api)
        val result = repo.refreshSuppliers()
        assertTrue(result is AppResult.Success)
        val list = repo.observeSuppliers().first()
        assertEquals(1, list.size)
        assertEquals("مورد أ", list[0].name)
        assertEquals("079", list[0].phone)
    }

    @Test
    fun `create sends name and contact then refreshes`() = runTest {
        val api = FakeVendorApi()
        val repo = ApiSupplierRepository(api)
        val result = repo.createSupplier(supplier(name = "مورد جديد"))
        assertTrue(result is AppResult.Success)
        assertEquals("مورد جديد", api.lastRequest?.name)
    }

    @Test
    fun `backend error maps to ServerError - never fake success`() = runTest {
        val api = FakeVendorApi(failWith = 403)
        val repo = ApiSupplierRepository(api)
        val result = repo.createSupplier(supplier())
        assertTrue(result is AppResult.Error)
        val err = (result as AppResult.Error).appError
        assertEquals(403, (err as AppError.ServerError).code)
    }

    @Test
    fun `status lifecycle replaces hard delete`() = runTest {
        val api = FakeVendorApi()
        val repo = ApiSupplierRepository(api)
        val result = repo.setSupplierStatus("v1", "inactive")
        assertTrue(result is AppResult.Success)
        assertEquals("inactive", api.lastStatus?.status)
    }

    // ---- Sprint 12I (M08): vendor archive lifecycle ----

    @Test
    fun `refreshSuppliersAllStatuses merges active inactive and archived vendors`() = runTest {
        val api = FakeVendorApi(
            vendors = listOf(VendorDto(id = "v1", companyId = "c1", name = "مورد", status = "placeholder"))
        )
        val repo = ApiSupplierRepository(api)
        val result = repo.refreshSuppliersAllStatuses()
        assertTrue(result is AppResult.Success)
        // Every getVendors() call returns the same fixture regardless of the status
        // query param here, so after merging by id the cache holds exactly one vendor.
        assertEquals(1, repo.observeSuppliers().first().size)
    }

    @Test
    fun `loadSupplierLifecycle maps the authoritative vendor including lifecycleVersion`() = runTest {
        val api = FakeVendorApi(
            lifecycleVendor = VendorDto(
                id = "v1", companyId = "c1", name = "مورد", status = "archived",
                lifecycleVersion = 3, archivedAt = "2026-01-01T00:00:00Z", archiveReason = "تجربة"
            )
        )
        val repo = ApiSupplierRepository(api)
        val result = repo.loadSupplierLifecycle("v1") as AppResult.Success
        assertEquals(3, result.data.lifecycleVersion)
        assertEquals("archived", result.data.status)
        assertEquals("تجربة", result.data.archiveReason)
    }

    @Test
    fun `archive sends trimmed reason and expectedVersion then caches the archived vendor`() = runTest {
        val api = FakeVendorApi()
        val repo = ApiSupplierRepository(api)
        val result = repo.archiveSupplier(
            "v1",
            com.example.domain.model.VendorArchiveRequest(reason = "  لا حاجة له  ", expectedVersion = 2)
        ) as AppResult.Success

        assertEquals("لا حاجة له", api.lastArchiveRequest?.reason)
        assertEquals(2, api.lastArchiveRequest?.expectedVersion)
        assertEquals("archived", result.data.status)
        assertEquals(3, result.data.lifecycleVersion)
    }

    @Test
    fun `reactivate sends expectedVersion and optional reason then caches the active vendor`() = runTest {
        val api = FakeVendorApi()
        val repo = ApiSupplierRepository(api)
        val result = repo.reactivateSupplier(
            "v1",
            com.example.domain.model.VendorReactivateRequest(expectedVersion = 4, reason = "عودة النشاط")
        ) as AppResult.Success

        assertEquals(4, api.lastReactivateRequest?.expectedVersion)
        assertEquals("عودة النشاط", api.lastReactivateRequest?.reason)
        assertEquals("active", result.data.status)
        assertEquals(5, result.data.lifecycleVersion)
    }

    @Test
    fun `version mismatch on archive surfaces the backend error code for the UI to translate`() = runTest {
        val api = FakeVendorApi(
            failWith = 412,
            errorJson = """{"error":"VENDOR_VERSION_MISMATCH","message":"تم تعديل المورد من مستخدم آخر، يرجى تحديث الصفحة","code":412}"""
        )
        val repo = ApiSupplierRepository(api)
        val result = repo.archiveSupplier(
            "v1",
            com.example.domain.model.VendorArchiveRequest(reason = "سبب", expectedVersion = 1)
        ) as AppResult.Error

        assertEquals("VENDOR_VERSION_MISMATCH", result.exception.message)
        assertEquals(
            "تم تعديل المورد من مستخدم آخر، يرجى تحديث الصفحة",
            (result.appError as AppError.ValidationError).message
        )
    }

    @Test
    fun `forbidden reactivate maps to AppError Forbidden`() = runTest {
        val api = FakeVendorApi(failWith = 403, errorJson = """{"error":"Forbidden"}""")
        val repo = ApiSupplierRepository(api)
        val result = repo.reactivateSupplier(
            "v1",
            com.example.domain.model.VendorReactivateRequest(expectedVersion = 1)
        ) as AppResult.Error

        assertEquals("Forbidden", result.exception.message)
        assertEquals(AppError.Forbidden, result.appError)
    }
}

class ApiPayrollRepositoryTest {

    @Test
    fun `refresh maps backend periods into the stream`() = runTest {
        val api = FakePayrollApi(
            periods = listOf(
                PayrollPeriodDto(id = "pp1", companyId = "c1", month = 6, year = 2026, status = "draft")
            )
        )
        val repo = ApiPayrollRepository(api)
        val result = repo.refreshPayroll()
        assertTrue(result is AppResult.Success)
        val list = repo.observePayrollPeriods().first()
        assertEquals(1, list.size)
        assertEquals("draft", list[0].status)
    }

    @Test
    fun `create maps month and year then refreshes periods`() = runTest {
        val api = FakePayrollApi()
        val result = ApiPayrollRepository(api).createPayrollPeriod(8, 2026)
        assertTrue(result is AppResult.Success)
        assertEquals(8, api.lastCreate?.month)
        assertEquals(2026, api.lastCreate?.year)
        assertTrue(api.getPeriodsCalls > 0)
    }

    @Test
    fun `calculate maps exact String money idempotency reason and protected rows`() = runTest {
        val api = FakePayrollApi().apply { idempotent = true }
        val repo = ApiPayrollRepository(api)
        val result = repo.calculatePayrollPeriod("pp1", "تصحيح السجل")
        assertTrue(result is AppResult.Success)
        val calculation = (result as AppResult.Success).data
        assertTrue(calculation.idempotent)
        assertEquals("تصحيح السجل", api.lastCalculation?.recalculationReason)
        assertEquals("1000.00", calculation.details.items.single().netPay)

        val loaded = repo.loadPayrollItems("pp1") as AppResult.Success
        assertEquals("1000.00", loaded.data.visibleSummary?.net)
        assertTrue(loaded.data.protectedRowsHidden)
        assertEquals(1, loaded.data.protectedRowCount)
        assertEquals("1000.00", repo.observePayrollItems("pp1").first().single().baseSalary)
    }

    @Test
    fun `Arabic blocker error remains structured and never becomes fake success`() = runTest {
        val json = """{"error":"PayrollEligibilityBlocked","message":"تعذر احتساب الرواتب","details":{"issues":[{"code":"MISSING_SALARY","message":"لا يوجد راتب","employeeId":"e1","employeeNum":"EMP-1","employeeName":"موظف"}],"protectedEmployeeIssues":1}}"""
        val result = ApiPayrollRepository(FakePayrollApi(failWith = 409, errorJson = json))
            .calculatePayrollPeriod("pp1")
        assertTrue(result is AppResult.Error)
        result as AppResult.Error
        assertEquals(409, (result.appError as AppError.ServerError).code)
        val workflow = result.exception as PayrollWorkflowException
        assertEquals("تعذر احتساب الرواتب", workflow.message)
        assertEquals("MISSING_SALARY", workflow.blockers.single().code)
        assertEquals(1, workflow.protectedEmployeeIssues)
    }

    @Test
    fun `approve paid and report use the real workflow and refresh after writes`() = runTest {
        val api = FakePayrollApi()
        val repo = ApiPayrollRepository(api)
        val approved = repo.approvePayrollPeriod("pp1") as AppResult.Success
        assertEquals("approved", approved.data.period.status)
        val paid = repo.markPayrollPeriodPaid("pp1") as AppResult.Success
        assertEquals("paid", paid.data.period.status)
        assertEquals(false, paid.data.bankTransferProof)
        assertTrue(api.getPeriodsCalls >= 2)

        val report = repo.loadPayrollReport("pp1") as AppResult.Success
        assertEquals("1000.00", report.data.visibleSummary?.net)
        assertEquals("1000.00", report.data.rows.single().netPay)
        assertTrue(report.data.protectedRowsHidden)
    }

    @Test
    fun `legacy approved period never becomes a fake zero summary`() = runTest {
        val api = FakePayrollApi(
            periods = listOf(
                PayrollPeriodDto(
                    id = "legacy",
                    companyId = "c1",
                    month = 1,
                    year = 2026,
                    status = "approved",
                    legacyWithoutItems = true,
                    visibleSummary = null
                ),
                PayrollPeriodDto(
                    id = "modern",
                    companyId = "c1",
                    month = 2,
                    year = 2026,
                    status = "paid",
                    visibleSummary = PayrollMoneySummaryDto(
                        1, "1000.00", "0.00", "1000.00", "SAR"
                    )
                )
            )
        )
        val repo = ApiPayrollRepository(api)
        repo.refreshPayroll()
        val period = repo.observePayrollPeriods().first().first { it.id == "legacy" }
        assertTrue(period.legacyWithoutItems)
        val summary = repo.getPayrollSummary() as AppResult.Success
        assertEquals(null, summary.data.totalNetPayroll)
    }

    // ---- Sprint 12H: payroll partial payments (v2) + exports ----

    @Test
    fun `record payment sends idempotency header and body then caches payment and period`() = runTest {
        val api = FakePayrollApi()
        val repo = ApiPayrollRepository(api)
        val result = repo.recordPayrollPayment(
            "pp1",
            com.example.domain.model.PayrollRecordPaymentRequest(
                amount = "500.00",
                paymentDate = "2026-07-01",
                expectedVersion = 0
            ),
            "idem-key-1"
        ) as AppResult.Success

        assertEquals("idem-key-1", api.lastIdempotencyKey)
        assertEquals("500.00", api.lastRecordRequest?.amount)
        assertEquals(0, api.lastRecordRequest?.expectedVersion)
        assertEquals("500.00", result.data.payment.amount)
        assertEquals("partially_paid", result.data.period.paymentState)
        assertEquals(1, result.data.period.paymentVersion)

        // recordPayrollPayment merges the new payment into the cache even without a
        // prior loadPayrollPayments() call, so the payments list stays consistent.
        val cachedPayments = repo.observePayrollPayments("pp1").first()
        assertEquals(1, cachedPayments.size)
        assertEquals("500.00", cachedPayments.single().amount)
    }

    @Test
    fun `load then record merges the new payment into the cached list`() = runTest {
        val api = FakePayrollApi().apply {
            payments = listOf(
                PayrollPaymentDto(
                    id = "pay-existing",
                    companyId = "c1",
                    payrollPeriodId = "pp1",
                    amount = "100.00",
                    currency = "SAR",
                    paymentDate = "2026-06-01",
                    status = "posted",
                    idempotencyKey = "key-existing",
                    recordedByUserId = "u1"
                )
            )
        }
        val repo = ApiPayrollRepository(api)
        repo.loadPayrollPayments("pp1")
        repo.recordPayrollPayment(
            "pp1",
            com.example.domain.model.PayrollRecordPaymentRequest(amount = "500.00", paymentDate = "2026-07-01", expectedVersion = 0),
            "idem-key-2"
        )
        val cached = repo.observePayrollPayments("pp1").first()
        assertEquals(2, cached.size)
        assertTrue(cached.any { it.id == "pay-existing" })
    }

    @Test
    fun `void payment sends reason and expected version then refreshes payment state`() = runTest {
        val api = FakePayrollApi()
        val repo = ApiPayrollRepository(api)
        val result = repo.voidPayrollPayment(
            "pp1",
            "pay-1",
            com.example.domain.model.PayrollVoidPaymentRequest(reason = "خطأ في الإدخال", expectedVersion = 1)
        ) as AppResult.Success

        assertEquals("خطأ في الإدخال", api.lastVoidRequest?.reason)
        assertEquals(1, api.lastVoidRequest?.expectedVersion)
        assertEquals("voided", result.data.payment.status)
        assertEquals("unpaid", result.data.period.paymentState)
        assertEquals(2, result.data.period.paymentVersion)
    }

    @Test
    fun `a v1 refresh never wipes payment state learned from the payments endpoints`() = runTest {
        val api = FakePayrollApi(periods = listOf(PayrollPeriodDto("pp1", "c1", 7, 2026, "approved")))
        val repo = ApiPayrollRepository(api)
        repo.refreshPayroll()
        repo.recordPayrollPayment(
            "pp1",
            com.example.domain.model.PayrollRecordPaymentRequest(amount = "500.00", paymentDate = "2026-07-01", expectedVersion = 0),
            "idem-key-3"
        )
        assertEquals("partially_paid", repo.observePayrollPeriods().first().first { it.id == "pp1" }.paymentState)

        repo.refreshPayroll()
        assertEquals(
            "partially_paid",
            repo.observePayrollPeriods().first().first { it.id == "pp1" }.paymentState
        )
    }

    @Test
    fun `payments messageKey errors translate to Arabic never leak raw keys`() = runTest {
        val api = FakePayrollApi(
            failWith = 409,
            errorJson = """{"code":"PayrollPaymentOverpay","messageKey":"payroll.payments.overpayment"}"""
        )
        val repo = ApiPayrollRepository(api)
        val result = repo.recordPayrollPayment(
            "pp1",
            com.example.domain.model.PayrollRecordPaymentRequest(amount = "999999.00", paymentDate = "2026-07-01", expectedVersion = 0),
            "idem-key-4"
        ) as AppResult.Error
        assertEquals("تتجاوز الدفعة صافي الرواتب المعتمد المتبقي.", result.exception.message)
    }

    @Test
    fun `export downloads the raw file bytes and maps content type to mime`() = runTest {
        val api = FakePayrollApi()
        val repo = ApiPayrollRepository(api)
        val result = repo.exportPayrollPeriod(
            "pp1",
            com.example.domain.model.PayrollExportFormat.CSV,
            "ar"
        ) as AppResult.Success

        assertEquals("csv", api.lastExportRequest?.format)
        assertEquals("ar", api.lastExportRequest?.locale)
        assertEquals("text/csv", result.data.mimeType)
        assertTrue(result.data.bytes.isNotEmpty())
    }
}
