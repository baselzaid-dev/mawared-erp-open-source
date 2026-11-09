package com.example.data.remote.repository

import com.example.core.utils.AppResult
import com.example.data.remote.api.*
import com.example.domain.model.PermissionOperation
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

class ApiAuthorizationRepositoryTest {
    @Test
    fun `effective authorization preserves scope source and expiry`() = runTest {
        val api = FakeAuthorizationApi()
        val result = ApiAuthorizationRepository(api).loadEffective() as AppResult.Success

        assertTrue(result.data.isPrimaryOwner)
        assertEquals(7, result.data.authorizationVersion)
        assertEquals(listOf("department-1"), result.data.managedDepartmentIds)
        assertEquals(listOf("employees.view", "company.security.manage"), result.data.flatPermissions)
        assertEquals("temporary_delegation", result.data.capabilities.single().source)
        assertEquals("2026-07-20T00:00:00.000Z", result.data.capabilities.single().validUntil)
    }

    @Test
    fun `preview and apply preserve optimistic version and generate idempotency keys`() = runTest {
        val api = FakeAuthorizationApi()
        val repository = ApiAuthorizationRepository(api)

        val preview = repository.previewPermissionChanges(
            targetUserId = "target-1",
            expectedVersion = 11,
            reason = "approved change",
            operations = listOf(
                PermissionOperation("grant", "tasks.review", "department", "department-1")
            )
        ) as AppResult.Success
        repository.applyPermissionChanges(preview.data.previewId)
        repository.applyPermissionChanges(preview.data.previewId)

        assertEquals(11, api.lastPreviewRequest?.expectedAuthorizationVersion)
        assertEquals("department-1", api.lastPreviewRequest?.operations?.single()?.departmentId)
        assertTrue(api.applyKeys.all { it.length >= 8 })
        assertNotEquals(api.applyKeys[0], api.applyKeys[1])
    }

    @Test
    fun `no-content revocations are successful and stale errors stay visible`() = runTest {
        val api = FakeAuthorizationApi()
        val repository = ApiAuthorizationRepository(api)

        assertTrue(repository.revokeDelegatedAdmin("target-1", "role ended", 9) is AppResult.Success)
        assertTrue(repository.revokeDepartmentManager("department-1", "target-1", "assignment ended", 9) is AppResult.Success)
        assertEquals(9, api.lastDelegatedAdminRequest?.expectedVersion)
        assertEquals(9, api.lastManagerRequest?.expectedAuthorizationVersion)

        api.grantableResponse = Response.error(
            412,
            """{"messageKey":"authorization.stale_version"}"""
                .toResponseBody("application/json".toMediaType())
        )
        val stale = repository.loadGrantablePermissions("target-1") as AppResult.Error
        assertEquals("authorization.stale_version", stale.exception.message)
    }

    private class FakeAuthorizationApi : AuthorizationApi {
        var grantableResponse: Response<GrantablePermissionsDto> = Response.success(
            GrantablePermissionsDto(
                "target-1",
                11,
                AuthorizationScopeDto("department", "department-1"),
                listOf("tasks.review")
            )
        )
        var lastPreviewRequest: PermissionPreviewRequestDto? = null
        var lastDelegatedAdminRequest: DelegatedAdminRevokeRequestDto? = null
        var lastManagerRequest: DepartmentManagerRequestDto? = null
        val applyKeys = mutableListOf<String>()

        override suspend fun getEffective() = Response.success(
            EffectiveAuthorizationDto(
                userId = "owner-1",
                authorizationVersion = 7,
                isPrimaryOwner = true,
                managedDepartmentIds = listOf("department-1"),
                capabilities = listOf(
                    EffectiveCapabilityDto(
                        "tasks.review",
                        "department",
                        "department-1",
                        "temporary_delegation",
                        "2026-07-20T00:00:00.000Z"
                    )
                ),
                flatPermissions = listOf("employees.view", "company.security.manage")
            )
        )

        override suspend fun getManageablePrincipals(departmentId: String?) = Response.success(
            listOf(ManageablePrincipalDto("target-1", "employee-1", "Target", departmentId, 11))
        )

        override suspend fun getGrantablePermissions(targetUserId: String, departmentId: String?) = grantableResponse

        override suspend fun previewPermissionChanges(request: PermissionPreviewRequestDto): Response<PermissionPreviewDto> {
            lastPreviewRequest = request
            return Response.success(
                PermissionPreviewDto(
                    "preview-token-long-enough",
                    "digest",
                    600,
                    request.targetUserId,
                    request.expectedAuthorizationVersion,
                    request.operations.map {
                        PermissionPreviewChangeDto(it.action, it.capability, it.scopeType, it.departmentId, "absent", "active")
                    }
                )
            )
        }

        override suspend fun applyPermissionChanges(request: PermissionApplyRequestDto): Response<EffectiveAuthorizationDto> {
            applyKeys += request.idempotencyKey
            return getEffective()
        }

        override suspend fun getDelegations() = Response.success(emptyList<TemporaryDelegationDto>())

        override suspend fun createDelegation(request: DelegationCreateRequestDto) = Response.success(
            TemporaryDelegationDto(
                "delegation-1",
                "owner-1",
                request.recipientUserId,
                request.scopeType,
                request.departmentId,
                request.validFrom,
                request.validUntil,
                "active",
                capabilities = request.capabilities,
                effective = true
            )
        )

        override suspend fun revokeDelegation(id: String, request: DelegationRevokeRequestDto) = Response.success(
            TemporaryDelegationDto(id, "owner-1", "target-1", "company", null, "from", "until", "revoked")
        )

        override suspend fun previewOwnershipTransfer(request: OwnershipPreviewRequestDto) = Response.success(
            OwnershipTransferPreviewDto(
                "ownership-preview-long-enough",
                "digest",
                600,
                "TRANSFER OWNERSHIP",
                "owner-1",
                ManageablePrincipalDto("target-1", "employee-1", "Target", authorizationVersion = 11)
            )
        )

        override suspend fun applyOwnershipTransfer(request: OwnershipApplyRequestDto) = Response.success(
            OwnershipTransferResultDto("transfer-1", false, null, true)
        )

        override suspend fun createDelegatedAdmin(request: DelegatedAdminRequestDto) = Response.success(
            DelegatedAdminResultDto(request.userId!!, request.capabilities, request.expectedVersion + 1)
        )

        override suspend fun revokeDelegatedAdmin(userId: String, request: DelegatedAdminRevokeRequestDto): Response<Unit> {
            lastDelegatedAdminRequest = request
            return Response.success(Unit)
        }

        override suspend fun getDepartmentManagers(departmentId: String) = Response.success(emptyList<DepartmentManagerDto>())

        override suspend fun assignDepartmentManager(departmentId: String, request: DepartmentManagerRequestDto) = Response.success(
            DepartmentManagerDto("manager-1", departmentId, request.userId!!, authorizationVersion = request.expectedAuthorizationVersion + 1, assignedAt = "now")
        )

        override suspend fun revokeDepartmentManager(
            departmentId: String,
            userId: String,
            request: DepartmentManagerRequestDto
        ): Response<Unit> {
            lastManagerRequest = request
            return Response.success(Unit)
        }
    }
}
