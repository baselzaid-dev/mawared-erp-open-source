package com.example.ui

import com.example.core.session.AuthorizationSessionPolicy
import com.example.domain.model.CurrentSession
import com.example.domain.model.EffectiveAuthorization

/**
 * Behavioral controller for authorization session transitions.
 * MawaredViewModel uses this so logout, company/user switches, and
 * same-identity authorizationVersion refreshes stay testable without Android.
 */
class AuthorizationSessionController {
    var activeIdentityKey: String? = null
        private set

    fun bindSession(
        session: CurrentSession?,
        onIdentityBoundary: () -> Unit
    ): Boolean {
        if (!AuthorizationSessionPolicy.shouldHardReset(activeIdentityKey, session)) {
            return false
        }
        onIdentityBoundary()
        activeIdentityKey = AuthorizationSessionPolicy.identityKey(session)
        return true
    }

    fun ingestEffectiveAuthorization(
        session: CurrentSession?,
        effective: EffectiveAuthorization,
        onUpdate: (authorizationVersion: Int, permissions: Set<String>) -> Unit
    ): Boolean {
        if (session == null) return false
        if (AuthorizationSessionPolicy.identityKey(session) != activeIdentityKey) return false

        return when (
            val decision = AuthorizationSessionPolicy.decideSameIdentityRefresh(session, effective)
        ) {
            is AuthorizationSessionPolicy.SameIdentityRefresh.Update -> {
                onUpdate(decision.authorizationVersion, decision.permissions)
                true
            }
            AuthorizationSessionPolicy.SameIdentityRefresh.IdentityMismatch,
            AuthorizationSessionPolicy.SameIdentityRefresh.None -> false
        }
    }
}
