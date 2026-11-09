package com.example.ui.navigation

import com.example.domain.model.GlobalSearchRules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Sprint 12L: global-search result descriptors must round-trip through the
 * navigation allowlist into typed destinations, and unknown routes must stay
 * safely unavailable.
 */
class Sprint12LSearchNavigationTest {

    @Test
    fun `vendor search descriptor resolves to the vendors destination`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "vendors.list",
            resourceType = "vendor",
            resourceId = "v-1",
            filterJson = "{\"vendorId\":\"v-1\"}"
        )
        val destination = NavigationCoordinator.resolveDestination(descriptor)
        assertTrue(destination is TypedDestination.Vendors)
        assertEquals("v-1", (destination as TypedDestination.Vendors).vendorId)
    }

    @Test
    fun `purchase request search descriptor resolves to purchasing`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "purchasing.requests",
            resourceType = "purchaserequest",
            resourceId = "pr-1",
            filterJson = "{\"requestId\":\"pr-1\"}"
        )
        val destination = NavigationCoordinator.resolveDestination(descriptor)
        assertTrue(destination is TypedDestination.Purchasing)
        assertEquals("pr-1", (destination as TypedDestination.Purchasing).requestId)
    }

    @Test
    fun `training course search descriptor resolves to training`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "training.courses",
            resourceType = "trainingcourse",
            resourceId = "tc-1",
            filterJson = "{\"courseId\":\"tc-1\"}"
        )
        val destination = NavigationCoordinator.resolveDestination(descriptor)
        assertTrue(destination is TypedDestination.Training)
        assertEquals("tc-1", (destination as TypedDestination.Training).courseId)
    }

    @Test
    fun `employee search descriptor keeps resolving to the employees list`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "employees.list",
            resourceType = "employee",
            resourceId = "emp-1",
            filterJson = "{\"employeeId\":\"emp-1\"}"
        )
        val destination = NavigationCoordinator.resolveDestination(descriptor)
        assertTrue(destination is TypedDestination.Employees)
        assertEquals("emp-1", (destination as TypedDestination.Employees).employeeId)
    }

    @Test
    fun `task and Chat descriptors preserve their exact resource ids`() {
        val task = NavigationCoordinator.resolveDestination(
            ResourceDescriptor.parse("task.detail", "task", "task-1")
        )
        val chat = NavigationCoordinator.resolveDestination(
            ResourceDescriptor.parse("chat.conversation", "conversation", "chat-1")
        )

        assertEquals(TypedDestination.TaskDetail("task-1"), task)
        assertEquals(TypedDestination.Chat("chat-1"), chat)
    }

    @Test
    fun `mismatched resource type for a search route stays unavailable`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "vendors.list",
            resourceType = "employee",
            resourceId = "v-1"
        )
        assertTrue(descriptor.isUnavailable())
        val destination = NavigationCoordinator.resolveDestination(descriptor)
        assertTrue(destination is TypedDestination.Unavailable)
    }

    @Test
    fun `unsafe search descriptor content stays unavailable`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "vendors.list",
            resourceType = "vendor",
            resourceId = "https://evil.example/x"
        )
        assertTrue(descriptor.isUnavailable())
    }

    @Test
    fun `stale search target maps to the stale destination`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "training.courses",
            resourceType = "trainingcourse",
            resourceId = "tc-1"
        )
        val destination = NavigationCoordinator.resolveDestination(
            descriptor,
            NavigationCoordinator.TargetLoadState.Stale
        )
        assertTrue(destination is TypedDestination.Stale)
    }

    @Test
    fun `search query rules enforce shared bounds`() {
        assertTrue(!GlobalSearchRules.isQuerySearchable(""))
        assertTrue(!GlobalSearchRules.isQuerySearchable("a"))
        assertTrue(!GlobalSearchRules.isQuerySearchable("  b  "))
        assertTrue(GlobalSearchRules.isQuerySearchable("ab"))
        assertTrue(GlobalSearchRules.isQuerySearchable("سالم"))
        assertTrue(!GlobalSearchRules.isQuerySearchable("x".repeat(101)))
    }

    @Test
    fun `supported type contract covers every search result type`() {
        val expected = setOf(
            "employee", "vendor", "purchase_request",
            "training_course", "task", "chat_conversation"
        )
        assertEquals(expected, GlobalSearchRules.SUPPORTED_TYPES)
    }
}
