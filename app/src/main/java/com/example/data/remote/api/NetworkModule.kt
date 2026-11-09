package com.example.data.remote.api

import com.example.BuildConfig
import com.example.core.session.SessionManager
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import com.example.core.network.NetworkLoggingPolicy
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.util.concurrent.TimeUnit

object NetworkModule {

    private val moshi = Moshi.Builder()
        .add(KotlinJsonAdapterFactory())
        .build()

    /**
     * Blocking refresh call used by [TokenAuthenticator]. Uses a bare OkHttp
     * client (no auth interceptor / no authenticator) to avoid recursion.
     * Never logs the tokens.
     */
    private fun buildRefreshCall(): (String) -> RefreshedTokens? {
        val bareClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
        val jsonMedia = "application/json; charset=utf-8".toMediaType()
        val refreshUrl = BuildConfig.API_BASE_URL.trimEnd('/') + "/api/auth/refresh"

        return { refreshToken ->
            try {
                val body = JSONObject().put("refreshToken", refreshToken)
                    .toString()
                    .toRequestBody(jsonMedia)
                val request = Request.Builder().url(refreshUrl).post(body).build()
                bareClient.newCall(request).execute().use { resp ->
                    if (!resp.isSuccessful) {
                        null
                    } else {
                        val json = JSONObject(resp.body?.string().orEmpty())
                        val access = json.optString("token", "")
                        if (access.isEmpty()) null
                        else RefreshedTokens(
                            accessToken = access,
                            refreshToken = json.optString("refreshToken", "").ifEmpty { null },
                            mustChangePassword = json.optBoolean("mustChangePassword", false)
                        )
                    }
                }
            } catch (e: Exception) {
                null
            }
        }
    }

    fun provideRetrofit(sessionManager: SessionManager): Retrofit {
        val loggingInterceptor = NetworkLoggingPolicy.createInterceptor()

        val authInterceptor = Interceptor { chain ->
            val requestBuilder = chain.request().newBuilder()
            val session = sessionManager.currentSession.value

            session?.token?.let { token ->
                requestBuilder.addHeader("Authorization", "Bearer $token")
            }

            chain.proceed(requestBuilder.build())
        }

        val client = OkHttpClient.Builder()
            .addInterceptor(loggingInterceptor)
            .addInterceptor(authInterceptor)
            .addInterceptor(PasswordChangeRequiredInterceptor(sessionManager))
            // 401 → one refresh attempt → one retry; then clean logout state.
            .authenticator(TokenAuthenticator(sessionManager, buildRefreshCall()))
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()

        return Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL)
            .client(client)
            .addConverterFactory(MoshiConverterFactory.create(moshi))
            .build()
    }
}
