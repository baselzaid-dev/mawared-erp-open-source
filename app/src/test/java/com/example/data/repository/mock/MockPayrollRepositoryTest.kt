package com.example.data.repository.mock

import com.example.core.utils.AppResult
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MockPayrollRepositoryTest {

    @Test
    fun `create then calculate follows draft to calculated with String money`() = runTest {
        val repo = MockPayrollRepository()
        val created = repo.createPayrollPeriod(7, 2026) as AppResult.Success
        assertEquals("draft", created.data.status)

        val result = repo.calculatePayrollPeriod(created.data.id) as AppResult.Success
        assertEquals("calculated", result.data.details.period.status)
        assertEquals("22000.00", result.data.details.visibleSummary?.net)
        assertEquals("10000.00", result.data.details.items.first().baseSalary)
        assertFalse(result.data.idempotent)
    }

    @Test
    fun `unchanged calculated period is idempotent and does not rewrite items`() = runTest {
        val repo = MockPayrollRepository()
        val created = repo.createPayrollPeriod(7, 2026) as AppResult.Success
        repo.calculatePayrollPeriod(created.data.id)
        val before = repo.observePayrollItems(created.data.id).first().map { it.id }

        val repeated = repo.calculatePayrollPeriod(created.data.id) as AppResult.Success
        assertTrue(repeated.data.idempotent)
        assertEquals(before, repo.observePayrollItems(created.data.id).first().map { it.id })
    }

    @Test
    fun `approve and paid transitions preserve immutable item snapshots`() = runTest {
        val repo = MockPayrollRepository()
        val created = repo.createPayrollPeriod(7, 2026) as AppResult.Success
        repo.calculatePayrollPeriod(created.data.id)
        val before = repo.observePayrollItems(created.data.id).first()

        val approved = repo.approvePayrollPeriod(created.data.id) as AppResult.Success
        assertEquals("approved", approved.data.period.status)
        val paid = repo.markPayrollPeriodPaid(created.data.id) as AppResult.Success
        assertEquals("paid", paid.data.period.status)
        assertEquals(false, paid.data.bankTransferProof)
        assertEquals(before, repo.observePayrollItems(created.data.id).first())
    }

    @Test
    fun `approved period cannot be calculated or approved twice`() = runTest {
        val repo = MockPayrollRepository()
        val created = repo.createPayrollPeriod(7, 2026) as AppResult.Success
        repo.calculatePayrollPeriod(created.data.id)
        repo.approvePayrollPeriod(created.data.id)
        assertTrue(repo.calculatePayrollPeriod(created.data.id) is AppResult.Error)
        assertTrue(repo.approvePayrollPeriod(created.data.id) is AppResult.Error)
    }

    @Test
    fun `report returns approved snapshots and exact totals`() = runTest {
        val repo = MockPayrollRepository()
        val report = repo.loadPayrollReport("PP-2026-05") as AppResult.Success
        assertEquals("approved", report.data.period.status)
        assertEquals("22000.00", report.data.visibleSummary?.net)
        assertEquals(2, report.data.rows.size)
    }

    @Test
    fun `draft report and unknown period fail honestly`() = runTest {
        val repo = MockPayrollRepository()
        val created = repo.createPayrollPeriod(7, 2026) as AppResult.Success
        assertTrue(repo.loadPayrollReport(created.data.id) is AppResult.Error)
        assertTrue(repo.approvePayrollPeriod("PP-0000-00") is AppResult.Error)
    }

    // ---- Sprint 12H: payroll partial payments (v2) + exports (demo-only) ----

    @Test
    fun `partial payment moves an approved period to partially_paid never invents a total`() = runTest {
        val repo = MockPayrollRepository()
        val result = repo.recordPayrollPayment(
            "PP-2026-05",
            com.example.domain.model.PayrollRecordPaymentRequest(amount = "10000.00", paymentDate = "2026-07-01", expectedVersion = 0),
            "idem-1"
        ) as AppResult.Success

        assertEquals("posted", result.data.payment.status)
        assertEquals("partially_paid", result.data.period.paymentState)
        assertEquals("approved", result.data.period.status)
        assertEquals(1, result.data.period.paymentVersion)
        assertEquals(1, repo.observePayrollPayments("PP-2026-05").first().size)
    }

    @Test
    fun `full payment flips the period to paid and void reverts it to approved`() = runTest {
        val repo = MockPayrollRepository()
        val recorded = repo.recordPayrollPayment(
            "PP-2026-05",
            com.example.domain.model.PayrollRecordPaymentRequest(amount = "22000.00", paymentDate = "2026-07-01", expectedVersion = 0),
            "idem-full"
        ) as AppResult.Success
        assertEquals("paid", recorded.data.period.status)
        assertEquals("paid", recorded.data.period.paymentState)

        val voided = repo.voidPayrollPayment(
            "PP-2026-05",
            recorded.data.payment.id,
            com.example.domain.model.PayrollVoidPaymentRequest(reason = "خطأ في الإدخال", expectedVersion = 1)
        ) as AppResult.Success
        assertEquals("voided", voided.data.payment.status)
        assertEquals("approved", voided.data.period.status)
        assertEquals("unpaid", voided.data.period.paymentState)
    }

    @Test
    fun `overpayment and stale version are rejected before touching state`() = runTest {
        val repo = MockPayrollRepository()
        val overpay = repo.recordPayrollPayment(
            "PP-2026-05",
            com.example.domain.model.PayrollRecordPaymentRequest(amount = "999999.00", paymentDate = "2026-07-01", expectedVersion = 0),
            "idem-over"
        )
        assertTrue(overpay is AppResult.Error)

        val staleVersion = repo.recordPayrollPayment(
            "PP-2026-05",
            com.example.domain.model.PayrollRecordPaymentRequest(amount = "1000.00", paymentDate = "2026-07-01", expectedVersion = 5),
            "idem-stale"
        )
        assertTrue(staleVersion is AppResult.Error)
        assertTrue(repo.observePayrollPayments("PP-2026-05").first().isEmpty())
    }

    @Test
    fun `repeating the same idempotency key returns the original payment not a duplicate`() = runTest {
        val repo = MockPayrollRepository()
        val first = repo.recordPayrollPayment(
            "PP-2026-05",
            com.example.domain.model.PayrollRecordPaymentRequest(amount = "5000.00", paymentDate = "2026-07-01", expectedVersion = 0),
            "idem-same"
        ) as AppResult.Success
        val second = repo.recordPayrollPayment(
            "PP-2026-05",
            com.example.domain.model.PayrollRecordPaymentRequest(amount = "5000.00", paymentDate = "2026-07-01", expectedVersion = 0),
            "idem-same"
        ) as AppResult.Success

        assertEquals(first.data.payment.id, second.data.payment.id)
        assertEquals(1, repo.observePayrollPayments("PP-2026-05").first().size)
    }

    @Test
    fun `payments require an approved or paid period`() = runTest {
        val repo = MockPayrollRepository()
        val result = repo.recordPayrollPayment(
            "PP-2026-06",
            com.example.domain.model.PayrollRecordPaymentRequest(amount = "1000.00", paymentDate = "2026-07-01", expectedVersion = 0),
            "idem-calc"
        )
        assertTrue(result is AppResult.Error)
    }

    @Test
    fun `export is only available for approved or paid periods and money stays a String`() = runTest {
        val repo = MockPayrollRepository()
        val blocked = repo.exportPayrollPeriod("PP-2026-06", com.example.domain.model.PayrollExportFormat.CSV)
        assertTrue(blocked is AppResult.Error)

        val allowed = repo.exportPayrollPeriod("PP-2026-05", com.example.domain.model.PayrollExportFormat.XLSX) as AppResult.Success
        assertEquals(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            allowed.data.mimeType
        )
        assertTrue(allowed.data.bytes.isNotEmpty())
        assertTrue(String(allowed.data.bytes).contains("10000.00"))
    }
}
