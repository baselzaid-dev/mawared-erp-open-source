package com.example.data.demo

/**
 * Display-only profiles used by DEMO_MODE. Permissions still come from the
 * mock CurrentSession and never from these labels.
 */
data class DemoLoginProfile(
    val companyCode: String,
    val identifier: String,
    val password: String,
    val fullName: String,
    val roleName: String,
    val departmentName: String
)

object DemoLoginProfiles {
    val profiles: List<DemoLoginProfile> = listOf(
        DemoLoginProfile(
            companyCode = "CMP-DEMO",
            identifier = "a.otaibi@fixture-1.example.test",
            password = "1234",
            fullName = "موظف تجريبي 3",
            roleName = "مدير الموارد البشرية",
            departmentName = "الموارد البشرية"
        ),
        DemoLoginProfile(
            companyCode = "CMP-DEMO",
            identifier = "s.ghamdi@fixture-1.example.test",
            password = "1234",
            fullName = "موظف تجريبي 4",
            roleName = "مديرة المالية",
            departmentName = "المالية"
        ),
        DemoLoginProfile(
            companyCode = "CMP-DEMO",
            identifier = "r.shammari@fixture-1.example.test",
            password = "1234",
            fullName = "موظف تجريبي 5",
            roleName = "مسؤول المشتريات",
            departmentName = "المشتريات"
        ),
        DemoLoginProfile(
            companyCode = "CMP-DEMO",
            identifier = "b.yousef@fixture-1.example.test",
            password = "1234",
            fullName = "موظف تجريبي 6",
            roleName = "موظف",
            departmentName = "تقنية المعلومات"
        ),
        DemoLoginProfile(
            companyCode = "CMP-BRANCH",
            identifier = "b.yousef@fixture-1.example.test",
            password = "1234",
            fullName = "موظف تجريبي 7",
            roleName = "موظف",
            departmentName = "فرع الشركة"
        )
    )

    fun find(companyCode: String, identifier: String): DemoLoginProfile? =
        profiles.firstOrNull {
            it.companyCode.equals(companyCode.trim(), ignoreCase = true) &&
                it.identifier.equals(identifier.trim(), ignoreCase = true)
        }
}
