package com.example.ui

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class NotificationPreferencesControllerTest {
    private val samplePreferences = listOf(
        NotificationPreferenceItem("general", inAppEnabled = true, mandatory = false),
        NotificationPreferenceItem("security", inAppEnabled = true, mandatory = true),
        NotificationPreferenceItem("leave", inAppEnabled = true, mandatory = false)
    )

    @Test
    fun `load success shows content with persisted preferences`() = runTest {
        val repository = FakeNotificationPreferencesRepository(
            preferences = samplePreferences
        )
        val controller = NotificationPreferencesController(repository, backgroundScope)

        controller.load()
        runCurrent()

        val state = controller.state.value as NotificationPreferencesUiState.Content
        assertEquals(samplePreferences, state.content.items)
        assertEquals(samplePreferences, state.content.persistedItems)
        assertFalse(state.content.isDirty)
        assertEquals(NotificationPreferencesSaveState.Idle, state.content.saveState)
    }

    @Test
    fun `load failure shows error and retry reloads`() = runTest {
        val repository = FakeNotificationPreferencesRepository(
            loadError = AppResult.Error(Exception("network down"))
        )
        val controller = NotificationPreferencesController(repository, backgroundScope)

        controller.load()
        runCurrent()
        assertTrue(controller.state.value is NotificationPreferencesUiState.Error)

        repository.loadError = null
        repository.preferences = samplePreferences
        controller.retry()
        runCurrent()

        assertTrue(controller.state.value is NotificationPreferencesUiState.Content)
    }

    @Test
    fun `toggle non-mandatory category marks dirty without saving`() = runTest {
        val repository = FakeNotificationPreferencesRepository(
            preferences = samplePreferences
        )
        val controller = NotificationPreferencesController(repository, backgroundScope)
        controller.load()
        runCurrent()

        controller.toggleCategory("leave", enabled = false)
        runCurrent()

        val state = controller.state.value as NotificationPreferencesUiState.Content
        assertTrue(state.content.isDirty)
        assertEquals(false, state.content.items.first { it.category == "leave" }.inAppEnabled)
        assertEquals(0, repository.updateCalls)
    }

    @Test
    fun `mandatory security category cannot be toggled off`() = runTest {
        val repository = FakeNotificationPreferencesRepository(
            preferences = samplePreferences
        )
        val controller = NotificationPreferencesController(repository, backgroundScope)
        controller.load()
        runCurrent()

        controller.toggleCategory("security", enabled = false)
        runCurrent()

        val state = controller.state.value as NotificationPreferencesUiState.Content
        assertFalse(state.content.isDirty)
        assertTrue(state.content.items.first { it.category == "security" }.inAppEnabled)
    }

    @Test
    fun `save success clears dirty and shows saved feedback`() = runTest {
        val repository = FakeNotificationPreferencesRepository(
            preferences = samplePreferences
        )
        val controller = NotificationPreferencesController(repository, backgroundScope)
        controller.load()
        runCurrent()

        controller.toggleCategory("general", enabled = false)
        runCurrent()
        controller.save()
        runCurrent()

        val state = controller.state.value as NotificationPreferencesUiState.Content
        assertFalse(state.content.isDirty)
        assertEquals(NotificationPreferencesSaveState.Saved, state.content.saveState)
        assertEquals(false, state.content.persistedItems.first { it.category == "general" }.inAppEnabled)
        assertEquals(1, repository.updateCalls)
    }

    @Test
    fun `save failure keeps dirty state and does not claim success`() = runTest {
        val repository = FakeNotificationPreferencesRepository(
            preferences = samplePreferences,
            updateError = AppResult.Error(
                AppError.ValidationError("notification.mandatory_category")
            )
        )
        val controller = NotificationPreferencesController(repository, backgroundScope)
        controller.load()
        runCurrent()

        controller.toggleCategory("leave", enabled = false)
        runCurrent()
        controller.save()
        runCurrent()

        val state = controller.state.value as NotificationPreferencesUiState.Content
        assertTrue(state.content.isDirty)
        assertEquals(NotificationPreferencesSaveState.Failed, state.content.saveState)
        assertTrue(state.content.saveErrorMessage.orEmpty().contains("الأمان"))
        assertEquals(
            true,
            state.content.persistedItems.first { it.category == "leave" }.inAppEnabled
        )
        assertEquals(
            false,
            state.content.items.first { it.category == "leave" }.inAppEnabled
        )
    }

    @Test
    fun `save while already saving is ignored`() = runTest {
        val repository = FakeNotificationPreferencesRepository(
            preferences = samplePreferences,
            blockUpdateUntil = kotlinx.coroutines.CompletableDeferred()
        )
        val controller = NotificationPreferencesController(repository, backgroundScope)
        controller.load()
        runCurrent()
        controller.toggleCategory("general", enabled = false)
        runCurrent()

        controller.save()
        runCurrent()
        controller.save()
        runCurrent()

        assertEquals(1, repository.updateCalls)
        repository.blockUpdateUntil?.complete(Unit)
        runCurrent()
    }

    private class FakeNotificationPreferencesRepository(
        var preferences: List<NotificationPreferenceItem> = emptyList(),
        var loadError: AppResult.Error? = null,
        var updateError: AppResult.Error? = null,
        var blockUpdateUntil: kotlinx.coroutines.CompletableDeferred<Unit>? = null
    ) : NotificationPreferencesRepository {
        var updateCalls = 0

        override suspend fun getPreferences(): AppResult<List<NotificationPreferenceItem>> {
            loadError?.let { return it }
            return AppResult.Success(preferences)
        }

        override suspend fun updatePreferences(
            preferences: List<NotificationPreferenceItem>
        ): AppResult<List<NotificationPreferenceItem>> {
            updateCalls += 1
            blockUpdateUntil?.await()
            updateError?.let { return it }
            this.preferences = preferences
            return AppResult.Success(preferences)
        }
    }
}
