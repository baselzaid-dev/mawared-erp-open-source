package com.example.core.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class AccessTokenClaimsParserTest {
    private fun token(payloadJson: String): String {
        val header = Base64.getUrlEncoder().withoutPadding()
            .encodeToString("""{"alg":"none"}""".toByteArray())
        val payload = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(payloadJson.toByteArray())
        return "$header.$payload.signature"
    }

    @Test
    fun `parses authorizationVersion and permissions from access token`() {
        val claims = AccessTokenClaimsParser.parse(
            token("""{"authorizationVersion":4,"permissions":["employees.view","hr.manage"]}""")
        )

        assertEquals(4, claims!!.authorizationVersion)
        assertEquals(setOf("employees.view", "hr.manage"), claims.permissions)
    }

    @Test
    fun `parses legitimate empty permission arrays`() {
        val claims = AccessTokenClaimsParser.parse(
            token("""{"authorizationVersion":6,"permissions":[]}""")
        )
        assertEquals(6, claims!!.authorizationVersion)
        assertTrue(claims.permissions.isEmpty())
    }

    @Test
    fun `rejects blank or malformed tokens`() {
        assertNull(AccessTokenClaimsParser.parse(null))
        assertNull(AccessTokenClaimsParser.parse(""))
        assertNull(AccessTokenClaimsParser.parse("not-a-jwt"))
        assertNull(AccessTokenClaimsParser.parse(token("""{"permissions":[]}""")))
        // Missing permissions array is malformed (fail-closed), not an empty grant set.
        assertNull(AccessTokenClaimsParser.parse(token("""{"authorizationVersion":0}""")))
    }
}
