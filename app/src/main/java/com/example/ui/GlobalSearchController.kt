package com.example.ui

import com.example.core.utils.AppResult
import com.example.domain.model.GlobalSearchResult
import com.example.domain.model.GlobalSearchRules
import com.example.domain.repository.GlobalSearchRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

enum class GlobalSearchErrorKind {
    QueryLength,
    InvalidRequest,
    Failed,
    Connection
}

sealed interface GlobalSearchUiState {
    /** Nothing searched yet, or the query is below the minimum length. */
    data class Idle(val query: String = "") : GlobalSearchUiState

    data class Loading(val query: String) : GlobalSearchUiState

    data class Content(
        val query: String,
        val items: List<GlobalSearchResult>,
        val nextCursor: Int?,
        val isLoadingMore: Boolean = false,
        val paginationError: GlobalSearchErrorKind? = null
    ) : GlobalSearchUiState

    data class Empty(val query: String) : GlobalSearchUiState

    data class Error(val query: String, val kind: GlobalSearchErrorKind) : GlobalSearchUiState
}

interface GlobalSearchActions {
    fun onQueryChanged(query: String)
    fun onSearch()
    fun onLoadMore()
    fun onRetry()
}

/**
 * Global search state machine. Search only runs against the server when the
 * normalized query satisfies the shared minimum length; stale responses are
 * dropped by generation so a slow earlier query never overwrites a newer one.
 */
class GlobalSearchController(
    private val repository: GlobalSearchRepository,
    private val scope: CoroutineScope
) : GlobalSearchActions {
    private val _state = MutableStateFlow<GlobalSearchUiState>(GlobalSearchUiState.Idle())
    val state: StateFlow<GlobalSearchUiState> = _state.asStateFlow()

    private val generation = AtomicLong(0L)
    private var currentQuery: String = ""

    override fun onQueryChanged(query: String) {
        val changed = GlobalSearchRules.normalizedQuery(query) !=
            GlobalSearchRules.normalizedQuery(currentQuery)
        currentQuery = query
        if (changed) {
            generation.incrementAndGet()
            _state.value = GlobalSearchUiState.Idle(query)
        }
    }

    override fun onSearch() {
        startSearch(currentQuery)
    }

    override fun onRetry() {
        startSearch(currentQuery)
    }

    override fun onLoadMore() {
        val content = _state.value as? GlobalSearchUiState.Content ?: return
        val cursor = content.nextCursor ?: return
        if (content.isLoadingMore) return
        val expected = generation.get()
        _state.value = content.copy(isLoadingMore = true, paginationError = null)
        scope.launch {
            when (val result = repository.search(query = content.query, cursor = cursor)) {
                is AppResult.Success -> {
                    if (generation.get() != expected) return@launch
                    _state.value = GlobalSearchUiState.Content(
                        query = content.query,
                        items = content.items + result.data.items,
                        nextCursor = result.data.nextCursor,
                        isLoadingMore = false,
                        paginationError = null
                    )
                }
                is AppResult.Error -> {
                    if (generation.get() != expected) return@launch
                    _state.value = content.copy(
                        isLoadingMore = false,
                        paginationError = errorKind(result)
                    )
                }
                AppResult.Loading -> Unit
            }
        }
    }

    fun reset() {
        generation.incrementAndGet()
        currentQuery = ""
        _state.value = GlobalSearchUiState.Idle()
    }

    private fun startSearch(rawQuery: String) {
        val query = GlobalSearchRules.normalizedQuery(rawQuery)
        if (!GlobalSearchRules.isQuerySearchable(query)) {
            _state.value = GlobalSearchUiState.Idle(rawQuery)
            return
        }
        val expected = generation.incrementAndGet()
        _state.value = GlobalSearchUiState.Loading(query)
        scope.launch {
            when (val result = repository.search(query = query)) {
                is AppResult.Success -> {
                    if (generation.get() != expected) return@launch
                    _state.value = if (result.data.items.isEmpty()) {
                        GlobalSearchUiState.Empty(query)
                    } else {
                        GlobalSearchUiState.Content(
                            query = query,
                            items = result.data.items,
                            nextCursor = result.data.nextCursor
                        )
                    }
                }
                is AppResult.Error -> {
                    if (generation.get() != expected) return@launch
                    _state.value = GlobalSearchUiState.Error(query, errorKind(result))
                }
                AppResult.Loading -> Unit
            }
        }
    }

    private fun errorKind(error: AppResult.Error): GlobalSearchErrorKind {
        val raw = error.exception.message.orEmpty()
        return when (raw) {
            "search.query_length" -> GlobalSearchErrorKind.QueryLength
            "search.invalid_request", "search.invalid_type" -> GlobalSearchErrorKind.InvalidRequest
            "search.failed" -> GlobalSearchErrorKind.Failed
            else -> GlobalSearchErrorKind.Connection
        }
    }
}
