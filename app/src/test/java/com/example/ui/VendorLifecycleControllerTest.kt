package com.example.ui

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.domain.model.Supplier
import com.example.domain.model.VendorArchiveRequest
import com.example.domain.model.VendorReactivateRequest
import com.example.domain.repository.SupplierRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private fun vendor(status: String = "active", lifecycleVersion: Int = 1, name: String = "مورد تجريبي") = Supplier(
    id = "v1",
    companyId = "c1",
    name = name,
    phone = null,
    email = null,
    taxNumber = null,
    category = null,
    status = status,
    lifecycleVersion = lifecycleVersion
)

/** Fake [SupplierRepository] — no network, no server. Only the lifecycle members are exercised here. */
private class FakeSupplierRepository(
    var lifecycleResult: AppResult<Supplier> = AppResult.Success(vendor()),
    var archiveResult: AppResult<Supplier> = AppResult.Success(vendor(status = "archived", lifecycleVersion = 2)),
    var reactivateResult: AppResult<Supplier> = AppResult.Success(vendor(status = "active", lifecycleVersion = 2))
) : SupplierRepository {
    var lifecycleCalls = 0
    var archiveCalls = 0
    var reactivateCalls = 0
    var lastArchiveRequest: VendorArchiveRequest? = null
    var lastReactivateRequest: VendorReactivateRequest? = null
    var refreshCount = 0

    override fun observeSuppliers(): Flow<List<Supplier>> = MutableStateFlow(emptyList())
    override suspend fun refreshSuppliers(status: String?, search: String?): AppResult<Unit> = error("unused")
    override suspend fun refreshSuppliersAllStatuses(search: String?): AppResult<Unit> {
        refreshCount += 1
        return AppResult.Success(Unit)
    }
    override suspend fun createSupplier(supplier: Supplier): AppResult<Unit> = error("unused")
    override suspend fun updateSupplier(id: String, supplier: Supplier): AppResult<Unit> = error("unused")
    override suspend fun setSupplierStatus(id: String, status: String): AppResult<Unit> = error("unused")

    override suspend fun loadSupplierLifecycle(id: String): AppResult<Supplier> {
        lifecycleCalls += 1
        return lifecycleResult
    }

    override suspend fun archiveSupplier(id: String, request: VendorArchiveRequest): AppResult<Supplier> {
        archiveCalls += 1
        lastArchiveRequest = request
        return archiveResult
    }

    override suspend fun reactivateSupplier(id: String, request: VendorReactivateRequest): AppResult<Supplier> {
        reactivateCalls += 1
        lastReactivateRequest = request
        return reactivateResult
    }

    override fun clear() = Unit
}

@OptIn(ExperimentalCoroutinesApi::class)
class VendorLifecycleControllerTest {

    @Test
    fun `archive fetches fresh lifecycle version then sends it and refreshes only after success`() = runTest {
        val repo = FakeSupplierRepository(lifecycleResult = AppResult.Success(vendor(lifecycleVersion = 5)))
        val controller = VendorLifecycleController(repo, backgroundScope) { repo.refreshCount += 1 }

        controller.archiveVendor(vendor(lifecycleVersion = 1), "لم يعد نشطاً", hasArchivePermission = true)
        runCurrent()

        assertEquals(1, repo.lifecycleCalls)
        assertEquals(1, repo.archiveCalls)
        assertEquals(5, repo.lastArchiveRequest?.expectedVersion)
        assertEquals("لم يعد نشطاً", repo.lastArchiveRequest?.reason)
        assertEquals(1, repo.refreshCount)
        assertTrue(controller.state.value is VendorLifecycleUiState.SuccessMessage)
    }

    @Test
    fun `archive without permission never calls the repository`() = runTest {
        val repo = FakeSupplierRepository()
        val controller = VendorLifecycleController(repo, backgroundScope)

        controller.archiveVendor(vendor(), "سبب", hasArchivePermission = false)
        runCurrent()

        assertEquals(0, repo.lifecycleCalls)
        assertEquals(0, repo.archiveCalls)
        val error = controller.state.value as VendorLifecycleUiState.Error
        assertEquals(VendorLifecycleActionKind.ARCHIVE, error.kind)
    }

    @Test
    fun `archive rejects a blank reason before calling the repository`() = runTest {
        val repo = FakeSupplierRepository()
        val controller = VendorLifecycleController(repo, backgroundScope)

        controller.archiveVendor(vendor(), "   ", hasArchivePermission = true)
        runCurrent()

        assertEquals(0, repo.lifecycleCalls)
        val error = controller.state.value as VendorLifecycleUiState.Error
        assertEquals("سبب الأرشفة مطلوب.", error.message)
    }

