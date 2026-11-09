package com.example.core.auth

import com.example.core.session.SessionManager
import com.example.core.utils.AppResult
import com.example.domain.model.AuthLoginResult
import com.example.data.repository.mock.MockAuthRepository
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CompanyLoginRulesTest {
    @Test
    fun `company code normalization is locale independent`() {
        assertEquals("CMP-DEMO", CompanyLoginRules.normalizeCompanyCode(" cmp-demo "))
        assertTrue(CompanyLoginRules.isValidCompanyCode("cmp-demo"))
        assertFalse(CompanyLoginRules.isValidCompanyCode("company code"))
        assertFalse(CompanyLoginRules.isValidCompanyCode("CMP--DEMO"))
        assertFalse(CompanyLoginRules.isValidCompanyCode("CMP-"))
    }

    @Test
    fun `identifier rejects empty control and format characters`() {
        assertTrue(CompanyLoginRules.isValidIdentifier("employee-101"))
        assertFalse(CompanyLoginRules.isValidIdentifier("   "))
        assertFalse(CompanyLoginRules.isValidIdentifier("employee\u0000"))
        assertFalse(CompanyLoginRules.isValidIdentifier("employee\u200B101"))
    }

    @Test
    fun `remembered account requires matching normalized company code`() {
        assertTrue(CompanyLoginRules.matchesRememberedCompany("cmp-demo", "CMP-DEMO"))
        assertFalse(CompanyLoginRules.matchesRememberedCompany("CMP-OTHER", "CMP-DEMO"))
        assertFalse(CompanyLoginRules.matchesRememberedCompany("CMP-DEMO", null))
    }

    @Test
    fun `three fields are required and loading blocks duplicate submit`() {
        assertTrue(CompanyLoginRules.canSubmit("CMP-DEMO", "EMP-101", "password", false))
        assertFalse(CompanyLoginRules.canSubmit("", "EMP-101", "password", false))
        assertFalse(CompanyLoginRules.canSubmit("CMP-DEMO", "", "password", false))
        assertFalse(CompanyLoginRules.canSubmit("CMP-DEMO", "EMP-101", "", false))
        assertFalse(CompanyLoginRules.canSubmit("CMP-DEMO", "EMP-101", "password", true))
    }

    @Test
    fun `same identifier resolves independently in two demo companies`() = runTest {
        val repo = MockAuthRepository(SessionManager())

        val primary = repo.login("CMP-DEMO", "b.yousef@fixture-1.example.test", "1234") as AppResult.Success
        val branch = repo.login("CMP-BRANCH", "b.yousef@fixture-1.example.test", "1234") as AppResult.Success

        val primarySession = (primary.data as AuthLoginResult.Authenticated).session
        val branchSession = (branch.data as AuthLoginResult.Authenticated).session
        assertNotEquals(primarySession.companyId, branchSession.companyId)
        assertEquals("CMP-DEMO", primarySession.companyCode)
        assertEquals("CMP-BRANCH", branchSession.companyCode)
    }
}
