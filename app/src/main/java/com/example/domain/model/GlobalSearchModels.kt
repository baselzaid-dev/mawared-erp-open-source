package com.example.domain.model

/**
 * Sprint 12L global search domain model.
 *
 * Results are read-only descriptors: opening one goes through the typed
 * navigation allowlist and the module endpoint re-authorizes the target.
 */
data class GlobalSearchResult(
    val type: String,
    val id: String,
    val title: String,
    val subtitle: String?,
    val status: String?,
    val routeKey: String,
    val resourceType: String,
    val resourceId: String?,
    val filterJson: String?
)

data class GlobalSearchPage(
    val items: List<GlobalSearchResult>,
    val nextCursor: Int?
)

object GlobalSearchRules {
    const val MIN_QUERY_LENGTH = 2
    const val MAX_QUERY_LENGTH = 100
    val SUPPORTED_TYPES: Set<String> = setOf(
        "employee",
        "vendor",
        "purchase_request",
        "training_course",
        "task",
        "chat_conversation"
    )

    fun normalizedQuery(raw: String): String = raw.trim()

    fun isQuerySearchable(raw: String): Boolean {
        val normalized = normalizedQuery(raw)
        return normalized.length in MIN_QUERY_LENGTH..MAX_QUERY_LENGTH
    }
}
