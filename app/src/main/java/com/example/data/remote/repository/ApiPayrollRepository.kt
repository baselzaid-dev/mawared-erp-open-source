package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.CreatePayrollPeriodRequestDto
import com.example.data.remote.api.PayrollActionResponseDto
import com.example.data.remote.api.PayrollApi
import com.example.data.remote.api.PayrollCalculationRequestDto
import com.example.data.remote.api.PayrollCalculationResponseDto
import com.example.data.remote.api.PayrollErrorResponseDto
import com.example.data.remote.api.PayrollExportRequestDto
import com.example.data.remote.api.PayrollItemDto
import com.example.data.remote.api.PayrollItemsResponseDto
import com.example.data.remote.api.PayrollMoneySummaryDto
import com.example.data.remote.api.PayrollPaymentActionResponseDto
import com.example.data.remote.api.PayrollPaymentDto
import com.example.data.remote.api.PayrollPaymentErrorResponseDto
import com.example.data.remote.api.PayrollPeriodDto
import com.example.data.remote.api.PayrollPeriodPaymentSummaryDto
import com.example.data.remote.api.PayrollRecordPaymentRequestDto
import com.example.data.remote.api.PayrollReportResponseDto
import com.example.data.remote.api.PayrollVoidPaymentRequestDto
import com.example.domain.model.PayrollActionResult
import com.example.domain.model.PayrollBlockerParams
import com.example.domain.model.PayrollCalculationResult
import com.example.domain.model.PayrollExportFormat
import com.example.domain.model.PayrollItemParams
import com.example.domain.model.PayrollItemsResult
import com.example.domain.model.PayrollMoneySummary
import com.example.domain.model.PayrollPaymentActionResult
import com.example.domain.model.PayrollPaymentParams
import com.example.domain.model.PayrollPeriodParams
import com.example.domain.model.PayrollRecordPaymentRequest
import com.example.domain.model.PayrollReportParams
import com.example.domain.model.PayrollSummary
import com.example.domain.model.PayrollVoidPaymentRequest
import com.example.domain.model.PayrollWorkflowException
import com.example.domain.model.ReportExportPayload
import com.example.domain.repository.PayrollRepository
import com.squareup.moshi.Moshi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import okhttp3.ResponseBody
import retrofit2.Response
import java.io.ByteArrayOutputStream
import java.math.BigDecimal
import java.math.RoundingMode

private const val MAX_EXPORT_BYTES = 10 * 1024 * 1024

