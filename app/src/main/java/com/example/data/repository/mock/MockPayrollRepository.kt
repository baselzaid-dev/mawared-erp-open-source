package com.example.data.repository.mock

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.domain.model.PayrollActionResult
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
import com.example.domain.model.ReportExportPayload
import com.example.domain.repository.PayrollRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map
import java.math.BigDecimal
import java.math.RoundingMode

/** Deterministic demo-only implementation of the Sprint 6B payroll contract. */
class MockPayrollRepository : PayrollRepository {

    private val periods = mutableListOf(
        PayrollPeriodParams(
            id = "PP-2026-04",
            companyId = "1",
            month = 4,
            year = 2026,
            status = "paid",
            itemCount = 2,
            calculationVersion = 1,
            createdAt = "2026-04-28T10:00:00Z",
            calculatedAt = "2026-04-28T10:05:00Z",
            approvedAt = "2026-04-29T11:30:00Z",
            paidAt = "2026-04-30T09:00:00Z"
        ),
        PayrollPeriodParams(
            id = "PP-2026-05",
            companyId = "1",
            month = 5,
            year = 2026,
            status = "approved",
            itemCount = 2,
            calculationVersion = 1,
            createdAt = "2026-05-28T10:00:00Z",
            calculatedAt = "2026-05-28T10:05:00Z",
            approvedAt = "2026-05-29T12:15:00Z"
        ),
        PayrollPeriodParams(
            id = "PP-2026-06",
            companyId = "1",
            month = 6,
            year = 2026,
            status = "calculated",
            itemCount = 2,
            calculationVersion = 1,
            createdAt = "2026-06-26T09:00:00Z",
            calculatedAt = "2026-06-26T09:05:00Z"
        )
    )

    private val itemsByPeriod = mutableMapOf<String, List<PayrollItemParams>>().apply {
        periods.forEach { period -> put(period.id, buildItems(period.id)) }
    }
    private val periodsFlow = MutableStateFlow(periodsWithSummaries())
    private val itemsFlow = MutableStateFlow(itemsByPeriod.toMap())

    private val paymentsByPeriod = mutableMapOf<String, MutableList<PayrollPaymentParams>>()
    private val paymentsFlow = MutableStateFlow<Map<String, List<PayrollPaymentParams>>>(emptyMap())
    private var paymentSequence = 0

    private fun buildItems(periodId: String): List<PayrollItemParams> = listOf(
        PayrollItemParams(
            id = "PI-$periodId-1",
            payrollPeriodId = periodId,
            employeeId = "1",
            employeeName = "موظف تجريبي 3",
            employeeNum = "EMP-001",
            departmentName = "الموارد البشرية",
            baseSalary = "10000.00",
            grossPay = "10000.00",
            totalDeductions = "0.00",
            netPay = "10000.00",
            currency = "SAR",
            status = "calculated"
        ),
        PayrollItemParams(
            id = "PI-$periodId-2",
            payrollPeriodId = periodId,
            employeeId = "2",
            employeeName = "موظف تجريبي 4",
            employeeNum = "EMP-002",
            departmentName = "المالية",
            baseSalary = "12000.00",
            grossPay = "12000.00",
            totalDeductions = "0.00",
            netPay = "12000.00",
            currency = "SAR",
            status = "calculated"
        )
    )

    private fun summary(items: List<PayrollItemParams>): PayrollMoneySummary {
        fun sum(selector: (PayrollItemParams) -> String): String = items
            .map { selector(it).toBigDecimal() }
            .fold(BigDecimal.ZERO, BigDecimal::add)
            .setScale(2, RoundingMode.UNNECESSARY)
            .toPlainString()
        return PayrollMoneySummary(
            employeeCount = items.size,
            gross = sum { it.grossPay },
            deductions = sum { it.totalDeductions },
            net = sum { it.netPay },
            currency = "SAR"
        )
    }

    private fun periodsWithSummaries(): List<PayrollPeriodParams> = periods.map { period ->
        val items = itemsByPeriod[period.id].orEmpty()
        period.copy(
            itemCount = items.size,
            visibleSummary = items.takeIf { it.isNotEmpty() }?.let(::summary)
        )
    }

    private fun details(period: PayrollPeriodParams): PayrollItemsResult {
        val rows = itemsByPeriod[period.id].orEmpty()
        val itemSummary = rows.takeIf { it.isNotEmpty() }?.let(::summary)
        return PayrollItemsResult(
            period = period.copy(itemCount = rows.size, visibleSummary = itemSummary),
            items = rows,
            visibleSummary = itemSummary,
            fullSummary = itemSummary,
            protectedRowsHidden = false,
            protectedRowCount = 0
        )
    }

