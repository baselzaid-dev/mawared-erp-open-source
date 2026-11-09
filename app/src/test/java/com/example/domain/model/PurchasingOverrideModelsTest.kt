package com.example.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PurchasingOverrideModelsTest {

    @Test
    fun `legal override actions mirror the backend ALLOWED_FROM_STATUSES 1 to 1`() {
        assertEquals(listOf("approve", "reject", "cancel"), purchasingOverrideLegalActionsFor("pending_department"))
        assertEquals(listOf("approve", "reject", "cancel"), purchasingOverrideLegalActionsFor("pending_purchasing"))
        assertEquals(listOf("reject", "cancel"), purchasingOverrideLegalActionsFor("approved"))
        assertEquals(emptyList<String>(), purchasingOverrideLegalActionsFor("rejected"))
        assertEquals(emptyList<String>(), purchasingOverrideLegalActionsFor("cancelled"))
        assertEquals(emptyList<String>(), purchasingOverrideLegalActionsFor("ordered"))
        assertEquals(emptyList<String>(), purchasingOverrideLegalActionsFor("received"))
    }

    @Test
    fun `confirmation token matches the backend literal exactly`() {
        assertEquals("OVERRIDE", PURCHASING_OVERRIDE_CONFIRMATION_TOKEN)
    }

    @Test
    fun `export formats carry the exact mime type the backend returns`() {
        assertEquals("text/csv", PurchasingExportFormat.CSV.mimeType)
        assertEquals(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            PurchasingExportFormat.XLSX.mimeType
        )
        assertEquals("application/pdf", PurchasingExportFormat.PDF.mimeType)
        assertEquals(3, PurchasingExportFormat.entries.size)
    }

    @Test
    fun `override exception carries the outcome code and optional version-conflict details`() {
        val exception = PurchasingOverrideException(
            message = "تغيّرت بيانات الطلب منذ فتح الشاشة.",
            code = "VersionMismatch",
            currentUpdatedAt = "2026-07-19T09:00:00.000Z"
        )
        assertEquals("VersionMismatch", exception.code)
        assertEquals("2026-07-19T09:00:00.000Z", exception.currentUpdatedAt)
        assertTrue(exception.message.orEmpty().isNotBlank())
    }
}
