package com.example.data.repository.mock

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.domain.model.Supplier
import com.example.domain.model.VendorArchiveRequest
import com.example.domain.model.VendorReactivateRequest
import com.example.domain.repository.SupplierRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import java.util.UUID

class MockSupplierRepository : SupplierRepository {
    private val suppliers = MutableStateFlow(
        listOf(
            Supplier("demo-vendor", "1", "مورد تجريبي", "0110000000", null, null, "عام", "active"),
            Supplier(
                id = "demo-vendor-archived",
                companyId = "1",
                name = "مورد مؤرشف تجريبي",
                phone = null,
                email = null,
                taxNumber = null,
                category = "عام",
                status = "archived",
                lifecycleVersion = 2,
                archivedAt = "2026-06-01T00:00:00Z",
                archivedByUserId = "demo-owner",
                archiveReason = "بيانات تجريبية"
            )
        )
    )
    override fun observeSuppliers(): Flow<List<Supplier>> = suppliers

    override fun clear() {
        suppliers.value = emptyList()
    }

    override suspend fun refreshSuppliers(status: String?, search: String?): AppResult<Unit> {
        suppliers.value = suppliers.value.filter { (status == null || it.status == status) && (search.isNullOrBlank() || it.name.contains(search, true)) }
        return AppResult.Success(Unit)
    }

    override suspend fun refreshSuppliersAllStatuses(search: String?): AppResult<Unit> {
        if (!search.isNullOrBlank()) {
            suppliers.value = suppliers.value.filter { it.name.contains(search, true) }
        }
        return AppResult.Success(Unit)
    }

    override suspend fun createSupplier(supplier: Supplier): AppResult<Unit> {
        suppliers.value = suppliers.value + supplier.copy(id = UUID.randomUUID().toString(), status = "active")
        return AppResult.Success(Unit)
    }
    override suspend fun updateSupplier(id: String, supplier: Supplier): AppResult<Unit> {
        suppliers.value = suppliers.value.map { if (it.id == id) supplier.copy(id = id) else it }
        return AppResult.Success(Unit)
    }
    override suspend fun setSupplierStatus(id: String, status: String): AppResult<Unit> {
        suppliers.value = suppliers.value.map { if (it.id == id) it.copy(status = status) else it }
        return AppResult.Success(Unit)
    }

    override suspend fun loadSupplierLifecycle(id: String): AppResult<Supplier> {
        val supplier = suppliers.value.find { it.id == id }
            ?: return AppResult.Error(Exception("VENDOR_NOT_FOUND"), AppError.ServerError(404, "المورد غير موجود"))
        return AppResult.Success(supplier)
    }

    override suspend fun archiveSupplier(id: String, request: VendorArchiveRequest): AppResult<Supplier> {
        val supplier = suppliers.value.find { it.id == id }
            ?: return AppResult.Error(Exception("VENDOR_NOT_FOUND"), AppError.ServerError(404, "المورد غير موجود"))
        if (supplier.status == "archived") {
            return AppResult.Error(Exception("VENDOR_ALREADY_ARCHIVED"), AppError.ValidationError("المورد مؤرشف بالفعل"))
        }
        if (supplier.lifecycleVersion != request.expectedVersion) {
            return AppResult.Error(Exception("VENDOR_VERSION_MISMATCH"), AppError.ValidationError("تم تعديل المورد من مستخدم آخر، يرجى تحديث الصفحة"))
        }
        val updated = supplier.copy(
            status = "archived",
            archivedAt = "2026-01-01T00:00:00Z",
            archiveReason = request.reason,
            lifecycleVersion = supplier.lifecycleVersion + 1
        )
        suppliers.value = suppliers.value.map { if (it.id == id) updated else it }
        return AppResult.Success(updated)
    }

    override suspend fun reactivateSupplier(id: String, request: VendorReactivateRequest): AppResult<Supplier> {
        val supplier = suppliers.value.find { it.id == id }
            ?: return AppResult.Error(Exception("VENDOR_NOT_FOUND"), AppError.ServerError(404, "المورد غير موجود"))
        if (supplier.status != "archived") {
            return AppResult.Error(Exception("VENDOR_NOT_ARCHIVED"), AppError.ValidationError("المورد غير مؤرشف"))
        }
        if (supplier.lifecycleVersion != request.expectedVersion) {
            return AppResult.Error(Exception("VENDOR_VERSION_MISMATCH"), AppError.ValidationError("تم تعديل المورد من مستخدم آخر، يرجى تحديث الصفحة"))
        }
        val updated = supplier.copy(
            status = "active",
            archivedAt = null,
            archivedByUserId = null,
            archiveReason = null,
            lifecycleVersion = supplier.lifecycleVersion + 1
        )
        suppliers.value = suppliers.value.map { if (it.id == id) updated else it }
        return AppResult.Success(updated)
    }
}
