package com.example.data.repository.mock

import com.example.core.utils.AppResult
import com.example.domain.model.GlobalSearchPage
import com.example.domain.model.GlobalSearchResult
import com.example.domain.model.GlobalSearchRules
import kotlinx.coroutines.delay

/**
 * Demo-mode search over a small fixed catalog. Mirrors the server contract:
 * minimum query length, type filtering, and deterministic ordering.
 */
class MockGlobalSearchRepository : com.example.domain.repository.GlobalSearchRepository {

    private val catalog = listOf(
        GlobalSearchResult(
            type = "employee", id = "demo-emp-1", title = "سالم الحربي",
            subtitle = "محاسب — المالية", status = null,
            routeKey = "employees.list", resourceType = "employee",
            resourceId = "demo-emp-1", filterJson = "{\"employeeId\":\"demo-emp-1\"}"
        ),
        GlobalSearchResult(
            type = "vendor", id = "demo-v-1", title = "شركة الخليج للتوريدات",
            subtitle = "قرطاسية", status = "active",
            routeKey = "vendors.list", resourceType = "vendor",
            resourceId = "demo-v-1", filterJson = "{\"vendorId\":\"demo-v-1\"}"
        ),
        GlobalSearchResult(
            type = "purchase_request", id = "demo-pr-1", title = "شراء أوراق طابعة",
            subtitle = "PR-100", status = "pending_department",
            routeKey = "purchasing.requests", resourceType = "purchaserequest",
            resourceId = "demo-pr-1", filterJson = "{\"requestId\":\"demo-pr-1\"}"
        ),
        GlobalSearchResult(
            type = "training_course", id = "demo-tc-1", title = "أساسيات السلامة",
            subtitle = "TR-01", status = "published",
            routeKey = "training.courses", resourceType = "trainingcourse",
            resourceId = "demo-tc-1", filterJson = "{\"courseId\":\"demo-tc-1\"}"
        ),
        GlobalSearchResult(
            type = "task", id = "demo-t-1", title = "تقرير الربع المالي",
            subtitle = "high", status = "active",
            routeKey = "task.detail", resourceType = "task",
            resourceId = "demo-t-1", filterJson = null
        )
    )

    override suspend fun search(
        query: String,
        types: List<String>?,
        cursor: Int?,
        limit: Int?
    ): AppResult<GlobalSearchPage> {
        delay(150)
        if (!GlobalSearchRules.isQuerySearchable(query)) {
            return AppResult.Error(Exception("search.query_length"))
        }
        val normalized = GlobalSearchRules.normalizedQuery(query)
        val filtered = catalog.filter { result ->
            (types.isNullOrEmpty() || types.contains(result.type)) &&
                (result.title.contains(normalized, ignoreCase = true) ||
                    result.subtitle?.contains(normalized, ignoreCase = true) == true)
        }
        val start = (cursor ?: 0).coerceAtLeast(0)
        val pageSize = (limit ?: 20).coerceIn(1, 25)
        val page = filtered.drop(start).take(pageSize)
        val nextCursor = (start + page.size).takeIf { it < filtered.size }
        return AppResult.Success(GlobalSearchPage(items = page, nextCursor = nextCursor))
    }
}
