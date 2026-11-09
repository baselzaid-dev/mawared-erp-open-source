package com.example.ui.navigation

/**
 * Allowlisted backend deep-link payload. Android never accepts arbitrary URIs or
 * opaque route strings — only known routeKey/resourceType combinations pass parsing.
 */
data class ResourceDescriptor(
    val routeKey: String,
    val resourceType: String,
    val resourceId: String? = null,
    val filterJson: String? = null
) {
    fun isUnavailable(): Boolean = routeKey == ROUTE_UNAVAILABLE

    companion object {
        const val ROUTE_UNAVAILABLE = "unavailable"
        private const val UNAVAILABLE_TYPE = "unavailable"

        private const val MAX_ROUTE_KEY_LENGTH = 64
        private const val MAX_RESOURCE_TYPE_LENGTH = 32
        private const val MAX_RESOURCE_ID_LENGTH = 128
        private const val MAX_FILTER_JSON_LENGTH = 512

        private val ALLOWED_ROUTE_TYPES: Map<String, Set<String>> = mapOf(
            "dashboard.home" to setOf("dashboard"),
            "my_work.list" to setOf("work"),
            "notifications.inbox" to setOf("notification"),
            "employees.list" to setOf("employee"),
            // Account-status notices; resourceId is optional (usually absent).
            "employees.profile" to setOf("security", "employee"),
            "attendance.today" to setOf("attendance"),
            "attendance.list" to setOf("attendance"),
            "attendance.corrections" to setOf("attendance"),
            "attendance_correction.detail" to setOf("attendance"),
            "attendance.exemptions" to setOf("attendance"),
            "leaves.pending" to setOf("leave"),
            // Backend notification payloads use leaveRequest; Android My Work uses leave.
            "leave.detail" to setOf("leave", "leaverequest"),
            "task.detail" to setOf("task", "taskassignment"),
            "chat.conversation" to setOf("conversation", "chatconversation"),
            "reports.builder" to setOf("report"),
            "reports.saved" to setOf("report"),
            // Sprint 12L global search targets (list destinations + filter).
            "purchasing.requests" to setOf("purchaserequest"),
            // Notification override producer writes purchase_request (underscore retained).
            "purchasing.requests.detail" to setOf("purchase_request", "purchaserequest"),
            "vendors.list" to setOf("vendor"),
            "training.courses" to setOf("trainingcourse"),
            "payroll.list" to setOf("payroll"),
            "auth.sessions" to setOf("security")
            // auth.change_password intentionally omitted — forced password gate handles it;
            // notification deep links must fail closed rather than invent a destination.
        )

        /** Legacy stored notification keys → canonical route key used by navigation. */
        private val ROUTE_KEY_ALIASES: Map<String, String> = mapOf(
            "leaves.detail" to "leave.detail"
        )

        private val ROUTES_REQUIRING_ID = setOf(
            "leave.detail",
            "task.detail",
            "chat.conversation",
            "attendance_correction.detail",
            "purchasing.requests.detail"
        )

        private val URI_LIKE_PATTERN = Regex(
            pattern = "(https?://|javascript:|file:|content:|\\\\|//)",
            option = RegexOption.IGNORE_CASE
        )

        fun unavailable(reason: UnavailableReason = UnavailableReason.Unknown): ResourceDescriptor =
            ResourceDescriptor(
                routeKey = ROUTE_UNAVAILABLE,
                resourceType = UNAVAILABLE_TYPE,
                resourceId = reason.name
            )

        fun parse(
            routeKey: String?,
            resourceType: String?,
            resourceId: String? = null,
            filterJson: String? = null
        ): ResourceDescriptor {
            val normalizedRouteRaw = routeKey?.trim()?.lowercase().orEmpty()
            val normalizedRoute = ROUTE_KEY_ALIASES[normalizedRouteRaw] ?: normalizedRouteRaw
            val normalizedType = resourceType?.trim()?.lowercase().orEmpty()
            val normalizedId = resourceId?.trim()?.takeIf { it.isNotEmpty() }
            val normalizedFilter = filterJson?.trim()?.takeIf { it.isNotEmpty() }

            if (normalizedRoute.isEmpty() || normalizedType.isEmpty()) {
                return unavailable(UnavailableReason.MalformedDescriptor)
            }
            if (normalizedRoute.length > MAX_ROUTE_KEY_LENGTH ||
                normalizedType.length > MAX_RESOURCE_TYPE_LENGTH
            ) {
                return unavailable(UnavailableReason.MalformedDescriptor)
            }
            if (containsUnsafeText(normalizedRoute) ||
                containsUnsafeText(normalizedType) ||
                normalizedId?.let { containsUnsafeText(it) } == true
            ) {
                return unavailable(UnavailableReason.MalformedDescriptor)
            }
            if (normalizedFilter != null && !isSafeFilterJson(normalizedFilter)) {
                return unavailable(UnavailableReason.MalformedDescriptor)
            }

            val allowedTypes = ALLOWED_ROUTE_TYPES[normalizedRoute]
                ?: return unavailable(UnavailableReason.UnsupportedRoute)
            if (normalizedType !in allowedTypes) {
                return unavailable(UnavailableReason.UnsupportedRoute)
            }
            if (normalizedRoute in ROUTES_REQUIRING_ID && normalizedId.isNullOrBlank()) {
                return unavailable(UnavailableReason.MalformedDescriptor)
            }
            if (normalizedId != null && normalizedId.length > MAX_RESOURCE_ID_LENGTH) {
                return unavailable(UnavailableReason.MalformedDescriptor)
            }

            return ResourceDescriptor(
                routeKey = normalizedRoute,
                resourceType = normalizedType,
                resourceId = normalizedId,
                filterJson = normalizedFilter
            )
        }

        private fun containsUnsafeText(value: String): Boolean {
            if (URI_LIKE_PATTERN.containsMatchIn(value)) return true
            return value.any { it.isISOControl() }
        }

        private val FILTER_KEY_PATTERN = Regex("^[a-zA-Z][a-zA-Z0-9_]{0,31}$")

        private fun isSafeFilterJson(raw: String): Boolean {
            if (raw.length > MAX_FILTER_JSON_LENGTH) return false
            if (!raw.startsWith("{") || !raw.endsWith("}")) return false

            val inner = raw.substring(1, raw.length - 1).trim()
            if (inner.isEmpty()) return true

            return inner.split(',').all { segment ->
                val colonIndex = segment.indexOf(':')
                if (colonIndex <= 0) return false
                val key = segment.substring(0, colonIndex).trim().removeSurrounding("\"")
                val value = segment.substring(colonIndex + 1).trim().removeSurrounding("\"")
                FILTER_KEY_PATTERN.matches(key) &&
                    value.isNotBlank() &&
                    value.length <= 128 &&
                    !containsUnsafeText(key) &&
                    !containsUnsafeText(value)
            }
        }
    }
}
