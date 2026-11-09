package com.example.core.utils

sealed class AppResult<out T> {
    data class Success<out T>(val data: T) : AppResult<T>()
    data class Error(val exception: Exception, val appError: AppError? = null) : AppResult<Nothing>()
    object Loading : AppResult<Nothing>()
}

sealed class AppError : Exception() {
    object NetworkError : AppError()
    object Unauthorized : AppError()
    object Forbidden : AppError()
    data class ValidationError(override val message: String, val fields: Map<String, String>? = null) : AppError()
    data class ServerError(val code: Int, override val message: String, val supportRequestId: String? = null) : AppError()
    data class UnknownError(override val message: String) : AppError()
}

// TODO: Implement SessionManager, TokenManager, AuthRepository
