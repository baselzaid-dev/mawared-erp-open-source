package com.example.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResourceDescriptorTest {

    @Test
    fun `allowlisted dashboard descriptor parses`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "dashboard.home",
            resourceType = "dashboard"
        )

        assertFalse(descriptor.isUnavailable())
        assertEquals("dashboard.home", descriptor.routeKey)
        assertEquals("dashboard", descriptor.resourceType)
    }

    @Test
    fun `allowlisted detail descriptor requires resource id`() {
        val missingId = ResourceDescriptor.parse(
            routeKey = "leave.detail",
            resourceType = "leave"
        )
        assertTrue(missingId.isUnavailable())
        assertEquals(UnavailableReason.MalformedDescriptor.name, missingId.resourceId)

        val valid = ResourceDescriptor.parse(
            routeKey = "leave.detail",
            resourceType = "leave",
            resourceId = "leave-42"
        )
        assertFalse(valid.isUnavailable())
        assertEquals("leave-42", valid.resourceId)
    }

    @Test
    fun `cross tenant looking id still parses structurally`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "task.detail",
            resourceType = "task",
            resourceId = "company-b-task-999"
        )

        assertFalse(descriptor.isUnavailable())
        assertEquals("company-b-task-999", descriptor.resourceId)
    }

    @Test
    fun `unknown route returns unavailable`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "payroll.secret",
            resourceType = "payroll",
            resourceId = "1"
        )

        assertTrue(descriptor.isUnavailable())
        assertEquals(UnavailableReason.UnsupportedRoute.name, descriptor.resourceId)
    }

    @Test
    fun `allowlisted payroll list parses`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "payroll.list",
            resourceType = "payroll"
        )

        assertFalse(descriptor.isUnavailable())
        assertEquals("payroll.list", descriptor.routeKey)
        assertEquals("payroll", descriptor.resourceType)
    }

    @Test
    fun `malicious uri like route is rejected`() {
        val httpRoute = ResourceDescriptor.parse(
            routeKey = "https://evil.example/steal",
            resourceType = "dashboard"
        )
        assertTrue(httpRoute.isUnavailable())

        val javascriptRoute = ResourceDescriptor.parse(
            routeKey = "javascript:alert(1)",
            resourceType = "dashboard"
        )
        assertTrue(javascriptRoute.isUnavailable())
    }

    @Test
    fun `route and type mismatch returns unavailable`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "chat.conversation",
            resourceType = "leave",
            resourceId = "chat-1"
        )

        assertTrue(descriptor.isUnavailable())
        assertEquals(UnavailableReason.UnsupportedRoute.name, descriptor.resourceId)
    }

    @Test
    fun `unsafe filter json is rejected`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "employees.list",
            resourceType = "employee",
            filterJson = """{"redirect":"https://evil.example"}"""
        )

        assertTrue(descriptor.isUnavailable())
    }

    @Test
    fun `legacy leaves detail alias canonicalizes to leave detail`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "leaves.detail",
            resourceType = "leave",
            resourceId = "leave-legacy-1"
        )

        assertFalse(descriptor.isUnavailable())
        assertEquals("leave.detail", descriptor.routeKey)
        assertEquals("leave-legacy-1", descriptor.resourceId)
    }

    @Test
    fun `purchasing request detail requires id and accepts purchase_request type`() {
        val missingId = ResourceDescriptor.parse(
            routeKey = "purchasing.requests.detail",
            resourceType = "purchase_request"
        )
        assertTrue(missingId.isUnavailable())

        val valid = ResourceDescriptor.parse(
            routeKey = "purchasing.requests.detail",
            resourceType = "purchase_request",
            resourceId = "pr-42"
        )
        assertFalse(valid.isUnavailable())
        assertEquals("purchasing.requests.detail", valid.routeKey)
        assertEquals("pr-42", valid.resourceId)
    }

    @Test
    fun `auth sessions parses without resource id`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "auth.sessions",
            resourceType = "security"
        )
        assertFalse(descriptor.isUnavailable())
        assertEquals("auth.sessions", descriptor.routeKey)
    }

    @Test
    fun `auth change password remains unsupported on Android`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "auth.change_password",
            resourceType = "security"
        )
        assertTrue(descriptor.isUnavailable())
        assertEquals(UnavailableReason.UnsupportedRoute.name, descriptor.resourceId)
    }

    @Test
    fun `employees profile parses security notices without inventing an id`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "employees.profile",
            resourceType = "security"
        )
        assertFalse(descriptor.isUnavailable())
        assertEquals("employees.profile", descriptor.routeKey)
        assertEquals(null, descriptor.resourceId)
    }

    @Test
    fun `secret-looking auth metadata is rejected as malformed`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "auth.sessions",
            resourceType = "security",
            resourceId = "https://evil.example/token=abc"
        )
        assertTrue(descriptor.isUnavailable())
    }

    @Test
    fun `safe filter json is preserved`() {
        val descriptor = ResourceDescriptor.parse(
            routeKey = "my_work.list",
            resourceType = "work",
            filterJson = """{"category":"tasks"}"""
        )

        assertFalse(descriptor.isUnavailable())
        assertEquals("""{"category":"tasks"}""", descriptor.filterJson)
    }
}
