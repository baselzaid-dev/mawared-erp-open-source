package com.example.ui

import com.example.core.permissions.Permissions
import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.domain.model.CreateEmployeeCredentialRequest
import com.example.domain.model.EmployeeArchiveRequest
import com.example.domain.model.EmployeeArchiveResult
import com.example.domain.model.EmployeeParams
import com.example.domain.model.ForcedPasswordChangeRequest
import com.example.domain.model.ForcedPasswordChangeResult
import com.example.domain.model.OneTimeCredential
import com.example.domain.model.ResetEmployeeCredentialRequest
import com.example.domain.repository.CredentialRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private fun employee(
    id: String = "e1",
    userId: String? = null,
    status: String = "active",
    credentialVersion: Int? = null,
    updatedAtIso: String? = "2026-07-19T10:00:00.000Z",
    archivedAtIso: String? = null,
    email: String? = "e1@example.com"
) = EmployeeParams(
    id = id,
    companyId = "c1",
    departmentId = "d1",
    employeeCode = "EMP-1",
    fullName = "موظف تجريبي",
    jobTitle = "Engineer",
    phone = null,
    email = email,
    nationalIdOrIqama = null,
    basicSalary = 0.0,
    allowances = 0.0,
    deductions = 0.0,
    status = status,
    joiningDate = "2025-01-10",
    contractType = null,
    createdAt = 0L,
    updatedAt = 0L,
    departmentName = "HR",
    roleId = "r1",
    roleName = "Employee",
    userId = userId,
    credentialVersion = credentialVersion,
    updatedAtIso = updatedAtIso,
    archivedAtIso = archivedAtIso
)

private class FakeCredentialRepository : CredentialRepository {
    var createResult: AppResult<OneTimeCredential> = AppResult.Success(
        OneTimeCredential("TempPass1234", true, "2026-07-20T10:00:00.000Z", 1)
    )
    var resetResult: AppResult<OneTimeCredential> = AppResult.Success(
        OneTimeCredential("ResetPass123", true, "2026-07-20T10:00:00.000Z", 2)
    )
    var archiveResult: AppResult<EmployeeArchiveResult> = AppResult.Success(
        EmployeeArchiveResult(
            employeeId = "e1",
            archivedAt = "2026-07-19T11:00:00.000Z",
            archiveReason = "reason",
            updatedAt = "2026-07-19T11:00:00.000Z",
            accountStatus = "archived"
        )
    )
    var createCalls = 0
    var resetCalls = 0
    var archiveCalls = 0
    var lastCreateRequest: CreateEmployeeCredentialRequest? = null
    var lastResetRequest: ResetEmployeeCredentialRequest? = null
    var lastArchiveRequest: EmployeeArchiveRequest? = null
    var refreshCount = 0

    override suspend fun changeTemporaryPassword(
        request: ForcedPasswordChangeRequest
    ): AppResult<ForcedPasswordChangeResult> = error("unused")

    override suspend fun createEmployeeCredential(
        employeeId: String,
        request: CreateEmployeeCredentialRequest
    ): AppResult<OneTimeCredential> {
        createCalls += 1
        lastCreateRequest = request
        return createResult
    }

    override suspend fun resetEmployeeCredential(
        employeeId: String,
        request: ResetEmployeeCredentialRequest
    ): AppResult<OneTimeCredential> {
        resetCalls += 1
        lastResetRequest = request
        return resetResult
    }

    override suspend fun archiveEmployee(
        employeeId: String,
        request: EmployeeArchiveRequest
    ): AppResult<EmployeeArchiveResult> {
        archiveCalls += 1
        lastArchiveRequest = request
        return archiveResult
    }

    override suspend fun reactivateEmployee(
        employeeId: String,
        request: EmployeeArchiveRequest
    ): AppResult<EmployeeArchiveResult> = error("unused")
}

class EmployeeCredentialRulesTest {
    private val hrPermissions = setOf(
        Permissions.EMPLOYEES_CREDENTIALS_CREATE,
        Permissions.EMPLOYEES_CREDENTIALS_RESET,
        Permissions.EMPLOYEES_ARCHIVE
    )

    @Test
    fun `create is allowed only without an existing login user`() {
        assertTrue(
            EmployeeCredentialRules.canCreateCredentialFor(
                employee(userId = null),
                hrPermissions
            )
        )
        assertFalse(
            EmployeeCredentialRules.canCreateCredentialFor(
                employee(userId = "u1"),
                hrPermissions
            )
        )
        assertFalse(
            EmployeeCredentialRules.canCreateCredentialFor(
                employee(userId = null),
                setOf(Permissions.EMPLOYEES_VIEW)
            )
        )
    }

    @Test
    fun `reset requires permission, existing user, and not self`() {
        assertTrue(
            EmployeeCredentialRules.canResetCredentialFor(
                employee = employee(id = "e2", userId = "u2", credentialVersion = 3),
                currentUserId = "u-actor",
                actorEmployeeId = "e-actor",
                permissions = hrPermissions
            )
        )
        assertFalse(
            EmployeeCredentialRules.canResetCredentialFor(
                employee = employee(id = "e2", userId = "u-actor", credentialVersion = 3),
                currentUserId = "u-actor",
                actorEmployeeId = "e-actor",
                permissions = hrPermissions
            )
        )
        assertFalse(
            EmployeeCredentialRules.canResetCredentialFor(
                employee = employee(id = "e2", userId = "u2", credentialVersion = null),
                currentUserId = "u-actor",
                actorEmployeeId = "e-actor",
                permissions = hrPermissions
            )
        )
    }

