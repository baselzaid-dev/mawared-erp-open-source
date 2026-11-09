package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.VendorApi
import com.example.data.remote.api.VendorArchiveRequestDto
import com.example.data.remote.api.VendorDto
import com.example.data.remote.api.VendorLifecycleErrorResponseDto
import com.example.data.remote.api.VendorReactivateRequestDto
import com.example.data.remote.api.VendorRequestDto
import com.example.data.remote.api.VendorStatusRequestDto
import com.example.domain.model.Supplier
import com.example.domain.model.VendorArchiveRequest
import com.example.domain.model.VendorReactivateRequest
import com.example.domain.repository.SupplierRepository
import com.squareup.moshi.Moshi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import retrofit2.Response

class ApiSupplierRepository(private val vendorApi: VendorApi) : SupplierRepository {
    private val suppliers = MutableStateFlow<List<Supplier>>(emptyList())
    private val lifecycleErrorAdapter = Moshi.Builder().build().adapter(VendorLifecycleErrorResponseDto::class.java)

    private fun VendorDto.toSupplier() = Supplier(
        id, companyId, name, contact, email, taxNumber, category, status,
        deactivatedAt, createdAt, updatedAt,
        lifecycleVersion, archivedAt, archivedByUserId, archiveReason
    )

    private fun Supplier.toRequest() = VendorRequestDto(name, phone, email, taxNumber, category)

    override fun observeSuppliers(): Flow<List<Supplier>> = suppliers.asStateFlow()

    override suspend fun refreshSuppliers(status: String?, search: String?): AppResult<Unit> = try {
        val response = vendorApi.getVendors(status, search)
        val body = response.body()
        if (response.isSuccessful && body != null) {
            suppliers.value = body.items.map { it.toSupplier() }
            AppResult.Success(Unit)
        } else AppResult.Error(Exception("تعذر تحميل الموردين"), AppError.ServerError(response.code(), response.message()))
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun refreshSuppliersAllStatuses(search: String?): AppResult<Unit> {
        return try {
            val merged = LinkedHashMap<String, Supplier>()
            for (status in listOf("active", "inactive", "archived")) {
                val response = vendorApi.getVendors(status, search)
                val body = response.body()
                if (!response.isSuccessful || body == null) {
                    return AppResult.Error(Exception("تعذر تحميل الموردين"), AppError.ServerError(response.code(), response.message()))
                }
                body.items.forEach { merged[it.id] = it.toSupplier() }
            }
            suppliers.value = merged.values.sortedBy { it.name }
            AppResult.Success(Unit)
        } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }
    }

    override suspend fun createSupplier(supplier: Supplier): AppResult<Unit> = try {
        val response = vendorApi.createVendor(supplier.toRequest())
        if (response.isSuccessful) {
            refreshSuppliersAllStatuses(null)
            AppResult.Success(Unit)
        } else AppResult.Error(Exception("تعذر إنشاء المورد"), AppError.ServerError(response.code(), response.message()))
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun updateSupplier(id: String, supplier: Supplier): AppResult<Unit> = try {
        val response = vendorApi.updateVendor(id, supplier.toRequest())
        if (response.isSuccessful) {
            refreshSuppliersAllStatuses(null)
            AppResult.Success(Unit)
        } else AppResult.Error(Exception("تعذر تحديث المورد"), AppError.ServerError(response.code(), response.message()))
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun setSupplierStatus(id: String, status: String): AppResult<Unit> = try {
        val response = vendorApi.updateVendorStatus(id, VendorStatusRequestDto(status))
        if (response.isSuccessful) {
            refreshSuppliersAllStatuses(null)
            AppResult.Success(Unit)
        } else AppResult.Error(Exception("تعذر تغيير حالة المورد"), AppError.ServerError(response.code(), response.message()))
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    /** Maps the vendorLifecycle.ts `{ error, message, code }` shape; `exception.message` carries the raw `error` code for the UI layer to translate. */
    private fun <T> lifecycleError(response: Response<T>, fallback: String): AppResult.Error {
        val payload = try {
            response.errorBody()?.string()?.let(lifecycleErrorAdapter::fromJson)
        } catch (_: Exception) {
            null
        }
        val code = payload?.error?.takeIf(String::isNotBlank)
        val message = payload?.message?.takeIf(String::isNotBlank) ?: fallback
        val appError = when (response.code()) {
            401 -> AppError.Unauthorized
            403 -> AppError.Forbidden
            400, 404, 409, 412 -> AppError.ValidationError(message)
            else -> AppError.ServerError(response.code(), message)
        }
        return AppResult.Error(Exception(code ?: message), appError)
    }

    override suspend fun loadSupplierLifecycle(id: String): AppResult<Supplier> = try {
        val response = vendorApi.getVendorLifecycle(id)
        val body = response.body()
        if (response.isSuccessful && body != null) AppResult.Success(body.toSupplier())
        else lifecycleError(response, "تعذر تحميل بيانات المورد")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun archiveSupplier(id: String, request: VendorArchiveRequest): AppResult<Supplier> = try {
        val response = vendorApi.archiveVendor(
            id,
            VendorArchiveRequestDto(reason = request.reason.trim(), expectedVersion = request.expectedVersion)
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val supplier = body.toSupplier()
            suppliers.value = suppliers.value.map { if (it.id == id) supplier else it }
            AppResult.Success(supplier)
        } else lifecycleError(response, "تعذر أرشفة المورد")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override suspend fun reactivateSupplier(id: String, request: VendorReactivateRequest): AppResult<Supplier> = try {
        val response = vendorApi.reactivateVendor(
            id,
            VendorReactivateRequestDto(expectedVersion = request.expectedVersion, reason = request.reason?.trim()?.ifEmpty { null })
        )
        val body = response.body()
        if (response.isSuccessful && body != null) {
            val supplier = body.toSupplier()
            suppliers.value = suppliers.value.map { if (it.id == id) supplier else it }
            AppResult.Success(supplier)
        } else lifecycleError(response, "تعذر إعادة تفعيل المورد")
    } catch (exception: Exception) { AppResult.Error(exception, AppError.NetworkError) }

    override fun clear() {
        suppliers.value = emptyList()
    }
}
