package com.example.core.session

import com.example.domain.model.CurrentSession
import com.example.domain.model.EffectiveAuthorization

/**
 * Explicit same-identity authorization refresh policy for RC2.
 *
 * Hard reset happens only when company/user identity changes.
 * Soft refresh updates local permissions when the same identity receives a
 * newer authorizationVersion or a different effective permission set.
 */
object AuthorizationSessionPolicy {
    fun identityKey(session: CurrentSession?): String? =
        session?.let { "${it.companyId}:${it.userId}" }

    fun shouldHardReset(activeIdentityKey: String?, session: CurrentSession?): Boolean =
        identityKey(session) != activeIdentityKey

    sealed class SameIdentityRefresh {
        data object None : SameIdentityRefresh()
        data object IdentityMismatch : SameIdentityRefresh()
        data class Update(
            val authorizationVersion: Int,
            val permissions: Set<String>
        ) : SameIdentityRefresh()
    }

    fun decideSameIdentityRefresh(
        session: CurrentSession,
        effective: EffectiveAuthorization
    ): SameIdentityRefresh {
        if (effective.userId != session.userId) return SameIdentityRefresh.IdentityMismatch
        if (effective.authorizationVersion < 0) return SameIdentityRefresh.None

        val permissions = effectivePermissions(effective)
        val versionChanged = effective.authorizationVersion != session.authorizationVersion
        val permissionsChanged = permissions != session.permissions
        if (!versionChanged && !permissionsChanged) return SameIdentityRefresh.None

        return SameIdentityRefresh.Update(
            authorizationVersion = effective.authorizationVersion,
            permissions = permissions
        )
    }

    fun effectivePermissions(effective: EffectiveAuthorization): Set<String> =
        // Backend effective summary always includes flatPermissions (including []).
        // Prefer that list so an intentional empty snapshot cannot be rebuilt from
        // department-scoped capability rows.
        effective.flatPermissions.toSet()
}
