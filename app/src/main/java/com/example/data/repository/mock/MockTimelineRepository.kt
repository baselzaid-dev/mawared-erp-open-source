package com.example.data.repository.mock

import com.example.core.utils.AppResult
import com.example.domain.model.TimelineEntity
import com.example.domain.model.TimelineEvent
import com.example.domain.model.TimelineKind
import com.example.domain.repository.TimelineRepository
import kotlinx.coroutines.delay

/** Demo-mode timeline: a small deterministic history per kind. */
class MockTimelineRepository : TimelineRepository {

    override suspend fun loadTimeline(
        kind: TimelineKind,
        id: String
    ): AppResult<TimelineEntity> {
        delay(120)
        val events = when (kind) {
            TimelineKind.LEAVE -> listOf(
                event("2026-06-01T08:00:00.000Z", "leave.submitted", "Leave request submitted", toStatus = "pending_hr", actorName = "سالم الحربي"),
                event("2026-06-02T09:30:00.000Z", "leave.hr_approve", "Leave hr approve", fromStatus = "pending_hr", toStatus = "pending_admin", actorName = "هناء الموارد", actorRole = "HR Manager"),
                event("2026-06-03T10:00:00.000Z", "leave.admin_approve", "Leave admin approve", fromStatus = "pending_admin", toStatus = "approved", actorName = "عمر المدير", actorRole = "Admin")
            )
            TimelineKind.PURCHASE_REQUEST -> listOf(
                event("2026-05-01T08:00:00.000Z", "purchase_request.created", "Purchase request created", toStatus = "pending_department", actorName = "سالم الحربي"),
                event("2026-05-02T11:00:00.000Z", "purchase_request.department_reviewed", "Department review recorded", actorName = "دانة القسم", reason = "موافقة القسم"),
                event("2026-05-03T14:00:00.000Z", "purchase_request.purchasing_reviewed", "Purchasing review recorded", actorName = "بلال المشتريات", reason = "موافقة المشتريات")
            )
            TimelineKind.EMPLOYEE -> listOf(
                event("2025-01-10T00:00:00.000Z", "employee.created", "Employee record created"),
                event("2025-01-15T00:00:00.000Z", "employee.joined", "Employment start date", toStatus = "active")
            )
            TimelineKind.TRAINING_ASSIGNMENT -> listOf(
                event("2026-04-01T08:00:00.000Z", "assignment.assigned", "Training assigned", toStatus = "assigned", actorName = "طارق المدرب"),
                event("2026-04-02T08:00:00.000Z", "assignment.started", "Training started", fromStatus = "assigned", toStatus = "in_progress"),
                event("2026-04-04T08:00:00.000Z", "assignment.reviewed", "Training reviewed", actorName = "رنا المراجعة", reason = "أداء ممتاز")
            )
        }
        return AppResult.Success(
            TimelineEntity(
                entityType = kind.name.lowercase(),
                entityId = id,
                events = events
            )
        )
    }

    private fun event(
        at: String,
        type: String,
        summary: String,
        fromStatus: String? = null,
        toStatus: String? = null,
        actorName: String? = null,
        actorRole: String? = null,
        reason: String? = null,
        override: Boolean = false
    ) = TimelineEvent(
        at = at,
        type = type,
        summary = summary,
        fromStatus = fromStatus,
        toStatus = toStatus,
        actorName = actorName,
        actorRole = actorRole,
        reason = reason,
        override = override
    )
}
