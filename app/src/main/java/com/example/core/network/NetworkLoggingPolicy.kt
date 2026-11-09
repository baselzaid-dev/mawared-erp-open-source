package com.example.core.network

import com.example.BuildConfig
import okhttp3.logging.HttpLoggingInterceptor

/** Release-safe OkHttp logging configuration. */
object NetworkLoggingPolicy {
    val REDACTED_HEADERS = listOf(
        "Authorization",
        "Proxy-Authorization",
        "Cookie",
        "Set-Cookie",
    )

    fun createInterceptor(): HttpLoggingInterceptor =
        HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) {
                HttpLoggingInterceptor.Level.BASIC
            } else {
                HttpLoggingInterceptor.Level.NONE
            }
        }.also { interceptor ->
            REDACTED_HEADERS.forEach(interceptor::redactHeader)
        }
}
