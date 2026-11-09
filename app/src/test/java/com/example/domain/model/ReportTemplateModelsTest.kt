package com.example.domain.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReportTemplateModelsTest {

    @Test
    fun `extra filter key is null for composite templates`() {
        assertNull(reportTemplateExtraFilterKey(listOf("attendance", "leaves")))
    }

    @Test
    fun `extra filter key maps single module templates`() {
        assertEquals("status", reportTemplateExtraFilterKey(listOf("attendance")))
        assertEquals("periodId", reportTemplateExtraFilterKey(listOf("payroll")))
        assertEquals("requestStatus", reportTemplateExtraFilterKey(listOf("purchasing")))
    }

    @Test
    fun `catalog item supports only server-declared formats`() {
        val item = ReportTemplateCatalogItem(
            builtInKey = "attendance",
            version = 1,
            kind = "single",
            modules = listOf("attendance"),
            title = "الحضور",
            description = "desc",
            formats = listOf("csv", "pdf"),
            maximumRangeDays = 366
        )
        assertTrue(item.supportsFormat(ReportTemplateExportFormat.CSV))
        assertTrue(item.supportsFormat(ReportTemplateExportFormat.PDF))
        assertEquals(false, item.supportsFormat(ReportTemplateExportFormat.XLSX))
    }
}
