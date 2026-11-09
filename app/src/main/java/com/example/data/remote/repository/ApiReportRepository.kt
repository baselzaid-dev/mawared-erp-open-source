package com.example.data.remote.repository

import com.example.core.export.ReportExportFilename
import com.example.core.export.ReportExportStore
import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.CreateSavedReportTemplateRequestDto
import com.example.data.remote.api.ReportApi
import com.example.data.remote.api.ReportCatalogItemDto
import com.example.data.remote.api.ReportDetailDto
import com.example.data.remote.api.ReportErrorResponseDto
import com.example.data.remote.api.ReportExportRequestDto
import com.example.data.remote.api.ReportOverviewDto
import com.example.data.remote.api.ReportTemplateCatalogItemDto
import com.example.data.remote.api.ReportTemplateDocumentDto
import com.example.data.remote.api.ReportTemplateErrorResponseDto
import com.example.data.remote.api.ReportTemplateExportRequestDto
import com.example.data.remote.api.ReportTemplatePreviewRequestDto
import com.example.data.remote.api.ReportTemplateScopeRequestDto
import com.example.data.remote.api.SavedReportTemplateDto
import com.example.domain.model.ReportCatalogItem
import com.example.domain.model.ReportDetailParams
import com.example.domain.model.ReportExportPayload
import com.example.domain.model.ReportOverview
import com.example.domain.model.ReportOverviewSection
import com.example.domain.model.ReportPagination
import com.example.domain.model.ReportRange
import com.example.domain.model.ReportScope
import com.example.domain.model.ReportTemplateCatalogItem
import com.example.domain.model.ReportTemplateDocument
import com.example.domain.model.ReportTemplateExportFormat
import com.example.domain.model.ReportTemplateSection
import com.example.domain.model.SaveReportTemplateRequest
import com.example.domain.model.SavedReportTemplate
import com.example.domain.repository.ReportRepository
import com.example.ui.PayrollExportStore
import com.squareup.moshi.Moshi
import okhttp3.ResponseBody
import retrofit2.Response
import java.io.ByteArrayOutputStream

