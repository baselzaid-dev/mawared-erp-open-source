package com.example.domain.model

/**
 * Sprint 12J — server-owned report template registry (catalog/preview/save/export).
 *
 * Per ADR-007, the backend owns the versioned allowlist of built-in templates and all
 * query logic. Android never invents SQL, joins, or financial totals — it only shows
 * what the server already computed (see backend/src/reportTemplates.ts).
 */
data class ReportTemplateCatalogItem(
    val builtInKey: String,
    val version: Int,
    val kind: String,
    val modules: List<String>,
    val title: String,
    val description: String,
    val formats: List<String>,
    val maximumRangeDays: Int
)

data class ReportTemplateSection(
    val module: String,
    val title: String,
    val summary: Map<String, String?>,
    val rows: List<Map<String, String?>>,
    val rowCount: Int,
    val truncated: Boolean,
    val warnings: List<String>
)

data class ReportTemplateDocument(
    val builtInKey: String,
    val templateVersion: Int,
    val generatedAt: String,
    val scope: ReportScope,
    val sections: List<ReportTemplateSection>,
    val warnings: List<String>
)

data class SavedReportTemplate(
    val id: String,
    val name: String,
    val builtInKey: String,
    val templateVersion: Int,
    val scope: ReportScope,
    val filters: Map<String, String?>,
    val preferredFormat: String?,
    val archivedAt: String?,
    val createdAt: String?,
    val updatedAt: String?
)

data class SaveReportTemplateRequest(
    val name: String,
    val builtInKey: String,
    val templateVersion: Int,
    val departmentId: String? = null,
    val filters: Map<String, String> = emptyMap(),
    val preferredFormat: ReportTemplateExportFormat? = null
)

enum class ReportTemplateExportFormat(val apiValue: String, val fileExtension: String, val mimeType: String) {
    CSV("csv", "csv", "text/csv"),
    XLSX("xlsx", "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    PDF("pdf", "pdf", "application/pdf")
}

fun ReportTemplateCatalogItem.supportsFormat(format: ReportTemplateExportFormat): Boolean =
    formats.contains(format.apiValue)

fun SavedReportTemplate.isArchived(): Boolean = archivedAt != null

/**
 * The backend only forwards `from`/`to`/`departmentId` to every module of a COMPOSITE
 * template (per-module fields like `status` mean different things per module — see the
 * `dispatchFilters` comment in reportTemplates.ts) — so a single extra status-like filter
 * is only ever meaningful for single-module templates. Mirrors reportTemplates.ts exactly;
 * never invents a filter key the backend doesn't already document.
 */
fun reportTemplateExtraFilterKey(modules: List<String>): String? {
    if (modules.size != 1) return null
    return when (modules.single()) {
        "attendance" -> "status"
        "leaves" -> "status"
        "purchasing" -> "requestStatus"
        "training" -> "courseStatus"
        "payroll" -> "periodId"
        else -> null
    }
}
