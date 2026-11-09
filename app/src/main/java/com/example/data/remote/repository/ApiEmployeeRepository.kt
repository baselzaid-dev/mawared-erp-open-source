package com.example.data.remote.repository

import com.example.core.utils.AppError
import com.example.core.utils.AppResult
import com.example.domain.model.EmployeeParams
import com.example.domain.model.EmployeeUpdateForm
import com.example.domain.model.CreateSalaryRecordRequest
import com.example.domain.model.CurrentSalaryDetails
import com.example.domain.model.SalaryEmployeeSummary
import com.example.domain.model.SalaryHistoryDetails
import com.example.domain.model.SalaryRecordParams
import com.example.domain.model.Department
import com.example.domain.model.DepartmentDraft
import com.example.domain.model.DepartmentManagerCandidate
import com.example.domain.model.Role
import com.example.domain.repository.EmployeeRepository
import com.example.data.remote.api.EmployeeApi
import com.example.data.remote.api.CreateEmployeeDto
import com.example.data.remote.api.DepartmentRequestDto
import com.example.data.remote.api.EmployeeDto
import com.example.data.remote.api.EmployeeUpdateRequestDto
import com.example.data.remote.api.CreateSalaryRecordDto
import com.example.data.remote.api.SalaryEmployeeSummaryDto
import com.example.data.remote.api.SalaryRecordDto
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

