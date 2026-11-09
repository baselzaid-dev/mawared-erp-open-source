package com.example.ui

import com.example.core.utils.AppResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Temporary preference models for the preferences UI. Domain types live in
 * [com.example.domain.model.NotificationPreference]; use
 * [NotificationInboxRepository.asNotificationPreferencesRepository] for real wiring.
 */
data class NotificationPreferenceItem(
    val category: String,
    val inAppEnabled: Boolean,
    val mandatory: Boolean
)

/**
 * UI-facing preference repository contract. Production wiring adapts
 * [com.example.domain.repository.NotificationInboxRepository].
 */
interface NotificationPreferencesRepository {
    suspend fun getPreferences(): AppResult<List<NotificationPreferenceItem>>
    suspend fun updatePreferences(
        preferences: List<NotificationPreferenceItem>
    ): AppResult<List<NotificationPreferenceItem>>
}

fun com.example.domain.repository.NotificationInboxRepository.asNotificationPreferencesRepository(): NotificationPreferencesRepository =
    object : NotificationPreferencesRepository {
        override suspend fun getPreferences(): AppResult<List<NotificationPreferenceItem>> =
            when (val result = loadPreferences()) {
                is AppResult.Success -> AppResult.Success(
                    result.data.map {
                        NotificationPreferenceItem(it.category, it.inAppEnabled, it.mandatory)
                    }
                )
                is AppResult.Error -> result
                AppResult.Loading -> AppResult.Loading
            }

        override suspend fun updatePreferences(
            preferences: List<NotificationPreferenceItem>
        ): AppResult<List<NotificationPreferenceItem>> =
            when (
                val result = savePreferences(
                    preferences.map {
                        com.example.domain.model.NotificationPreferenceUpdate(
                            category = it.category,
                            inAppEnabled = it.inAppEnabled
                        )
                    }
                )
            ) {
                is AppResult.Success -> AppResult.Success(
                    result.data.map {
                        NotificationPreferenceItem(it.category, it.inAppEnabled, it.mandatory)
                    }
                )
                is AppResult.Error -> result
                AppResult.Loading -> AppResult.Loading
            }
    }

enum class NotificationPreferencesSaveState {
    Idle,
    Saving,
    Saved,
    Failed
}

data class NotificationPreferencesContentState(
    val items: List<NotificationPreferenceItem>,
    val persistedItems: List<NotificationPreferenceItem>,
    val isDirty: Boolean,
    val saveState: NotificationPreferencesSaveState,
    val saveErrorMessage: String? = null
)

sealed interface NotificationPreferencesUiState {
    data object Loading : NotificationPreferencesUiState

    data class Error(val message: String) : NotificationPreferencesUiState

    data class Content(
        val content: NotificationPreferencesContentState
    ) : NotificationPreferencesUiState
}

/**
 * Loads and persists in-app notification category toggles.
 * Save feedback reflects real API outcomes — no optimistic success.
 */
class NotificationPreferencesController(
    private val repository: NotificationPreferencesRepository,
    private val scope: CoroutineScope
) {
    private val _state = MutableStateFlow<NotificationPreferencesUiState>(
        NotificationPreferencesUiState.Loading
    )
    val state: StateFlow<NotificationPreferencesUiState> = _state.asStateFlow()

    fun load() {
        scope.launch {
            _state.value = NotificationPreferencesUiState.Loading
            when (val result = repository.getPreferences()) {
                is AppResult.Success -> {
                    val items = normalizeItems(result.data)
                    _state.value = NotificationPreferencesUiState.Content(
                        content = NotificationPreferencesContentState(
                            items = items,
                            persistedItems = items,
                            isDirty = false,
                            saveState = NotificationPreferencesSaveState.Idle
                        )
                    )
                }

                is AppResult.Error -> {
                    _state.value = NotificationPreferencesUiState.Error(
                        message = preferenceErrorText(result)
                    )
                }

                AppResult.Loading -> Unit
            }
        }
    }

    fun retry() = load()

    fun toggleCategory(category: String, enabled: Boolean) {
        val current = _state.value as? NotificationPreferencesUiState.Content ?: return
        val target = current.content.items.firstOrNull { it.category == category } ?: return
        if (target.mandatory || target.inAppEnabled == enabled) return

        val updatedItems = current.content.items.map { item ->
            if (item.category == category) item.copy(inAppEnabled = enabled) else item
        }
        val isDirty = updatedItems != current.content.persistedItems

        _state.value = current.copy(
            content = current.content.copy(
                items = updatedItems,
                isDirty = isDirty,
                saveState = NotificationPreferencesSaveState.Idle,
                saveErrorMessage = null
            )
        )
    }

    fun save() {
        val current = _state.value as? NotificationPreferencesUiState.Content ?: return
        if (!current.content.isDirty ||
            current.content.saveState == NotificationPreferencesSaveState.Saving
        ) {
            return
        }

        val draftSnapshot = current.content.items
        _state.value = current.copy(
            content = current.content.copy(
                saveState = NotificationPreferencesSaveState.Saving,
                saveErrorMessage = null
            )
        )

        scope.launch {
            when (val result = repository.updatePreferences(draftSnapshot)) {
                is AppResult.Success -> {
                    val persisted = normalizeItems(result.data)
                    _state.update { state ->
                        if (state !is NotificationPreferencesUiState.Content) return@update state
                        NotificationPreferencesUiState.Content(
                            content = NotificationPreferencesContentState(
                                items = persisted,
                                persistedItems = persisted,
                                isDirty = false,
                                saveState = NotificationPreferencesSaveState.Saved
                            )
                        )
                    }
                }

                is AppResult.Error -> {
                    _state.update { state ->
                        val contentState = state as? NotificationPreferencesUiState.Content
                            ?: return@update state
                        NotificationPreferencesUiState.Content(
                            content = contentState.content.copy(
                                items = draftSnapshot,
                                persistedItems = contentState.content.persistedItems,
                                isDirty = true,
                                saveState = NotificationPreferencesSaveState.Failed,
                                saveErrorMessage = preferenceErrorText(result)
                            )
                        )
                    }
                }

                AppResult.Loading -> Unit
            }
        }
    }

    fun dismissSaveFeedback() {
        val current = _state.value as? NotificationPreferencesUiState.Content ?: return
        if (current.content.saveState == NotificationPreferencesSaveState.Saving) return

        _state.value = current.copy(
            content = current.content.copy(
                saveState = NotificationPreferencesSaveState.Idle,
                saveErrorMessage = null
            )
        )
    }

    private fun normalizeItems(items: List<NotificationPreferenceItem>): List<NotificationPreferenceItem> =
        items.map { item ->
            if (item.mandatory) item.copy(inAppEnabled = true) else item
        }

    private fun preferenceErrorText(error: AppResult.Error): String {
        val raw = error.exception.message.orEmpty()
        return when (raw) {
            "notification.mandatory_category" ->
                "لا يمكن إيقاف إشعارات الأمان؛ هذه الفئة إلزامية."
            "notification.invalid_request" ->
                "طلب غير صالح. راجع الإعدادات ثم أعد المحاولة."
            "notification.unauthorized" ->
                "انتهت الجلسة. سجّل الدخول مجددًا ثم أعد المحاولة."
            else -> raw.takeIf { it.isNotBlank() }
                ?: "تعذر حفظ إعدادات الإشعارات. تحقق من الاتصال وأعد المحاولة."
        }
    }
}
