package com.example.security

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class CompanyAuthContractTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    private fun source(path: String): String = File(appRoot, path).readText()

    @Test
    fun `canonical Android login uses v2 without legacy fallback`() {
        val api = source("src/main/java/com/example/data/remote/api/ApiInterfaces.kt")
        val repository = source("src/main/java/com/example/data/remote/repository/ApiAuthRepository.kt")

        assertTrue(api.contains("@POST(\"/api/v2/auth/login\")"))
        assertFalse(api.contains("@POST(\"/api/auth/login\")"))
        assertFalse(repository.contains("/api/auth/login"))
    }

    @Test
    fun `login form has three fields keyboard safety scroll and biometric separation`() {
        val view = source("src/main/java/com/example/ui/AuthViews.kt")
        val scrollableForm = source("src/main/java/com/example/ui/ux/MawaredUxComponents.kt")

        assertTrue(view.contains("inputCompanyCode"))
        assertTrue(view.contains("inputIdentifier"))
        assertTrue(view.contains("inputPassword"))
        assertTrue(view.contains("KeyboardType.Ascii"))
        assertTrue(view.contains("KeyboardType.Text"))
        assertTrue(view.contains("MawaredScrollableForm"))
        assertTrue(scrollableForm.contains("imePadding()"))
        assertTrue(scrollableForm.contains("verticalScroll(rememberScrollState())"))
        assertTrue(view.indexOf("HorizontalDivider") < view.indexOf("OutlinedButton("))
    }

    @Test
    fun `English and Arabic company login resources stay generic`() {
        val arabic = source("src/main/res/values/strings.xml")
        val english = source("src/main/res/values-en/strings.xml")
        val combined = (english + arabic).lowercase()

        assertTrue(english.contains("company_code"))
        assertTrue(arabic.contains("company_code"))
        assertTrue(english.contains("login_identifier"))
        assertTrue(arabic.contains("login_identifier"))
        assertFalse(combined.contains("company not found"))
        assertFalse(combined.contains("email exists in another company"))
    }

    @Test
    fun `encrypted remembered session binds company without storing password`() {
        val store = source("src/main/java/com/example/core/session/EncryptedSessionStore.kt")

        assertTrue(store.contains("json.put(\"companyId\""))
        assertTrue(store.contains("json.put(\"companyCode\""))
        assertTrue(store.contains("json.put(\"companyName\""))
        assertFalse(store.contains("json.put(\"password\""))
    }

    @Test
    fun `production MFA uses backend enrollment and verification without biometric bypass`() {
        val api = source("src/main/java/com/example/data/remote/api/ApiInterfaces.kt")
        val repository = source("src/main/java/com/example/data/remote/repository/ApiAuthRepository.kt")
        val viewModel = source("src/main/java/com/example/ui/MawaredViewModel.kt")
        val store = source("src/main/java/com/example/core/session/EncryptedSessionStore.kt")
        val manager = source("src/main/java/com/example/core/session/SessionManager.kt")

        assertTrue(api.contains("@POST(\"/api/v2/auth/mfa/enroll/start\")"))
        assertTrue(api.contains("@POST(\"/api/v2/auth/mfa/enroll/confirm\")"))
        assertTrue(api.contains("@POST(\"/api/v2/auth/mfa/verify\")"))
        assertTrue(repository.contains("AuthLoginResult.MfaChallenge"))
        assertTrue(viewModel.contains("authRepository.confirmMfaEnrollment"))
        assertTrue(viewModel.contains("authRepository.verifyMfa"))
        assertTrue(viewModel.contains("if (session.mfaProtected)"))
        assertTrue(store.contains("json.put(\"mfaProtected\""))
        assertTrue(store.contains("if (json.has(\"mfaProtected\"))"))
        assertTrue(manager.contains("if (remembered.mfaProtected) return null"))
        assertFalse(viewModel.contains("local MFA simulation is disabled"))
    }

    @Test
    fun `company and user switch clears every company scoped repository`() {
        val viewModel = source("src/main/java/com/example/ui/MawaredViewModel.kt")
        val repositories = listOf(
            "employeeRepository",
            "attendanceRepository",
            "leaveRepository",
            "payrollRepository",
            "purchaseRepository",
            "supplierRepository",
            "taskRepository"
        )

        assertTrue(viewModel.contains("\"\${it.companyId}:\${it.userId}\""))
        repositories.forEach { repository ->
            assertTrue("$repository must be cleared on identity change", viewModel.contains("$repository.clear()"))
        }
        assertTrue(viewModel.contains("resetCompanyScopedDataIfNeeded(null)"))
    }
}
