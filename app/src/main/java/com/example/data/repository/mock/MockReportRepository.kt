package com.example.data.repository.mock

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.domain.model.ReportCatalogItem
import com.example.domain.model.ReportDetailParams
import com.example.domain.model.ReportExportPayload
import com.example.domain.model.ReportOverview
import com.example.domain.model.ReportScope
import com.example.domain.model.ReportTemplateCatalogItem
import com.example.domain.model.ReportTemplateDocument
import com.example.domain.model.ReportTemplateExportFormat
import com.example.domain.model.ReportTemplateSection
import com.example.domain.model.SaveReportTemplateRequest
import com.example.domain.model.SavedReportTemplate
import com.example.domain.repository.ReportRepository

class MockReportRepository : ReportRepository {
    private val mockCatalog = listOf(
        ReportTemplateCatalogItem(
            builtInKey = "attendance",
            version = 1,
            kind = "single",
            modules = listOf("attendance"),
            title = "الحضور والانصراف",
            description = "قالب مبني على تقرير الحضور والانصراف الحالي",
            formats = listOf("csv", "xlsx", "pdf"),
            maximumRangeDays = 366
        )
    )
    private val savedTemplates = mutableListOf<SavedReportTemplate>()

    override suspend fun loadCatalog(): AppResult<List<ReportCatalogItem>> =
        AppResult.Success(emptyList())

    override suspend fun loadOverview(
        from: String,
        to: String,
        departmentId: String?
    ): AppResult<ReportOverview> = unavailable()

    override suspend fun loadDetail(
        type: String,
        filters: Map<String, String>
    ): AppResult<ReportDetailParams> = unavailable()

    override suspend fun exportCsv(
        type: String,
        filters: Map<String, String>
    ): AppResult<ReportExportPayload> = unavailable()

    override suspend fun loadTemplateCatalog(): AppResult<List<ReportTemplateCatalogItem>> =
        AppResult.Success(mockCatalog)

    override suspend fun previewTemplate(
        builtInKey: String,
        templateVersion: Int,
        departmentId: String?,
        filters: Map<String, String>
    ): AppResult<ReportTemplateDocument> {
        val item = mockCatalog.firstOrNull {
            it.builtInKey == builtInKey && it.version == templateVersion
        } ?: return AppResult.Error(
            Exception("القالب غير موجود"),
            AppError.ServerError(404, "القالب غير موجود")
        )
        return AppResult.Success(
            ReportTemplateDocument(
                builtInKey = item.builtInKey,
                templateVersion = item.version,
                generatedAt = "2026-07-19T00:00:00.000Z",
                scope = ReportScope(
                    kind = if (departmentId == null) "company" else "department",
                    departmentId = departmentId
                ),
                sections = listOf(
                    ReportTemplateSection(
                        module = item.modules.first(),
                        title = item.title,
                        summary = mapOf("recordCount" to "1"),
                        rows = listOf(
                            mapOf(
                                "employeeName" to "موظف تجريبي",
                                "status" to "present",
                                "date" to filters["from"].orEmpty()
                            )
                        ),
                        rowCount = 1,
                        truncated = false,
                        warnings = emptyList()
                    )
                ),
                warnings = emptyList()
            )
        )
    }

    override suspend fun loadSavedTemplates(includeArchived: Boolean): AppResult<List<SavedReportTemplate>> {
        val visible = savedTemplates.filter { includeArchived || it.archivedAt == null }
        return AppResult.Success(visible)
    }

    override suspend fun saveTemplate(request: SaveReportTemplateRequest): AppResult<SavedReportTemplate> {
        val saved = SavedReportTemplate(
            id = "mock-template-${savedTemplates.size + 1}",
            name = request.name,
            builtInKey = request.builtInKey,
            templateVersion = request.templateVersion,
            scope = ReportScope(
                kind = if (request.departmentId == null) "company" else "department",
                departmentId = request.departmentId
            ),
            filters = request.filters,
            preferredFormat = request.preferredFormat?.apiValue,
            archivedAt = null,
            createdAt = "2026-07-19T00:00:00.000Z",
            updatedAt = "2026-07-19T00:00:00.000Z"
        )
        savedTemplates.add(0, saved)
        return AppResult.Success(saved)
    }

    override suspend fun archiveSavedTemplate(id: String): AppResult<SavedReportTemplate> {
        val index = savedTemplates.indexOfFirst { it.id == id }
        if (index < 0) {
            return AppResult.Error(
                Exception("القالب المحفوظ غير موجود"),
                AppError.ServerError(404, "القالب المحفوظ غير موجود")
            )
        }
        val archived = savedTemplates[index].copy(archivedAt = "2026-07-19T12:00:00.000Z")
        savedTemplates[index] = archived
        return AppResult.Success(archived)
    }

    override suspend fun exportTemplate(
        builtInKey: String,
        templateVersion: Int,
        departmentId: String?,
        filters: Map<String, String>,
        format: ReportTemplateExportFormat,
        locale: String
    ): AppResult<ReportExportPayload> {
        val bytes = when (format) {
            ReportTemplateExportFormat.CSV -> "\uFEFF\"العنوان\"\r\n\"قيمة\"\r\n".toByteArray(Charsets.UTF_8)
            ReportTemplateExportFormat.XLSX -> byteArrayOf(0x50, 0x4B, 0x03, 0x04)
            ReportTemplateExportFormat.PDF -> "%PDF-1.4\n".toByteArray(Charsets.UTF_8)
        }
        return AppResult.Success(
            ReportExportPayload(
                bytes = bytes,
                filename = "mawared_${builtInKey}.${format.fileExtension}",
                mimeType = format.mimeType
            )
        )
    }

    override fun clear() {
        savedTemplates.clear()
    }

    private fun unavailable(): AppResult.Error {
        val message = "التقارير الموحدة متاحة عند الاتصال بالخادم"
        return AppResult.Error(Exception(message), AppError.ServerError(503, message))
    }
}
