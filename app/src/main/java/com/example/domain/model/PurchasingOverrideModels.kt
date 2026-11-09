package com.example.domain.model

/**
 * Sprint 12I — purchasing admin override (`purchasing.admin_override`) + purchasing
 * exports (v2). Mirrors the shape of `PayrollExportFormat`/payroll payments (Sprint 12H)
 * so the ViewModel/UI pattern stays consistent across modules. Money and dates stay
 * String end-to-end; the client never invents a status or a total.
 */
enum class PurchasingExportFormat(val apiValue: String, val fileExtension: String, val mimeType: String) {
    CSV("csv", "csv", "text/csv"),
    XLSX("xlsx", "xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    PDF("pdf", "pdf", "application/pdf")
}

/** Second-confirmation token the backend requires verbatim in the override body. */
const val PURCHASING_OVERRIDE_CONFIRMATION_TOKEN = "OVERRIDE"

const val PURCHASING_OVERRIDE_NOTICE =
    "هذا إجراء إداري استثنائي يتجاوز مسار المراجعة العادي وسيُسجَّل في سجل التدقيق."

/**
 * Carries the backend's specific override outcome `error` code so the ViewModel/UI can
 * render an honest, distinct message for every documented failure — self-forbidden (403),
 * stale version (412), illegal transition / active-order / idempotency reuse (409) —
 * instead of a generic error string.
 */
class PurchasingOverrideException(
    message: String,
    val code: String,
    val currentUpdatedAt: String? = null,
    val currentStatus: String? = null
) : Exception(message)

/**
 * Client-side mirror of the backend's `ALLOWED_FROM_STATUSES` (purchasingOverride.ts).
 * Used ONLY to avoid offering a doomed action in the UI; the server remains the sole
 * source of truth and re-validates on every call.
 */
fun purchasingOverrideLegalActionsFor(status: String): List<String> = buildList {
    if (status == "pending_department" || status == "pending_purchasing") add("approve")
    if (status == "pending_department" || status == "pending_purchasing" || status == "approved") {
        add("reject")
        add("cancel")
    }
}
