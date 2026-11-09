package com.example.core.auth

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class OwnerRecoveryDeepLinkTest {

    private val validToken = "A".repeat(40)
    private val recoveryHost = OwnerRecoveryDeepLink.HTTPS_HOST

    @Test
    fun `accepts the configured https host with fragment token`() {
        val uri = Uri.parse(
            "https://$recoveryHost/owner-recovery/reset#token=$validToken"
        )
        val result = OwnerRecoveryDeepLink.parse(uri)
        assertTrue(result is OwnerRecoveryDeepLink.ParseResult.Accepted)
        assertEquals(validToken, (result as OwnerRecoveryDeepLink.ParseResult.Accepted).token)
    }

    @Test
    fun `rejects unverified custom scheme with fragment token`() {
        val uri = Uri.parse("mawared://owner-recovery/reset#token=$validToken")
        val result = OwnerRecoveryDeepLink.parse(uri)
        assertEquals(OwnerRecoveryDeepLink.ParseResult.NotOwnerRecovery, result)
    }

    @Test
    fun `rejects placeholder local host`() {
        val uri = Uri.parse(
            "https://recovery.mawared.local/owner-recovery/reset#token=$validToken"
        )
        assertEquals(
            OwnerRecoveryDeepLink.ParseResult.NotOwnerRecovery,
            OwnerRecoveryDeepLink.parse(uri)
        )
    }

    @Test
    fun `rejects attacker subdomain`() {
        val uri = Uri.parse(
            "https://evil.$recoveryHost/owner-recovery/reset#token=$validToken"
        )
        assertEquals(
            OwnerRecoveryDeepLink.ParseResult.NotOwnerRecovery,
            OwnerRecoveryDeepLink.parse(uri)
        )
    }

    @Test
    fun `rejects lookalike hostname`() {
        val uri = Uri.parse(
            "https://recovery.example.invalid.evil.example/owner-recovery/reset#token=$validToken"
        )
        assertEquals(
            OwnerRecoveryDeepLink.ParseResult.NotOwnerRecovery,
            OwnerRecoveryDeepLink.parse(uri)
        )
    }

    @Test
    fun `rejects http scheme`() {
        val uri = Uri.parse(
            "http://$recoveryHost/owner-recovery/reset#token=$validToken"
        )
        assertEquals(
            OwnerRecoveryDeepLink.ParseResult.NotOwnerRecovery,
            OwnerRecoveryDeepLink.parse(uri)
        )
    }

    @Test
    fun `rejects wrong host`() {
        val uri = Uri.parse(
            "https://evil.example/owner-recovery/reset#token=$validToken"
        )
        assertEquals(
            OwnerRecoveryDeepLink.ParseResult.NotOwnerRecovery,
            OwnerRecoveryDeepLink.parse(uri)
        )
    }

    @Test
    fun `rejects wrong path purpose`() {
        val uri = Uri.parse(
            "https://$recoveryHost/platform-recovery/reset#token=$validToken"
        )
        assertEquals(
            OwnerRecoveryDeepLink.ParseResult.NotOwnerRecovery,
            OwnerRecoveryDeepLink.parse(uri)
        )
    }

    @Test
    fun `rejects unrelated custom-scheme path`() {
        val uri = Uri.parse("mawared://owner-recovery/other#token=$validToken")
        assertEquals(
            OwnerRecoveryDeepLink.ParseResult.NotOwnerRecovery,
            OwnerRecoveryDeepLink.parse(uri)
        )
    }

    @Test
    fun `rejects query token even on allowlisted https host`() {
        val uri = Uri.parse(
            "https://$recoveryHost/owner-recovery/reset?token=$validToken"
        )
        assertEquals(
            OwnerRecoveryDeepLink.ParseResult.ManualFallback,
            OwnerRecoveryDeepLink.parse(uri)
        )
    }

    @Test
    fun `malformed token falls back to manual entry`() {
        val uri = Uri.parse(
            "https://$recoveryHost/owner-recovery/reset#token=short"
        )
        assertEquals(
            OwnerRecoveryDeepLink.ParseResult.ManualFallback,
            OwnerRecoveryDeepLink.parse(uri)
        )
    }

    @Test
    fun `missing token falls back to manual entry`() {
        val uri = Uri.parse("https://$recoveryHost/owner-recovery/reset")
        assertEquals(
            OwnerRecoveryDeepLink.ParseResult.ManualFallback,
            OwnerRecoveryDeepLink.parse(uri)
        )
    }
}

class PasswordPolicyTest {
    @Test
    fun `accepts 10 to 128 without whitespace`() {
        assertTrue(PasswordPolicy.isValid("Password12"))
        assertTrue(PasswordPolicy.isValid("x".repeat(128)))
        assertFalse(PasswordPolicy.isValid("short"))
        assertFalse(PasswordPolicy.isValid("x".repeat(129)))
        assertFalse(PasswordPolicy.isValid("Password 12"))
    }
}

class OwnerRecoveryTokenRulesTest {
    @Test
    fun `token length and charset`() {
        assertTrue(OwnerRecoveryTokenRules.isValid("A".repeat(40)))
        assertTrue(OwnerRecoveryTokenRules.isValid("Ab_9-".repeat(8) + "ABCD"))
        assertFalse(OwnerRecoveryTokenRules.isValid("short"))
        assertFalse(OwnerRecoveryTokenRules.isValid("A".repeat(40) + "!"))
        assertFalse(OwnerRecoveryTokenRules.isValid("A".repeat(257)))
    }
}
