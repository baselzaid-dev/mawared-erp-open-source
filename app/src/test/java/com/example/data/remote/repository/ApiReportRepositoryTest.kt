package com.example.data.remote.repository

import com.example.core.utils.AppResult
import com.example.data.remote.api.ReportApi
import com.example.data.remote.api.ReportCatalogItemDto
import com.example.data.remote.api.ReportDetailDto
import com.example.data.remote.api.ReportExportRequestDto
import com.example.data.remote.api.ReportOverviewDto
import com.example.data.remote.api.ReportOverviewSectionDto
import com.example.data.remote.api.ReportPaginationDto
import com.example.data.remote.api.ReportRangeDto
import com.example.data.remote.api.ReportScopeDto
import com.example.data.remote.api.ReportTemplateCatalogItemDto
import com.example.data.remote.api.ReportTemplateDocumentDto
import com.example.data.remote.api.ReportTemplateExportRequestDto
import com.example.data.remote.api.ReportTemplatePreviewRequestDto
import com.example.data.remote.api.ReportTemplateSectionDto
import com.example.data.remote.api.CreateSavedReportTemplateRequestDto
import com.example.data.remote.api.SavedReportTemplateDto
import com.example.domain.model.ReportTemplateExportFormat
import com.example.domain.model.SaveReportTemplateRequest
import kotlinx.coroutines.test.runTest
import okhttp3.Headers
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

class ApiReportRepositoryTest {

    @Test
    fun `catalog and detail mapping preserve server authorization and exact money strings`() = runTest {
        val api = FakeReportApi().apply {
            catalogResponse = Response.success(listOf(
                ReportCatalogItemDto(
                    type = "payroll",
                    title = "الرواتب",
                    description = "تقرير الرواتب",
                    availableScopes = listOf("company"),
                    supportedFilters = listOf("periodId"),
                    exportAvailable = true,
                    containsFinancialData = true
                )
            ))
            detailResponse = Response.success(
                ReportDetailDto(
                    type = "payroll",
                    generatedAt = "2026-07-11T00:00:00.000Z",
                    scope = ReportScopeDto("company"),
                    summary = mapOf(
                        "visibleNet" to "1234.50",
                        "visibleEmployeeCount" to 2.0
                    ),
                    rows = listOf(mapOf("employeeName" to "موظف", "netPay" to "617.25")),
                    pagination = ReportPaginationDto(1, 25, 1),
                    protectedRowsHidden = true,
                    protectedRowCount = 1
                )
            )
        }
        val repository = ApiReportRepository(api)

        val catalog = repository.loadCatalog() as AppResult.Success
        assertEquals(listOf("payroll"), catalog.data.map { it.type })
        assertTrue(catalog.data.single().exportAvailable)

        val detail = repository.loadDetail("payroll", emptyMap()) as AppResult.Success
        assertEquals("1234.50", detail.data.summary["visibleNet"])
        assertEquals("2", detail.data.summary["visibleEmployeeCount"])
        assertEquals("617.25", detail.data.rows.single()["netPay"])
        assertTrue(detail.data.protectedRowsHidden)
    }

    @Test
    fun `CSV export accepts only text csv and replaces traversal filenames`() = runTest {
        val csv = "\uFEFF\"العنوان\"\r\n\"قيمة\"\r\n"
        val api = FakeReportApi().apply {
            exportResponse = Response.success(
                csv.toResponseBody("text/csv; charset=utf-8".toMediaType()),
                Headers.headersOf(
                    "Content-Type", "text/csv; charset=utf-8",
                    "Content-Disposition", "attachment; filename=../../private.csv"
                )
            )
        }
        val repository = ApiReportRepository(api)
        val result = repository.exportCsv("attendance", emptyMap()) as AppResult.Success
        assertEquals("mawared_attendance.csv", result.data.filename)
        assertEquals("text/csv", result.data.mimeType)
        assertEquals(csv, result.data.bytes.toString(Charsets.UTF_8))

        api.exportResponse = Response.success(
            "not csv".toResponseBody("application/json".toMediaType()),
            Headers.headersOf("Content-Type", "application/json")
        )
        assertTrue(repository.exportCsv("attendance", emptyMap()) is AppResult.Error)
    }

