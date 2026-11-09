package com.example.ui

import com.example.core.utils.AppError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * Guards the login error-message mapping (Sprint 2.1 hotfix). Wrong password
 * (HTTP 400/401) must show an invalid-credentials message, NOT the generic
 * "connection failed" text. Real network failures keep the connection message.
 */
class LoginErrorMappingTest {

    @Test
    fun `HTTP 400 invalid credentials shows invalid-credentials message`() {
        val msg = MawaredViewModel.mapLoginError(
            AppError.ServerError(400, "Invalid credentials"), Exception("Login failed: 400")
        )
        assertEquals("بيانات الدخول غير صحيحة", msg)
    }

    @Test
    fun `HTTP 401 shows invalid-credentials message`() {
        val msg = MawaredViewModel.mapLoginError(
            AppError.ServerError(401, "Unauthorized"), Exception("Login failed: 401")
        )
        assertEquals("بيانات الدخول غير صحيحة", msg)
    }

    @Test
    fun `AppError Unauthorized shows invalid-credentials message`() {
        val msg = MawaredViewModel.mapLoginError(AppError.Unauthorized, AppError.Unauthorized)
        assertEquals("بيانات الدخول غير صحيحة", msg)
    }

    @Test
    fun `HTTP 429 shows the backend Arabic rate-limit message when present`() {
        val serverMsg = "محاولات كثيرة. حاول مرة أخرى لاحقاً."
        val msg = MawaredViewModel.mapLoginError(
            AppError.ServerError(429, serverMsg), Exception("Login failed: 429")
        )
        assertEquals(serverMsg, msg)
    }

    @Test
    fun `HTTP 429 falls back to a default rate-limit message when blank`() {
        val msg = MawaredViewModel.mapLoginError(
            AppError.ServerError(429, ""), Exception("Login failed: 429")
        )
        assertEquals("محاولات كثيرة. حاول مرة أخرى لاحقاً.", msg)
    }

    @Test
    fun `HTTP 500 shows support ID when present and hides server text`() {
        val msg = MawaredViewModel.mapLoginError(
            AppError.ServerError(
                500,
                "InternalServerError",
                "a1b2c3d4-e5f6-4789-a012-3456789abcde",
            ),
            Exception("Login failed: 500"),
        )
        assertTrue(msg.contains("a1b2c3d4-e5f6-4789-a012-3456789abcde"))
        assertFalse(msg.contains("InternalServerError"))
    }

    @Test
    fun `HTTP 500 without support ID keeps generic server error text`() {
        val msg = MawaredViewModel.mapLoginError(
            AppError.ServerError(500, "Login failed"),
            Exception("Login failed: 500"),
        )
        assertEquals("حدث خطأ غير متوقع. حاول مرة أخرى لاحقاً.", msg)
    }

    @Test
    fun `network failure shows the connection-failed message`() {
        val msg = MawaredViewModel.mapLoginError(AppError.NetworkError, IOException("timeout"))
        assertEquals("فشل الاتصال بالخادم. تأكد من الاتصال والبيانات.", msg)
    }

    @Test
    fun `response parsing error shows the read-response message`() {
        val msg = MawaredViewModel.mapLoginError(
            null, com.squareup.moshi.JsonDataException("Expected a String but was NULL")
        )
        assertEquals("خطأ في قراءة استجابة الخادم", msg)
    }
}
