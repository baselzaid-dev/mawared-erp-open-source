package com.example.ui.ux

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class EmployeeAuthUxIntegrationTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    @Test
    fun `employee views keep 12C authority gates and 12D shared UX forms`() {
        val source = File(appRoot, "src/main/java/com/example/ui/EmployeeViews.kt").readText()
        assertTrue(source.contains("MawaredScrollableForm"))
        assertTrue(source.contains("MawaredTextField"))
        assertTrue(source.contains("MawaredEmailField"))
        assertTrue(source.contains("MawaredPasswordField"))
        assertTrue(source.contains("canChangeRole"))
        assertTrue(source.contains("canManageManager"))
        assertTrue(source.contains("employeeRoleIdForSubmission"))
        assertTrue(source.contains("canChangeRoles"))
        assertTrue(source.contains("canManageDepartmentManagers"))
    }
}
