package com.example.ui

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AuthorizationLifecycleIntegrationTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    private fun viewModelSource(): String =
        File(appRoot, "src/main/java/com/example/ui/MawaredViewModel.kt").readText()

    @Test
    fun `identity boundary resets authorization before company repositories`() {
        val boundary = viewModelSource()
            .substringAfter("private fun resetCompanyScopedDataIfNeeded(")
            .substringBefore("// ---------------- AUTHENTICATION OPERATIONS")

        val controllerBind = boundary.indexOf("authorizationSessionController.bindSession(session)")
        val authorizationReset = boundary.indexOf("authorization.reset()")
        val firstRepositoryClear = boundary.indexOf("employeeRepository.clear()")

        assertTrue(controllerBind >= 0)
        assertTrue(authorizationReset > controllerBind)
        assertTrue(firstRepositoryClear > authorizationReset)
    }

    @Test
    fun `logout enters the same identity boundary`() {
        val logout = viewModelSource()
            .substringAfter("fun logOut()")
            .substringBefore("// ---------------- DATA FLOWS FROM REPOSITORY")

        assertTrue(logout.contains("resetCompanyScopedDataIfNeeded(null)"))
    }

    @Test
    fun `same identity authorization soft refresh is wired`() {
        val source = viewModelSource()
        assertTrue(source.contains("authorization.onEffectiveAuthorizationLoaded"))
        assertTrue(source.contains("syncSessionAuthorizationFromEffective"))
        assertTrue(source.contains("fun refreshAuthorizationForCurrentSession"))
        assertTrue(source.contains("updateAuthorizationSnapshot"))
        assertTrue(source.contains("refreshAuthorizationForCurrentSession()"))
    }
}
