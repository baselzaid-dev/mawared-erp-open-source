package com.example.domain.model

/**
 * Sprint 12H — payroll partial payments (v2) + exports.
 *
 * Money stays String end-to-end (never Double/Float). `paymentState` and totals are
 * always computed server-side; the client only ever displays what the API returns.
 */
data class PayrollPaymentParams(
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

data class PayrollPaymentActionResult(
    val payment: PayrollPaymentParams,
    val period: PayrollPeriodParams
)

data class PayrollRecordPaymentRequest(
    val amount: String,
    val currency: String = "SAR",
    val paymentDate: String,
    val reference: String? = null,
    val note: String? = null,
    val expectedVersion: Int
)

data class PayrollVoidPaymentRequest(
    val reason: String,
    val expectedVersion: Int
)

enum class PayrollExportFormat(val apiValue: String, val fileExtension: String, val mimeType: String) {
    CSV("csv", "csv", "text/csv"),
    XLSX("xlsx", "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    PDF("pdf", "pdf", "application/pdf")
}

const val PAYROLL_PAYMENT_NO_BANK_TRANSFER_NOTICE =
    "تسجيل الدفعة إداري ولا يمثل إثبات تحويل بنكي."

fun PayrollPaymentParams.isVoided(): Boolean = status == "voided"

fun PayrollPaymentParams.arabicPaymentStatus(): String = when (status) {
    "posted" -> "مسجلة"
    "voided" -> "ملغاة"
    else -> status
}

/**
 * Never invents a total: when the payments endpoints haven't been called yet for this
 * period, falls back to the period's own (already-known) `status` instead of guessing.
 */
fun PayrollPeriodParams.arabicPaymentState(): String = when (paymentState) {
    "unpaid" -> "غير مدفوعة"
    "partially_paid" -> "مدفوعة جزئياً"
    "paid" -> "مدفوعة بالكامل"
    else -> if (status == "paid") "مدفوعة بالكامل" else "لم تُحمّل بيانات الدفع"
}

/** `${year}-${month}` — pure formatting, matches the backend's numericLabel() 1:1. */
fun PayrollPeriodParams.numericPeriodLabel(): String = "%04d-%02d".format(year, month)

fun PayrollPeriodParams.canRecordPayment(): Boolean = status == "approved" || status == "paid"
fun PayrollPeriodParams.canVoidPayment(): Boolean = status == "approved" || status == "paid"
fun PayrollPeriodParams.canExportPayroll(): Boolean = status == "approved" || status == "paid"
