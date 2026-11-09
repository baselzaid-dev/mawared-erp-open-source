package com.example.ui

import com.example.core.utils.AppResult
import com.example.data.repository.mock.MockGlobalSearchRepository
import com.example.domain.model.GlobalSearchPage
import com.example.domain.model.GlobalSearchResult
import com.example.domain.repository.GlobalSearchRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class GlobalSearchControllerTest {

    private class FakeGlobalSearchRepository : GlobalSearchRepository {
        val responses = ArrayDeque<AppResult<GlobalSearchPage>>()
        val calls = mutableListOf<Triple<String, Int?, Int?>>()

        override suspend fun search(
            query: String,
            types: List<String>?,
            cursor: Int?,
            limit: Int?
        ): AppResult<GlobalSearchPage> {
            calls += Triple(query, cursor, limit)
            return responses.removeFirstOrNull()
                ?: AppResult.Success(GlobalSearchPage(emptyList(), null))
        }
    }

    private fun result(id: String, type: String = "employee") = GlobalSearchResult(
        type = type,
        id = id,
        title = "نتيجة $id",
        subtitle = null,
        status = null,
        routeKey = "employees.list",
        resourceType = "employee",
        resourceId = id,
        filterJson = null
    )

    @Test
    fun `short query stays idle and never calls the repository`() = runTest {
        val repository = FakeGlobalSearchRepository()
        val controller = GlobalSearchController(repository, backgroundScope)

        controller.onQueryChanged("a")
        controller.onSearch()
        runCurrent()

        assertTrue(controller.state.value is GlobalSearchUiState.Idle)
        assertEquals(0, repository.calls.size)
    }

    @Test
    fun `successful search publishes content`() = runTest {
        val repository = FakeGlobalSearchRepository()
        repository.responses += AppResult.Success(
            GlobalSearchPage(listOf(result("r1"), result("r2")), nextCursor = 2)
        )
        val controller = GlobalSearchController(repository, backgroundScope)

        controller.onQueryChanged("سالم")
        controller.onSearch()
        runCurrent()

        val content = controller.state.value as GlobalSearchUiState.Content
        assertEquals(2, content.items.size)
        assertEquals(2, content.nextCursor)
        assertEquals("سالم", content.query)
    }

    @Test
    fun `empty result publishes empty state`() = runTest {
        val repository = FakeGlobalSearchRepository()
        repository.responses += AppResult.Success(GlobalSearchPage(emptyList(), null))
        val controller = GlobalSearchController(repository, backgroundScope)

        controller.onQueryChanged("لا يوجد")
        controller.onSearch()
        runCurrent()

        assertTrue(controller.state.value is GlobalSearchUiState.Empty)
    }

    @Test
    fun `server error maps to a safe localized reason and retry works`() = runTest {
        val repository = FakeGlobalSearchRepository()
        repository.responses += AppResult.Error(Exception("search.failed"))
        repository.responses += AppResult.Success(
            GlobalSearchPage(listOf(result("r1")), null)
        )
        val controller = GlobalSearchController(repository, backgroundScope)

        controller.onQueryChanged("سالم")
        controller.onSearch()
        runCurrent()

        val error = controller.state.value as GlobalSearchUiState.Error
        assertEquals(GlobalSearchErrorKind.Failed, error.kind)

        controller.onRetry()
        runCurrent()

        assertTrue(controller.state.value is GlobalSearchUiState.Content)
        assertEquals(2, repository.calls.size)
    }

    @Test
    fun `load more appends the next page with the cursor`() = runTest {
        val repository = FakeGlobalSearchRepository()
        repository.responses += AppResult.Success(
            GlobalSearchPage(listOf(result("r1")), nextCursor = 1)
        )
        repository.responses += AppResult.Success(
            GlobalSearchPage(listOf(result("r2")), nextCursor = null)
        )
        val controller = GlobalSearchController(repository, backgroundScope)

        controller.onQueryChanged("سالم")
        controller.onSearch()
        runCurrent()
        controller.onLoadMore()
        runCurrent()

        val content = controller.state.value as GlobalSearchUiState.Content
        assertEquals(listOf("r1", "r2"), content.items.map { it.id })
        assertNull(content.nextCursor)
        assertEquals(1, repository.calls[1].second)
    }

    @Test
    fun `clearing the query below minimum drops in-flight results`() = runTest {
        val repository = FakeGlobalSearchRepository()
        repository.responses += AppResult.Success(
            GlobalSearchPage(listOf(result("r1")), null)
        )
        val controller = GlobalSearchController(repository, backgroundScope)

        controller.onQueryChanged("سالم")
        controller.onSearch()
        // The response has not been processed yet; the user clears the field.
        controller.onQueryChanged("")
        runCurrent()

        assertTrue(controller.state.value is GlobalSearchUiState.Idle)
    }

    @Test
    fun `editing one valid query to another invalidates the old response`() = runTest {
        val repository = FakeGlobalSearchRepository()
        repository.responses += AppResult.Success(
            GlobalSearchPage(listOf(result("old")), null)
        )
        val controller = GlobalSearchController(repository, backgroundScope)

        controller.onQueryChanged("سالم")
        controller.onSearch()
        controller.onQueryChanged("خالد")
        runCurrent()

        val state = controller.state.value as GlobalSearchUiState.Idle
        assertEquals("خالد", state.query)
    }

    @Test
    fun `pagination error keeps current results and exposes retry state`() = runTest {
        val repository = FakeGlobalSearchRepository()
        repository.responses += AppResult.Success(
            GlobalSearchPage(listOf(result("r1")), nextCursor = 1)
        )
        repository.responses += AppResult.Error(Exception("socket host.internal"))
        val controller = GlobalSearchController(repository, backgroundScope)

        controller.onQueryChanged("سالم")
        controller.onSearch()
        runCurrent()
        controller.onLoadMore()
        runCurrent()

        val content = controller.state.value as GlobalSearchUiState.Content
        assertEquals(listOf("r1"), content.items.map { it.id })
        assertEquals(GlobalSearchErrorKind.Connection, content.paginationError)
        assertTrue(!content.isLoadingMore)
    }

    @Test
    fun `reset returns to idle`() = runTest {
        val repository = FakeGlobalSearchRepository()
        repository.responses += AppResult.Success(
            GlobalSearchPage(listOf(result("r1")), null)
        )
        val controller = GlobalSearchController(repository, backgroundScope)

        controller.onQueryChanged("سالم")
        controller.onSearch()
        runCurrent()
        controller.reset()

        assertTrue(controller.state.value is GlobalSearchUiState.Idle)
    }

    @Test
    fun `mock repository honors minimum query and type filters`() = runTest {
        val repository = MockGlobalSearchRepository()

        val tooShort = repository.search("س")
        assertTrue(tooShort is AppResult.Error)

        val employees = repository.search("سالم", types = listOf("employee"))
        val page = (employees as AppResult.Success).data
        assertEquals(1, page.items.size)
        assertEquals("employee", page.items[0].type)

        val vendorsOnly = repository.search("سالم", types = listOf("vendor"))
        assertTrue((vendorsOnly as AppResult.Success).data.items.isEmpty())
    }
}
