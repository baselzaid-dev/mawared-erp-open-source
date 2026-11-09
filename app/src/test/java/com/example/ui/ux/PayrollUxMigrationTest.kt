package com.example.ui.ux

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class PayrollUxMigrationTest {
    @Test
    fun `payroll create period dialog uses shared scrollable form fields`() {
        val appRoot = listOf(File("."), File("app"))
            .first { File(it, "src/main/AndroidManifest.xml").exists() }
        val source = File(appRoot, "src/main/java/com/example/ui/PayrollViews.kt").readText()
        // No editable money OutlinedTextFields exist in Payroll UI (amounts are read-only String displays).
        // Fallback: create-period month/year form migrated to shared scrollable text fields.
        assertTrue(source.contains("MawaredScrollableForm"))
        assertTrue(source.contains("MawaredTextField"))
        assertTrue(source.contains("PayrollCreatePeriodDialog"))
        assertTrue(source.contains("onCreate"))
        val createPeriodDialog = source.substringAfter("fun PayrollCreatePeriodDialog")
            .substringBefore("fun PayrollCalculationConfirmation")
        assertTrue(createPeriodDialog.contains("MawaredScrollableForm"))
        assertTrue(createPeriodDialog.contains("MawaredTextField"))
        assertTrue(!createPeriodDialog.contains("OutlinedTextField"))
    }
}
