package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.NotificationApi
import com.example.data.remote.api.NotificationDescriptorDto
import com.example.data.remote.api.NotificationDto
import com.example.data.remote.api.NotificationErrorResponseDto
import com.example.data.remote.api.NotificationPreferenceDto
import com.example.data.remote.api.NotificationPreferencePutItemDto
import com.example.data.remote.api.NotificationPreferencesPutRequestDto
import com.example.domain.model.NotificationInboxItem
import com.example.domain.model.NotificationInboxPage
import com.example.domain.model.NotificationPreference
import com.example.domain.model.NotificationPreferenceUpdate
import com.example.domain.model.NotificationResourceTarget
import com.example.domain.repository.NotificationInboxRepository
import com.squareup.moshi.Moshi
import retrofit2.Response
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

class ApiNotificationInboxRepository(
    private val api: NotificationApi
) : NotificationInboxRepository {
    private val errorAdapter = Moshi.Builder().build().adapter(NotificationErrorResponseDto::class.java)

    override suspend fun loadInbox(
        category: String?,
        read: Boolean?,
        hidden: Boolean,
        cursor: String?,
        limit: Int?
    ): AppResult<NotificationInboxPage> = request(
        fallback = "تعذر تحميل الإشعارات",
        call = {
            api.listV2(
                category = category,
                read = read?.let { if (it) "true" else "false" },
                hidden = if (hidden) "true" else "false",
                cursor = cursor,
                limit = limit
            )
        }
    ) { response ->
        NotificationInboxPage(
            items = response.items.map { it.toDomain() },
            nextCursor = response.nextCursor,
            hasMore = response.hasMore
        )
    }

    override suspend fun markAsRead(id: String): AppResult<NotificationInboxItem> = request(
        fallback = "تعذر تعليم الإشعار كمقروء",
        call = { api.markAsReadV2(id) }
    ) { it.toDomain() }

    override suspend fun markAllRead(category: String?): AppResult<Int> = request(
        fallback = "تعذر تعليم جميع الإشعارات كمقروءة",
        call = { api.markAllReadV2(com.example.data.remote.api.NotificationReadAllRequestDto(category)) }
    ) { it.updatedCount }

    override suspend fun hide(id: String): AppResult<Unit> = requestNoBody(
        fallback = "تعذر إخفاء الإشعار",
        call = { api.hideV2(id) }
    )

    override suspend fun loadPreferences(): AppResult<List<NotificationPreference>> = request(
        fallback = "تعذر تحميل تفضيلات الإشعارات",
        call = api::getPreferencesV2
    ) { response -> response.preferences.map { it.toDomain() } }

    override suspend fun savePreferences(
        preferences: List<NotificationPreferenceUpdate>
    ): AppResult<List<NotificationPreference>> = request(
        fallback = "تعذر حفظ تفضيلات الإشعارات",
        call = {
            api.putPreferencesV2(
                NotificationPreferencesPutRequestDto(
                    preferences = preferences.map {
                        NotificationPreferencePutItemDto(
                            category = it.category,
                            inAppEnabled = it.inAppEnabled
                        )
                    }
                )
            )
        }
    ) { response -> response.preferences.map { it.toDomain() } }

    private fun NotificationDto.toDomain() = NotificationInboxItem(
        id = id,
        title = title,
        message = message,
        category = category?.trim()?.lowercase().orEmpty().ifBlank { "general" },
        isRead = isRead,
        createdAtLabel = formatCreatedAtLabel(createdAt),
        resourceTarget = descriptor?.toDomain()
    )

    private fun NotificationDescriptorDto.toDomain(): NotificationResourceTarget? {
        val normalizedRoute = routeKey.trim()
        val normalizedType = resourceType.trim()
        if (normalizedRoute.isEmpty() || normalizedType.isEmpty()) return null
        val rebuiltFilter = filterJson?.trim()?.takeIf { it.isNotEmpty() }
            ?: rebuildFilterJson(filterKey, filterValue)
        return NotificationResourceTarget(
            routeKey = normalizedRoute,
            resourceType = normalizedType,
            resourceId = resourceId?.trim()?.takeIf { it.isNotEmpty() },
            filterJson = rebuiltFilter
        )
    }

    private fun rebuildFilterJson(filterKey: String?, filterValue: String?): String? {
        val key = filterKey?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val value = filterValue?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        if (key.contains('"') || value.contains('"') || key.contains('\\') || value.contains('\\')) {
            return null
        }
        return """{"$key":"$value"}"""
    }

    private fun NotificationPreferenceDto.toDomain() = NotificationPreference(
        category = category,
        inAppEnabled = inAppEnabled,
        mandatory = mandatory
    )

    private fun formatCreatedAtLabel(iso: String): String {
        val utcPatterns = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            "yyyy-MM-dd'T'HH:mm:ss'Z'"
        )
        val parsed = utcPatterns.firstNotNullOfOrNull { pattern ->
            runCatching {
                SimpleDateFormat(pattern, Locale.US).apply {
                    timeZone = TimeZone.getTimeZone("UTC")
                }.parse(iso)
            }.getOrNull()
        }
        if (parsed == null) return iso
        return SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.forLanguageTag("ar")).format(parsed)
    }

    private fun <T> responseError(response: Response<T>, fallback: String): AppResult.Error {
        val payload = try {
            response.errorBody()?.string()?.let(errorAdapter::fromJson)
        } catch (_: Exception) {
            null
        }
        val message = payload?.messageKey?.takeIf(String::isNotBlank)
            ?: payload?.message?.takeIf(String::isNotBlank)
            ?: fallback
        val appError = when (response.code()) {
            401 -> AppError.Unauthorized
            403 -> AppError.Forbidden
            400, 404, 409, 412 -> AppError.ValidationError(message)
            else -> AppError.ServerError(response.code(), message)
        }
        return AppResult.Error(Exception(message), appError)
    }

    private suspend fun <D, T> request(
        fallback: String,
        call: suspend () -> Response<D>,
        map: (D) -> T
    ): AppResult<T> = try {
        val response = call()
        val body = response.body()
        if (response.isSuccessful && body != null) AppResult.Success(map(body))
        else responseError(response, fallback)
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    private suspend fun requestNoBody(
        fallback: String,
        call: suspend () -> Response<Map<String, Boolean>>
    ): AppResult<Unit> = try {
        val response = call()
        if (response.isSuccessful) AppResult.Success(Unit)
        else responseError(response, fallback)
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }
}