    @Test
    fun `template catalog preview save and export map server shapes`() = runTest {
        val api = FakeReportApi().apply {
            templateCatalogResponse = Response.success(listOf(
                ReportTemplateCatalogItemDto(
                    builtInKey = "attendance",
                    version = 1,
                    kind = "single",
                    modules = listOf("attendance"),
                    title = "الحضور",
                    description = "desc",
                    formats = listOf("csv", "xlsx", "pdf")
                )
            ))
            templatePreviewResponse = Response.success(
                ReportTemplateDocumentDto(
                    builtInKey = "attendance",
                    templateVersion = 1,
                    generatedAt = "2026-07-19T00:00:00.000Z",
                    scope = ReportScopeDto("company"),
                    sections = listOf(
                        ReportTemplateSectionDto(
                            module = "attendance",
                            title = "الحضور",
                            summary = mapOf("recordCount" to 1),
                            rows = listOf(mapOf("employeeName" to "موظف", "status" to "present")),
                            rowCount = 1
                        )
                    )
                )
            )
            savedTemplateResponse = Response.success(
                SavedReportTemplateDto(
                    id = "saved-1",
                    name = "قالبي",
                    builtInKey = "attendance",
                    templateVersion = 1,
                    scope = ReportScopeDto("company"),
                    filters = mapOf("from" to "2026-07-01")
                )
            )
            templateExportResponse = Response.success(
                "csv".toResponseBody("text/csv".toMediaType()),
                Headers.headersOf(
                    "Content-Type", "text/csv",
                    "Content-Disposition", "attachment; filename=../../bad.csv"
                )
            )
        }
        val repository = ApiReportRepository(api)

        val catalog = repository.loadTemplateCatalog() as AppResult.Success
        assertEquals("attendance", catalog.data.single().builtInKey)

        val preview = repository.previewTemplate("attendance", 1, null, mapOf("from" to "2026-07-01")) as AppResult.Success
        assertEquals("1", preview.data.sections.single().summary["recordCount"])
        assertEquals("present", preview.data.sections.single().rows.single()["status"])

        val saved = repository.saveTemplate(
            SaveReportTemplateRequest(
                name = "قالبي",
                builtInKey = "attendance",
                templateVersion = 1,
                filters = mapOf("from" to "2026-07-01")
            )
        ) as AppResult.Success
        assertEquals("saved-1", saved.data.id)

        val export = repository.exportTemplate(
            builtInKey = "attendance",
            templateVersion = 1,
            departmentId = null,
            filters = emptyMap(),
            format = ReportTemplateExportFormat.CSV
        ) as AppResult.Success
        assertEquals("mawared_attendance.csv", export.data.filename)
        assertEquals("text/csv", export.data.mimeType)
    }

    private class FakeReportApi : ReportApi {
        var catalogResponse: Response<List<ReportCatalogItemDto>> = Response.success(emptyList())
        var overviewResponse: Response<ReportOverviewDto> = Response.success(
            ReportOverviewDto(
                generatedAt = "2026-07-11T00:00:00.000Z",
                dateRange = ReportRangeDto("2026-07-01", "2026-07-11"),
                scope = ReportScopeDto("company"),
                sections = mapOf("attendance" to ReportOverviewSectionDto("الحضور"))
            )
        )
        var detailResponse: Response<ReportDetailDto> = Response.success(
            ReportDetailDto(
                type = "attendance",
                generatedAt = "2026-07-11T00:00:00.000Z",
                scope = ReportScopeDto("company"),
                pagination = ReportPaginationDto(1, 25, 0)
            )
        )
        var exportResponse: Response<ResponseBody> = Response.success(
            "".toResponseBody("text/csv".toMediaType())
        )
        var templateCatalogResponse: Response<List<ReportTemplateCatalogItemDto>> = Response.success(emptyList())
        var templatePreviewResponse: Response<ReportTemplateDocumentDto> = Response.success(
            ReportTemplateDocumentDto(
                builtInKey = "attendance",
                templateVersion = 1,
                generatedAt = "2026-07-19T00:00:00.000Z",
                scope = ReportScopeDto("company")
            )
        )
        var savedTemplatesResponse: Response<List<SavedReportTemplateDto>> = Response.success(emptyList())
        var savedTemplateResponse: Response<SavedReportTemplateDto> = Response.success(
            SavedReportTemplateDto(
                id = "saved-1",
                name = "قالب",
                builtInKey = "attendance",
                templateVersion = 1,
                scope = ReportScopeDto("company")
            )
        )
        var templateExportResponse: Response<ResponseBody> = Response.success(
            "".toResponseBody("text/csv".toMediaType())
        )

        override suspend fun getCatalog() = catalogResponse

        override suspend fun getOverview(from: String, to: String, departmentId: String?) =
            overviewResponse

        override suspend fun getReport(type: String, filters: Map<String, String>) = detailResponse

        override suspend fun exportCsv(request: ReportExportRequestDto) = exportResponse

        override suspend fun getTemplateCatalog() = templateCatalogResponse

        override suspend fun previewTemplate(request: ReportTemplatePreviewRequestDto) =
            templatePreviewResponse

        override suspend fun getSavedTemplates(includeArchived: Boolean?) = savedTemplatesResponse

        override suspend fun createSavedTemplate(request: CreateSavedReportTemplateRequestDto) =
            savedTemplateResponse

        override suspend fun archiveSavedTemplate(id: String) = savedTemplateResponse

        override suspend fun exportTemplate(request: ReportTemplateExportRequestDto) =
            templateExportResponse
    }
}
