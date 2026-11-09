package com.example.ui.ux

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class EmployeeUxMigrationTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    @Test
    fun `employee create edit form reuses shared text and email fields`() {
        val employeeViews = File(appRoot, "src/main/java/com/example/ui/EmployeeViews.kt").readText()
        assertTrue(employeeViews.contains("MawaredScrollableForm"))
        assertTrue(employeeViews.contains("MawaredEmailField"))
        assertTrue(employeeViews.contains("MawaredTextField"))
        assertTrue(employeeViews.contains("MawaredPasswordField"))
    }
}
