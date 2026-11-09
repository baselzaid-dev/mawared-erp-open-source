package com.example.ui.ux

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SupplierUxMigrationTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    @Test
    fun `supplier create edit form reuses shared text and email fields`() {
        val supplierViews = File(appRoot, "src/main/java/com/example/ui/SupplierViews.kt").readText()
        assertTrue(supplierViews.contains("MawaredScrollableForm"))
        assertTrue(supplierViews.contains("MawaredEmailField"))
        assertTrue(supplierViews.contains("MawaredTextField"))
        assertTrue(supplierViews.contains("stringResource(R.string.supplier_name)"))
        assertTrue(supplierViews.contains("stringResource(R.string.supplier_email)"))
    }
}