class ApiReportRepository(
    private val reportApi: ReportApi
) : ReportRepository {
    private val moshi = Moshi.Builder().build()
    private val errorAdapter = moshi.adapter(ReportErrorResponseDto::class.java)
    private val templateErrorAdapter = moshi.adapter(ReportTemplateErrorResponseDto::class.java)

    private fun displayValue(value: Any?): String? = when (value) {
        null -> null
        is String -> value
        is Boolean -> value.toString()
        is Byte, is Short, is Int, is Long -> value.toString()
        is Float, is Double -> {
            val number = (value as Number).toDouble()
            if (number.isFinite() && number % 1.0 == 0.0) number.toLong().toString()
            else number.toString()
        }
        is Number -> value.toString()
        is Map<*, *> -> value.entries
            .sortedBy { it.key.toString() }
            .joinToString(prefix = "{", postfix = "}") { (key, nested) ->
                "${key}:${displayValue(nested).orEmpty()}"
            }
        is List<*> -> value.joinToString(prefix = "[", postfix = "]") { displayValue(it).orEmpty() }
        else -> value.toString()
    }

    private fun Map<String, Any?>.toDisplayMap(): Map<String, String?> =
        entries.associate { (key, value) -> key to displayValue(value) }

    private fun ReportCatalogItemDto.toParams() = ReportCatalogItem(
        type = type,
        title = title,
        description = description,
        availableScopes = availableScopes,
        supportedFilters = supportedFilters,
        exportAvailable = exportAvailable,
        containsFinancialData = containsFinancialData,
        maximumRangeDays = maximumRangeDays
    )

    private fun ReportOverviewDto.toParams() = ReportOverview(
        generatedAt = generatedAt,
        dateRange = ReportRange(dateRange.from, dateRange.to),
        scope = ReportScope(scope.kind, scope.departmentId),
        sections = sections.mapValues { (_, section) ->
            ReportOverviewSection(
                title = section.title,
                metrics = section.metrics.toDisplayMap(),
                protectedRowsHidden = section.protectedRowsHidden
            )
        },
        unavailableSections = unavailableSections,
        warnings = warnings
    )

    private fun ReportDetailDto.toParams() = ReportDetailParams(
        type = type,
        generatedAt = generatedAt,
        range = range?.let { ReportRange(it.from, it.to) },
        scope = ReportScope(scope.kind, scope.departmentId),
        summary = summary.toDisplayMap(),
        rows = rows.map { it.toDisplayMap() },
        pagination = ReportPagination(pagination.page, pagination.pageSize, pagination.total),
        warnings = warnings,
        protectedRowsHidden = protectedRowsHidden,
        protectedRowCount = protectedRowCount
    )

    private fun <T> responseError(response: Response<T>, fallback: String): AppResult.Error {
        val payload = try {
            response.errorBody()?.string()?.let(errorAdapter::fromJson)
        } catch (_: Exception) {
            null
        }
        val message = payload?.message?.takeIf { it.isNotBlank() }
            ?: payload?.error?.takeIf { it.isNotBlank() }
            ?: fallback
        return AppResult.Error(Exception(message), AppError.ServerError(response.code(), message))
    }

    override suspend fun loadCatalog(): AppResult<List<ReportCatalogItem>> = try {
        val response = reportApi.getCatalog()
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(body.map { it.toParams() })
        } else responseError(response, "تعذر تحميل قائمة التقارير")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadOverview(
        from: String,
        to: String,
        departmentId: String?
    ): AppResult<ReportOverview> = try {
        val response = reportApi.getOverview(from, to, departmentId)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(body.toParams())
        } else responseError(response, "تعذر تحميل ملخص التقارير")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadDetail(
        type: String,
        filters: Map<String, String>
    ): AppResult<ReportDetailParams> = try {
        val response = reportApi.getReport(type, filters)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(body.toParams())
        } else responseError(response, "تعذر تحميل التقرير")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun exportCsv(
        type: String,
        filters: Map<String, String>
    ): AppResult<ReportExportPayload> {
        return try {
            val response = reportApi.exportCsv(ReportExportRequestDto(type, filters))
            val body = response.body()
            if (!response.isSuccessful || body == null) {
                responseError(response, "تعذر تصدير التقرير")
            } else {
                val mime = response.headers()["Content-Type"]?.substringBefore(';')?.trim()?.lowercase()
                    ?: body.contentType()?.toString()?.substringBefore(';')?.trim()?.lowercase()
                if (mime != ReportExportStore.CSV_MIME) {
                    AppResult.Error(
                        Exception("نوع ملف التقرير غير صالح"),
                        AppError.ValidationError("نوع ملف التقرير غير صالح")
                    )
                } else if (body.contentLength() > ReportExportStore.MAX_BYTES) {
                    AppResult.Error(
                        Exception("حجم ملف التقرير يتجاوز الحد المسموح"),
                        AppError.ValidationError("حجم ملف التقرير يتجاوز الحد المسموح")
                    )
                } else {
                    val bytes = body.readLimitedBytes(ReportExportStore.MAX_BYTES)
                    val filename = ReportExportFilename.fromContentDisposition(
                        response.headers()["Content-Disposition"],
                        "mawared_${type}.csv"
                    )
                    AppResult.Success(
                        ReportExportPayload(bytes, filename, ReportExportStore.CSV_MIME)
                    )
                }
            }
        } catch (exception: Exception) {
            AppResult.Error(exception, AppError.NetworkError)
        }
    }

    override suspend fun loadTemplateCatalog(): AppResult<List<ReportTemplateCatalogItem>> = try {
        val response = reportApi.getTemplateCatalog()
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(body.map { it.toTemplateCatalogItem() })
        } else templateResponseError(response, "تعذر تحميل قوالب التقارير")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun previewTemplate(
        builtInKey: String,
        templateVersion: Int,
        departmentId: String?,
        filters: Map<String, String>
    ): AppResult<ReportTemplateDocument> = try {
        val response = reportApi.previewTemplate(
            ReportTemplatePreviewRequestDto(
                builtInKey = builtInKey,
                templateVersion = templateVersion,
                scope = departmentId?.let { ReportTemplateScopeRequestDto(it) },
                filters = filters
            )
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(body.toTemplateDocument())
        } else templateResponseError(response, "تعذر معاينة القالب")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun loadSavedTemplates(includeArchived: Boolean): AppResult<List<SavedReportTemplate>> =
        try {
            val response = reportApi.getSavedTemplates(includeArchived)
            val body = response.body()
            if (response.isSuccessful && body != null) {
                AppResult.Success(body.map { it.toSavedTemplate() })
            } else templateResponseError(response, "تعذر تحميل القوالب المحفوظة")
        } catch (exception: Exception) {
            AppResult.Error(exception, AppError.NetworkError)
        }

    override suspend fun saveTemplate(request: SaveReportTemplateRequest): AppResult<SavedReportTemplate> = try {
        val response = reportApi.createSavedTemplate(
            CreateSavedReportTemplateRequestDto(
                name = request.name,
                builtInKey = request.builtInKey,
                templateVersion = request.templateVersion,
                scope = request.departmentId?.let { ReportTemplateScopeRequestDto(it) },
                filters = request.filters,
                preferredFormat = request.preferredFormat?.apiValue
            )
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(body.toSavedTemplate())
        } else templateResponseError(response, "تعذر حفظ القالب")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun archiveSavedTemplate(id: String): AppResult<SavedReportTemplate> = try {
        val response = reportApi.archiveSavedTemplate(id)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            AppResult.Success(body.toSavedTemplate())
        } else templateResponseError(response, "تعذر أرشفة القالب المحفوظ")
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override suspend fun exportTemplate(
        builtInKey: String,
        templateVersion: Int,
        departmentId: String?,
        filters: Map<String, String>,
        format: ReportTemplateExportFormat,
        locale: String
    ): AppResult<ReportExportPayload> = try {
        val response = reportApi.exportTemplate(
            ReportTemplateExportRequestDto(
                builtInKey = builtInKey,
                templateVersion = templateVersion,
                scope = departmentId?.let { ReportTemplateScopeRequestDto(it) },
                filters = filters,
                format = format.apiValue,
                locale = locale
            )
        )
        val body = response.body()
        if (!response.isSuccessful || body == null) {
            templateResponseError(response, "تعذر تصدير القالب")
        } else {
            val mime = response.headers()["Content-Type"]?.substringBefore(';')?.trim()?.lowercase()
                ?: body.contentType()?.toString()?.substringBefore(';')?.trim()?.lowercase()
            if (mime != format.mimeType) {
                AppResult.Error(
                    Exception("نوع ملف التصدير غير صالح"),
                    AppError.ValidationError("نوع ملف التصدير غير صالح")
                )
            } else if (body.contentLength() > PayrollExportStore.MAX_BYTES) {
                AppResult.Error(
                    Exception("حجم ملف التصدير يتجاوز الحد المسموح"),
                    AppError.ValidationError("حجم ملف التصدير يتجاوز الحد المسموح")
                )
            } else {
                val bytes = body.readLimitedBytes(PayrollExportStore.MAX_BYTES)
                val fallback = "mawared_${builtInKey}.${format.fileExtension}"
                val filename = templateExportFilename(response.headers()["Content-Disposition"], fallback)
                AppResult.Success(ReportExportPayload(bytes, filename, format.mimeType))
            }
        }
    } catch (exception: Exception) {
        AppResult.Error(exception, AppError.NetworkError)
    }

    override fun clear() = Unit

    private fun ReportTemplateCatalogItemDto.toTemplateCatalogItem() = ReportTemplateCatalogItem(
        builtInKey = builtInKey,
        version = version,
        kind = kind,
        modules = modules,
        title = title,
        description = description,
        formats = formats,
        maximumRangeDays = maximumRangeDays
    )

    private fun ReportTemplateDocumentDto.toTemplateDocument() = ReportTemplateDocument(
        builtInKey = builtInKey,
        templateVersion = templateVersion,
        generatedAt = generatedAt,
        scope = ReportScope(scope.kind, scope.departmentId),
        sections = sections.map { section ->
            ReportTemplateSection(
                module = section.module,
                title = section.title,
                summary = section.summary.toDisplayMap(),
                rows = section.rows.map { it.toDisplayMap() },
                rowCount = section.rowCount,
                truncated = section.truncated,
                warnings = section.warnings
            )
        },
        warnings = warnings
    )

    private fun SavedReportTemplateDto.toSavedTemplate() = SavedReportTemplate(
        id = id,
        name = name,
        builtInKey = builtInKey,
        templateVersion = templateVersion,
        scope = ReportScope(scope.kind, scope.departmentId),
        filters = filters.toDisplayMap(),
        preferredFormat = preferredFormat,
        archivedAt = archivedAt,
        createdAt = createdAt,
        updatedAt = updatedAt
    )

    private fun <T> templateResponseError(response: Response<T>, fallback: String): AppResult.Error {
        val payload = try {
            response.errorBody()?.string()?.let(templateErrorAdapter::fromJson)
        } catch (_: Exception) {
            null
        }
        val message = payload?.message?.takeIf { it.isNotBlank() }
            ?: payload?.error?.takeIf { it.isNotBlank() }
            ?: fallback
        return AppResult.Error(Exception(message), AppError.ServerError(response.code(), message))
    }

    private fun templateExportFilename(contentDisposition: String?, fallback: String): String {
        val encoded = contentDisposition?.let {
            Regex("filename\\*?=\\s*(?:UTF-8''|\")?([^\";]+)", RegexOption.IGNORE_CASE)
                .find(it)?.groupValues?.getOrNull(1)
        }
        val decoded = encoded?.trim()?.removeSurrounding("\"")
        val candidate = decoded?.let {
            runCatching { java.net.URLDecoder.decode(it, Charsets.UTF_8.name()) }.getOrDefault(it)
        } ?: fallback
        if (
            candidate.contains('/') || candidate.contains('\\') || candidate.contains("..") ||
            candidate.any { it.code < 32 } ||
            !Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\\.[A-Za-z0-9]{2,5}$").matches(candidate)
        ) {
            return fallback
        }
        return candidate
    }

    private fun ResponseBody.readLimitedBytes(maxBytes: Int): ByteArray {
        val output = ByteArrayOutputStream()
        byteStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var total = 0
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                require(total <= maxBytes) { "حجم ملف التقرير يتجاوز الحد المسموح" }
                output.write(buffer, 0, read)
            }
        }
        return output.toByteArray()
    }
}
