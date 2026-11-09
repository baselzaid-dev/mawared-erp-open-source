package com.example.domain.model

/**
 * Sprint 12L timeline presentation model — a safe, chronological projection of
 * domain history: actor name/role snapshot and authorized reason only, never
 * raw audit payloads.
 */
data class TimelineEvent(
    val at: String,
    val type: String,
    val summary: String,
    val fromStatus: String?,
    val toStatus: String?,
    val actorName: String?,
    val actorRole: String?,
    val reason: String?,
    val override: Boolean
)

data class TimelineEntity(
    val entityType: String,
    val entityId: String,
    val events: List<TimelineEvent>
)

enum class TimelineKind {
    LEAVE,
    PURCHASE_REQUEST,
    EMPLOYEE,
    TRAINING_ASSIGNMENT
}

object TimelineRules {
    fun isDateOnly(event: TimelineEvent): Boolean = event.type == "employee.joined"
}
