package com.example.core.network

import com.example.core.utils.AppError
import retrofit2.Response

/** Maps HTTP failures to safe [AppError] values with optional support request IDs. */
object ApiErrorSupport {
    private val TECHNICAL_MESSAGE = Regex(
        "(?i)(exception|stacktrace|stack trace|httpurlconnection|retrofit|okhttp|prisma|postgres|sql|syntaxerror|internal server error|failed to )",
    )

    fun extractSupportRequestId(response: Response<*>, errorBody: String? = null): String? {
        SupportRequestId.fromHeaders(response.headers())?.let { return it }
        val body = errorBody ?: runCatching { response.errorBody()?.string().orEmpty() }.getOrDefault("")
        return SupportRequestId.fromErrorJson(body)
    }

    fun sanitizeUserMessage(raw: String?, fallback: String, statusCode: Int): String {
        if (raw.isNullOrBlank()) return fallback
        if (statusCode in 500..599) return fallback
        if (TECHNICAL_MESSAGE.containsMatchIn(raw)) return fallback
        if (raw.contains('<') && raw.contains('>')) return fallback
        return raw
    }

    fun mapHttpFailure(
        response: Response<*>,
        fallback: String,
        parsedMessage: String? = null,
        errorBody: String? = null,
    ): AppError {
        val body = errorBody ?: runCatching { response.errorBody()?.string().orEmpty() }.getOrDefault("")
        val supportRequestId = SupportRequestId.fromHeaders(response.headers())
            ?: SupportRequestId.fromErrorJson(body)
        val code = response.code()
        val message = sanitizeUserMessage(parsedMessage, fallback, code)
        return when (code) {
            401 -> AppError.Unauthorized
            403 -> AppError.Forbidden
            400, 409, 412, 422, 429 -> AppError.ValidationError(message)
            in 500..599 -> AppError.ServerError(code, fallback, supportRequestId)
            else -> AppError.ServerError(code, message, supportRequestId = null)
        }
    }

    fun serverError(code: Int, message: String, supportRequestId: String? = null): AppError.ServerError =
        AppError.ServerError(code, message, supportRequestId)
}
