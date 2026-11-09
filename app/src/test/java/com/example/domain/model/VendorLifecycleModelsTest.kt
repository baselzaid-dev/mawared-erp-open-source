package com.example.domain.model

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private fun vendor(status: String, lifecycleVersion: Int = 1) = Supplier(
    id = "v1",
    companyId = "c1",
    name = "مورد",
    phone = null,
    email = null,
    taxNumber = null,
    category = null,
    status = status,
    lifecycleVersion = lifecycleVersion
)

class VendorLifecycleModelsTest {

    @Test
    fun `isArchived and selectability reflect the true vendor state`() {
        assertTrue(vendor("archived").isArchived)
        assertFalse(vendor("active").isArchived)
        assertFalse(vendor("inactive").isArchived)

        assertTrue(vendor("active").isSelectableForPurchaseOrder)
        assertFalse(vendor("inactive").isSelectableForPurchaseOrder)
        assertFalse(vendor("archived").isSelectableForPurchaseOrder)
    }

    @Test
    fun `canArchive requires permission and a non-archived vendor`() {
        assertTrue(VendorLifecycleRules.canArchive(vendor("active"), hasArchivePermission = true))
        assertTrue(VendorLifecycleRules.canArchive(vendor("inactive"), hasArchivePermission = true))
        assertFalse(VendorLifecycleRules.canArchive(vendor("archived"), hasArchivePermission = true))
        assertFalse(VendorLifecycleRules.canArchive(vendor("active"), hasArchivePermission = false))
    }

    @Test
    fun `canReactivate requires permission and an archived vendor`() {
        assertTrue(VendorLifecycleRules.canReactivate(vendor("archived"), hasArchivePermission = true))
        assertFalse(VendorLifecycleRules.canReactivate(vendor("active"), hasArchivePermission = true))
        assertFalse(VendorLifecycleRules.canReactivate(vendor("inactive"), hasArchivePermission = true))
        assertFalse(VendorLifecycleRules.canReactivate(vendor("archived"), hasArchivePermission = false))
    }
}