    @Test
    fun `archive already-archived vendor reports the conflict without calling archive`() = runTest {
        val repo = FakeSupplierRepository(lifecycleResult = AppResult.Success(vendor(status = "archived", lifecycleVersion = 2)))
        val controller = VendorLifecycleController(repo, backgroundScope) { repo.refreshCount += 1 }

        controller.archiveVendor(vendor(status = "active"), "سبب", hasArchivePermission = true)
        runCurrent()

        assertEquals(1, repo.lifecycleCalls)
        assertEquals(0, repo.archiveCalls)
        val error = controller.state.value as VendorLifecycleUiState.Error
        assertEquals("المورد مؤرشف بالفعل.", error.message)
        // The stale local card is refreshed even on this early-exit path.
        assertEquals(1, repo.refreshCount)
    }

    @Test
    fun `version mismatch never reports fake success and translates the backend code to Arabic`() = runTest {
        val repo = FakeSupplierRepository(
            archiveResult = AppResult.Error(
                Exception("VENDOR_VERSION_MISMATCH"),
                AppError.ValidationError("تم تعديل المورد من مستخدم آخر، يرجى تحديث الصفحة")
            )
        )
        val controller = VendorLifecycleController(repo, backgroundScope)

        controller.archiveVendor(vendor(), "سبب", hasArchivePermission = true)
        runCurrent()

        assertEquals(0, repo.refreshCount)
        val error = controller.state.value as VendorLifecycleUiState.Error
        assertEquals("تغيّرت بيانات المورد. حدّث القائمة ثم أعد المحاولة.", error.message)
    }

    @Test
    fun `forbidden archive attempt surfaces an Arabic permission message`() = runTest {
        val repo = FakeSupplierRepository(
            archiveResult = AppResult.Error(Exception("Forbidden"), AppError.Forbidden)
        )
        val controller = VendorLifecycleController(repo, backgroundScope)

        controller.archiveVendor(vendor(), "سبب", hasArchivePermission = true)
        runCurrent()

        assertEquals(0, repo.refreshCount)
        val error = controller.state.value as VendorLifecycleUiState.Error
        assertEquals("لا تملك صلاحية تنفيذ هذه العملية على المورد.", error.message)
    }

    @Test
    fun `reactivate fetches fresh lifecycle version then sends it with an optional reason`() = runTest {
        val repo = FakeSupplierRepository(lifecycleResult = AppResult.Success(vendor(status = "archived", lifecycleVersion = 7)))
        val controller = VendorLifecycleController(repo, backgroundScope) { repo.refreshCount += 1 }

        controller.reactivateVendor(vendor(status = "archived", lifecycleVersion = 1), null, hasArchivePermission = true)
        runCurrent()

        assertEquals(1, repo.reactivateCalls)
        assertEquals(7, repo.lastReactivateRequest?.expectedVersion)
        assertEquals(null, repo.lastReactivateRequest?.reason)
        assertEquals(1, repo.refreshCount)
        assertTrue(controller.state.value is VendorLifecycleUiState.SuccessMessage)
    }

    @Test
    fun `reactivate a non-archived vendor reports the conflict without calling reactivate`() = runTest {
        val repo = FakeSupplierRepository(lifecycleResult = AppResult.Success(vendor(status = "active", lifecycleVersion = 2)))
        val controller = VendorLifecycleController(repo, backgroundScope)

        controller.reactivateVendor(vendor(status = "archived"), "ملاحظة", hasArchivePermission = true)
        runCurrent()

        assertEquals(1, repo.lifecycleCalls)
        assertEquals(0, repo.reactivateCalls)
        val error = controller.state.value as VendorLifecycleUiState.Error
        assertEquals("المورد غير مؤرشف.", error.message)
    }

    @Test
    fun `reactivate without permission never calls the repository`() = runTest {
        val repo = FakeSupplierRepository()
        val controller = VendorLifecycleController(repo, backgroundScope)

        controller.reactivateVendor(vendor(status = "archived"), null, hasArchivePermission = false)
        runCurrent()

        assertEquals(0, repo.lifecycleCalls)
        assertEquals(0, repo.reactivateCalls)
        val error = controller.state.value as VendorLifecycleUiState.Error
        assertEquals(VendorLifecycleActionKind.REACTIVATE, error.kind)
    }
}
