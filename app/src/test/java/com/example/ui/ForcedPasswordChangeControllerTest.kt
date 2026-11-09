package com.example.ui

import com.example.core.utils.AppResult
import com.example.data.repository.mock.MockCredentialRepository
import com.example.domain.model.*
import com.example.domain.repository.CredentialRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ForcedPasswordChangeControllerTest {
    @Test
    fun `submit success completes blocking state`() = runTest {
        val repository = MockCredentialRepository()
        var changed: ForcedPasswordChangeResult? = null
        val controller = ForcedPasswordChangeController(
            repository = repository,
            scope = backgroundScope,
            onPasswordChanged = { changed = it }
        )

        controller.onSubmit(
            temporaryPassword = MockCredentialRepository.DEMO_TEMP_PASSWORD,
            newPassword = "NewSecurePass1",
            confirmPassword = "NewSecurePass1"
        )
        runCurrent()

        val completed = controller.state.value as ForcedPasswordChangeUiState.Completed
        assertEquals(2, completed.result.sessionsRevoked)
        assertEquals(2, changed?.sessionsRevoked)
    }

    @Test
    fun `invalid temporary password stays blocking without success callback`() = runTest {
        val repository = MockCredentialRepository()
        var callbackCount = 0
        val controller = ForcedPasswordChangeController(
            repository = repository,
            scope = backgroundScope,
            onPasswordChanged = { callbackCount += 1 }
        )

        controller.onSubmit(
            temporaryPassword = "wrong-temp",
            newPassword = "NewSecurePass1",
            confirmPassword = "NewSecurePass1"
        )
        runCurrent()

        val blocking = controller.state.value as ForcedPasswordChangeUiState.Blocking
        assertTrue(blocking.errorMessage.orEmpty().isNotBlank())
        assertEquals(0, callbackCount)
    }

    @Test
    fun `local mismatch blocks submit before repository call`() = runTest {
        val repository = TrackingCredentialRepository()
        val controller = ForcedPasswordChangeController(repository, backgroundScope)

        controller.onSubmit(
            temporaryPassword = "TempPass1234",
            newPassword = "NewSecurePass1",
            confirmPassword = "DifferentPass1"
        )
        runCurrent()

        assertTrue(controller.state.value is ForcedPasswordChangeUiState.Blocking)
        assertEquals(0, repository.changeCalls)
    }

    @Test
    fun `reset clears blocking error`() = runTest {
        val controller = ForcedPasswordChangeController(MockCredentialRepository(), backgroundScope)
        controller.onSubmit("a", "b", "c")
        runCurrent()
        controller.reset()

        val blocking = controller.state.value as ForcedPasswordChangeUiState.Blocking
        assertNull(blocking.errorMessage)
        assertEquals(false, blocking.isSubmitting)
    }

    private class TrackingCredentialRepository : CredentialRepository {
        var changeCalls = 0

        override suspend fun changeTemporaryPassword(
            request: ForcedPasswordChangeRequest
        ): AppResult<ForcedPasswordChangeResult> {
            changeCalls += 1
            return AppResult.Success(
                ForcedPasswordChangeResult("2026-07-19T12:00:00.000Z", 0)
            )
        }

        override suspend fun createEmployeeCredential(
            employeeId: String,
            request: CreateEmployeeCredentialRequest
        ): AppResult<OneTimeCredential> = AppResult.Error(Exception("unused"))

        override suspend fun resetEmployeeCredential(
            employeeId: String,
            request: ResetEmployeeCredentialRequest
        ): AppResult<OneTimeCredential> = AppResult.Error(Exception("unused"))

        override suspend fun archiveEmployee(
            employeeId: String,
            request: EmployeeArchiveRequest
        ): AppResult<EmployeeArchiveResult> = AppResult.Error(Exception("unused"))

        override suspend fun reactivateEmployee(
            employeeId: String,
            request: EmployeeArchiveRequest
        ): AppResult<EmployeeArchiveResult> = AppResult.Error(Exception("unused"))
    }
}
