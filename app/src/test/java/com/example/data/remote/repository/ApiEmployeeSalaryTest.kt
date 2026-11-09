package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.data.remote.api.*
import com.example.data.repository.mock.MockEmployeeRepository
import com.example.domain.model.CreateSalaryRecordRequest
import com.example.domain.model.SalaryRecordParams
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import retrofit2.Response

private fun salaryEmployeeDto() = SalaryEmployeeSummaryDto(
    id = "e1",
    employeeNum = "E-001",
    name = "Employee",
    jobTitle = "Engineer",
    departmentName = "Engineering"
)

private fun salaryDto(id: String = "s1") = SalaryRecordDto(
    id = id,
    employeeId = "e1",
    baseSalary = "2500.25",
    currency = "SAR",
    effectiveFrom = "2025-01-01",
    effectiveTo = null,
    createdAt = "2025-01-01T00:00:00.000Z"
)

private class SalaryEmployeeApi : EmployeeApi {
    var currentResponse: Response<CurrentSalaryResponseDto> = Response.success(
        CurrentSalaryResponseDto(salaryEmployeeDto(), salaryDto())
    )
    var historyResponse: Response<SalaryHistoryResponseDto> = Response.success(
        SalaryHistoryResponseDto(salaryEmployeeDto(), listOf(salaryDto("new"), salaryDto("old")))
    )
    var createResponse: Response<CurrentSalaryResponseDto> = Response.success(
        CurrentSalaryResponseDto(salaryEmployeeDto(), salaryDto(), salaryDto())
    )
    var lastSalaryEmployeeId: String? = null
    var lastSalaryRequest: CreateSalaryRecordDto? = null

    override suspend fun getCurrentSalary(id: String): Response<CurrentSalaryResponseDto> = currentResponse
    override suspend fun getSalaryHistory(id: String): Response<SalaryHistoryResponseDto> = historyResponse
    override suspend fun createSalaryRecord(
        id: String,
        request: CreateSalaryRecordDto
    ): Response<CurrentSalaryResponseDto> {
        lastSalaryEmployeeId = id
        lastSalaryRequest = request
        return createResponse
    }

    override suspend fun getEmployees(): Response<List<EmployeeDto>> = Response.success(emptyList())
    override suspend fun createEmployee(request: CreateEmployeeDto): Response<Map<String, String>> =
        Response.success(emptyMap())
    override suspend fun updateEmployee(id: String, request: EmployeeUpdateRequestDto): Response<EmployeeDto> =
        throw UnsupportedOperationException()
    override suspend fun deactivateEmployee(id: String): Response<Map<String, String>> =
        Response.success(emptyMap())
    override suspend fun getRoles(): Response<List<RoleDto>> = Response.success(emptyList())
    override suspend fun getDepartments(): Response<List<DepartmentDto>> = Response.success(emptyList())
    override suspend fun createDepartment(request: DepartmentRequestDto): Response<DepartmentDto> =
        throw UnsupportedOperationException()
    override suspend fun updateDepartment(id: String, request: DepartmentRequestDto): Response<DepartmentDto> =
        throw UnsupportedOperationException()
    override suspend fun getDepartmentManagerCandidates(): Response<List<DepartmentManagerCandidateDto>> =
        Response.success(emptyList())
}

class ApiEmployeeSalaryTest {
    @Test
    fun `salary API and domain models do not use Double or Float`() {
        val forbidden = setOf(
            java.lang.Double.TYPE,
            java.lang.Double::class.java,
            java.lang.Float.TYPE,
            java.lang.Float::class.java
        )
        assertFalse(SalaryRecordDto::class.java.declaredFields.any { it.type in forbidden })
        assertFalse(SalaryRecordParams::class.java.declaredFields.any { it.type in forbidden })
        assertEquals(String::class.java, SalaryRecordDto::class.java.getDeclaredField("baseSalary").type)
    }

    @Test
    fun `maps current salary and history without numeric conversion`() = runTest {
        val repo = ApiEmployeeRepository(SalaryEmployeeApi())
        val current = repo.getCurrentSalary("e1") as AppResult.Success
        val history = repo.getSalaryHistory("e1") as AppResult.Success

        assertEquals("2500.25", current.data.currentSalary?.baseSalary)
        assertEquals(listOf("new", "old"), history.data.history.map { it.id })
    }

    @Test
    fun `missing salary remains null and never becomes zero`() = runTest {
        val api = SalaryEmployeeApi().apply {
            currentResponse = Response.success(CurrentSalaryResponseDto(salaryEmployeeDto(), null))
        }
        val result = ApiEmployeeRepository(api).getCurrentSalary("e1") as AppResult.Success
        assertNull(result.data.currentSalary)
    }

    @Test
    fun `create request preserves amount and ISO effective date as strings`() = runTest {
        val api = SalaryEmployeeApi()
        val result = ApiEmployeeRepository(api).createSalaryRecord(
            "e1",
            CreateSalaryRecordRequest("2500.25", effectiveFrom = "2025-01-01")
        )

        assertTrue(result is AppResult.Success)
        assertEquals("e1", api.lastSalaryEmployeeId)
        assertEquals("2500.25", api.lastSalaryRequest?.baseSalary)
        assertEquals("SAR", api.lastSalaryRequest?.currency)
        assertEquals("2025-01-01", api.lastSalaryRequest?.effectiveFrom)
    }

    @Test
    fun `surfaces Arabic salary API errors`() = runTest {
        val api = SalaryEmployeeApi().apply {
            createResponse = Response.error(
                409,
                """{"error":"SalaryConflict","message":"تاريخ سريان الراتب غير صالح"}"""
                    .toResponseBody("application/json".toMediaType())
            )
        }
        val result = ApiEmployeeRepository(api).createSalaryRecord(
            "e1",
            CreateSalaryRecordRequest("2500.25", effectiveFrom = "2025-01-01")
        ) as AppResult.Error

        assertEquals("تاريخ سريان الراتب غير صالح", (result.appError as AppError.ServerError).message)
    }

    @Test
    fun `mock repository starts without fake salary and refreshes after a user-created record`() = runTest {
        val repo = MockEmployeeRepository()
        val before = repo.getCurrentSalary("1") as AppResult.Success
        assertNull(before.data.currentSalary)

        repo.createSalaryRecord(
            "1",
            CreateSalaryRecordRequest("3200.75", effectiveFrom = "2025-01-01")
        )
        val after = repo.getCurrentSalary("1") as AppResult.Success
        val history = repo.getSalaryHistory("1") as AppResult.Success

        assertEquals("3200.75", after.data.currentSalary?.baseSalary)
        assertEquals(1, history.data.history.size)
    }
}
