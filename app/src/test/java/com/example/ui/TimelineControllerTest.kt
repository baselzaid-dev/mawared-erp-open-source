package com.example.ui

import com.example.core.utils.AppResult
import com.example.data.repository.mock.MockTimelineRepository
import com.example.domain.model.TimelineEntity
import com.example.domain.model.TimelineEvent
import com.example.domain.model.TimelineKind
import com.example.domain.model.TimelineRules
import com.example.domain.repository.TimelineRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TimelineControllerTest {

    private class FakeTimelineRepository : TimelineRepository {
        val responses = ArrayDeque<AppResult<TimelineEntity>>()
        val calls = mutableListOf<Pair<TimelineKind, String>>()

        override suspend fun loadTimeline(
            kind: TimelineKind,
            id: String
        ): AppResult<TimelineEntity> {
            calls += kind to id
            return responses.removeFirstOrNull()
                ?: AppResult.Success(TimelineEntity("leave", id, emptyList()))
        }
    }

    private fun entity(vararg types: String) = TimelineEntity(
        entityType = "leave",
        entityId = "lr-1",
        events = types.map { type ->
            TimelineEvent(
                at = "2026-06-01T08:00:00.000Z",
                type = type,
                summary = type,
                fromStatus = null,
                toStatus = null,
                actorName = null,
                actorRole = null,
                reason = null,
                override = type.contains("override")
            )
        }
    )

    @Test
    fun `open loads and shows the timeline`() = runTest {
        val repository = FakeTimelineRepository()
        repository.responses += AppResult.Success(entity("leave.submitted", "leave.hr_approve"))
        val controller = TimelineController(repository, backgroundScope)

        controller.open(TimelineKind.LEAVE, "lr-1")
        runCurrent()

        val content = controller.state.value as TimelineUiState.Content
        assertEquals(2, content.events.size)
        assertEquals(TimelineKind.LEAVE to "lr-1", repository.calls.single())
    }

    @Test
    fun `opaque server 404 maps to a safe localized reason and retry reloads`() = runTest {
        val repository = FakeTimelineRepository()
        repository.responses += AppResult.Error(Exception("timeline.not_found"))
        repository.responses += AppResult.Success(entity("leave.submitted"))
        val controller = TimelineController(repository, backgroundScope)

        controller.open(TimelineKind.LEAVE, "lr-1")
        runCurrent()
        val error = controller.state.value as TimelineUiState.Error
        assertEquals(TimelineErrorKind.Unavailable, error.reason)

        controller.retry()
        runCurrent()
        assertTrue(controller.state.value is TimelineUiState.Content)
        assertEquals(2, repository.calls.size)
    }

    @Test
    fun `dismiss hides the dialog and drops in-flight results`() = runTest {
        val repository = FakeTimelineRepository()
        repository.responses += AppResult.Success(entity("leave.submitted"))
        val controller = TimelineController(repository, backgroundScope)

        controller.open(TimelineKind.LEAVE, "lr-1")
        controller.dismiss()
        runCurrent()

        assertTrue(controller.state.value is TimelineUiState.Hidden)
    }

    @Test
    fun `mock repository returns a deterministic history per kind`() = runTest {
        val repository = MockTimelineRepository()
        TimelineKind.entries.forEach { kind ->
            val result = repository.loadTimeline(kind, "any-id")
            val data = (result as AppResult.Success).data
            assertTrue(data.events.isNotEmpty())
        }
    }

    @Test
    fun `date-only timeline rule is limited to employment start dates`() {
        val joined = TimelineEvent(
            at = "2026-06-01T08:00:00.000Z", type = "leave.override_approve",
            summary = "Leave override approve", fromStatus = null, toStatus = null,
            actorName = null, actorRole = null, reason = null, override = true
        )
        assertTrue(!TimelineRules.isDateOnly(joined))
        assertTrue(TimelineRules.isDateOnly(joined.copy(type = "employee.joined")))
    }
}
