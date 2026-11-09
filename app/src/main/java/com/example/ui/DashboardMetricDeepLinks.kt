package com.example.ui

import com.example.ui.navigation.NavigationCoordinator
import com.example.ui.navigation.ResourceDescriptor
import com.example.ui.navigation.TypedDestination

/**
 * Maps dashboard summary metrics to allowlisted [ResourceDescriptor] payloads.
 * Unsupported metrics return null — never invent opaque tab routes.
 */
enum class DashboardMetric {
    TotalEmployees,
    PresentToday,
    PendingLeaves,
    PendingPurchases,
    LatestPayrollNet,
    ApprovedSpend
}

object DashboardMetricDeepLinks {

    fun descriptorFor(metric: DashboardMetric): ResourceDescriptor? = when (metric) {
        DashboardMetric.TotalEmployees -> ResourceDescriptor.parse(
            routeKey = "employees.list",
            resourceType = "employee"
        )
        DashboardMetric.PresentToday -> ResourceDescriptor.parse(
            routeKey = "attendance.today",
            resourceType = "attendance"
        )
        DashboardMetric.PendingLeaves -> ResourceDescriptor.parse(
            routeKey = "leaves.pending",
            resourceType = "leave",
            filterJson = """{"category":"leaves"}"""
        )
        DashboardMetric.PendingPurchases -> ResourceDescriptor.parse(
            routeKey = "purchasing.requests",
            resourceType = "purchaserequest"
        )
        DashboardMetric.ApprovedSpend -> ResourceDescriptor.parse(
            routeKey = "purchasing.requests",
            resourceType = "purchaserequest",
            filterJson = """{"status":"approved"}"""
        )
        DashboardMetric.LatestPayrollNet -> ResourceDescriptor.parse(
            routeKey = "payroll.list",
            resourceType = "payroll"
        )
    }

    fun resolveDestination(metric: DashboardMetric): TypedDestination? {
        val descriptor = descriptorFor(metric) ?: return null
        if (descriptor.isUnavailable()) return TypedDestination.Unavailable()
        return NavigationCoordinator.resolveDestination(descriptor)
    }

    /**
     * Returns a safe descriptor only when [NavigationCoordinator] resolves a navigable target.
     */
    fun clickableDescriptor(metric: DashboardMetric): ResourceDescriptor? {
        val descriptor = descriptorFor(metric) ?: return null
        if (descriptor.isUnavailable()) return null
        return when (NavigationCoordinator.resolveDestination(descriptor)) {
            is TypedDestination.Unavailable -> null
            else -> descriptor
        }
    }

    fun isClickable(metric: DashboardMetric): Boolean = clickableDescriptor(metric) != null
}
