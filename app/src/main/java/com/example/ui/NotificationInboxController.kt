package com.example.ui

import com.example.core.utils.AppResult
import com.example.domain.model.NotificationInboxItem
import com.example.domain.model.NotificationPreference
import com.example.domain.model.NotificationPreferenceUpdate
import com.example.domain.model.NotificationResourceTarget
import com.example.domain.repository.NotificationInboxRepository
import com.example.ui.navigation.ResourceDescriptor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

val NotificationInboxItem.resourceDescriptor: ResourceDescriptor?
    get() = resourceTarget?.toResourceDescriptor()

fun NotificationResourceTarget.toResourceDescriptor(): ResourceDescriptor =
    ResourceDescriptor.parse(
        routeKey = routeKey,
        resourceType = resourceType,
        resourceId = resourceId,
        filterJson = filterJson
    )

/**
 * State machine for Notification Center inbox wiring. Keeps loading/refresh/empty/error
 * transitions testable without touching MawaredViewModel.
 */
class NotificationInboxController(
    private val repository: NotificationInboxRepository,
    private val scope: CoroutineScope,
    private val onNavigate: (ResourceDescriptor?) -> Unit = {},
    private val onOpenPreferencesScreen: () -> Unit = {}
) : NotificationCenterActions {
    private val _state = MutableStateFlow<NotificationCenterUiState>(NotificationCenterUiState.Loading)
    val state: StateFlow<NotificationCenterUiState> = _state.asStateFlow()

    private val _preferences = MutableStateFlow<List<NotificationPreference>?>(null)
    val preferences: StateFlow<List<NotificationPreference>?> = _preferences.asStateFlow()

    private val _preferencesError = MutableStateFlow<String?>(null)
    val preferencesError: StateFlow<String?> = _preferencesError.asStateFlow()

    private val parentJob = scope.coroutineContext[Job]
    private var sessionJob = SupervisorJob(parentJob)
    private var sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)

    private var selectedCategory: String? = null
    private var cachedItems: List<NotificationInboxItem> = emptyList()
    private var hasLoadedOnce = false
    private val lifecycleEpoch = AtomicLong(0L)
    private val refreshGeneration = AtomicLong(0L)

    fun reset() {
        lifecycleEpoch.incrementAndGet()
        refreshGeneration.incrementAndGet()
        sessionJob.cancel()
        sessionJob = SupervisorJob(parentJob)
        sessionScope = CoroutineScope(scope.coroutineContext + sessionJob)
        selectedCategory = null
        cachedItems = emptyList()
        hasLoadedOnce = false
        _state.value = NotificationCenterUiState.Loading
        _preferences.value = null
        _preferencesError.value = null
    }

    fun load() {
        refresh()
    }

    fun refresh() {
        startRefresh(lifecycleEpoch.get())
    }

    fun loadPreferences() {
        val epoch = lifecycleEpoch.get()
        sessionScope.launch {
            when (val result = repository.loadPreferences()) {
                is AppResult.Success -> {
                    if (isCurrent(epoch)) {
                        _preferences.value = result.data
                        _preferencesError.value = null
                    }
                }
                is AppResult.Error -> {
                    if (isCurrent(epoch)) {
                        _preferencesError.value = errorText(result)
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    fun savePreferences(updates: List<NotificationPreferenceUpdate>) {
        val epoch = lifecycleEpoch.get()
        sessionScope.launch {
            when (val result = repository.savePreferences(updates)) {
                is AppResult.Success -> {
                    if (isCurrent(epoch)) {
                        _preferences.value = result.data
                        _preferencesError.value = null
                    }
                }
                is AppResult.Error -> {
                    if (isCurrent(epoch)) {
                        _preferencesError.value = errorText(result)
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    override fun onRetry() {
        refresh()
    }

    override fun onCategorySelected(category: String?) {
        selectedCategory = category
        publishContentState()
    }

    override fun onNotificationClick(notificationId: String, descriptor: ResourceDescriptor?) {
        onNavigate(descriptor)
    }

    override fun onOpenPreferences() {
        onOpenPreferencesScreen()
    }

    override fun onMarkRead(notificationId: String) {
        val epoch = lifecycleEpoch.get()
        sessionScope.launch {
            when (val result = repository.markAsRead(notificationId)) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    cachedItems = cachedItems.map { item ->
                        if (item.id == notificationId) result.data else item
                    }
                    publishContentState()
                }
                is AppResult.Error -> {
                    if (isCurrent(epoch)) {
                        _state.value = NotificationCenterUiState.Error(errorText(result))
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    override fun onHide(notificationId: String) {
        val epoch = lifecycleEpoch.get()
        sessionScope.launch {
            when (val result = repository.hide(notificationId)) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    cachedItems = cachedItems.filterNot { it.id == notificationId }
                    publishContentState()
                }
                is AppResult.Error -> {
                    if (isCurrent(epoch)) {
                        _state.value = NotificationCenterUiState.Error(errorText(result))
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    override fun onMarkAllRead(category: String?) {
        val epoch = lifecycleEpoch.get()
        sessionScope.launch {
            when (val result = repository.markAllRead(category)) {
                is AppResult.Success -> {
                    if (!isCurrent(epoch)) return@launch
                    val normalizedCategory = category?.lowercase()
                    cachedItems = cachedItems.map { item ->
                        val matches = normalizedCategory == null || item.category == normalizedCategory
                        if (matches) item.copy(isRead = true) else item
                    }
                    publishContentState()
                }
                is AppResult.Error -> {
                    if (isCurrent(epoch)) {
                        _state.value = NotificationCenterUiState.Error(errorText(result))
                    }
                }
                AppResult.Loading -> Unit
            }
        }
    }

    private fun startRefresh(epoch: Long) {
        if (!isCurrent(epoch)) return
        val generation = refreshGeneration.incrementAndGet()
        if (!hasLoadedOnce) {
            _state.value = NotificationCenterUiState.Loading
        }
        sessionScope.launch {
            if (!isCurrentRefresh(epoch, generation)) return@launch
            when (val result = repository.loadInbox(category = null, hidden = false)) {
                is AppResult.Success -> {
                    if (!isCurrentRefresh(epoch, generation)) return@launch
                    cachedItems = result.data.items
                    hasLoadedOnce = true
                    publishContentState()
                }
                is AppResult.Error -> {
                    if (!isCurrentRefresh(epoch, generation)) return@launch
                    _state.value = NotificationCenterUiState.Error(errorText(result))
                }
                AppResult.Loading -> Unit
            }
        }
    }

    private fun publishContentState() {
        val filtered = filterItems(cachedItems, selectedCategory)
        _state.value = when {
            cachedItems.isEmpty() && selectedCategory == null -> NotificationCenterUiState.Empty
            else -> NotificationCenterUiState.Content(
                items = filtered,
                selectedCategory = selectedCategory
            )
        }
    }

    private fun filterItems(
        items: List<NotificationInboxItem>,
        category: String?
    ): List<NotificationInboxItem> {
        if (category == null) return items
        return items.filter { it.category == category.lowercase() }
    }

    private fun isCurrent(epoch: Long): Boolean = lifecycleEpoch.get() == epoch

    private fun isCurrentRefresh(epoch: Long, generation: Long): Boolean =
        isCurrent(epoch) && refreshGeneration.get() == generation

    private fun errorText(error: AppResult.Error): String {
        val raw = error.exception.message.orEmpty()
        return when (raw) {
            "notification.not_found" -> "الإشعار غير متاح أو تمت إزالته."
            "notification.invalid_request" -> "طلب غير صالح. حدّث الشاشة ثم أعد المحاولة."
            "notification.unauthorized" -> "يلزم تسجيل الدخول مجددًا."
            else -> raw.takeIf { it.isNotBlank() } ?: "تعذر إكمال العملية. تحقق من الاتصال وأعد المحاولة."
        }
    }
}
