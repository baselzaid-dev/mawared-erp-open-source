package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.CreateEmployeeDto
import com.example.data.remote.api.DepartmentDto
import com.example.data.remote.api.DepartmentManagerCandidateDto
import com.example.data.remote.api.DepartmentRequestDto
import com.example.data.remote.api.EmployeeApi
import com.example.data.remote.api.EmployeeDto
import com.example.data.remote.api.EmployeeUpdateRequestDto
import com.example.data.remote.api.RoleDto
import com.example.data.remote.api.CreateSalaryRecordDto
import com.example.data.remote.api.CurrentSalaryResponseDto
import com.example.data.remote.api.SalaryHistoryResponseDto
import com.example.domain.model.EmployeeParams
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

private class FakeEmployeeApi(
    var roles: List<RoleDto> = listOf(
        RoleDto("11111111-1111-1111-1111-111111111111", "Admin"),
        RoleDto("22222222-2222-2222-2222-222222222222", "Employee")
    ),
    var createResult: () -> Response<Map<String, String>> = { Response.success(mapOf("id" to "new")) }
) : EmployeeApi {
    var lastCreate: CreateEmployeeDto? = null
    var lastDeactivateId: String? = null
    var deactivateResult: () -> Response<Map<String, String>> =
        { Response.success(mapOf("status" to "inactive")) }
    override suspend fun getEmployees(): Response<List<EmployeeDto>> = Response.success(emptyList())
    override suspend fun createEmployee(request: CreateEmployeeDto): Response<Map<String, String>> {
        lastCreate = request
        return createResult()
    }
    override suspend fun updateEmployee(
        id: String,
        request: EmployeeUpdateRequestDto
    ): Response<EmployeeDto> = throw UnsupportedOperationException("Not used in create tests")
    override suspend fun deactivateEmployee(id: String): Response<Map<String, String>> {
        lastDeactivateId = id
        return deactivateResult()
    }
    override suspend fun getRoles(): Response<List<RoleDto>> = Response.success(roles)
    override suspend fun getDepartments(): Response<List<DepartmentDto>> = Response.success(emptyList())
    override suspend fun createDepartment(request: DepartmentRequestDto): Response<DepartmentDto> =
        Response.success(DepartmentDto("d-new", request.name, request.managerId))
    override suspend fun updateDepartment(
        id: String,
        request: DepartmentRequestDto
    ): Response<DepartmentDto> = Response.success(DepartmentDto(id, request.name, request.managerId))
    override suspend fun getDepartmentManagerCandidates(): Response<List<DepartmentManagerCandidateDto>> =
        Response.success(emptyList())
    override suspend fun getCurrentSalary(id: String): Response<CurrentSalaryResponseDto> =
        throw UnsupportedOperationException("Not used in create tests")
    override suspend fun getSalaryHistory(id: String): Response<SalaryHistoryResponseDto> =
        throw UnsupportedOperationException("Not used in create tests")
    override suspend fun createSalaryRecord(
        id: String,
        request: CreateSalaryRecordDto
    ): Response<CurrentSalaryResponseDto> =
        throw UnsupportedOperationException("Not used in create tests")
}

private fun newEmp(dept: String? = null) = EmployeeParams(
    id = "0", companyId = "1", departmentId = dept, employeeCode = "EMP1",
    fullName = "موظف جديد", jobTitle = "مطور", phone = "079", email = "new@fixture-2.example.test",
    nationalIdOrIqama = "", basicSalary = 5000.0, allowances = 1000.0, deductions = 0.0,
    status = "نشط", joiningDate = "2026-01-01", contractType = "FULL_TIME",
    createdAt = 0L, updatedAt = 0L,
    temporaryPassword = "temporary-test-password" // security-scan-allow: deterministic test credential
)

class ApiEmployeeCreateTest {

    @Test
    fun `resolves the real Employee role UUID instead of a hardcoded index`() = runTest {
        val api = FakeEmployeeApi()
        val repo = ApiEmployeeRepository(api)
        repo.createEmployee(newEmp())
        assertEquals("22222222-2222-2222-2222-222222222222", api.lastCreate?.roleId)
        assertEquals("temporary-test-password", api.lastCreate?.password)
    }

    @Test
    fun `rejects employee creation when a temporary password is missing`() = runTest {
        val api = FakeEmployeeApi()
        val repo = ApiEmployeeRepository(api)

        val result = repo.createEmployee(newEmp().copy(temporaryPassword = null))

        assertTrue(result is AppResult.Error)
        assertEquals(null, api.lastCreate)
    }

    @Test
    fun `does not fall back to an admin role when Employee role is unavailable`() = runTest {
        val api = FakeEmployeeApi(
            roles = listOf(RoleDto("11111111-1111-1111-1111-111111111111", "Admin"))
        )
        val repo = ApiEmployeeRepository(api)

        val result = repo.createEmployee(newEmp())

        assertTrue(result is AppResult.Error)
        assertEquals(null, api.lastCreate)
    }

    @Test
    fun `sends null department for a non-UUID department name`() = runTest {
        val api = FakeEmployeeApi()
        val repo = ApiEmployeeRepository(api)
        repo.createEmployee(newEmp(dept = "1"))
        assertEquals(null, api.lastCreate?.departmentId)
    }

    @Test
    fun `surfaces the backend Arabic error message instead of a generic one`() = runTest {
        val api = FakeEmployeeApi(createResult = {
            Response.error(400, """{"error":"البريد الإلكتروني مستخدم مسبقاً"}""".toResponseBody("application/json".toMediaType()))
        })
        val repo = ApiEmployeeRepository(api)
        val result = repo.createEmployee(newEmp())
        assertTrue(result is AppResult.Error)
        val err = (result as AppResult.Error).appError as AppError.ServerError
        assertEquals("البريد الإلكتروني مستخدم مسبقاً", err.message)
    }

    @Test
    fun `prefers the Arabic validation message field over the error code`() = runTest {
        val api = FakeEmployeeApi(createResult = {
            Response.error(
                400,
                """{"error":"ValidationError","message":"صيغة التاريخ غير صحيحة"}"""
                    .toResponseBody("application/json".toMediaType())
            )
        })
        val repo = ApiEmployeeRepository(api)
        val result = repo.createEmployee(newEmp())
        val err = (result as AppResult.Error).appError as AppError.ServerError
        assertEquals("صيغة التاريخ غير صحيحة", err.message)
    }

    @Test
    fun `deactivate calls the backend endpoint and succeeds on 2xx`() = runTest {
        val api = FakeEmployeeApi()
        val repo = ApiEmployeeRepository(api)
        val result = repo.deactivateEmployee("emp-42")
        assertTrue(result is AppResult.Success)
        assertEquals("emp-42", api.lastDeactivateId)
    }

    @Test
    fun `deactivate surfaces the backend Arabic owner-protection message`() = runTest {
        val api = FakeEmployeeApi()
        api.deactivateResult = {
            Response.error(
                403,
                """{"error":"لا يمكن إيقاف حساب المدير العام"}"""
                    .toResponseBody("application/json".toMediaType())
            )
        }
        val repo = ApiEmployeeRepository(api)
        val result = repo.deactivateEmployee("owner-1")
        val err = (result as AppResult.Error).appError as AppError.ServerError
        assertEquals("لا يمكن إيقاف حساب المدير العام", err.message)
    }
}
