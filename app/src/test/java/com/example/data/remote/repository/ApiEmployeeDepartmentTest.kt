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
import com.example.data.remote.api.UserDto
import com.example.data.remote.api.CreateSalaryRecordDto
import com.example.data.remote.api.CurrentSalaryResponseDto
import com.example.data.remote.api.SalaryHistoryResponseDto
import com.example.domain.model.DepartmentDraft
import com.example.domain.model.EmployeeUpdateForm
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

private fun employeeDto() = EmployeeDto(
    id = "e1",
    companyId = "c1",
    employeeNum = "E-001",
    jobTitle = "Engineer",
    joiningDate = "2025-01-10T00:00:00.000Z",
    status = "active",
    user = UserDto(
        id = "u1",
        name = "Employee",
        email = "employee@example.com",
        roleId = "r1",
        roleName = "Employee"
    ),
    department = DepartmentDto("d1", "Engineering")
)

private class EmployeeManagementApi : EmployeeApi {
    var employeeCalls = 0
    var updateResponse: Response<EmployeeDto> = Response.success(employeeDto())
    var lastUpdateId: String? = null
    var lastUpdate: EmployeeUpdateRequestDto? = null
    var lastCreatedDepartment: DepartmentRequestDto? = null
    var lastUpdatedDepartmentId: String? = null
    var lastUpdatedDepartment: DepartmentRequestDto? = null

    override suspend fun getEmployees(): Response<List<EmployeeDto>> {
        employeeCalls++
        return Response.success(listOf(employeeDto()))
    }

    override suspend fun createEmployee(request: CreateEmployeeDto): Response<Map<String, String>> =
        Response.success(mapOf("id" to "new"))

    override suspend fun updateEmployee(
        id: String,
        request: EmployeeUpdateRequestDto
    ): Response<EmployeeDto> {
        lastUpdateId = id
        lastUpdate = request
        return updateResponse
    }

    override suspend fun deactivateEmployee(id: String): Response<Map<String, String>> =
        Response.success(mapOf("status" to "inactive"))

    override suspend fun getRoles(): Response<List<RoleDto>> = Response.success(
        listOf(RoleDto("r1", "Employee"), RoleDto("r2", "HR Manager"))
    )

    override suspend fun getDepartments(): Response<List<DepartmentDto>> = Response.success(
        listOf(DepartmentDto("d1", "Engineering", "u-manager", "Manager", 4))
    )

    override suspend fun createDepartment(request: DepartmentRequestDto): Response<DepartmentDto> {
        lastCreatedDepartment = request
        return Response.success(DepartmentDto("d-new", request.name, request.managerId))
    }

    override suspend fun updateDepartment(
        id: String,
        request: DepartmentRequestDto
    ): Response<DepartmentDto> {
        lastUpdatedDepartmentId = id
        lastUpdatedDepartment = request
        return Response.success(DepartmentDto(id, request.name, request.managerId))
    }

    override suspend fun getDepartmentManagerCandidates(): Response<List<DepartmentManagerCandidateDto>> =
        Response.success(
            listOf(DepartmentManagerCandidateDto("u-manager", "e-manager", "Manager", "Department Manager", "d1"))
        )

    override suspend fun getCurrentSalary(id: String): Response<CurrentSalaryResponseDto> =
        throw UnsupportedOperationException("Not used in employee management tests")

    override suspend fun getSalaryHistory(id: String): Response<SalaryHistoryResponseDto> =
        throw UnsupportedOperationException("Not used in employee management tests")

    override suspend fun createSalaryRecord(
        id: String,
        request: CreateSalaryRecordDto
    ): Response<CurrentSalaryResponseDto> =
        throw UnsupportedOperationException("Not used in employee management tests")
}

private fun updateForm() = EmployeeUpdateForm(
    name = "Updated Employee",
    email = "updated@example.com",
    employeeNum = "E-002",
    jobTitle = "Senior Engineer",
    joiningDate = "2025-02-15",
    departmentId = "d1",
    roleId = "r2"
)

class ApiEmployeeDepartmentTest {
    @Test
    fun `employee update maps real role department and strict date then refreshes`() = runTest {
        val api = EmployeeManagementApi()
        val repository = ApiEmployeeRepository(api)

        val result = repository.updateEmployee("e1", updateForm())

        assertTrue(result is AppResult.Success)
        assertEquals("e1", api.lastUpdateId)
        assertEquals("r2", api.lastUpdate?.roleId)
        assertEquals("d1", api.lastUpdate?.departmentId)
        assertEquals("2025-02-15", api.lastUpdate?.joiningDate)
        assertEquals(1, api.employeeCalls)
        val fieldNames = EmployeeUpdateRequestDto::class.java.declaredFields.map { it.name }
        assertFalse(fieldNames.contains("password"))
        assertFalse(fieldNames.contains("salary"))
    }

    @Test
    fun `employee update supports clearing department`() = runTest {
        val api = EmployeeManagementApi()
        val repository = ApiEmployeeRepository(api)

        repository.updateEmployee("e1", updateForm().copy(departmentId = null))

        assertNull(api.lastUpdate?.departmentId)
    }

    @Test
    fun `employee update surfaces backend Arabic errors without refreshing`() = runTest {
        val api = EmployeeManagementApi().apply {
            updateResponse = Response.error(
                409,
                """{"error":"EmployeeConflict","message":"البريد الإلكتروني مستخدم مسبقاً"}"""
                    .toResponseBody("application/json".toMediaType())
            )
        }
        val repository = ApiEmployeeRepository(api)

        val result = repository.updateEmployee("e1", updateForm())

        assertTrue(result is AppResult.Error)
        val error = (result as AppResult.Error).appError as AppError.ServerError
        assertEquals("البريد الإلكتروني مستخدم مسبقاً", error.message)
        assertEquals(0, api.employeeCalls)
    }

    @Test
    fun `loads real role department and manager candidate IDs`() = runTest {
        val repository = ApiEmployeeRepository(EmployeeManagementApi())

        val result = repository.refreshEmployeeOptions(includeManagerCandidates = true)

        assertTrue(result is AppResult.Success)
        assertEquals("r2", repository.observeEmployeeRoles().first()[1].id)
        val department = repository.observeDepartments().first().single()
        assertEquals("d1", department.id)
        assertEquals("u-manager", department.managerId)
        assertEquals(4, department.activeEmployeeCount)
        assertEquals("u-manager", repository.observeDepartmentManagerCandidates().first().single().userId)
    }

    @Test
    fun `department create update and clear manager map exactly`() = runTest {
        val api = EmployeeManagementApi()
        val repository = ApiEmployeeRepository(api)

        val create = repository.createDepartment(DepartmentDraft("People", "u-manager"))
        val update = repository.updateDepartment("d1", DepartmentDraft("People Ops", null))

        assertTrue(create is AppResult.Success)
        assertTrue(update is AppResult.Success)
        assertEquals("u-manager", api.lastCreatedDepartment?.managerId)
        assertEquals("d1", api.lastUpdatedDepartmentId)
        assertEquals("People Ops", api.lastUpdatedDepartment?.name)
        assertNull(api.lastUpdatedDepartment?.managerId)
    }

    @Test
    fun `employee API exposes no hard delete method`() {
        val methodNames = EmployeeApi::class.java.methods.map { it.name.lowercase() }
        assertFalse(methodNames.any { it.contains("delete") || it.contains("remove") })
    }
}
