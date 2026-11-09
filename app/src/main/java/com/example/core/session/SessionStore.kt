package com.example.core.session

import com.example.domain.model.CurrentSession

/**
 * Persistence abstraction for the current session.
 *
 * The production implementation is [EncryptedSessionStore] (encrypted at rest).
 * Tests can supply an in-memory fake. Implementations must never write the
 * session to plaintext storage or logs.
 */
interface SessionStore {
    fun save(session: CurrentSession)
    fun load(): CurrentSession?
    fun clear()
}
