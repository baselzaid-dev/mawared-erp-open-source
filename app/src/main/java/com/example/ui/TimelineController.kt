package com.example.ui

import com.example.core.utils.AppResult
import com.example.domain.model.TimelineEvent
import com.example.domain.model.TimelineKind
import com.example.domain.repository.TimelineRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

enum class TimelineErrorKind {
    Unavailable,
    Failed,
    Connection
}

sealed interface TimelineUiState {
    data object Hidden : TimelineUiState

    data class Loading(val kind: TimelineKind) : TimelineUiState

    data class Content(
        val kind: TimelineKind,
        val events: List<TimelineEvent>
    ) : TimelineUiState

    data class Error(
        val kind: TimelineKind,
        val reason: TimelineErrorKind
    ) : TimelineUiState
}

/**
 * Shared timeline viewer state. Any screen opens a timeline with a kind + id;
 * one dialog rendered at the root shows it. Stale loads are dropped by
 * generation, and dismissing hides the dialog immediately.
 */
class TimelineController(
    private val repository: TimelineRepository,
    private val scope: CoroutineScope
) {
    private val _state = MutableStateFlow<TimelineUiState>(TimelineUiState.Hidden)
    val state: StateFlow<TimelineUiState> = _state.asStateFlow()

    private val generation = AtomicLong(0L)
    private var lastRequest: Pair<TimelineKind, String>? = null

    fun open(kind: TimelineKind, id: String) {
        lastRequest = kind to id
        load(kind, id)
    }

    fun retry() {
        val request = lastRequest ?: return
        load(request.first, request.second)
    }

    fun dismiss() {
        generation.incrementAndGet()
        lastRequest = null
        _state.value = TimelineUiState.Hidden
    }

    fun reset() = dismiss()

    private fun load(kind: TimelineKind, id: String) {
        val expected = generation.incrementAndGet()
        _state.value = TimelineUiState.Loading(kind)
        scope.launch {
            when (val result = repository.loadTimeline(kind, id)) {
                is AppResult.Success -> {
                    if (generation.get() != expected) return@launch
                    _state.value = TimelineUiState.Content(
                        kind = kind,
                        events = result.data.events
                    )
                }
                is AppResult.Error -> {
                    if (generation.get() != expected) return@launch
                    _state.value = TimelineUiState.Error(kind, errorKind(result))
                }
                AppResult.Loading -> Unit
            }
        }
    }

    private fun errorKind(error: AppResult.Error): TimelineErrorKind {
        val raw = error.exception.message.orEmpty()
        return when (raw) {
            "timeline.not_found" -> TimelineErrorKind.Unavailable
            "timeline.failed" -> TimelineErrorKind.Failed
            else -> TimelineErrorKind.Connection
        }
    }
}