class ApiEmployeeRepository(
    private val employeeApi: EmployeeApi
) : EmployeeRepository {

    private val _employees = MutableStateFlow<List<EmployeeParams>>(emptyList())
    private val _roles = MutableStateFlow<List<Role>>(emptyList())
    private val _departments = MutableStateFlow<List<Department>>(emptyList())
    private val _managerCandidates = MutableStateFlow<List<DepartmentManagerCandidate>>(emptyList())

    override fun observeEmployees(): Flow<List<EmployeeParams>> = _employees.asStateFlow()
    override fun observeEmployeeRoles(): Flow<List<Role>> = _roles.asStateFlow()
    override fun observeDepartments(): Flow<List<Department>> = _departments.asStateFlow()
    override fun observeDepartmentManagerCandidates(): Flow<List<DepartmentManagerCandidate>> =
        _managerCandidates.asStateFlow()

    private fun EmployeeDto.toDomain(): EmployeeParams = EmployeeParams(
        id = id,
        companyId = companyId,
        departmentId = department?.id,
        employeeCode = employeeNum,
        fullName = user?.name ?: "غير معروف",
        jobTitle = jobTitle,
        phone = null,
        email = user?.email,
        nationalIdOrIqama = null,
        basicSalary = 0.0,
        allowances = 0.0,
        deductions = 0.0,
        status = status ?: "active",
        joiningDate = joiningDate,
        contractType = null,
        createdAt = System.currentTimeMillis(),
        updatedAt = System.currentTimeMillis(),
        departmentName = department?.name,
        roleId = user?.roleId,
        roleName = user?.roleName ?: user?.oldRole,
        userId = user?.id,
        credentialVersion = user?.credentialVersion,
        updatedAtIso = updatedAt,
        archivedAtIso = archivedAt
    )

    private fun SalaryEmployeeSummaryDto.toDomain() = SalaryEmployeeSummary(
        id = id,
        employeeNum = employeeNum,
        name = name,
        jobTitle = jobTitle,
        departmentName = departmentName
    )

    private fun SalaryRecordDto.toDomain() = SalaryRecordParams(
        id = id,
        employeeId = employeeId,
        baseSalary = baseSalary,
        currency = currency,
        effectiveFrom = effectiveFrom,
        effectiveTo = effectiveTo,
        createdAt = createdAt
    )

    private fun serverMessage(response: retrofit2.Response<*>): String? = try {
        response.errorBody()?.string()?.let { body ->
            Regex("\"message\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
                ?: Regex("\"error\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
        }
    } catch (_: Exception) {
        null
    }

    private fun responseError(response: retrofit2.Response<*>, fallback: String): AppResult.Error {
        val message = serverMessage(response) ?: response.message().takeIf { it.isNotBlank() } ?: fallback
        return AppResult.Error(Exception(message), AppError.ServerError(response.code(), message))
    }

    override suspend fun refreshEmployees(): AppResult<Unit> {
        return try {
            val response = employeeApi.getEmployees()
            if (response.isSuccessful && response.body() != null) {
                val mapped = response.body()!!.map { it.toDomain() }
                _employees.value = mapped
                AppResult.Success(Unit)
            } else {
                AppResult.Error(Exception("Failed: ${response.code()}"), AppError.ServerError(response.code(), response.message()))
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun refreshEmployeeOptions(includeManagerCandidates: Boolean): AppResult<Unit> {
        return try {
            val rolesResponse = employeeApi.getRoles()
            if (!rolesResponse.isSuccessful || rolesResponse.body() == null) {
                return responseError(rolesResponse, "تعذّر تحميل الأدوار الوظيفية")
            }
            val departmentsResponse = employeeApi.getDepartments()
            if (!departmentsResponse.isSuccessful || departmentsResponse.body() == null) {
                return responseError(departmentsResponse, "تعذّر تحميل الأقسام")
            }

            _roles.value = rolesResponse.body()!!.map { dto ->
                Role(id = dto.id, companyId = "", name = dto.name, description = null)
            }
            _departments.value = departmentsResponse.body()!!.map { dto ->
                Department(
                    id = dto.id,
                    name = dto.name,
                    managerId = dto.managerId,
                    managerName = dto.managerName,
                    activeEmployeeCount = dto.activeEmployeeCount
                )
            }

            if (includeManagerCandidates) {
                val candidatesResponse = employeeApi.getDepartmentManagerCandidates()
                if (!candidatesResponse.isSuccessful || candidatesResponse.body() == null) {
                    return responseError(candidatesResponse, "تعذّر تحميل المرشحين لإدارة الأقسام")
                }
                _managerCandidates.value = candidatesResponse.body()!!.map { dto ->
                    DepartmentManagerCandidate(
                        userId = dto.userId,
                        employeeId = dto.employeeId,
                        name = dto.name,
                        roleName = dto.roleName,
                        departmentId = dto.departmentId
                    )
                }
            } else {
                _managerCandidates.value = emptyList()
            }
            AppResult.Success(Unit)
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun getEmployee(id: String): AppResult<EmployeeParams> {
        val emp = _employees.value.find { it.id == id }
        return if (emp != null) AppResult.Success(emp) else AppResult.Error(Exception("Not found"))
    }

    override suspend fun createEmployee(employee: EmployeeParams): AppResult<Unit> {
        return try {
            // Backend needs a REAL role UUID, not a hardcoded index. New staff are
            // created with the lowest-privilege "Employee" role (resolved live).
            val rolesResp = employeeApi.getRoles()
            val roles = if (rolesResp.isSuccessful) rolesResp.body().orEmpty() else emptyList()
            val employeeRoleId = roles.firstOrNull { it.name.equals("Employee", ignoreCase = true) }?.id
            if (employeeRoleId == null) {
                return AppResult.Error(
                    Exception("No roles available"),
                    AppError.ServerError(rolesResp.code(), "تعذّر جلب الأدوار الوظيفية من الخادم")
                )
            }
            // The UI collects a department NAME, not the backend UUID. Send a real
            // department id only when it already looks like a UUID; otherwise null
            // (department is optional) so the backend does not reject a fake id.
            val safeDepartmentId = employee.departmentId?.takeIf { it.length >= 36 }
            val temporaryPassword = employee.temporaryPassword?.takeIf { it.length in 8..256 }
                ?: return AppResult.Error(
                    IllegalArgumentException("Temporary password is required"),
                    AppError.ValidationError("يجب إدخال كلمة مرور مؤقتة من 8 أحرف على الأقل")
                )

            val dto = CreateEmployeeDto(
                email = employee.email ?: "",
                password = temporaryPassword,
                name = employee.fullName,
                roleId = employeeRoleId,
                employeeNum = employee.employeeCode,
                jobTitle = employee.jobTitle ?: "Employee",
                joiningDate = employee.joiningDate ?: "2026-01-01",
                departmentId = safeDepartmentId
            )
            val response = employeeApi.createEmployee(dto)
            if (response.isSuccessful) {
                refreshEmployees()
                AppResult.Success(Unit)
            } else {
                // Surface the backend's Arabic error (duplicate email/employeeNum,
                // invalid role/department, validation) instead of a generic message.
                // Prefer the human "message" (validation errors) then fall back to
                // "error" (business errors like duplicate email put Arabic there).
                val serverMessage = try {
                    response.errorBody()?.string()?.let { body ->
                        Regex("\"message\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
                            ?: Regex("\"error\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
                    }
                } catch (_: Exception) { null }
                AppResult.Error(
                    Exception(serverMessage ?: "Failed to create"),
                    AppError.ServerError(response.code(), serverMessage ?: response.message())
                )
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun updateEmployee(id: String, employee: EmployeeUpdateForm): AppResult<Unit> {
        return try {
            val response = employeeApi.updateEmployee(
                id,
                EmployeeUpdateRequestDto(
                    name = employee.name,
                    email = employee.email,
                    employeeNum = employee.employeeNum,
                    jobTitle = employee.jobTitle,
                    joiningDate = employee.joiningDate,
                    departmentId = employee.departmentId,
                    roleId = employee.roleId
                )
            )
            if (response.isSuccessful) {
                refreshEmployees()
            } else {
                responseError(response, "تعذّر تحديث بيانات الموظف")
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun createDepartment(department: DepartmentDraft): AppResult<Unit> {
        return try {
            val response = employeeApi.createDepartment(
                DepartmentRequestDto(department.name, department.managerId)
            )
            if (response.isSuccessful) {
                AppResult.Success(Unit)
            } else {
                responseError(response, "تعذّر إنشاء القسم")
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun updateDepartment(id: String, department: DepartmentDraft): AppResult<Unit> {
        return try {
            val response = employeeApi.updateDepartment(
                id,
                DepartmentRequestDto(department.name, department.managerId)
            )
            if (response.isSuccessful) {
                AppResult.Success(Unit)
            } else {
                responseError(response, "تعذّر تحديث القسم")
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun deactivateEmployee(id: String): AppResult<Unit> {
        return try {
            val response = employeeApi.deactivateEmployee(id)
            if (response.isSuccessful) {
                refreshEmployees()
                AppResult.Success(Unit)
            } else {
                // Surface the backend's Arabic error (owner protection, self,
                // already-inactive) instead of a generic message.
                val serverMessage = try {
                    response.errorBody()?.string()?.let { body ->
                        Regex("\"(?:message|error)\"\\s*:\\s*\"([^\"]+)\"").find(body)?.groupValues?.get(1)
                    }
                } catch (_: Exception) { null }
                AppResult.Error(
                    Exception(serverMessage ?: "Failed to deactivate"),
                    AppError.ServerError(response.code(), serverMessage ?: response.message())
                )
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun getCurrentSalary(employeeId: String): AppResult<CurrentSalaryDetails> {
        return try {
            val response = employeeApi.getCurrentSalary(employeeId)
            val body = response.body()
            if (response.isSuccessful && body != null) {
                AppResult.Success(
                    CurrentSalaryDetails(
                        employee = body.employee.toDomain(),
                        currentSalary = body.currentSalary?.toDomain()
                    )
                )
            } else {
                responseError(response, "تعذّر تحميل بيانات الراتب")
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun getSalaryHistory(employeeId: String): AppResult<SalaryHistoryDetails> {
        return try {
            val response = employeeApi.getSalaryHistory(employeeId)
            val body = response.body()
            if (response.isSuccessful && body != null) {
                AppResult.Success(
                    SalaryHistoryDetails(
                        employee = body.employee.toDomain(),
                        history = body.history.map { it.toDomain() }
                    )
                )
            } else {
                responseError(response, "تعذّر تحميل سجل الرواتب")
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override suspend fun createSalaryRecord(
        employeeId: String,
        request: CreateSalaryRecordRequest
    ): AppResult<SalaryRecordParams> {
        return try {
            val response = employeeApi.createSalaryRecord(
                employeeId,
                CreateSalaryRecordDto(
                    baseSalary = request.baseSalary,
                    currency = request.currency,
                    effectiveFrom = request.effectiveFrom
                )
            )
            val body = response.body()
            val salary = body?.createdSalary ?: body?.currentSalary
            if (response.isSuccessful && salary != null) {
                AppResult.Success(salary.toDomain())
            } else {
                responseError(response, "تعذّر حفظ سجل الراتب")
            }
        } catch (e: Exception) {
            AppResult.Error(e, AppError.NetworkError)
        }
    }

    override fun clear() {
        _employees.value = emptyList()
        _roles.value = emptyList()
        _departments.value = emptyList()
        _managerCandidates.value = emptyList()
    }
}
