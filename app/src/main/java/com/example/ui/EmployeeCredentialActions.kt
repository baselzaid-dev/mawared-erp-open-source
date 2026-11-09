package com.example.ui

import com.example.core.permissions.PermissionChecker
import com.example.core.permissions.Permissions
import com.example.domain.model.EmployeeParams

object EmployeeCredentialRules {
    fun canCreateCredential(permissions: Set<String>): Boolean =
        PermissionChecker(permissions).hasPermission(Permissions.EMPLOYEES_CREDENTIALS_CREATE)

    fun canResetCredential(permissions: Set<String>): Boolean =
        PermissionChecker(permissions).hasPermission(Permissions.EMPLOYEES_CREDENTIALS_RESET)

    fun canArchiveEmployee(permissions: Set<String>): Boolean =
        PermissionChecker(permissions).hasPermission(Permissions.EMPLOYEES_ARCHIVE)

    fun canManageSessions(permissions: Set<String>): Boolean =
        PermissionChecker(permissions).hasPermission(Permissions.COMPANY_SESSIONS_MANAGE)

    fun canCreateCredentialFor(
        employee: EmployeeParams,
        permissions: Set<String>
    ): Boolean = canCreateCredential(permissions) &&
        employee.userId.isNullOrBlank() &&
        employee.archivedAtIso.isNullOrBlank() &&
        employee.status.lowercase() == "active"

    fun canResetCredentialFor(
        employee: EmployeeParams,
        currentUserId: String?,
        actorEmployeeId: String?,
        permissions: Set<String>,
        isPrimaryOwnerTarget: Boolean = false
    ): Boolean = canResetCredential(permissions) &&
        !isPrimaryOwnerTarget &&
        !currentUserId.isNullOrBlank() &&
        !employee.userId.isNullOrBlank() &&
        employee.userId != currentUserId &&
        employee.id != actorEmployeeId &&
        employee.archivedAtIso.isNullOrBlank() &&
        (employee.credentialVersion ?: 0) >= 1

    fun canArchiveEmployeeRecord(
        employee: EmployeeParams,
        currentUserId: String?,
        actorEmployeeId: String?,
        isPrimaryOwnerTarget: Boolean,
        permissions: Set<String>
    ): Boolean = canArchiveEmployee(permissions) &&
        !currentUserId.isNullOrBlank() &&
        employee.id != actorEmployeeId &&
        employee.userId != currentUserId &&
        !isPrimaryOwnerTarget &&
        employee.archivedAtIso.isNullOrBlank() &&
        employee.status.lowercase() != "archived" &&
        !employee.updatedAtIso.isNullOrBlank()
}
