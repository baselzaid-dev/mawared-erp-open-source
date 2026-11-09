package com.example.ui.ux

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MawaredUxIntegrationTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    @Test
    fun `login and mfa screens reuse shared scrollable form helpers`() {
        val authViews = File(appRoot, "src/main/java/com/example/ui/AuthViews.kt").readText()
        assertTrue(authViews.contains("MawaredScrollableForm"))
        assertTrue(authViews.contains("MawaredTextField"))
        assertTrue(authViews.contains("MawaredPasswordField"))
        assertTrue(authViews.contains("stringResource(R.string.mfa_title)"))
        assertFalse(authViews.contains("تأكيد وفتح لوحة الإدارة"))
    }

    @Test
    fun `shared ux components expose required sprint 12d building blocks`() {
        val source = File(appRoot, "src/main/java/com/example/ui/ux/MawaredUxComponents.kt").readText()
        listOf(
            "fun MawaredScrollableForm",
            "fun MawaredLoadingState",
            "fun MawaredEmptyState",
            "fun MawaredErrorState",
            "fun MawaredConfirmDialog",
            "fun MawaredUnsavedChangesDialog",
            "fun MawaredEmailField",
            "fun MawaredMoneyField",
            "fun MawaredDateField",
            "fun MawaredStatusChip"
        ).forEach { assertTrue(source.contains(it)) }
    }
}
