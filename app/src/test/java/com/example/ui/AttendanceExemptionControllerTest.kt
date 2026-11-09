package com.example.ui

import com.example.core.permissions.Permissions
import com.example.core.utils.AppResult
import com.example.domain.model.AttendanceExemptionReasonCategory
import com.example.domain.model.AttendanceExemptionStatus
import com.example.domain.model.AttendanceExemptionStatusFilter
import com.example.domain.model.AttendanceExemptionTarget
import com.example.domain.repository.AttendanceExemptionRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AttendanceExemptionControllerTest {
    @Test
    fun `load shows content for viewer without manage permission`() = runTest {
        val repository = FakeAttendanceExemptionRepository()
        val controller = AttendanceExemptionController(
            repository = repository,
            scope = backgroundScope,
            permissionsProvider = { emptySet() }
        )

        controller.load()
        runCurrent()

        val screen = controller.state.value
        assertFalse(screen.canManage)
        assertTrue(screen.canView)
        val content = screen.listState as AttendanceExemptionListState.Content
        assertEquals(2, content.items.size)
    }

    @Test
    fun `manager permission enables create and revoke actions`() = runTest {
        val repository = FakeAttendanceExemptionRepository()
        val controller = AttendanceExemptionController(
            repository = repository,
            scope = backgroundScope,
            permissionsProvider = { setOf(Permissions.EMPLOYEES_ATTENDANCE_EXEMPTION_MANAGE) }
        )

        controller.load()
        runCurrent()

        assertTrue(controller.state.value.canManage)
        controller.onOpenCreateDialog()
        assertTrue(controller.state.value.showCreateDialog)
    }

    @Test
    fun `server failure surfaces error with retry path`() = runTest {
        val repository = FakeAttendanceExemptionRepository(failList = true)
        val controller = AttendanceExemptionController(repository, backgroundScope)

        controller.load()
        runCurrent()

        val error = controller.state.value.listState as AttendanceExemptionListState.Error
        assertTrue(error.message.isNotBlank())
        assertEquals(1, repository.listCalls)
    }

    @Test
    fun `revoke failure keeps active status without fake success`() = runTest {
        val repository = FakeAttendanceExemptionRepository(failRevoke = true)
        val controller = AttendanceExemptionController(
            repository = repository,
            scope = backgroundScope,
            permissionsProvider = { setOf(Permissions.ADMIN_FULL) }
        )

        controller.load()
        runCurrent()

        val active = (controller.state.value.listState as AttendanceExemptionListState.Content)
            .items
            .first { it.status == AttendanceExemptionStatus.ACTIVE }

        controller.onOpenRevokeDialog(active)
        controller.onRevokeExemption("سبب الإلغاء")
        runCurrent()

        val screen = controller.state.value
        assertNull(screen.successMessage)
        assertTrue(screen.actionErrorMessage?.contains("تغيّرت البيانات") == true)
        assertEquals(active.id, screen.revokingExemption?.id)

        val stillActive = (screen.listState as AttendanceExemptionListState.Content)
            .items
            .first { it.id == active.id }
        assertEquals(AttendanceExemptionStatus.ACTIVE, stillActive.status)
        assertEquals(1, repository.revokeCalls)
    }

    @Test
    fun `successful revoke updates item status`() = runTest {
        val repository = FakeAttendanceExemptionRepository()
        val controller = AttendanceExemptionController(
            repository = repository,
            scope = backgroundScope,
            permissionsProvider = { setOf(Permissions.ADMIN_FULL) }
        )

        controller.load()
        runCurrent()

        val active = (controller.state.value.listState as AttendanceExemptionListState.Content)
            .items
            .first { it.status == AttendanceExemptionStatus.ACTIVE }

        controller.onOpenRevokeDialog(active)
        controller.onRevokeExemption("انتهت المهمة الميدانية")
        runCurrent()

        val updated = (controller.state.value.listState as AttendanceExemptionListState.Content)
            .items
            .first { it.id == active.id }
        assertEquals(AttendanceExemptionStatus.REVOKED, updated.status)
        assertEquals("تم إلغاء إعفاء الحضور بنجاح.", controller.state.value.successMessage)
    }

    @Test
    fun `status filter keeps filtered empty content state`() = runTest {
        val repository = FakeAttendanceExemptionRepository()
        val controller = AttendanceExemptionController(repository, backgroundScope)

        controller.load()
        runCurrent()
        controller.onStatusFilterSelected(AttendanceExemptionStatusFilter.REVOKED)
        runCurrent()

        val filtered = controller.state.value.listState as AttendanceExemptionListState.Content
        assertEquals(AttendanceExemptionStatusFilter.REVOKED, filtered.statusFilter)
        assertTrue(filtered.items.all { it.status == AttendanceExemptionStatus.REVOKED })
    }

    @Test
    fun `create success prepends item and closes dialog`() = runTest {
        val repository = FakeAttendanceExemptionRepository()
        val controller = AttendanceExemptionController(
            repository = repository,
            scope = backgroundScope,
            permissionsProvider = { setOf(Permissions.ADMIN_FULL) }
        )
        controller.setEligibleTargets(
            listOf(AttendanceExemptionTarget("user-new", "موظف جديد", "المبيعات"))
        )

        controller.load()
        runCurrent()
        controller.onOpenCreateDialog()
        controller.onCreateExemption(
            targetUserId = "user-new",
            validFrom = "2026-08-01T00:00:00.000Z",
            validUntil = null,
            reasonCategory = AttendanceExemptionReasonCategory.REMOTE_WORK,
            note = "عمل عن بُعد"
        )
        runCurrent()

        val screen = controller.state.value
        assertFalse(screen.showCreateDialog)
        assertEquals("تم إنشاء إعفاء الحضور بنجاح.", screen.successMessage)
        val content = screen.listState as AttendanceExemptionListState.Content
        assertEquals("user-new", content.items.first().userId)
    }

    @Test
    fun `reset clears cached state`() = runTest {
        val repository = FakeAttendanceExemptionRepository()
        val controller = AttendanceExemptionController(repository, backgroundScope)

        controller.load()
        runCurrent()
        controller.reset()

        assertEquals(AttendanceExemptionListState.Loading, controller.state.value.listState)
    }

    private class FakeAttendanceExemptionRepository(
        private val failList: Boolean = false,
        private val failRevoke: Boolean = false
    ) : AttendanceExemptionRepository {
        var listCalls = 0
        var revokeCalls = 0

        private val items = mutableListOf(
            com.example.domain.model.AttendanceExemption(
                id = "ex-1",
                userId = "user-1",
                employeeId = "emp-1",
                validFrom = "2026-07-01T00:00:00.000Z",
                validUntil = "2026-12-31T23:59:59.000Z",
                reasonCategory = AttendanceExemptionReasonCategory.FIELD_ASSIGNMENT,
                note = "ميداني",
                status = AttendanceExemptionStatus.ACTIVE,
                version = 1,
                createdAt = "2026-07-01T08:00:00.000Z",
                revokedAt = null
            ),
            com.example.domain.model.AttendanceExemption(
                id = "ex-2",
                userId = "user-2",
                employeeId = "emp-2",
                validFrom = "2026-01-01T00:00:00.000Z",
                validUntil = null,
                reasonCategory = AttendanceExemptionReasonCategory.ADMIN_ACCOUNT,
                note = null,
                status = AttendanceExemptionStatus.REVOKED,
                version = 2,
                createdAt = "2026-01-01T08:00:00.000Z",
                revokedAt = "2026-06-01T10:00:00.000Z"
            )
        )

        override suspend fun listExemptions(
            status: String?,
            targetUserId: String?
        ): AppResult<com.example.domain.model.AttendanceExemptionPage> {
            listCalls += 1
            if (failList) return AppResult.Error(Exception("attendance.network_error"))
            val filtered = status?.let { value ->
                items.filter { it.status.apiValue == value }
            } ?: items.toList()
            return AppResult.Success(com.example.domain.model.AttendanceExemptionPage(filtered))
        }

        override suspend fun createExemption(
            request: com.example.domain.model.AttendanceExemptionCreateRequest
        ): AppResult<com.example.domain.model.AttendanceExemption> {
            val created = com.example.domain.model.AttendanceExemption(
                id = "ex-new",
                userId = request.targetUserId,
                employeeId = null,
                validFrom = request.validFrom,
                validUntil = request.validUntil,
                reasonCategory = request.reasonCategory,
                note = request.note,
                status = AttendanceExemptionStatus.ACTIVE,
                version = 1,
                createdAt = request.validFrom,
                revokedAt = null
            )
            items.add(0, created)
            return AppResult.Success(created)
        }

        override suspend fun revokeExemption(
            exemptionId: String,
            request: com.example.domain.model.AttendanceExemptionRevokeRequest
        ): AppResult<com.example.domain.model.AttendanceExemption> {
            revokeCalls += 1
            if (failRevoke) {
                return AppResult.Error(Exception("attendance.version_mismatch"))
            }
            val index = items.indexOfFirst { it.id == exemptionId }
            val current = items[index]
            val revoked = current.copy(
                status = AttendanceExemptionStatus.REVOKED,
                version = current.version + 1,
                revokedAt = "2026-07-19T12:00:00.000Z"
            )
            items[index] = revoked
            return AppResult.Success(revoked)
        }
    }
}
