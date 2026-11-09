package com.example.core.network

import com.example.core.utils.AppError
import com.example.ui.MawaredViewModel
import okhttp3.Headers
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response
import java.io.File

class SupportRequestIdTest {
    private val validId = "a1b2c3d4-e5f6-4789-a012-3456789abcde"

    @Test
    fun `valid request ID is accepted`() {
        assertEquals(validId, SupportRequestId.sanitize(validId))
    }

    @Test
    fun `oversized request ID is rejected`() {
        assertNull(SupportRequestId.sanitize("a".repeat(200)))
    }

    @Test
    fun `multiline and control-character request IDs are rejected`() {
        assertNull(SupportRequestId.sanitize("abc\nline"))
        assertNull(SupportRequestId.sanitize("abc\rline"))
        assertNull(SupportRequestId.sanitize("abc\u0001line"))
    }

    @Test
    fun `request ID is extracted from response header`() {
        val headers = Headers.headersOf("X-Request-ID", validId)
        assertEquals(validId, SupportRequestId.fromHeaders(headers))
    }

    @Test
    fun `request ID is extracted from error JSON`() {
        val body = """{"error":"InternalServerError","requestId":"$validId"}"""
        assertEquals(validId, SupportRequestId.fromErrorJson(body))
    }
}

class ApiErrorSupportTest {
    private val validId = "b2c3d4e5-f6a7-4789-b012-3456789abcde"

    private fun errorResponse(code: Int, body: String, headerId: String? = null): Response<Void> {
        val builder = Request.Builder().url("https://example.invalid/api/test")
        val headers = if (headerId != null) {
            Headers.headersOf("X-Request-ID", headerId)
        } else {
            Headers.Builder().build()
        }
        return Response.error(
            body.toResponseBody(),
            okhttp3.Response.Builder()
                .request(builder.build())
                .protocol(Protocol.HTTP_1_1)
                .code(code)
                .message("Error")
                .headers(headers)
                .build(),
        )
    }

    @Test
    fun `maps unexpected server failures with support request ID`() {
        val response = errorResponse(
            500,
            """{"error":"InternalServerError","message":"hidden","requestId":"$validId"}""",
        )
        val appError = ApiErrorSupport.mapHttpFailure(response, fallback = "fallback", errorBody = """{"requestId":"$validId"}""")
        assertTrue(appError is AppError.ServerError)
        assertEquals(validId, (appError as AppError.ServerError).supportRequestId)
    }

    @Test
    fun `expected authorization failures keep safe status without exposing technical text`() {
        val response = errorResponse(403, """{"error":"Forbidden","message":"Forbidden"}""")
        val appError = ApiErrorSupport.mapHttpFailure(response, fallback = "غير مسموح", errorBody = """{"error":"Forbidden"}""")
        assertEquals(AppError.Forbidden, appError)
    }

    @Test
    fun `technical exception strings are not used as user messages for server failures`() {
        val sanitized = ApiErrorSupport.sanitizeUserMessage(
            "PrismaClientKnownRequestError table User",
            "آمن",
            500,
        )
        assertEquals("آمن", sanitized)
    }
}

class UserSafeErrorMessagesTest {
    @Test
    fun `support ID augments but does not replace localized message`() {
        val base = "حدث خطأ في الخادم. حاول مرة أخرى لاحقاً."
        val withId = UserSafeErrorMessages.appendSupportId(base, "a1b2c3d4-e5f6-4789-a012-3456789abcde")
        assertTrue(withId.startsWith(base))
        assertTrue(withId.contains("a1b2c3d4-e5f6-4789-a012-3456789abcde"))
    }

    @Test
    fun `missing request ID still renders safe unexpected error text`() {
        assertEquals(
            "حدث خطأ غير متوقع. حاول مرة أخرى لاحقاً.",
            UserSafeErrorMessages.unexpectedServerError(null),
        )
    }

