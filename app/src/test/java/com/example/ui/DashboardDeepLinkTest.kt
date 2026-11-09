package com.example.ui

import com.example.ui.navigation.TypedDestination
import com.example.ui.navigation.UnavailableReason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DashboardDeepLinkTest {

    @Test
    fun `total employees maps to employees list descriptor`() {
        val descriptor = DashboardMetricDeepLinks.descriptorFor(DashboardMetric.TotalEmployees)

        assertNotNull(descriptor)
        assertEquals("employees.list", descriptor?.routeKey)
        assertEquals("employee", descriptor?.resourceType)
    }

    @Test
    fun `present today maps to attendance today descriptor`() {
        val descriptor = DashboardMetricDeepLinks.descriptorFor(DashboardMetric.PresentToday)

        assertNotNull(descriptor)
        assertEquals("attendance.today", descriptor?.routeKey)
        assertEquals("attendance", descriptor?.resourceType)
    }

    @Test
    fun `pending leaves maps to leaves pending with category filter`() {
        val descriptor = DashboardMetricDeepLinks.descriptorFor(DashboardMetric.PendingLeaves)

        assertNotNull(descriptor)
        assertEquals("leaves.pending", descriptor?.routeKey)
        assertEquals("leave", descriptor?.resourceType)
        assertEquals("""{"category":"leaves"}""", descriptor?.filterJson)
    }

    @Test
    fun `pending purchases maps to purchasing requests descriptor`() {
        val descriptor = DashboardMetricDeepLinks.descriptorFor(DashboardMetric.PendingPurchases)

        assertNotNull(descriptor)
        assertEquals("purchasing.requests", descriptor?.routeKey)
        assertEquals("purchaserequest", descriptor?.resourceType)
    }

    @Test
    fun `approved spend maps to purchasing with approved filter`() {
        val descriptor = DashboardMetricDeepLinks.descriptorFor(DashboardMetric.ApprovedSpend)

        assertNotNull(descriptor)
        assertEquals("purchasing.requests", descriptor?.routeKey)
        assertEquals("purchaserequest", descriptor?.resourceType)
        assertEquals("""{"status":"approved"}""", descriptor?.filterJson)
    }

    @Test
    fun `latest payroll net maps to payroll list descriptor`() {
        val descriptor = DashboardMetricDeepLinks.descriptorFor(DashboardMetric.LatestPayrollNet)

        assertNotNull(descriptor)
        assertEquals("payroll.list", descriptor?.routeKey)
        assertEquals("payroll", descriptor?.resourceType)
    }

    @Test
    fun `supported metrics resolve to typed destinations`() {
        assertEquals(
            TypedDestination.Employees(filterJson = null),
            DashboardMetricDeepLinks.resolveDestination(DashboardMetric.TotalEmployees)
        )
        assertEquals(
            TypedDestination.Attendance(filterJson = null),
            DashboardMetricDeepLinks.resolveDestination(DashboardMetric.PresentToday)
        )
        assertEquals(
            TypedDestination.MyWork(category = "leaves"),
            DashboardMetricDeepLinks.resolveDestination(DashboardMetric.PendingLeaves)
        )
        assertEquals(
            TypedDestination.Purchasing(filterJson = null),
            DashboardMetricDeepLinks.resolveDestination(DashboardMetric.PendingPurchases)
        )
        assertEquals(
            TypedDestination.Purchasing(filterJson = """{"status":"approved"}"""),
            DashboardMetricDeepLinks.resolveDestination(DashboardMetric.ApprovedSpend)
        )
        assertEquals(
            TypedDestination.Payroll(),
            DashboardMetricDeepLinks.resolveDestination(DashboardMetric.LatestPayrollNet)
        )
    }

    @Test
    fun `clickableDescriptor only returns safe navigable descriptors`() {
        assertNotNull(DashboardMetricDeepLinks.clickableDescriptor(DashboardMetric.TotalEmployees))
        assertNotNull(DashboardMetricDeepLinks.clickableDescriptor(DashboardMetric.PresentToday))
        assertNotNull(DashboardMetricDeepLinks.clickableDescriptor(DashboardMetric.PendingLeaves))
        assertNotNull(DashboardMetricDeepLinks.clickableDescriptor(DashboardMetric.PendingPurchases))
        assertNotNull(DashboardMetricDeepLinks.clickableDescriptor(DashboardMetric.LatestPayrollNet))
        assertNotNull(DashboardMetricDeepLinks.clickableDescriptor(DashboardMetric.ApprovedSpend))
    }

    @Test
    fun `isClickable matches clickableDescriptor presence`() {
        assertTrue(DashboardMetricDeepLinks.isClickable(DashboardMetric.TotalEmployees))
        assertTrue(DashboardMetricDeepLinks.isClickable(DashboardMetric.PresentToday))
        assertTrue(DashboardMetricDeepLinks.isClickable(DashboardMetric.PendingLeaves))
        assertTrue(DashboardMetricDeepLinks.isClickable(DashboardMetric.PendingPurchases))
        assertTrue(DashboardMetricDeepLinks.isClickable(DashboardMetric.LatestPayrollNet))
        assertTrue(DashboardMetricDeepLinks.isClickable(DashboardMetric.ApprovedSpend))
    }

    @Test
    fun `dashboardMetricClickHandler returns null when callback absent`() {
        assertNull(
            dashboardMetricClickHandler(
                metric = DashboardMetric.TotalEmployees,
                onMetricClick = null
            )
        )
    }

    @Test
    fun `dashboardMetricClickHandler invokes callback for purchase metric`() {
        var capturedRouteKey: String? = null

        val handler = dashboardMetricClickHandler(
            metric = DashboardMetric.PendingPurchases,
            onMetricClick = { descriptor ->
                capturedRouteKey = descriptor.routeKey
            }
        )

        assertNotNull(handler)
        handler?.invoke()

        assertEquals("purchasing.requests", capturedRouteKey)
    }

    @Test
    fun `dashboardMetricClickHandler invokes callback with allowlisted descriptor`() {
        var capturedRouteKey: String? = null

        val handler = dashboardMetricClickHandler(
            metric = DashboardMetric.PendingLeaves,
            onMetricClick = { descriptor ->
                capturedRouteKey = descriptor.routeKey
            }
        )

        assertNotNull(handler)
        handler?.invoke()

        assertEquals("leaves.pending", capturedRouteKey)
    }

    @Test
    fun `unavailable parsed descriptor stays non clickable`() {
        val unavailable = com.example.ui.navigation.ResourceDescriptor.unavailable(
            UnavailableReason.UnsupportedRoute
        )

        assertTrue(unavailable.isUnavailable())
        assertTrue(
            com.example.ui.navigation.NavigationCoordinator.resolveDestination(unavailable)
                is TypedDestination.Unavailable
        )
    }
}
