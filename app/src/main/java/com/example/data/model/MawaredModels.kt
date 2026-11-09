package com.example.data.model

import androidx.room.Entity
import androidx.room.PrimaryKey
import java.util.UUID

@Entity(tableName = "employees")
data class Employee(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    val name: String,
    val email: String,
    val phone: String,
    val role: String,
    val department: String,
    val basicSalary: Double,
    val allowances: Double,
    val deductions: Double,
    val joinedDate: String,
    val status: String // "نشط" (Active), "في إجازة" (On Leave), "موقوف مؤقتاً" (Suspended)
) {
    // Computed total salary linked dynamically to financial payroll
    val totalSalary: Double
        get() = basicSalary + allowances - deductions
}

@Entity(tableName = "purchase_orders")
data class PurchaseOrder(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    val title: String,
    val requester: String,
    val department: String,
    val amount: String,
    val date: String,
    val status: String, // "قيد الانتظار" (Pending), "تمت الموافقة" (Approved), "مرفوض" (Rejected)
    val category: String // "أجهزة ومعدات" (Devices), "برمجيات" (Software), "مستلزمات مكتبية" (Office), "أخرى" (Other)
)

@Entity(tableName = "chat_messages")
data class ChatMessage(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    val senderName: String,
    val senderRole: String,
    val content: String,
    val timestamp: Long = System.currentTimeMillis(),
    val channel: String // "العامة" (General), "المالية والمشتريات" (Finance), "الموارد البشرية" (HR)
)

@Entity(tableName = "tasks")
data class Task(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    val title: String,
    val description: String,
    val dueDate: String,
    val priority: String, // "عالية" (High), "متوسطة" (Medium), "منخفضة" (Low)
    val isCompleted: Boolean = false,
    val isAlertTriggered: Boolean = false
)

@Entity(tableName = "training_courses")
data class TrainingCourse(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    val title: String,
    val description: String,
    val instructor: String,
    val startDate: String,
    val endDate: String,
    val resources: String, // "كتب مخصصة، ملف عروض تقديمة، روابط تعليمة" (Materials description)
    val status: String // "مخطط" (Planned), "نشط" (Active), "مكتمل" (Completed)
)

@Entity(tableName = "training_assignments")
data class TrainingAssignment(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    val courseId: String,
    val employeeId: String,
    val employeeName: String,
    val employeeRole: String,
    val progress: Int, // 0 to 100 %
    val status: String // "مسجل" (Registered), "قيد الدراسة" (In Progress), "مكتمل" (Completed), "متعثر" (Struggling)
)