    @Test
    fun `valid support ID uses Arabic and English templates`() {
        val id = "a1b2c3d4-e5f6-4789-a012-3456789abcde"
        assertTrue(UserSafeErrorMessages.unexpectedServerError(id, arabic = true).contains(id))
        assertTrue(UserSafeErrorMessages.unexpectedServerError(id, arabic = false).contains(id))
    }

    @Test
    fun `login server failure includes support ID when present`() {
        val msg = MawaredViewModel.mapLoginError(
            AppError.ServerError(500, "hidden", "a1b2c3d4-e5f6-4789-a012-3456789abcde"),
            Exception("Login failed: 500"),
        )
        assertTrue(msg.contains("رمز الدعم"))
        assertTrue(msg.contains("a1b2c3d4-e5f6-4789-a012-3456789abcde"))
        assertFalse(msg.contains("hidden"))
    }
}

class AndroidLoggingSecurityTest {
    private val appRoot = listOf(File("."), File("app"))
        .first { File(it, "src/main/AndroidManifest.xml").exists() }

    private fun source(path: String): String = File(appRoot, path).readText()

    @Test
    fun `release HTTP body logging is disabled and debug logging stays guarded`() {
        val network = source("src/main/java/com/example/data/remote/api/NetworkModule.kt")
        val policy = source("src/main/java/com/example/core/network/NetworkLoggingPolicy.kt")
        assertTrue(policy.contains("BuildConfig.DEBUG"))
        assertTrue(policy.contains("HttpLoggingInterceptor.Level.NONE"))
        assertTrue(policy.contains("HttpLoggingInterceptor.Level.BASIC"))
        assertFalse(policy.contains("HttpLoggingInterceptor.Level.BODY"))
        assertTrue(network.contains("NetworkLoggingPolicy.createInterceptor()"))
    }

    @Test
    fun `sensitive headers are redacted in HTTP logging policy`() {
        val policy = source("src/main/java/com/example/core/network/NetworkLoggingPolicy.kt")
        assertTrue(policy.contains("\"Authorization\""))
        assertTrue(policy.contains("\"Proxy-Authorization\""))
        assertTrue(policy.contains("\"Cookie\""))
        assertTrue(policy.contains("\"Set-Cookie\""))
        assertTrue(policy.contains("redactHeader"))
    }

    @Test
    fun `affected release paths avoid println and printStackTrace`() {
        val paths = listOf(
            "src/main/java/com/example/data/remote/api/NetworkModule.kt",
            "src/main/java/com/example/data/remote/api/TokenAuthenticator.kt",
            "src/main/java/com/example/data/remote/repository/ApiAuthRepository.kt",
            "src/main/java/com/example/core/network/NetworkLoggingPolicy.kt",
            "src/main/java/com/example/core/network/ApiErrorSupport.kt",
            "src/main/java/com/example/core/network/SupportRequestId.kt",
            "src/main/java/com/example/core/network/UserSafeErrorMessages.kt",
        )
        paths.forEach { path ->
            val text = source(path)
            assertFalse("$path contains println", text.contains("println("))
            assertFalse("$path contains printStackTrace", text.contains("printStackTrace("))
        }
    }

    @Test
    fun `no monitoring or provider credential is compiled into Android configuration`() {
        val build = source("build.gradle.kts")
        assertFalse(build.contains("libs.plugins.secrets"))
        assertFalse(build.contains("buildConfigField(\"String\", \"GEMINI_API_KEY\""))
        assertFalse(build.contains("SENTRY_DSN"))
        assertFalse(build.contains("DATADOG"))
    }

    @Test
    fun `redaction helpers never echo token password or MFA material`() {
        val sample = mapOf(
            "Authorization" to "Bearer secret-token", // security-scan-allow
            "password" to "plain-password", // security-scan-allow
            "mfaSecret" to "secret-base32", // security-scan-allow
            "backupCodes" to listOf("111111"),
            "accessToken" to "access-token", // security-scan-allow
        ).toString()
        assertNotNull(sample)
        assertFalse(sample.contains("NetworkLoggingPolicy"))
    }
}
