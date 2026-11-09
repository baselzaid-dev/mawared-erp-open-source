package com.example.data.repository.mock

import com.example.core.utils.AppResult
import com.example.domain.model.EmployeeParams
import com.example.domain.model.EmployeeUpdateForm
import com.example.domain.model.Department
import com.example.domain.model.DepartmentDraft
import com.example.domain.model.DepartmentManagerCandidate
import com.example.domain.model.Role
import com.example.domain.model.CreateSalaryRecordRequest
import com.example.domain.model.CurrentSalaryDetails
import com.example.domain.model.SalaryEmployeeSummary
import com.example.domain.model.SalaryHistoryDetails
import com.example.domain.model.SalaryRecordParams
import com.example.domain.repository.EmployeeRepository
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class MockEmployeeRepository : EmployeeRepository {
    private val rolesFlow = MutableStateFlow(
        listOf(Role(id = "r-employee", companyId = "1", name = "Employee", description = null))
    )
    private val departmentsFlow = MutableStateFlow(
        listOf(Department(id = "1", companyId = "1", name = "تقنية المعلومات", managerId = null))
    )
    private val managerCandidatesFlow = MutableStateFlow<List<DepartmentManagerCandidate>>(emptyList())
    private val fakeEmployees = mutableListOf(
        EmployeeParams(
            id = "1",
            companyId = "1",
            departmentId = "1",
            employeeCode = "EMP001",
            fullName = "موظف تجريبي 9",
            jobTitle = "IT Manager",
            phone = "+966500000006",
            email = "ahmed@fixture-2.example.test",
            nationalIdOrIqama = "1000000001",
            basicSalary = 0.0,
            allowances = 0.0,
            deductions = 0.0,
            status = "ACTIVE",
            joiningDate = "2024-01-01",
            contractType = "FULL_TIME",
            createdAt = System.currentTimeMillis(),
            updatedAt = System.currentTimeMillis()
        )
    )

    private val employeesFlow = MutableStateFlow<List<EmployeeParams>>(fakeEmployees)
    private val salaryHistory = mutableMapOf<String, MutableList<SalaryRecordParams>>()

    private fun salaryEmployee(employee: EmployeeParams) = SalaryEmployeeSummary(
        id = employee.id,
        employeeNum = employee.employeeCode,
        name = employee.fullName,
        jobTitle = employee.jobTitle.orEmpty(),
        departmentName = employee.departmentName
    )

    private fun isoToday(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
    }.format(Date())

    private fun previousIsoDay(date: String): String {
        val formatter = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
            isLenient = false
        }
        val calendar = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply {
            time = formatter.parse(date)!!
            add(Calendar.DAY_OF_MONTH, -1)
        }
        return formatter.format(calendar.time)
    }

    override fun observeEmployees(): Flow<List<EmployeeParams>> = employeesFlow
    override fun observeEmployeeRoles(): Flow<List<Role>> = rolesFlow
    override fun observeDepartments(): Flow<List<Department>> = departmentsFlow
    override fun observeDepartmentManagerCandidates(): Flow<List<DepartmentManagerCandidate>> =
        managerCandidatesFlow

    override fun clear() {
        employeesFlow.value = emptyList()
        rolesFlow.value = emptyList()
        departmentsFlow.value = emptyList()
        managerCandidatesFlow.value = emptyList()
        salaryHistory.clear()
    }

    override suspend fun refreshEmployees(): AppResult<Unit> {
        delay(800) // Simulate network
        employeesFlow.value = fakeEmployees.toList()
        return AppResult.Success(Unit)
    }

    override suspend fun refreshEmployeeOptions(includeManagerCandidates: Boolean): AppResult<Unit> {
        if (!includeManagerCandidates) managerCandidatesFlow.value = emptyList()
        return AppResult.Success(Unit)
    }

    override suspend fun getEmployee(id: String): AppResult<EmployeeParams> {
        delay(500)
        val emp = fakeEmployees.find { it.id == id }
        return if (emp != null) AppResult.Success(emp)
        else AppResult.Error(Exception("Employee not found"))
    }

    override suspend fun createEmployee(employee: EmployeeParams): AppResult<Unit> {
        delay(1000)
        fakeEmployees.add(employee.copy(id = (fakeEmployees.size + 1).toString()))
        employeesFlow.value = fakeEmployees.toList()
        return AppResult.Success(Unit)
    }

    override suspend fun updateEmployee(id: String, employee: EmployeeUpdateForm): AppResult<Unit> {
        delay(1000)
        val index = fakeEmployees.indexOfFirst { it.id == id }
        if (index != -1) {
            val department = departmentsFlow.value.firstOrNull { it.id == employee.departmentId }
            val role = rolesFlow.value.firstOrNull { it.id == employee.roleId }
            fakeEmployees[index] = fakeEmployees[index].copy(
                fullName = employee.name,
                email = employee.email,
                employeeCode = employee.employeeNum,
                jobTitle = employee.jobTitle,
                joiningDate = employee.joiningDate,
                departmentId = employee.departmentId,
                departmentName = department?.name,
                roleId = employee.roleId,
                roleName = role?.name
            )
            employeesFlow.value = fakeEmployees.toList()
            return AppResult.Success(Unit)
        }
        return AppResult.Error(Exception("Employee not found"))
    }

    override suspend fun createDepartment(department: DepartmentDraft): AppResult<Unit> {
        val created = Department(
            id = "d-${departmentsFlow.value.size + 1}",
            companyId = "1",
            name = department.name,
            managerId = department.managerId,
            managerName = managerCandidatesFlow.value.firstOrNull { it.userId == department.managerId }?.name
        )
        departmentsFlow.value = departmentsFlow.value + created
        return AppResult.Success(Unit)
    }

    override suspend fun updateDepartment(id: String, department: DepartmentDraft): AppResult<Unit> {
        val existing = departmentsFlow.value.firstOrNull { it.id == id }
            ?: return AppResult.Error(Exception("Department not found"))
        departmentsFlow.value = departmentsFlow.value.map {
            if (it.id == id) existing.copy(
                name = department.name,
                managerId = department.managerId,
                managerName = managerCandidatesFlow.value.firstOrNull { candidate ->
                    candidate.userId == department.managerId
                }?.name
            ) else it
        }
        return AppResult.Success(Unit)
    }

    override suspend fun deactivateEmployee(id: String): AppResult<Unit> {
        delay(800)
        val index = fakeEmployees.indexOfFirst { it.id == id }
        if (index != -1) {
            fakeEmployees[index] = fakeEmployees[index].copy(status = "INACTIVE")
            employeesFlow.value = fakeEmployees.toList()
            return AppResult.Success(Unit)
        }
        return AppResult.Error(Exception("Employee not found"))
    }

    override suspend fun getCurrentSalary(employeeId: String): AppResult<CurrentSalaryDetails> {
        val employee = fakeEmployees.firstOrNull { it.id == employeeId }
            ?: return AppResult.Error(Exception("Employee not found"))
        val today = isoToday()
        val current = salaryHistory[employeeId]
            .orEmpty()
            .filter { it.effectiveFrom <= today && (it.effectiveTo == null || it.effectiveTo >= today) }
            .maxByOrNull { it.effectiveFrom }
        return AppResult.Success(CurrentSalaryDetails(salaryEmployee(employee), current))
    }

    override suspend fun getSalaryHistory(employeeId: String): AppResult<SalaryHistoryDetails> {
        val employee = fakeEmployees.firstOrNull { it.id == employeeId }
            ?: return AppResult.Error(Exception("Employee not found"))
        return AppResult.Success(
            SalaryHistoryDetails(
                employee = salaryEmployee(employee),
                history = salaryHistory[employeeId].orEmpty().sortedByDescending { it.effectiveFrom }
            )
        )
    }

    override suspend fun createSalaryRecord(
        employeeId: String,
        request: CreateSalaryRecordRequest
    ): AppResult<SalaryRecordParams> {
        if (fakeEmployees.none { it.id == employeeId }) {
            return AppResult.Error(Exception("Employee not found"))
        }
        val records = salaryHistory.getOrPut(employeeId) { mutableListOf() }
        val latest = records.maxByOrNull { it.effectiveFrom }
        if (latest != null && request.effectiveFrom <= latest.effectiveFrom) {
            return AppResult.Error(Exception("تاريخ سريان الراتب يجب أن يكون بعد آخر سجل راتب"))
        }
        if (latest != null && latest.effectiveTo == null) {
            val index = records.indexOf(latest)
            records[index] = latest.copy(effectiveTo = previousIsoDay(request.effectiveFrom))
        }
        val created = SalaryRecordParams(
            id = "salary-${records.size + 1}",
            employeeId = employeeId,
            baseSalary = request.baseSalary,
            currency = request.currency,
            effectiveFrom = request.effectiveFrom,
            effectiveTo = null,
            createdAt = null
        )
        records += created
        return AppResult.Success(created)
    }
}
