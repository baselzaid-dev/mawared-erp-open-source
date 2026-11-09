package com.example.security

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Source-level contract checks for Credential Recovery Package E6 (Android company plane).
 */
class OwnerRecoveryAndroidContractTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    private fun source(path: String): String = File(appRoot, path).readText()

    @Test
    fun `manifest allowlists only the configured HTTPS recovery path`() {
        val manifest = source("src/main/AndroidManifest.xml")
        assertTrue(manifest.contains("android:host=\"\${ownerRecoveryHost}\""))
        assertTrue(manifest.contains("android:path=\"/owner-recovery/reset\""))
        assertTrue(manifest.contains("android:autoVerify=\"true\""))
        assertFalse(manifest.contains("android:scheme=\"mawared\""))
        assertFalse(manifest.contains("android:host=\"recovery.mawared.local\""))
        assertFalse(manifest.contains("android:pathPrefix=\"/\""))
        assertFalse(manifest.contains("android:host=\"*\""))
        assertFalse(manifest.contains("/api/platform"))
    }

    @Test
    fun `auth api exposes company owner recovery only`() {
        val api = source("src/main/java/com/example/data/remote/api/ApiInterfaces.kt")
        assertTrue(api.contains("@POST(\"/api/v2/auth/owner-recovery/initiate\")"))
        assertTrue(api.contains("@POST(\"/api/v2/auth/owner-recovery/confirm\")"))
        assertFalse(api.contains("/api/platform/v1/auth/recovery"))
        assertFalse(api.contains("platform_principal"))
    }

    @Test
    fun `login offers forgot owner password and recovery screens exist`() {
        val authViews = source("src/main/java/com/example/ui/AuthViews.kt")
        val main = source("src/main/java/com/example/ui/MawaredViews.kt")
        val controller = source("src/main/java/com/example/ui/OwnerRecoveryController.kt")
        assertTrue(authViews.contains("openOwnerForgotPassword"))
        assertTrue(main.contains("OwnerForgotPasswordScreen"))
        assertTrue(main.contains("OwnerResetConfirmScreen"))
        assertTrue(controller.contains("resetTokenInMemory"))
        assertFalse(controller.contains("savedStateHandle"))
        assertFalse(controller.contains("SavedStateHandle("))
    }

    @Test
    fun `dashboard stays gated while mustChangePassword`() {
        val main = source("src/main/java/com/example/ui/MawaredViews.kt")
        assertTrue(main.contains("mustChangePassword"))
        assertTrue(main.contains("ForcedPasswordChangeScreen"))
        assertTrue(
            main.indexOf("ForcedPasswordChangeScreen") <
                main.indexOf("MawaredAppDashboardContent")
        )
    }

    @Test
    fun `employee reset blocks primary owner and clears one-time secret`() {
        val rules = source("src/main/java/com/example/ui/EmployeeCredentialActions.kt")
        val dialogs = source("src/main/java/com/example/ui/EmployeeCredentialDialogs.kt")
        val views = source("src/main/java/com/example/ui/EmployeeViews.kt")
        assertTrue(rules.contains("isPrimaryOwnerTarget"))
        assertTrue(rules.contains("!isPrimaryOwnerTarget"))
        assertTrue(views.contains("isPrimaryOwnerTarget = ownerTarget"))
        assertTrue(dialogs.contains("لن تظهر مرة أخرى"))
        assertTrue(dialogs.contains("revealedPassword = \"\""))
    }

    @Test
    fun `english and arabic recovery strings stay generic`() {
        val arabic = source("src/main/res/values/strings.xml")
        val english = source("src/main/res/values-en/strings.xml")
        val combined = (english + arabic).lowercase()
        assertTrue(english.contains("owner_recovery_initiate_accepted"))
        assertTrue(arabic.contains("owner_recovery_initiate_accepted"))
        assertFalse(combined.contains("owner account not found"))
        assertFalse(combined.contains("email does not exist"))
    }
}