class ApiPayrollRepository(
    private val payrollApi: PayrollApi
) : PayrollRepository {

    private val periods = MutableStateFlow<List<PayrollPeriodParams>>(emptyList())
    private val periodDetails = MutableStateFlow<Map<String, PayrollItemsResult>>(emptyMap())
    private val paymentsByPeriod = MutableStateFlow<Map<String, List<PayrollPaymentParams>>>(emptyMap())
    private val errorAdapter = Moshi.Builder().build().adapter(PayrollErrorResponseDto::class.java)
    private val genericErrorAdapter = Moshi.Builder().build().adapter(Any::class.java)
    private val paymentErrorAdapter = Moshi.Builder().build().adapter(PayrollPaymentErrorResponseDto::class.java)

    private fun PayrollMoneySummaryDto.toParams() = PayrollMoneySummary(
        employeeCount = visibleEmployeeCount,
        gross = visibleGross,
        deductions = visibleDeductions,
        net = visibleNet,
        currency = currency
    )

    private fun PayrollPeriodDto.toParams() = PayrollPeriodParams(
        id = id,
        companyId = companyId,
        month = month,
        year = year,
        status = status,
        itemCount = itemCount,
        calculationVersion = calculationVersion,
        createdAt = createdAt.orEmpty(),
        calculatedAt = calculatedAt,
        approvedAt = approvedAt,
        paidAt = paidAt,
        legacyWithoutItems = legacyWithoutItems,
        visibleSummary = visibleSummary?.toParams(),
        fullSummary = fullSummary?.toParams(),
        protectedRowsHidden = protectedRowsHidden,
        protectedRowCount = protectedRowCount
    )

    private fun PayrollItemDto.toParams() = PayrollItemParams(
        id = id,
        payrollPeriodId = payrollPeriodId,
        employeeId = employeeId,
        employeeName = employeeName,
        employeeNum = employeeNum,
        departmentName = departmentName,
        baseSalary = baseSalary,
        grossPay = grossPay,
        totalDeductions = totalDeductions,
        netPay = netPay,
        currency = currency,
        status = status,
        calculatedAt = calculatedAt
    )

    private fun PayrollItemsResponseDto.toParams() = PayrollItemsResult(
        period = period.toParams(),
        items = items.map { it.toParams() },
        visibleSummary = visibleSummary?.toParams(),
        fullSummary = fullSummary?.toParams(),
        protectedRowsHidden = protectedRowsHidden,
        protectedRowCount = protectedRowCount
    )

    private fun PayrollCalculationResponseDto.toParams() = PayrollCalculationResult(
        details = PayrollItemsResult(
            period = period.toParams(),
            items = items.map { it.toParams() },
            visibleSummary = visibleSummary?.toParams(),
            fullSummary = fullSummary?.toParams(),
            protectedRowsHidden = protectedRowsHidden,
            protectedRowCount = protectedRowCount
        ),
        idempotent = idempotent,
        recalculated = recalculated,
        protectedEmployeeIssues = protectedEmployeeIssues
    )

    private fun PayrollActionResponseDto.toParams() = PayrollActionResult(
        period = period.toParams(),
        message = message,
        bankTransferProof = bankTransferProof
    )

    private fun PayrollReportResponseDto.toParams() = PayrollReportParams(
        period = period.toParams(),
        rows = rows.map { it.toParams() },
        visibleSummary = visibleSummary?.toParams(),
        fullSummary = fullSummary?.toParams(),
        protectedRowsHidden = protectedRowsHidden,
        protectedRowCount = protectedRowCount
    )

    private fun PayrollPaymentDto.toParams() = PayrollPaymentParams(
        id = id,
        companyId = companyId,
        payrollPeriodId = payrollPeriodId,
        amount = amount,
        currency = currency,
        paymentDate = paymentDate,
        reference = reference,
        note = note,
        status = status,
        idempotencyKey = idempotencyKey,
        recordedByUserId = recordedByUserId,
        createdAt = createdAt,
        voidedAt = voidedAt,
        voidedByUserId = voidedByUserId,
        voidReason = voidReason,
        isLegacyMigration = isLegacyMigration
    )

    /** Superset of PayrollPeriodDto returned only by the payments record/void endpoints. */
    private fun PayrollPeriodPaymentSummaryDto.toParams() = PayrollPeriodParams(
        id = id,
        companyId = companyId,
        month = month,
        year = year,
        status = status,
        itemCount = itemCount,
        calculationVersion = calculationVersion,
        createdAt = createdAt.orEmpty(),
        calculatedAt = calculatedAt,
        approvedAt = approvedAt,
        paidAt = paidAt,
        legacyWithoutItems = legacyWithoutItems,
        visibleSummary = visibleSummary?.toParams(),
        fullSummary = fullSummary?.toParams(),
        paymentState = paymentState,
        paymentVersion = paymentVersion,
        approvedNetTotal = approvedNetTotal,
        protectedRowsHidden = protectedRowsHidden,
        protectedRowCount = protectedRowCount
    )

    private fun <T> responseError(response: Response<T>, fallback: String): AppResult.Error {
        val rawError = response.errorBody()?.string()
        val payload = try {
            rawError?.let(errorAdapter::fromJson)
        } catch (_: Exception) {
            null
        }
        val genericPayload = try {
            rawError?.let(genericErrorAdapter::fromJson) as? Map<*, *>
        } catch (_: Exception) {
            null
        }
        val message = payload?.message?.takeIf { it.isNotBlank() }
            ?: payload?.error?.takeIf { it.isNotBlank() }
            ?: (genericPayload?.get("message") as? String)?.takeIf { it.isNotBlank() }
            ?: (genericPayload?.get("error") as? String)?.takeIf { it.isNotBlank() }
            ?: fallback
        val details = payload?.details
        val exception = PayrollWorkflowException(
            message = message,
            blockers = details?.issues.orEmpty().map { issue ->
                PayrollBlockerParams(
                    code = issue.code,
                    message = issue.message,
                    employeeId = issue.employeeId,
                    employeeNum = issue.employeeNum,
                    employeeName = issue.employeeName
                )
            },
            protectedEmployeeIssues = details?.protectedEmployeeIssues ?: 0
        )
        return AppResult.Error(exception, AppError.ServerError(response.code(), message))
    }

    /**
     * The payments endpoints (unlike the v1 payroll routes) only return a short
     * `messageKey` — never an Arabic message. Translate the known keys here so every
     * consumer (ViewModel, UI) always sees Arabic text, same convention as
     * ApiAttendanceExemptionRepository/AttendanceExemptionController.
     */
    private fun paymentMessageFor(key: String?): String? = when (key) {
        "payroll.payments.unauthorized" -> "يلزم تسجيل الدخول مجددًا."
        "payroll.payments.invalid_request" -> "طلب غير صالح. تحقق من البيانات وأعد المحاولة."
        "payroll.payments.idempotency_key_required" -> "مفتاح الطلب مفقود. أعد المحاولة."
        "payroll.payments.idempotency_key_invalid" -> "مفتاح الطلب غير صالح. أعد المحاولة."
        "payroll.payments.idempotency_conflict" -> "توجد محاولة سابقة بنفس المفتاح ببيانات مختلفة. أعد المحاولة."
        "payroll.payments.period_not_found" -> "فترة الرواتب غير موجودة."
        "payroll.payments.period_not_payable" -> "لا يمكن تسجيل دفعات إلا لفترة رواتب معتمدة أو مدفوعة."
        "payroll.payments.version_mismatch" -> "تغيّرت بيانات الفترة منذ فتح الشاشة. حدّث القائمة ثم أعد المحاولة."
        "payroll.payments.items_required" -> "لا يمكن تسجيل دفعة لفترة رواتب بلا عناصر."
        "payroll.payments.invalid_amount" -> "قيمة الدفعة غير صالحة."
        "payroll.payments.amount_must_be_positive" -> "يجب أن تكون قيمة الدفعة أكبر من صفر."
        "payroll.payments.currency_not_supported" -> "العملة غير مدعومة. استخدم الريال السعودي (SAR)."
        "payroll.payments.currency_mismatch" -> "عملة الدفعة لا تطابق عملة مسير الرواتب."
        "payroll.payments.overpayment" -> "تتجاوز الدفعة صافي الرواتب المعتمد المتبقي."
        "payroll.payments.payment_not_found" -> "الدفعة غير موجودة."
        else -> null
    }

    private fun <T> paymentResponseError(response: Response<T>, fallback: String): AppResult.Error {
        val payload = try {
            response.errorBody()?.string()?.let(paymentErrorAdapter::fromJson)
        } catch (_: Exception) {
            null
        }
        val message = paymentMessageFor(payload?.messageKey) ?: fallback
        return AppResult.Error(Exception(message), AppError.ServerError(response.code(), message))
    }

    private fun ResponseBody.readLimitedBytes(maxBytes: Int): ByteArray {
        val output = ByteArrayOutputStream()
        byteStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var total = 0
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                require(total <= maxBytes) { "حجم ملف التصدير يتجاوز الحد المسموح" }
                output.write(buffer, 0, read)
            }
        }
        return output.toByteArray()
    }

    private fun exportFilename(periodId: String, format: PayrollExportFormat, disposition: String?): String {
        val pattern = Regex("filename\\*?=\\s*(?:UTF-8''|\")?([^\";]+)", RegexOption.IGNORE_CASE)
        val raw = disposition?.let { pattern.find(it)?.groupValues?.getOrNull(1) }?.trim()
        val safe = raw?.takeIf { Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$").matches(it) }
        return safe ?: "payroll_${periodId}.${format.fileExtension}"
    }

    private fun cacheDetails(details: PayrollItemsResult) {
        periodDetails.value = periodDetails.value + (details.period.id to details)
    }

    private fun cachePeriod(period: PayrollPeriodParams) {
        val existing = periods.value.firstOrNull { it.id == period.id }
        val merged = period.copy(
            itemCount = if (period.itemCount == 0) existing?.itemCount ?: 0 else period.itemCount,
            visibleSummary = period.visibleSummary ?: existing?.visibleSummary,
            fullSummary = period.fullSummary ?: existing?.fullSummary,
            // The v1 period endpoints know nothing about payments (v2); never let a v1
            // response wipe out payment state learned from the payments endpoints.
            paymentState = period.paymentState ?: existing?.paymentState,
            paymentVersion = maxOf(period.paymentVersion, existing?.paymentVersion ?: 0),
            approvedNetTotal = period.approvedNetTotal ?: existing?.approvedNetTotal,
            protectedRowsHidden = period.protectedRowsHidden || existing?.protectedRowsHidden == true,
            protectedRowCount = maxOf(period.protectedRowCount, existing?.protectedRowCount ?: 0)
        )
        periods.value = (periods.value.filterNot { it.id == period.id } + merged)
            .sortedWith(compareByDescending<PayrollPeriodParams> { it.year }.thenByDescending { it.month })
    }

    override fun observePayrollPeriods(): Flow<List<PayrollPeriodParams>> = periods.asStateFlow()

    override fun observePayrollItems(periodId: String): Flow<List<PayrollItemParams>> =
        periodDetails.map { details -> details[periodId]?.items.orEmpty() }

    override suspend fun createPayrollPeriod(month: Int, year: Int): AppResult<PayrollPeriodParams> = try {
        val response = payrollApi.createPeriod(CreatePayrollPeriodRequestDto(month, year))
        val body = response.body()
        if (response.isSuccessful && body != null) {
            cachePeriod(body.toParams())
            refreshPayroll()
            AppResult.Success(body.toParams())
        } else {
            responseError(response, "تعذر إنشاء فترة الرواتب")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun calculatePayrollPeriod(
        periodId: String,
        recalculationReason: String?
    ): AppResult<PayrollCalculationResult> = try {
        val response = payrollApi.calculatePeriod(
            periodId,
            PayrollCalculationRequestDto(recalculationReason?.trim()?.takeIf { it.isNotEmpty() })
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val result = body.toParams()
            cacheDetails(result.details)
            cachePeriod(result.details.period)
            refreshPayroll()
            AppResult.Success(result)
        } else {
            responseError(response, "تعذر احتساب فترة الرواتب")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadPayrollItems(periodId: String): AppResult<PayrollItemsResult> = try {
        val response = payrollApi.getPeriodItems(periodId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val details = body.toParams()
            cacheDetails(details)
            AppResult.Success(details)
        } else {
            responseError(response, "تعذر تحميل عناصر الرواتب")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun approvePayrollPeriod(periodId: String): AppResult<PayrollActionResult> = try {
        val response = payrollApi.approvePeriod(periodId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            cachePeriod(body.period.toParams())
            refreshPayroll()
            AppResult.Success(body.toParams())
        } else {
            responseError(response, "تعذر اعتماد فترة الرواتب")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun markPayrollPeriodPaid(periodId: String): AppResult<PayrollActionResult> = try {
        val response = payrollApi.markPeriodPaid(periodId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            cachePeriod(body.period.toParams())
            refreshPayroll()
            AppResult.Success(body.toParams())
        } else {
            responseError(response, "تعذر تأكيد حالة الدفع")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadPayrollReport(periodId: String): AppResult<PayrollReportParams> = try {
        val response = payrollApi.getPayrollReport(periodId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(body.toParams())
        } else {
            responseError(response, "تعذر تحميل تقرير الرواتب")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun refreshPayroll(): AppResult<Unit> = try {
        val response = payrollApi.getPeriods()
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val freshIds = body.map { it.id }.toSet()
            body.forEach { cachePeriod(it.toParams()) }
            periods.value = periods.value.filter { it.id in freshIds }
            AppResult.Success(Unit)
        } else {
            responseError(response, "تعذر تحميل فترات الرواتب")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun getPayrollSummary(): AppResult<PayrollSummary> {
        if (periods.value.isEmpty()) {
            val refreshed = refreshPayroll()
            if (refreshed is AppResult.Error) return refreshed
        }
        val approvedOrPaid = periods.value.filter { it.status == "approved" || it.status == "paid" }
        val availableTotals = approvedOrPaid.mapNotNull { it.visibleSummary?.net?.toBigDecimalOrNull() }
        val totalNet = availableTotals.takeIf {
            approvedOrPaid.isNotEmpty() && it.size == approvedOrPaid.size
        }
            ?.fold(BigDecimal.ZERO, BigDecimal::add)
            ?.setScale(2, RoundingMode.UNNECESSARY)
            ?.toPlainString()
        val latest = approvedOrPaid.maxByOrNull { it.year * 12 + it.month }
        return AppResult.Success(
            PayrollSummary(
                totalPeriods = periods.value.size,
                approvedPeriods = approvedOrPaid.size,
                paidPeriods = periods.value.count { it.status == "paid" },
                totalNetPayroll = totalNet,
                totalEmployeesPaid = latest?.visibleSummary?.employeeCount
            )
        )
    }

    override fun observePayrollPayments(periodId: String): Flow<List<PayrollPaymentParams>> =
        paymentsByPeriod.map { it[periodId].orEmpty() }

    override suspend fun loadPayrollPayments(periodId: String): AppResult<List<PayrollPaymentParams>> = try {
        val response = payrollApi.getPeriodPayments(periodId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val mapped = body.map { it.toParams() }
            paymentsByPeriod.value = paymentsByPeriod.value + (periodId to mapped)
            AppResult.Success(mapped)
        } else {
            paymentResponseError(response, "تعذر تحميل دفعات الرواتب")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    private fun mergePayment(periodId: String, payment: PayrollPaymentParams) {
        val existing = paymentsByPeriod.value[periodId].orEmpty()
        val merged = if (existing.any { it.id == payment.id }) {
            existing.map { if (it.id == payment.id) payment else it }
        } else {
            existing + payment
        }
        paymentsByPeriod.value = paymentsByPeriod.value + (periodId to merged)
    }

    override suspend fun recordPayrollPayment(
        periodId: String,
        request: PayrollRecordPaymentRequest,
        idempotencyKey: String
    ): AppResult<PayrollPaymentActionResult> = try {
        val response = payrollApi.recordPeriodPayment(
            periodId,
            idempotencyKey,
            PayrollRecordPaymentRequestDto(
                amount = request.amount,
                currency = request.currency,
                paymentDate = request.paymentDate,
                reference = request.reference,
                note = request.note,
                expectedVersion = request.expectedVersion
            )
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val payment = body.payment.toParams()
            val period = body.period.toParams()
            mergePayment(periodId, payment)
            cachePeriod(period)
            AppResult.Success(PayrollPaymentActionResult(payment, period))
        } else {
            paymentResponseError(response, "تعذر تسجيل الدفعة")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun voidPayrollPayment(
        periodId: String,
        paymentId: String,
        request: PayrollVoidPaymentRequest
    ): AppResult<PayrollPaymentActionResult> = try {
        val response = payrollApi.voidPeriodPayment(
            periodId,
            paymentId,
            PayrollVoidPaymentRequestDto(reason = request.reason, expectedVersion = request.expectedVersion)
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val payment = body.payment.toParams()
            val period = body.period.toParams()
            mergePayment(periodId, payment)
            cachePeriod(period)
            AppResult.Success(PayrollPaymentActionResult(payment, period))
        } else {
            paymentResponseError(response, "تعذر إلغاء الدفعة")
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun exportPayrollPeriod(
        periodId: String,
        format: PayrollExportFormat,
        locale: String
    ): AppResult<ReportExportPayload> = try {
        val response = payrollApi.exportPeriod(periodId, PayrollExportRequestDto(format.apiValue, locale))
        val body = response.body()
        if (!response.isSuccessful || body == null) {
            responseError(response, "تعذر تصدير مسير الرواتب")
        } else if (body.contentLength() in 1..Long.MAX_VALUE && body.contentLength() > MAX_EXPORT_BYTES) {
            AppResult.Error(
                Exception("حجم ملف التصدير يتجاوز الحد المسموح"),
                AppError.ValidationError("حجم ملف التصدير يتجاوز الحد المسموح")
            )
        } else {
            val bytes = body.readLimitedBytes(MAX_EXPORT_BYTES)
            val filename = exportFilename(periodId, format, response.headers()["Content-Disposition"])
            AppResult.Success(ReportExportPayload(bytes, filename, format.mimeType))
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override fun clear() {
        periods.value = emptyList()
        periodDetails.value = emptyMap()
        paymentsByPeriod.value = emptyMap()
    }
}
