package com.example.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigationCoordinatorTest {

    @Test
    fun `dashboard descriptor maps to dashboard destination`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "dashboard.home",
            resourceType = "dashboard"
        )

        val destination = NavigationCoordinator.resolveDestination(descriptor)

        assertEquals(TypedDestination.Dashboard, destination)
    }

    @Test
    fun `leave detail maps structurally without implying data access`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "leave.detail",
            resourceType = "leave",
            resourceId = "foreign-company-leave-77"
        )

        val destination = NavigationCoordinator.resolveDestination(descriptor)

        assertEquals(
            TypedDestination.LeaveDetail(leaveId = "foreign-company-leave-77"),
            destination
        )
    }

    @Test
    fun `unknown parsed descriptor maps to unavailable destination`() {
        val descriptor = ResourceDescriptor.unavailable(UnavailableReason.UnsupportedRoute)

        val destination = NavigationCoordinator.resolveDestination(descriptor)

        assertEquals(
            TypedDestination.Unavailable(reason = UnavailableReason.UnsupportedRoute),
            destination
        )
    }

    @Test
    fun `stale target uses stale destination even for valid descriptor`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "task.detail",
            resourceType = "task",
            resourceId = "task-1"
        )

        val destination = NavigationCoordinator.resolveDestination(
            descriptor = descriptor,
            targetLoadState = NavigationCoordinator.TargetLoadState.Stale
        )

        assertEquals(TypedDestination.Stale(resourceLabel = "task.detail"), destination)
    }

    @Test
    fun `revoked target uses stale destination`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "chat.conversation",
            resourceType = "conversation",
            resourceId = "chat-9"
        )

        val destination = NavigationCoordinator.resolveDestination(
            descriptor = descriptor,
            targetLoadState = NavigationCoordinator.TargetLoadState.Revoked
        )

        assertEquals(TypedDestination.Stale(resourceLabel = "chat.conversation"), destination)
    }

    @Test
    fun `employees list preserves filter json on destination`() {
        val filter = """{"departmentId":"dept-1"}"""
        val descriptor = ResourceDescriptor.parse(
            routeKey = "employees.list",
            resourceType = "employee",
            filterJson = filter
        )

        val destination = NavigationCoordinator.resolveDestination(descriptor)

        assertTrue(destination is TypedDestination.Employees)
        assertEquals(filter, (destination as TypedDestination.Employees).filterJson)
    }

    @Test
    fun `notifications inbox maps category filter`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "notifications.inbox",
            resourceType = "notification",
            filterJson = """{"category":"security"}"""
        )

        val destination = NavigationCoordinator.resolveDestination(descriptor)

        assertEquals(
            TypedDestination.Notifications(category = "security"),
            destination
        )
    }

    @Test
    fun `reports saved maps template and saved id`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "reports.saved",
            resourceType = "report",
            resourceId = "saved-12",
            filterJson = """{"templateKey":"attendance_summary"}"""
        )

        val destination = NavigationCoordinator.resolveDestination(descriptor)

        assertEquals(
            TypedDestination.Reports(
                templateKey = "attendance_summary",
                savedTemplateId = "saved-12"
            ),
            destination
        )
    }

    @Test
    fun `payroll list maps to payroll destination`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "payroll.list",
            resourceType = "payroll"
        )

        val destination = NavigationCoordinator.resolveDestination(descriptor)

        assertEquals(TypedDestination.Payroll(), destination)
    }

    @Test
    fun `legacy leaves detail alias resolves to leave detail destination`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "leaves.detail",
            resourceType = "leave",
            resourceId = "lv-77"
        )

        val destination = NavigationCoordinator.resolveDestination(descriptor)

        assertEquals(TypedDestination.LeaveDetail(leaveId = "lv-77"), destination)
    }

    @Test
    fun `purchasing request detail maps to purchasing destination`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "purchasing.requests.detail",
            resourceType = "purchase_request",
            resourceId = "pr-12"
        )

        val destination = NavigationCoordinator.resolveDestination(descriptor)

        assertTrue(destination is TypedDestination.Purchasing)
        assertEquals("pr-12", (destination as TypedDestination.Purchasing).requestId)
    }

    @Test
    fun `auth sessions maps to sessions destination`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "auth.sessions",
            resourceType = "security"
        )

        val destination = NavigationCoordinator.resolveDestination(descriptor)

        assertEquals(TypedDestination.Sessions, destination)
    }

    @Test
    fun `employees profile maps to employees destination without inventing access`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "employees.profile",
            resourceType = "security"
        )

        val destination = NavigationCoordinator.resolveDestination(descriptor)

        assertTrue(destination is TypedDestination.Employees)
        assertEquals(null, (destination as TypedDestination.Employees).employeeId)
    }

    @Test
    fun `unsupported auth change password fails closed`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "auth.change_password",
            resourceType = "security"
        )

        val destination = NavigationCoordinator.resolveDestination(descriptor)

        assertEquals(
            TypedDestination.Unavailable(reason = UnavailableReason.UnsupportedRoute),
            destination
        )
    }
}
