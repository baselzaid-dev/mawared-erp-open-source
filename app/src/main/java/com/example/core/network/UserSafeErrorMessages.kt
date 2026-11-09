package com.example.core.network

/** Localized, user-safe support error text. IDs are never persisted by this helper. */
object UserSafeErrorMessages {
    fun unexpectedServerError(supportRequestId: String?, arabic: Boolean = true): String {
        if (!supportRequestId.isNullOrBlank()) {
            return if (arabic) {
                "حدث خطأ غير متوقع. رمز الدعم: $supportRequestId"
            } else {
                "An unexpected error occurred. Support ID: $supportRequestId"
            }
        }
        return if (arabic) {
            "حدث خطأ غير متوقع. حاول مرة أخرى لاحقاً."
        } else {
            "An unexpected error occurred. Try again later."
        }
    }

    fun appendSupportId(baseMessage: String, supportRequestId: String?, arabic: Boolean = true): String {
        if (supportRequestId.isNullOrBlank()) return baseMessage
        return if (arabic) {
            "$baseMessage رمز الدعم: $supportRequestId"
        } else {
            "$baseMessage Support ID: $supportRequestId"
        }
    }

    fun shouldExposeSupportId(statusCode: Int): Boolean = statusCode >= 500
}
