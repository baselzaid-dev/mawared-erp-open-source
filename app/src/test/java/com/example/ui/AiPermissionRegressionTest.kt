package com.example.ui

import com.example.core.permissions.Permissions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression: AI chat must never collapse navigation when Backend refresh returns
 * correct effective flatPermissions (Primary Owner). Legitimate empty grants must
 * remove protected modules immediately.
 */
class AiPermissionRegressionTest {

    @Test
    fun `module visibility stays rich when Primary Owner refresh keeps effective non-empty claims`() {
        val before = setOf(Permissions.ADMIN_FULL, Permissions.CHAT_VIEW)
        val visibleBefore = MawaredNavigation.visibleDestinations(before)
        val bottomBefore = MawaredNavigation.bottomDestinations(before)

        // Backend refresh issues loadAuthorizationContext.flatPermissions (non-empty).
        val afterRefresh = setOf(Permissions.ADMIN_FULL, Permissions.CHAT_VIEW)
        val visibleAfter = MawaredNavigation.visibleDestinations(afterRefresh)
        val bottomAfter = MawaredNavigation.bottomDestinations(afterRefresh)

        assertEquals(visibleBefore.map { it.tabIndex }, visibleAfter.map { it.tabIndex })
        assertEquals(bottomBefore.map { it.tabIndex }, bottomAfter.map { it.tabIndex })
        assertTrue(visibleAfter.size > 3)
        assertTrue(bottomAfter.size > 1)
        assertTrue(MawaredNavigation.isTabVisible(MawaredNavigation.TAB_AI_ASSISTANT, afterRefresh))
    }

    @Test
    fun `legitimate empty permissions collapse protected navigation immediately`() {
        val empty = emptySet<String>()
        val visible = MawaredNavigation.visibleDestinations(empty).map { it.tabIndex }.toSet()
        assertEquals(
            setOf(
                MawaredNavigation.TAB_DASHBOARD,
                MawaredNavigation.TAB_SECURITY_SESSIONS,
                MawaredNavigation.TAB_GLOBAL_SEARCH
            ),
            visible
        )
        assertEquals(
            listOf(MawaredNavigation.TAB_DASHBOARD),
            MawaredNavigation.bottomDestinations(empty).map { it.tabIndex }
        )
        assertFalse(MawaredNavigation.isTabVisible(MawaredNavigation.TAB_AI_ASSISTANT, empty))
        assertFalse(MawaredNavigation.isTabVisible(MawaredNavigation.TAB_CHAT, empty))
    }
}
