package com.example.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class Sprint12LComposeLayoutTest {
    private val appRoot = generateSequence(
        File(System.getProperty("user.dir") ?: ".")
    ) { it.parentFile }.first { File(it, "src/main/AndroidManifest.xml").exists() }

    @Test
    fun `dense Employee and Purchasing actions remain horizontally reachable`() {
        val employees = File(
            appRoot,
            "src/main/java/com/example/ui/EmployeeViews.kt"
        ).readText()
        val purchasing = File(
            appRoot,
            "src/main/java/com/example/ui/PurchaseViews.kt"
        ).readText()

        assertTrue(employees.contains(".horizontalScroll(rememberScrollState())"))
        assertTrue(purchasing.contains(".horizontalScroll(rememberScrollState())"))
    }

    @Test
    fun `search results render a localized status chip`() {
        val search = File(
            appRoot,
            "src/main/java/com/example/ui/GlobalSearchViews.kt"
        ).readText()
        assertTrue(search.contains("MawaredStatusChip"))
        assertTrue(search.contains("globalStatusLabel(status)"))
    }
}
