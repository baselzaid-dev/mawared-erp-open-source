package com.example.core.session

import com.example.core.auth.CompanyLoginRules
import com.example.domain.model.CurrentSession
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Keeps an active session in memory and a remembered session in encrypted storage.
 * A restored session stays locked until password login or a company-bound biometric unlock.
 */
class SessionManager(
    private val store: SessionStore? = null
) {
    private val _currentSession = MutableStateFlow<CurrentSession?>(null)
    val currentSession: StateFlow<CurrentSession?> = _currentSession.asStateFlow()

    private val _rememberedSession = MutableStateFlow<CurrentSession?>(null)
    val rememberedSession: StateFlow<CurrentSession?> = _rememberedSession.asStateFlow()

    init {
        _rememberedSession.value = try {
            store?.load()
        } catch (_: Exception) {
            null
        }
    }

    fun updateSession(session: CurrentSession?) {
        _currentSession.value = session
        _rememberedSession.value = session
        try {
            if (session != null) store?.save(session) else store?.clear()
        } catch (_: Exception) {
            // Encrypted persistence is best-effort; active memory state remains authoritative.
        }
    }

    fun clearSession() {
        _currentSession.value = null
        _rememberedSession.value = null
        try {
            store?.clear()
        } catch (_: Exception) {
            // Both in-memory copies are already cleared.
        }
    }

    fun requireSession(): CurrentSession =
        _currentSession.value ?: throw IllegalStateException("No active session found")

    fun unlockRememberedSession(companyCode: String): CurrentSession? {
        val remembered = _rememberedSession.value ?: return null
        if (!CompanyLoginRules.matchesRememberedCompany(companyCode, remembered.companyCode)) return null
        if (remembered.mfaProtected) return null
        _currentSession.value = remembered
        return remembered
    }
}
