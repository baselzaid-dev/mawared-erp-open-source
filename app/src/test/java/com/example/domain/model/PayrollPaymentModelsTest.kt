package com.example.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PayrollPaymentModelsTest {

    private fun period(
        status: String,
        paymentState: String? = null,
        paymentVersion: Int = 0
    ) = PayrollPeriodParams(
        id = "period",
        companyId = "company",
        month = 7,
        year = 2026,
        status = status,
        paymentState = paymentState,
        paymentVersion = paymentVersion
    )

    private fun payment(status: String = "posted", voidReason: String? = null) = PayrollPaymentParams(
        id = "pay-1",
        companyId = "company",
        payrollPeriodId = "period",
        amount = "500.00",
        currency = "SAR",
        paymentDate = "2026-07-01",
        status = status,
        idempotencyKey = "key-1",
        recordedByUserId = "u1",
        voidReason = voidReason
    )

    @Test
    fun `numeric period label is pure formatting matching the backend 1 to 1`() {
        assertEquals("2026-07", period("approved").numericPeriodLabel())
        val singleDigitMonth = period("approved").copy(month = 1)
        assertEquals("2026-01", singleDigitMonth.numericPeriodLabel())
    }

    @Test
    fun `payments actions are only allowed for approved or paid periods`() {
        assertFalse(period("draft").canRecordPayment())
        assertFalse(period("calculated").canRecordPayment())
        assertTrue(period("approved").canRecordPayment())
        assertTrue(period("paid").canRecordPayment())

        assertFalse(period("draft").canVoidPayment())
        assertTrue(period("approved").canVoidPayment())
        assertTrue(period("paid").canVoidPayment())

        assertFalse(period("calculated").canExportPayroll())
        assertTrue(period("approved").canExportPayroll())
        assertTrue(period("paid").canExportPayroll())
    }

    @Test
    fun `arabic payment state reflects the server-provided category never an invented total`() {
        assertEquals("غير مدفوعة", period("approved", paymentState = "unpaid").arabicPaymentState())
        assertEquals("مدفوعة جزئياً", period("approved", paymentState = "partially_paid").arabicPaymentState())
        assertEquals("مدفوعة بالكامل", period("paid", paymentState = "paid").arabicPaymentState())
        // Never seen the payments endpoints yet: fall back to the period's own status,
        // never a guessed amount.
        assertEquals("مدفوعة بالكامل", period("paid", paymentState = null).arabicPaymentState())
        assertEquals("لم تُحمّل بيانات الدفع", period("approved", paymentState = null).arabicPaymentState())
    }

    @Test
    fun `payment status and voided flag are explicit`() {
        val posted = payment(status = "posted")
        assertFalse(posted.isVoided())
        assertEquals("مسجلة", posted.arabicPaymentStatus())

        val voided = payment(status = "voided", voidReason = "خطأ في الإدخال")
        assertTrue(voided.isVoided())
        assertEquals("ملغاة", voided.arabicPaymentStatus())
        assertEquals("خطأ في الإدخال", voided.voidReason)
    }

    @Test
    fun `export formats carry the exact mime type the backend returns`() {
        assertEquals("text/csv", PayrollExportFormat.CSV.mimeType)
        assertEquals(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            PayrollExportFormat.XLSX.mimeType
        )
        assertEquals("application/pdf", PayrollExportFormat.PDF.mimeType)
        assertEquals(3, PayrollExportFormat.entries.size)
    }

    @Test
    fun `no bank transfer claim notice matches the money safety rule`() {
        assertTrue(PAYROLL_PAYMENT_NO_BANK_TRANSFER_NOTICE.contains("لا يمثل إثبات تحويل بنكي"))
    }
}