    private fun publish() {
        periodsFlow.value = periodsWithSummaries()
        itemsFlow.value = itemsByPeriod.toMap()
    }

    override fun observePayrollPeriods(): Flow<List<PayrollPeriodParams>> = periodsFlow

    override fun observePayrollItems(periodId: String): Flow<List<PayrollItemParams>> =
        itemsFlow.map { it[periodId].orEmpty() }

    override fun clear() {
        periodsFlow.value = emptyList()
        itemsFlow.value = emptyMap()
        paymentsFlow.value = emptyMap()
    }

    override suspend fun createPayrollPeriod(month: Int, year: Int): AppResult<PayrollPeriodParams> {
        if (periods.any { it.month == month && it.year == year }) {
            return AppResult.Error(Exception("فترة الرواتب موجودة مسبقاً"))
        }
        val created = PayrollPeriodParams(
            id = "PP-%04d-%02d".format(year, month),
            companyId = "1",
            month = month,
            year = year,
            status = "draft",
            createdAt = "2026-07-01T09:00:00Z"
        )
        periods.add(created)
        publish()
        return AppResult.Success(created)
    }

    override suspend fun calculatePayrollPeriod(
        periodId: String,
        recalculationReason: String?
    ): AppResult<PayrollCalculationResult> {
        val index = periods.indexOfFirst { it.id == periodId }
        if (index < 0) return AppResult.Error(Exception("فترة الرواتب غير موجودة"))
        val current = periods[index]
        if (current.status == "approved" || current.status == "paid") {
            return AppResult.Error(Exception("لا يمكن تعديل فترة رواتب معتمدة أو مدفوعة"))
        }
        if (current.status == "calculated") {
            return AppResult.Success(
                PayrollCalculationResult(details(current), idempotent = true, recalculated = false, protectedEmployeeIssues = 0)
            )
        }
        val updated = current.copy(
            status = "calculated",
            calculationVersion = 1,
            calculatedAt = "2026-07-01T09:05:00Z"
        )
        periods[index] = updated
        itemsByPeriod[periodId] = buildItems(periodId)
        publish()
        return AppResult.Success(
            PayrollCalculationResult(details(updated), idempotent = false, recalculated = false, protectedEmployeeIssues = 0)
        )
    }

    override suspend fun loadPayrollItems(periodId: String): AppResult<PayrollItemsResult> {
        val period = periodsWithSummaries().firstOrNull { it.id == periodId }
            ?: return AppResult.Error(Exception("فترة الرواتب غير موجودة"))
        return AppResult.Success(details(period))
    }

    override suspend fun approvePayrollPeriod(periodId: String): AppResult<PayrollActionResult> {
        val index = periods.indexOfFirst { it.id == periodId }
        if (index < 0) return AppResult.Error(Exception("فترة الرواتب غير موجودة"))
        if (periods[index].status != "calculated") {
            return AppResult.Error(Exception("يجب احتساب فترة الرواتب قبل اعتمادها"))
        }
        val updated = periods[index].copy(status = "approved", approvedAt = "2026-07-01T10:00:00Z")
        periods[index] = updated
        publish()
        return AppResult.Success(PayrollActionResult(updated, "تم اعتماد فترة الرواتب"))
    }

    override suspend fun markPayrollPeriodPaid(periodId: String): AppResult<PayrollActionResult> {
        val index = periods.indexOfFirst { it.id == periodId }
        if (index < 0) return AppResult.Error(Exception("فترة الرواتب غير موجودة"))
        if (periods[index].status != "approved") {
            return AppResult.Error(Exception("يجب اعتماد فترة الرواتب قبل تأكيد الدفع"))
        }
        val updated = periods[index].copy(status = "paid", paidAt = "2026-07-01T11:00:00Z")
        periods[index] = updated
        publish()
        return AppResult.Success(
            PayrollActionResult(updated, "تم تأكيد حالة الدفع إدارياً", bankTransferProof = false)
        )
    }

    override suspend fun loadPayrollReport(periodId: String): AppResult<PayrollReportParams> {
        val period = periodsWithSummaries().firstOrNull { it.id == periodId }
            ?: return AppResult.Error(Exception("فترة الرواتب غير موجودة"))
        if (period.status != "approved" && period.status != "paid") {
            return AppResult.Error(Exception("يتوفر تقرير الرواتب بعد اعتماد الفترة فقط"))
        }
        val itemDetails = details(period)
        return AppResult.Success(
            PayrollReportParams(
                period = itemDetails.period,
                rows = itemDetails.items,
                visibleSummary = itemDetails.visibleSummary,
                fullSummary = itemDetails.fullSummary,
                protectedRowsHidden = false,
                protectedRowCount = 0
            )
        )
    }

