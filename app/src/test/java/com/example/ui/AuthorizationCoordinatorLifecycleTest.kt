package com.example.ui

import com.example.core.utils.AppResult
import com.example.domain.model.*
import com.example.domain.repository.AuthorizationRepository
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AuthorizationCoordinatorLifecycleTest {
    @Test
    fun `reset clears every cached authorization value`() = runTest {
        val repository = FakeAuthorizationRepository()
        val coordinator = AuthorizationCoordinator(repository, backgroundScope)

        coordinator.refresh("department-1", "loaded")
        runCurrent()
        coordinator.loadGrantable(repository.principal.userId, "department-1")
        runCurrent()
        coordinator.previewPermissionChanges("grant", setOf("tasks.review"), "approved change")
        runCurrent()
        coordinator.previewOwnership(repository.principal, "approved transfer", "password")
        runCurrent()
        coordinator.revokeDelegation(
            repository.delegation.copy(recipientUserId = "missing-user"),
            "approved revoke",
            "department-1"
        )

        val populated = coordinator.state.value
        assertNotNull(populated.effective)
        assertTrue(populated.principals.isNotEmpty())
        assertNotNull(populated.grantable)
        assertNotNull(populated.permissionPreview)
        assertTrue(populated.delegations.isNotEmpty())
        assertTrue(populated.departmentManagers.isNotEmpty())
        assertNotNull(populated.ownershipPreview)
        assertNotNull(populated.message)
        assertNotNull(populated.errorMessage)

        coordinator.reset()

        assertEquals(AuthorizationUiState(), coordinator.state.value)

        coordinator.refresh("department-1")
        runCurrent()
        coordinator.previewOwnership(repository.principal, "approved transfer", "password")
        runCurrent()
        coordinator.applyOwnership()
        runCurrent()
        assertTrue(coordinator.state.value.ownershipCompleted)

        coordinator.reset()

        assertEquals(AuthorizationUiState(), coordinator.state.value)
    }

    @Test
    fun `completion from a cancelled lifecycle cannot repopulate state`() = runTest {
        val repository = FakeAuthorizationRepository()
        val requestStarted = CompletableDeferred<Unit>()
        val releaseOldRequest = CompletableDeferred<Unit>()
        repository.effectiveHandler = {
            requestStarted.complete(Unit)
            withContext(NonCancellable) { releaseOldRequest.await() }
            AppResult.Success(repository.effective)
        }
        val coordinator = AuthorizationCoordinator(repository, backgroundScope)

        coordinator.refresh("department-1")
        runCurrent()
        requestStarted.await()

        coordinator.reset()
        releaseOldRequest.complete(Unit)
        runCurrent()

        assertEquals(AuthorizationUiState(), coordinator.state.value)
        assertEquals(0, repository.manageablePrincipalCalls)
    }

    @Test
    fun `older refresh completion cannot overwrite a newer refresh in the same lifecycle`() = runTest {
        val repository = FakeAuthorizationRepository()
        val firstRequestStarted = CompletableDeferred<Unit>()
        val releaseFirstRequest = CompletableDeferred<Unit>()
        val olderEffective = repository.effective.copy(userId = "older-actor", authorizationVersion = 1)
        val newerEffective = repository.effective.copy(userId = "newer-actor", authorizationVersion = 2)
        var effectiveCalls = 0
        repository.effectiveHandler = {
            effectiveCalls += 1
            if (effectiveCalls == 1) {
                firstRequestStarted.complete(Unit)
                withContext(NonCancellable) { releaseFirstRequest.await() }
                AppResult.Success(olderEffective)
            } else {
                AppResult.Success(newerEffective)
            }
        }
        val coordinator = AuthorizationCoordinator(repository, backgroundScope)

        coordinator.refresh("department-1", "older refresh")
        runCurrent()
        firstRequestStarted.await()

        coordinator.refresh("department-1", "newer refresh")
        runCurrent()
        assertEquals(newerEffective, coordinator.state.value.effective)
        assertEquals("newer refresh", coordinator.state.value.message)

        releaseFirstRequest.complete(Unit)
        runCurrent()

        assertEquals(newerEffective, coordinator.state.value.effective)
        assertEquals("newer refresh", coordinator.state.value.message)
        assertEquals(1, repository.manageablePrincipalCalls)
    }

    @Test
    fun `successful refresh notifies same identity soft refresh listener`() = runTest {
        val repository = FakeAuthorizationRepository()
        val coordinator = AuthorizationCoordinator(repository, backgroundScope)
        var callbackCount = 0
        var receivedVersion = 0
        coordinator.onEffectiveAuthorizationLoaded = { effective ->
            callbackCount += 1
            receivedVersion = effective.authorizationVersion
        }

        coordinator.refresh("department-1")
        runCurrent()

        assertEquals(1, callbackCount)
        assertEquals(4, receivedVersion)

        coordinator.reset()
        coordinator.refresh("department-1")
        runCurrent()
        assertEquals(2, callbackCount)
    }

    private class FakeAuthorizationRepository : AuthorizationRepository {
        val effective = EffectiveAuthorization(
            userId = "actor-1",
            authorizationVersion = 4,
            isPrimaryOwner = true,
            managedDepartmentIds = listOf("department-1"),
            capabilities = listOf(
                EffectiveCapability("tasks.review", "department", "department-1", "direct")
            )
        )
        val principal = ManageablePrincipal(
            userId = "target-1",
            employeeId = "employee-1",
            name = "Target User",
            departmentId = "department-1",
            authorizationVersion = 7,
            managedDepartmentIds = emptyList()
        )
        val delegation = TemporaryDelegation(
            id = "delegation-1",
            delegatorUserId = effective.userId,
            recipientUserId = principal.userId,
            scopeType = "department",
            departmentId = "department-1",
            validFrom = "2026-07-19T00:00:00Z",
            validUntil = "2026-07-20T00:00:00Z",
            status = "active",
            revokedAt = null,
            createdAt = "2026-07-19T00:00:00Z",
            effective = true,
            capabilities = listOf("tasks.review")
        )
        private val manager = DepartmentManagerAssignment(
            id = "manager-1",
            departmentId = "department-1",
            userId = principal.userId,
            employeeId = principal.employeeId,
            name = principal.name,
            authorizationVersion = principal.authorizationVersion,
            assignedAt = "2026-07-19T00:00:00Z"
        )
        private val ownershipPreview = OwnershipTransferPreview(
            previewId = "ownership-preview",
            previewDigest = "digest",
            expiresInSeconds = 600,
            confirmationText = "TRANSFER OWNERSHIP",
            fromUserId = effective.userId,
            target = principal
        )

        var effectiveHandler: suspend () -> AppResult<EffectiveAuthorization> = {
            AppResult.Success(effective)
        }
        var manageablePrincipalCalls = 0

        override suspend fun loadEffective(): AppResult<EffectiveAuthorization> = effectiveHandler()

        override suspend fun loadManageablePrincipals(departmentId: String?): AppResult<List<ManageablePrincipal>> {
            manageablePrincipalCalls += 1
            return AppResult.Success(listOf(principal))
        }

        override suspend fun loadGrantablePermissions(
            targetUserId: String,
            departmentId: String?
        ): AppResult<GrantablePermissions> = AppResult.Success(
            GrantablePermissions(
                targetUserId,
                principal.authorizationVersion,
                AuthorizationScope("department", departmentId),
                listOf("tasks.review")
            )
        )

        override suspend fun previewPermissionChanges(
            targetUserId: String,
            expectedVersion: Int,
            reason: String,
            operations: List<PermissionOperation>
        ): AppResult<PermissionPreview> = AppResult.Success(
            PermissionPreview(
                previewId = "permission-preview",
                previewDigest = "digest",
                expiresInSeconds = 600,
                targetUserId = targetUserId,
                expectedAuthorizationVersion = expectedVersion,
                changes = operations.map {
                    PermissionPreviewChange(
                        it.action,
                        it.capability,
                        it.scopeType,
                        it.departmentId,
                        "absent",
                        "active"
                    )
                }
            )
        )

        override suspend fun applyPermissionChanges(previewId: String): AppResult<EffectiveAuthorization> =
            AppResult.Success(effective)

        override suspend fun listDelegations(): AppResult<List<TemporaryDelegation>> =
            AppResult.Success(listOf(delegation))

        override suspend fun createDelegation(
            recipientUserId: String,
            capabilities: List<String>,
            scope: AuthorizationScope,
            validFrom: String,
            validUntil: String,
            reason: String,
            expectedVersion: Int
        ): AppResult<TemporaryDelegation> = AppResult.Success(delegation)

        override suspend fun revokeDelegation(
            id: String,
            reason: String,
            expectedVersion: Int
        ): AppResult<TemporaryDelegation> = AppResult.Success(delegation.copy(status = "revoked"))

        override suspend fun previewOwnershipTransfer(
            targetUserId: String,
            reason: String,
            password: String
        ): AppResult<OwnershipTransferPreview> = AppResult.Success(ownershipPreview)

        override suspend fun applyOwnershipTransfer(
            preview: OwnershipTransferPreview,
            expectedVersion: Int
        ): AppResult<OwnershipTransferResult> = AppResult.Success(
            OwnershipTransferResult("transfer-1", false, principal, true)
        )

        override suspend fun createDelegatedAdmin(
            userId: String,
            capabilities: List<String>,
            reason: String,
            expectedVersion: Int
        ): AppResult<DelegatedAdminResult> = AppResult.Success(
            DelegatedAdminResult(userId, capabilities, expectedVersion + 1)
        )

        override suspend fun revokeDelegatedAdmin(
            userId: String,
            reason: String,
            expectedVersion: Int
        ): AppResult<Unit> = AppResult.Success(Unit)

        override suspend fun listDepartmentManagers(
            departmentId: String
        ): AppResult<List<DepartmentManagerAssignment>> = AppResult.Success(listOf(manager))

        override suspend fun assignDepartmentManager(
            departmentId: String,
            userId: String,
            reason: String,
            expectedVersion: Int
        ): AppResult<DepartmentManagerAssignment> = AppResult.Success(manager)

        override suspend fun revokeDepartmentManager(
            departmentId: String,
            userId: String,
            reason: String,
            expectedVersion: Int
        ): AppResult<Unit> = AppResult.Success(Unit)
    }
}
