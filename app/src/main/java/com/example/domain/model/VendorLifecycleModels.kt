package com.example.domain.model

/**
 * Sprint 12I (M08) — Vendor archive lifecycle.
 *
 * Mirrors backend/src/vendorLifecycle.ts: archive/reactivate are guarded by
 * optimistic concurrency (lifecycleVersion) and never delete the vendor row.
 * The three vendor states are 'active' | 'inactive' | 'archived'.
 */

data class VendorArchiveRequest(
    val reason: String,
    val expectedVersion: Int
)

data class VendorReactivateRequest(
    val expectedVersion: Int,
    val reason: String? = null
)

val Supplier.isArchived: Boolean get() = status == "archived"
val Supplier.isActiveVendor: Boolean get() = status == "active"
val Supplier.isInactiveVendor: Boolean get() = status == "inactive"

/** Archived (and inactive) vendors must not be selectable for a new/edited purchase order. */
val Supplier.isSelectableForPurchaseOrder: Boolean get() = status == "active"

/** Pure eligibility rules; permission gating is passed in from the caller's own state. */
object VendorLifecycleRules {
    fun canArchive(vendor: Supplier, hasArchivePermission: Boolean): Boolean =
        hasArchivePermission && !vendor.isArchived

    fun canReactivate(vendor: Supplier, hasArchivePermission: Boolean): Boolean =
        hasArchivePermission && vendor.isArchived
}