    override suspend fun refreshPayroll(): AppResult<Unit> {
        publish()
        return AppResult.Success(Unit)
    }

    override suspend fun getPayrollSummary(): AppResult<PayrollSummary> {
        val visible = periodsWithSummaries()
        val finalized = visible.filter { it.status == "approved" || it.status == "paid" }
        val totals = finalized.mapNotNull { it.visibleSummary?.net?.toBigDecimalOrNull() }
        val total = totals.takeIf { finalized.isNotEmpty() && it.size == finalized.size }
            ?.fold(BigDecimal.ZERO, BigDecimal::add)
            ?.setScale(2, RoundingMode.UNNECESSARY)
            ?.toPlainString()
        val latest = finalized.maxByOrNull { it.year * 12 + it.month }
        return AppResult.Success(
            PayrollSummary(
                totalPeriods = visible.size,
                approvedPeriods = finalized.size,
                paidPeriods = finalized.count { it.status == "paid" },
                totalNetPayroll = total,
                totalEmployeesPaid = latest?.visibleSummary?.employeeCount
            )
        )
    }

    // ---- Sprint 12H: payroll partial payments (v2) + exports (demo-only) ----

    private fun moneyToCents(value: String): Long =
        BigDecimal(value).movePointRight(2).toBigIntegerExact().toLong()

    private fun centsToMoney(cents: Long): String =
        BigDecimal(cents).movePointLeft(2).setScale(2, RoundingMode.UNNECESSARY).toPlainString()

    private fun approvedNetTotalCents(periodId: String): Long =
        itemsByPeriod[periodId].orEmpty().sumOf { moneyToCents(it.netPay) }

    private fun postedPaymentsTotalCents(periodId: String): Long =
        paymentsByPeriod[periodId].orEmpty()
            .filter { it.status == "posted" }
            .sumOf { moneyToCents(it.amount) }

    private fun derivePaymentState(paidCents: Long, approvedCents: Long): String = when {
        paidCents <= 0L -> "unpaid"
        paidCents >= approvedCents && approvedCents > 0L -> "paid"
        paidCents >= approvedCents -> if (paidCents > 0L) "paid" else "unpaid"
        else -> "partially_paid"
    }

    /** Mirrors backend applyPaymentStateToPeriod(): flips status paid<->approved, bumps version. */
    private fun applyPaymentStateAndVersion(periodId: String) {
        val index = periods.indexOfFirst { it.id == periodId }
        if (index < 0) return
        val current = periods[index]
        val approvedCents = approvedNetTotalCents(periodId)
        val paidCents = postedPaymentsTotalCents(periodId)
        val paymentState = derivePaymentState(paidCents, approvedCents)
        val nextStatus = when {
            paymentState == "paid" && current.status != "paid" -> "paid"
            paymentState != "paid" && current.status == "paid" -> "approved"
            else -> current.status
        }
        periods[index] = current.copy(
            status = nextStatus,
            paymentState = paymentState,
            paymentVersion = current.paymentVersion + 1,
            approvedNetTotal = centsToMoney(approvedCents)
        )
        paymentsFlow.value = paymentsByPeriod.mapValues { it.value.toList() }
        publish()
    }

    override fun observePayrollPayments(periodId: String): Flow<List<PayrollPaymentParams>> =
        paymentsFlow.map { it[periodId].orEmpty() }

    override suspend fun loadPayrollPayments(periodId: String): AppResult<List<PayrollPaymentParams>> {
        if (periods.none { it.id == periodId }) {
            return AppResult.Error(Exception("فترة الرواتب غير موجودة"))
        }
        return AppResult.Success(paymentsByPeriod[periodId].orEmpty())
    }

