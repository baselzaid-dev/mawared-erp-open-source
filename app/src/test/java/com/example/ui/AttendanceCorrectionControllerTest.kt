package com.example.ui

import com.example.core.permissions.Permissions
import com.example.core.utils.AppResult
import com.example.domain.model.*
import com.example.domain.repository.AttendanceCorrectionRepository
import com.example.ui.navigation.ResourceDescriptor
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AttendanceCorrectionControllerTest {
    @Test
    fun `load shows content from repository`() = runTest {
        val repository = FakeAttendanceCorrectionRepository()
        val controller = AttendanceCorrectionController(
            repository = repository,
            scope = backgroundScope,
            permissionsProvider = { setOf(Permissions.ATTENDANCE_REVIEW_CORRECTION) },
            currentUserIdProvider = { "reviewer-1" }
        )

        controller.load()
        runCurrent()

        val content = controller.state.value as AttendanceCorrectionUiState.Content
        assertEquals(2, content.items.size)
        assertTrue(content.canReview)
    }

    @Test
    fun `server failure surfaces error without optimistic success`() = runTest {
        val repository = FakeAttendanceCorrectionRepository(failLoad = true)
        val controller = AttendanceCorrectionController(repository, backgroundScope)

        controller.load()
        runCurrent()

        val error = controller.state.value as AttendanceCorrectionUiState.Error
        assertTrue(error.message.isNotBlank())
        assertEquals(1, repository.loadCalls)
    }

    @Test
    fun `decide failure keeps list unchanged`() = runTest {
        val repository = FakeAttendanceCorrectionRepository(failDecide = true)
        val controller = AttendanceCorrectionController(
            repository = repository,
            scope = backgroundScope,
            permissionsProvider = { setOf(Permissions.ATTENDANCE_REVIEW_CORRECTION) },
            currentUserIdProvider = { "reviewer-1" }
        )

        controller.load()
        runCurrent()
        val before = (controller.state.value as AttendanceCorrectionUiState.Content).items

        controller.onAccept("corr-1", 1, "approved after verification")
        runCurrent()

        assertTrue(controller.feedback.value.errorMessage.orEmpty().isNotBlank())
        val after = controller.state.value as AttendanceCorrectionUiState.Content
        assertEquals(before.first().status, after.items.first().status)
        assertEquals(1, repository.decideCalls)
    }

    @Test
    fun `decide success refreshes from server`() = runTest {
        val repository = FakeAttendanceCorrectionRepository()
        val controller = AttendanceCorrectionController(
            repository = repository,
            scope = backgroundScope,
            permissionsProvider = { setOf(Permissions.ATTENDANCE_REVIEW_CORRECTION) },
            currentUserIdProvider = { "reviewer-1" }
        )

        controller.load()
        runCurrent()
        controller.onAccept("corr-1", 1, "approved after verification")
        runCurrent()

        assertEquals("تم قبول طلب التصحيح.", controller.feedback.value.successMessage)
        assertEquals(1, repository.decideCalls)
        assertEquals(2, repository.loadCalls)
    }

    @Test
    fun `self-review is blocked in controller`() = runTest {
        val repository = FakeAttendanceCorrectionRepository()
        val controller = AttendanceCorrectionController(
            repository = repository,
            scope = backgroundScope,
            permissionsProvider = { setOf(Permissions.ATTENDANCE_REVIEW_CORRECTION) },
            currentUserIdProvider = { "requester-1" }
        )

        controller.load()
        runCurrent()
        controller.onReject("corr-1", 1, "cannot review own request")
        runCurrent()

        assertTrue(controller.feedback.value.errorMessage.orEmpty().contains("صلاحية"))
        assertEquals(0, repository.decideCalls)
    }

    @Test
    fun `status filter reloads list`() = runTest {
        val repository = FakeAttendanceCorrectionRepository()
        val controller = AttendanceCorrectionController(repository, backgroundScope)

        controller.load()
        runCurrent()
        controller.onStatusSelected(AttendanceCorrectionStatus.PENDING)
        runCurrent()

        val filtered = controller.state.value as AttendanceCorrectionUiState.Content
        assertEquals(AttendanceCorrectionStatus.PENDING, filtered.selectedStatus)
        assertEquals(2, repository.loadCalls)
    }

    @Test
    fun `reset clears cached state`() = runTest {
        val repository = FakeAttendanceCorrectionRepository()
        val controller = AttendanceCorrectionController(repository, backgroundScope)

        controller.load()
        runCurrent()
        controller.reset()

        assertEquals(AttendanceCorrectionUiState.Loading, controller.state.value)
        assertNull(controller.feedback.value.successMessage)
    }

    @Test
    fun `correction click emits detail descriptor for navigation`() = runTest {
        val repository = FakeAttendanceCorrectionRepository()
        var navigated: ResourceDescriptor? = null
        val controller = AttendanceCorrectionController(
            repository = repository,
            scope = backgroundScope,
            onNavigate = { navigated = it }
        )

        controller.onCorrectionClick("corr-99")

        assertEquals("attendance_correction.detail", navigated?.routeKey)
        assertEquals("corr-99", navigated?.resourceId)
    }

    @Test
    fun `rules gate review actions by permission and identity`() {
        val pending = sampleCorrection(requestedByUserId = "employee-1")
        assertTrue(
            AttendanceCorrectionRules.canDecide(
                pending,
                currentUserId = "manager-1",
                permissions = setOf(Permissions.ATTENDANCE_REVIEW_CORRECTION)
            )
        )
        assertFalse(
            AttendanceCorrectionRules.canDecide(
                pending,
                currentUserId = "employee-1",
                permissions = setOf(Permissions.ATTENDANCE_REVIEW_CORRECTION)
            )
        )
        assertFalse(
            AttendanceCorrectionRules.canDecide(
                pending,
                currentUserId = "manager-1",
                permissions = emptySet()
            )
        )
    }

    private fun sampleCorrection(requestedByUserId: String) = AttendanceCorrection(
        id = "corr-1",
        attendanceId = "att-1",
        employeeId = "emp-1",
        requestedByUserId = requestedByUserId,
        requestedClockIn = "2026-07-19T08:00:00.000Z",
        requestedClockOut = null,
        reason = "forgot clock in",
        status = AttendanceCorrectionStatus.PENDING,
        version = 1,
        reviewedAt = null,
        decisionReason = null,
        createdAt = "2026-07-19T09:00:00.000Z",
        updatedAt = "2026-07-19T09:00:00.000Z"
    )

    private class FakeAttendanceCorrectionRepository(
        private val failLoad: Boolean = false,
        private val failDecide: Boolean = false
    ) : AttendanceCorrectionRepository {
        var loadCalls = 0
        var decideCalls = 0

        private val pending = sampleCorrectionStatic("corr-1", "requester-1")
        private val approved = sampleCorrectionStatic("corr-2", "requester-2")
            .copy(status = AttendanceCorrectionStatus.APPROVED, version = 2)

        override suspend fun createCorrection(
            attendanceId: String,
            request: AttendanceCorrectionCreateRequest
        ): AppResult<AttendanceCorrection> = AppResult.Success(pending)

        override suspend fun listCorrections(
            status: String?,
            employeeId: String?,
            cursor: String?,
            limit: Int?
        ): AppResult<AttendanceCorrectionPage> {
            loadCalls += 1
            if (failLoad) {
                return AppResult.Error(Exception("network down"), com.example.core.utils.AppError.NetworkError)
            }
            val items = listOf(pending, approved).filter {
                status == null || AttendanceCorrectionStatus.toApiFilter(it.status) == status
            }
            return AppResult.Success(AttendanceCorrectionPage(items, nextCursor = null, hasMore = false))
        }

        override suspend fun decideCorrection(
            correctionId: String,
            request: AttendanceCorrectionDecisionRequest
        ): AppResult<AttendanceCorrectionDecisionResult> {
            decideCalls += 1
            if (failDecide) {
                return AppResult.Error(
                    Exception("attendance.version_mismatch"),
                    com.example.core.utils.AppError.ValidationError("attendance.version_mismatch")
                )
            }
            val updated = pending.copy(
                status = when (request.decision) {
                    AttendanceCorrectionDecision.ACCEPT -> AttendanceCorrectionStatus.APPROVED
                    AttendanceCorrectionDecision.REJECT -> AttendanceCorrectionStatus.REJECTED
                },
                version = pending.version + 1
            )
            return AppResult.Success(AttendanceCorrectionDecisionResult(updated, 2))
        }

        private fun sampleCorrectionStatic(id: String, requester: String) = AttendanceCorrection(
            id = id,
            attendanceId = "att-1",
            employeeId = "emp-1",
            requestedByUserId = requester,
            requestedClockIn = "2026-07-19T08:00:00.000Z",
            requestedClockOut = null,
            reason = "forgot clock in",
            status = AttendanceCorrectionStatus.PENDING,
            version = 1,
            reviewedAt = null,
            decisionReason = null,
            createdAt = "2026-07-19T09:00:00.000Z",
            updatedAt = "2026-07-19T09:00:00.000Z"
        )
    }
}