    @Test
    fun `reset cannot target primary owner`() {
        assertFalse(
            EmployeeCredentialRules.canResetCredentialFor(
                employee = employee(id = "e2", userId = "u2", credentialVersion = 3),
                currentUserId = "u-actor",
                actorEmployeeId = "e-actor",
                permissions = hrPermissions,
                isPrimaryOwnerTarget = true
            )
        )
    }

    @Test
    fun `archive requires permission, concurrency stamp, and not owner or self`() {
        assertTrue(
            EmployeeCredentialRules.canArchiveEmployeeRecord(
                employee = employee(id = "e2", userId = "u2"),
                currentUserId = "u-actor",
                actorEmployeeId = "e-actor",
                isPrimaryOwnerTarget = false,
                permissions = hrPermissions
            )
        )
        assertFalse(
            EmployeeCredentialRules.canArchiveEmployeeRecord(
                employee = employee(id = "e2", userId = "u2"),
                currentUserId = "u-actor",
                actorEmployeeId = "e-actor",
                isPrimaryOwnerTarget = true,
                permissions = hrPermissions
            )
        )
        assertFalse(
            EmployeeCredentialRules.canArchiveEmployeeRecord(
                employee = employee(id = "e2", userId = "u2", updatedAtIso = null),
                currentUserId = "u-actor",
                actorEmployeeId = "e-actor",
                isPrimaryOwnerTarget = false,
                permissions = hrPermissions
            )
        )
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class EmployeeSecurityControllerTest {
    private val permissions = setOf(
        Permissions.EMPLOYEES_CREDENTIALS_CREATE,
        Permissions.EMPLOYEES_CREDENTIALS_RESET,
        Permissions.EMPLOYEES_ARCHIVE
    )

    @Test
    fun `create reports one-time secret only after repository success and refreshes`() = runTest {
        val repo = FakeCredentialRepository()
        val controller = EmployeeSecurityController(repo, backgroundScope) { repo.refreshCount += 1 }

        controller.createCredential(employee(userId = null), "new@example.com", permissions)
        runCurrent()

        assertEquals(1, repo.createCalls)
        assertEquals("new@example.com", repo.lastCreateRequest?.email)
        assertEquals(1, repo.refreshCount)
        val state = controller.state.value as EmployeeSecurityUiState.OneTimeSecret
        assertEquals("TempPass1234", state.credential.temporaryPassword)
    }

    @Test
    fun `create failure never reports local success`() = runTest {
        val repo = FakeCredentialRepository().apply {
            createResult = AppResult.Error(
                Exception("employees.credential_already_exists"),
                AppError.ValidationError("employees.credential_already_exists")
            )
        }
        val controller = EmployeeSecurityController(repo, backgroundScope) { repo.refreshCount += 1 }

        controller.createCredential(employee(userId = null), "new@example.com", permissions)
        runCurrent()

        assertEquals(0, repo.refreshCount)
        assertTrue(controller.state.value is EmployeeSecurityUiState.Error)
    }

    @Test
    fun `reset sends reason and expected credential version`() = runTest {
        val repo = FakeCredentialRepository()
        val controller = EmployeeSecurityController(repo, backgroundScope)

        controller.resetCredential(
            employee = employee(id = "e2", userId = "u2", credentialVersion = 4),
            reason = "lost device access",
            currentUserId = "u-actor",
            actorEmployeeId = "e-actor",
            permissions = permissions
        )
        runCurrent()

        assertEquals(1, repo.resetCalls)
        assertEquals(4, repo.lastResetRequest?.expectedCredentialVersion)
        assertEquals("lost device access", repo.lastResetRequest?.reason)
        assertTrue(controller.state.value is EmployeeSecurityUiState.OneTimeSecret)
    }

    @Test
    fun `archive sends expectedUpdatedAt and refreshes after success only`() = runTest {
        val repo = FakeCredentialRepository()
        val controller = EmployeeSecurityController(repo, backgroundScope) { repo.refreshCount += 1 }

        controller.archiveEmployee(
            employee = employee(id = "e2", userId = "u2"),
            reason = "left company",
            currentUserId = "u-actor",
            actorEmployeeId = "e-actor",
            isPrimaryOwnerTarget = false,
            permissions = permissions
        )
        runCurrent()

        assertEquals(1, repo.archiveCalls)
        assertEquals("2026-07-19T10:00:00.000Z", repo.lastArchiveRequest?.expectedUpdatedAt)
        assertEquals(1, repo.refreshCount)
        assertTrue(controller.state.value is EmployeeSecurityUiState.SuccessMessage)
    }

    @Test
    fun `archive failure keeps idle refresh count at zero`() = runTest {
        val repo = FakeCredentialRepository().apply {
            archiveResult = AppResult.Error(
                Exception("employees.stale_employee_version"),
                AppError.ValidationError("employees.stale_employee_version")
            )
        }
        val controller = EmployeeSecurityController(repo, backgroundScope) { repo.refreshCount += 1 }

        controller.archiveEmployee(
            employee = employee(id = "e2", userId = "u2"),
            reason = "left company",
            currentUserId = "u-actor",
            actorEmployeeId = "e-actor",
            isPrimaryOwnerTarget = false,
            permissions = permissions
        )
        runCurrent()

        assertEquals(0, repo.refreshCount)
        val error = controller.state.value as EmployeeSecurityUiState.Error
        assertTrue(error.message.contains("حدّث"))
    }
}
