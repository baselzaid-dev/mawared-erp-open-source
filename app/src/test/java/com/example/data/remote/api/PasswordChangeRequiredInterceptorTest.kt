package com.example.data.remote.api

import com.example.core.session.SessionManager
import com.example.domain.model.CurrentSession
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PasswordChangeRequiredInterceptorTest {
    private fun session() = CurrentSession(
        companyId = "c1",
        companyCode = "CMP-DEMO",
        companyName = "Demo",
        userId = "u1",
        employeeId = "e1",
        roleId = "r1",
        departmentId = null,
        permissions = setOf("dashboard.self"),
        token = "access",
        refreshToken = "refresh",
        mustChangePassword = false
    )

    private fun responseInterceptor(code: Int, body: String) = Interceptor { chain ->
        Response.Builder()
            .request(chain.request())
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("test")
            .body(body.toResponseBody("application/json".toMediaType()))
            .build()
    }

    @Test
    fun `password-change-required response updates the active and remembered session`() {
        val manager = SessionManager()
        manager.updateSession(session())
        val client = OkHttpClient.Builder()
            .addInterceptor(PasswordChangeRequiredInterceptor(manager))
            .addInterceptor(
                responseInterceptor(
                    403,
                    """{"code":"PasswordChangeRequired","messageKey":"auth.password_change_required"}"""
                )
            )
            .build()

        client.newCall(Request.Builder().url("https://example.test/api/v2/search").build())
            .execute()
            .close()

        assertTrue(manager.currentSession.value?.mustChangePassword == true)
        assertTrue(manager.rememberedSession.value?.mustChangePassword == true)
    }

    @Test
    fun `ordinary forbidden response does not change the local password gate`() {
        val manager = SessionManager()
        manager.updateSession(session())
        val client = OkHttpClient.Builder()
            .addInterceptor(PasswordChangeRequiredInterceptor(manager))
            .addInterceptor(responseInterceptor(403, """{"code":"Forbidden"}"""))
            .build()

        client.newCall(Request.Builder().url("https://example.test/api/v2/search").build())
            .execute()
            .close()

        assertFalse(manager.currentSession.value?.mustChangePassword == true)
    }
}