    override suspend fun recordPayrollPayment(
        periodId: String,
        request: PayrollRecordPaymentRequest,
        idempotencyKey: String
    ): AppResult<PayrollPaymentActionResult> {
        val period = periods.firstOrNull { it.id == periodId }
            ?: return AppResult.Error(Exception("فترة الرواتب غير موجودة"))
        if (period.status != "approved" && period.status != "paid") {
            return AppResult.Error(
                Exception("لا يمكن تسجيل دفعات إلا لفترة رواتب معتمدة أو مدفوعة"),
                AppError.ValidationError("لا يمكن تسجيل دفعات إلا لفترة رواتب معتمدة أو مدفوعة")
            )
        }
        val payments = paymentsByPeriod.getOrPut(periodId) { mutableListOf() }
        val existingByKey = payments.firstOrNull { it.idempotencyKey == idempotencyKey }
        if (existingByKey != null) {
            return AppResult.Success(
                PayrollPaymentActionResult(existingByKey, periods.first { it.id == periodId })
            )
        }
        val items = itemsByPeriod[periodId].orEmpty()
        if (items.isEmpty()) {
            return AppResult.Error(Exception("لا يمكن تسجيل دفعة لفترة رواتب بلا عناصر"))
        }
        if (request.expectedVersion != period.paymentVersion) {
            return AppResult.Error(
                Exception("تغيّرت بيانات الفترة منذ فتح الشاشة. حدّث القائمة ثم أعد المحاولة"),
                AppError.ValidationError("تغيّرت بيانات الفترة منذ فتح الشاشة. حدّث القائمة ثم أعد المحاولة")
            )
        }
        val amountCents = try {
            moneyToCents(request.amount)
        } catch (_: Exception) {
            return AppResult.Error(Exception("قيمة الدفعة غير صالحة"))
        }
        if (amountCents <= 0L) {
            return AppResult.Error(Exception("يجب أن تكون قيمة الدفعة أكبر من صفر"))
        }
        if (request.currency.uppercase() != "SAR") {
            return AppResult.Error(Exception("العملة غير مدعومة. استخدم الريال السعودي (SAR)"))
        }
        val approvedCents = approvedNetTotalCents(periodId)
        val paidCents = postedPaymentsTotalCents(periodId)
        if (paidCents + amountCents > approvedCents) {
            return AppResult.Error(Exception("تتجاوز الدفعة صافي الرواتب المعتمد المتبقي"))
        }
        paymentSequence += 1
        val payment = PayrollPaymentParams(
            id = "PAY-$periodId-$paymentSequence",
            companyId = "1",
            payrollPeriodId = periodId,
            amount = normalizedAmount(amountCents),
            currency = "SAR",
            paymentDate = request.paymentDate,
            reference = request.reference,
            note = request.note,
            status = "posted",
            idempotencyKey = idempotencyKey,
            recordedByUserId = "demo-user",
            createdAt = "2026-07-19T12:00:00Z"
        )
        payments.add(payment)
        applyPaymentStateAndVersion(periodId)
        return AppResult.Success(
            PayrollPaymentActionResult(payment, periods.first { it.id == periodId })
        )
    }

    override suspend fun voidPayrollPayment(
        periodId: String,
        paymentId: String,
        request: PayrollVoidPaymentRequest
    ): AppResult<PayrollPaymentActionResult> {
        val period = periods.firstOrNull { it.id == periodId }
            ?: return AppResult.Error(Exception("فترة الرواتب غير موجودة"))
        val payments = paymentsByPeriod[periodId] ?: mutableListOf()
        val paymentIndex = payments.indexOfFirst { it.id == paymentId }
        if (paymentIndex < 0) return AppResult.Error(Exception("الدفعة غير موجودة"))
        if (request.expectedVersion != period.paymentVersion) {
            return AppResult.Error(
                Exception("تغيّرت بيانات الفترة منذ فتح الشاشة. حدّث القائمة ثم أعد المحاولة"),
                AppError.ValidationError("تغيّرت بيانات الفترة منذ فتح الشاشة. حدّث القائمة ثم أعد المحاولة")
            )
        }
        val existing = payments[paymentIndex]
        if (existing.status == "voided") {
            return AppResult.Success(PayrollPaymentActionResult(existing, period))
        }
        val voided = existing.copy(
            status = "voided",
            voidedAt = "2026-07-19T12:05:00Z",
            voidedByUserId = "demo-user",
            voidReason = request.reason
        )
        payments[paymentIndex] = voided
        applyPaymentStateAndVersion(periodId)
        return AppResult.Success(
            PayrollPaymentActionResult(voided, periods.first { it.id == periodId })
        )
    }

    private fun normalizedAmount(cents: Long): String = centsToMoney(cents)

    override suspend fun exportPayrollPeriod(
        periodId: String,
        format: PayrollExportFormat,
        locale: String
    ): AppResult<ReportExportPayload> {
        val period = periods.firstOrNull { it.id == periodId }
            ?: return AppResult.Error(Exception("فترة الرواتب غير موجودة"))
        if (period.status != "approved" && period.status != "paid") {
            return AppResult.Error(Exception("يتوفر تصدير مسير الرواتب بعد اعتماد الفترة فقط"))
        }
        val rows = itemsByPeriod[periodId].orEmpty()
        val header = if (locale == "en") "Employee,Net Pay,Currency" else "الموظف,الصافي,العملة"
        val body = rows.joinToString("\n") { "${it.employeeName},${it.netPay},${it.currency}" }
        val text = "$header\n$body\n"
        return AppResult.Success(
            ReportExportPayload(
                bytes = text.toByteArray(Charsets.UTF_8),
                filename = "payroll_${periodId}.${format.fileExtension}",
                mimeType = format.mimeType
            )
        )
    }
}
